/**
 * Test seams for applications built on @popcomputer/web.
 *
 * Tests call the application's real routes with `app.request` and pass
 * `testEnv(layer)` as the request env, so the layer's services replace or add
 * to what the request runtime provides. An action is tested through its
 * route, which reads its input and loads its records; a helper Effect that
 * reads only the signed-in user runs directly under `Effect.provide`.
 *
 * @example
 * const res = await app.request('/projects', {}, testEnv(signedIn({ id: 'user-1' })))
 */
import { Clock, DateTime, Duration, Effect, Layer, Option, Redacted, Schema as S, Scope } from 'effect'
import type { Cookie } from './effect/cookies.js'
import { TestClock } from 'effect/testing'
import { AuthUserService, type AuthUser, type DatabaseType, type DefaultAuthUser } from './effect/services.js'
import type { Registered } from './effect/register.js'
import { attachTestDatabase, attachTestLayer } from './effect/test-env.js'
import { whenTestCaseEnds } from './test-case.js'
import { held, receive, sent, type CookieJar } from './cookie-jar.js'
import { hostTag, POOL_DIRECTORY, removePoolDirectory, sweepAbandonedPools } from './test-pools.js'
import type { PageName } from './effect/pages.js'
import type { ErrorPageProps, FlashData, PagePropsFor } from './react.js'
import { ErrorResponse, errorResponseWith, type ErrorResponseBody } from './effect/error-response.js'

export { testOAuthProvider, type TestOAuthPerson, type TestOAuthProvider, type TestOAuthProviderOptions } from './test-oauth.js'

type RegisteredBindings = Registered<'bindings', never>

/**
 * The bindings a test passes to `testEnv`: any of the application's
 * registered bindings, each with its declared type.
 */
export type TestBindings = [RegisteredBindings] extends [never] ? object : Partial<RegisteredBindings>

/**
 * A binding a test passes that the application does not declare, such as a
 * misspelled one, typed so that passing it is an error naming the declared
 * bindings.
 */
type UndeclaredBindings<Given> = [Exclude<keyof Given, keyof RegisteredBindings>] extends [never]
  ? unknown
  : {
      // Written out rather than named, so the compiler's message shows it.
      readonly [Name in Exclude<keyof Given, keyof RegisteredBindings>]: {
        readonly __error: "Not one of the application's bindings: declare it in src/env.ts, or correct its name."
        readonly declaredBindings: keyof RegisteredBindings
      }
    }

/**
 * Build a request env that adds `layer` to the request's Effect runtime.
 *
 * Services in `layer` replace the ones effectBridge provides for the request,
 * such as `AuthUserService` and `DatabaseService`, and supply services the
 * application provides through `setupWeb`'s `services`. A layer that a
 * route registers with `.provide()` still takes precedence for that route.
 *
 * The env has each binding passed in with the type it was given, so a test
 * reads its database as `env.DB`, and may have any of the others.
 *
 * @param bindings - Bindings the request reads from `c.env` and Effect `Config`.
 */
export function testEnv<ROut, Given extends TestBindings>(
  layer: Layer.Layer<ROut>,
  bindings?: Given & UndeclaredBindings<Given>,
  options?: TestEnvOptions
): TestBindings & Given
/**
 * Build a request env from bindings alone, and a database, for a test whose
 * requests sign in through the application, as a `testBrowser` does.
 *
 * @example
 * const env = testEnv(testBindings, { database: await freshDatabase() })
 */
export function testEnv<Given extends TestBindings>(
  bindings: Given & UndeclaredBindings<Given>,
  options?: TestEnvOptions
): TestBindings & Given
export function testEnv(
  first: Layer.Layer<never> | TestBindings,
  second?: TestBindings | TestEnvOptions,
  third: TestEnvOptions = {}
): TestBindings {
  const isLayer = (value: Layer.Layer<never> | TestBindings): value is Layer.Layer<never> => Layer.isLayer(value)
  const layered = isLayer(first)
  // SAFETY: the overloads put the bindings second after a layer, first without one.
  const bindings = (layered ? second ?? {} : first) as TestBindings
  // SAFETY: as above, the options follow the bindings.
  const options = (layered ? third : second ?? {}) as TestEnvOptions
  const env = { ...bindings }

  attachTestLayer(env, isLayer(first) ? first : Layer.empty)

  if (options.database !== undefined) attachTestDatabase(env, options.database)

  return env
}

/** What a test request uses in place of the application's own setup. */
export interface TestEnvOptions {
  /**
   * The database in place of setupWeb's `database` factory: the database
   * operations, route model binding and the Better Auth client all use it,
   * such as an in-process PGlite database migrated with `applyMigrations`.
   */
  readonly database?: DatabaseType
}

/**
 * Apply drizzle-kit's SQL migrations in `folder`, in file order, running each
 * statement through `run`: `(sql) => d1.prepare(sql).run()` for a Miniflare
 * D1 database, `(sql) => pglite.exec(sql)` for PGlite.
 *
 * @example
 * await applyMigrations('./drizzle', (sql) => client.exec(sql))
 */
export async function applyMigrations(
  folder: string,
  run: (statement: string) => Promise<unknown>
): Promise<void> {
  for (const statement of await readMigrations(folder)) await run(statement)
}

/**
 * drizzle-kit's SQL migrations in `folder`, in file order, as statements,
 * for a database that runs many at once: a fresh D1 database migrated in
 * one batch takes one round trip rather than one per statement. Resolve the
 * folder from the test module, so the tests run from any directory.
 *
 * @example
 * const statements = await readMigrations(join(import.meta.dir, '../drizzle'))
 * await d1.batch(statements.map((sql) => d1.prepare(sql)))
 */
export async function readMigrations(folder: string): Promise<ReadonlyArray<string>> {
  const { readdir, readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const files = (await readdir(folder)).filter((name) => name.endsWith('.sql')).sort()
  const statements: string[] = []

  for (const file of files) {
    for (const statement of (await readFile(join(folder, file), 'utf8')).split('--> statement-breakpoint')) {
      if (statement.trim()) statements.push(statement)
    }
  }

  return statements
}

/** A D1 database, as `testD1` migrates it. */
export interface TestD1Database {
  prepare(query: string): unknown
  batch(statements: ReadonlyArray<unknown>): Promise<unknown>
}

/** The types of the bindings that are D1 databases. */
type D1BindingsOf<Bindings> = {
  [Name in keyof Bindings]-?: NonNullable<Bindings[Name]> extends { prepare(...args: never[]): unknown; batch(...args: never[]): unknown; exec(...args: never[]): unknown }
    ? NonNullable<Bindings[Name]>
    : never
}[keyof Bindings]

/** The application's D1 binding, by its declared type, which `testD1` hands a test: a D1 database's parts when none is registered. */
type RegisteredD1 = [D1BindingsOf<RegisteredBindings>] extends [never] ? TestD1Database : D1BindingsOf<RegisteredBindings>

export interface TestD1Options {
  /** drizzle-kit's migrations folder, applied to each database, relative to where `bun test` runs. */
  readonly migrations: string
  /** How many databases one Miniflare holds before another starts. Default 64. */
  readonly perMiniflare?: number
}

/** Fresh D1 databases for tests, each in a Miniflare that `dispose()` stops. */
export interface TestD1 {
  /**
   * A newly created, migrated and empty D1 database, typed as the application's
   * D1 binding. One a `fuzz` case asks for is finished when the case ends, and
   * its Miniflare stops once it has no other to hand out or still in use.
   */
  fresh(): Promise<RegisteredD1>
  /**
   * Stop every Miniflare the databases run in, once every test file is done
   * with them, and remove the databases' files, resolving once they are gone.
   * The next `fresh()` starts again, so a loop of its own may call it between
   * rounds.
   */
  dispose(): Promise<void>
}

/** The parts of Miniflare `testD1` starts databases with. */
interface MiniflareLike {
  getD1Database(name: string): Promise<TestD1Database>
  dispose(): Promise<void>
}

/** A running Miniflare, how many of its databases it has handed out, and how many of those are finished with. */
interface StartedMiniflare {
  readonly miniflare: MiniflareLike
  next: number
  finished: number
}

/** The environment variables `os.tmpdir()` reads, on every platform. */
const TEMPORARY_DIRECTORY_VARIABLES = ['TMPDIR', 'TMP', 'TEMP'] as const

/**
 * Construct a Miniflare whose temporary files live under `directory`.
 *
 * Miniflare keeps its databases in a directory it names from `os.tmpdir()`
 * when it is constructed, and its `dispose()` starts removing that directory
 * without waiting: `bun test` exits as soon as the last `afterAll` resolves,
 * which leaves the directory behind, tens of megabytes on every run.
 * Constructed here, its directory is inside one `testD1` owns, and removes,
 * waiting, on `dispose()`. The constructor is synchronous, so nothing else
 * reads the variables while they point there.
 */
function constructIn<A>(directory: string, construct: () => A): A {
  const previous = TEMPORARY_DIRECTORY_VARIABLES.map((name) => [name, process.env[name]] as const)

  for (const name of TEMPORARY_DIRECTORY_VARIABLES) process.env[name] = directory

  try {
    return construct()
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

/** The sweep this process began, once: what a killed run left can take a while to remove, so nothing waits for it. */
let sweeping: Promise<void> | undefined

/** A new directory of the pool's own, under the system's temporary directory. */
async function poolDirectory(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  sweeping ??= sweepAbandonedPools(tmpdir()).catch(() => undefined)

  return mkdtemp(join(tmpdir(), `${POOL_DIRECTORY}${process.pid}-${await hostTag()}-`))
}

/** How long, in milliseconds, Miniflare's read waits for a reply that has not landed. */
const LATE_REPLY_MILLIS = 30_000

/** A stack frame in Miniflare's own built module, `miniflare/dist`. */
const MINIFLARE_FRAME = /[\\/]miniflare[\\/]dist[\\/]/

/** Whether the code that called the patched read is Miniflare's own: the frame after the read's. */
const calledByMiniflare = (stack: string): boolean => MINIFLARE_FRAME.test(stack.split('\n').filter((line) => line.trim().startsWith('at '))[1] ?? '')

/** Whether this process's Miniflare reads wait yet. */
let waitingForLateReplies = false

/**
 * Let Miniflare's proxy read a reply it was woken too early for.
 *
 * A call on a D1 binding from outside `workerd` blocks in `Atomics.wait` on a
 * flag a worker thread sets after posting the reply, then reads the reply with
 * `receiveMessageOnPort` and asserts it is there. With both threads preempted,
 * as on a busy machine under any runtime, one reply's notify can land after
 * the next call has armed its wait. That call wakes with no reply, the
 * assertion fails (`false == true`), and every later call on that Miniflare
 * reads the reply before its own and fails too. Waiting for the reply cures
 * it. Only Miniflare's read waits: anyone else who asks for a message is told
 * at once there is none.
 *
 * Miniflare fixed this on its 5.x line (cloudflare/workers-sdk#15552), and no
 * 4.x release has it. Remove this when the peer range leaves 4.x.
 */
async function waitForLateReplies(): Promise<void> {
  if (waitingForLateReplies) return

  waitingForLateReplies = true

  const { createRequire } = await import('node:module')
  const threads: { receiveMessageOnPort(port: unknown): unknown } = createRequire(import.meta.url)('node:worker_threads')
  const receive = threads.receiveMessageOnPort
  const pause = new Int32Array(new SharedArrayBuffer(4))

  threads.receiveMessageOnPort = (port) => {
    let received = receive(port)

    if (received !== undefined || !calledByMiniflare(new Error().stack ?? '')) return received

    for (let waited = 0; received === undefined && waited < LATE_REPLY_MILLIS; waited += 1) {
      Atomics.wait(pause, 0, 0, 1)
      received = receive(port)
    }

    return received
  }
}

async function loadMiniflare(): Promise<new (options: object) => MiniflareLike> {
  try {
    await waitForLateReplies()

    const { Miniflare } = await import('miniflare')

    return Miniflare
  } catch (cause) {
    throw new Error('testD1 runs D1 in Miniflare, in process: add it to the devDependencies, `bun add -d miniflare`.', { cause })
  }
}

/**
 * Fresh, migrated Cloudflare D1 databases for tests, on Miniflare's real D1
 * in process. Starting Miniflare takes a moment, so one holds many databases,
 * and another starts when they run out. Stop them once, after every test file,
 * from a file `bunfig.toml`'s `[test] preload` names: a Miniflare left running
 * keeps its `workerd` process alive after `bun test` exits. In a `fuzz`
 * property that takes a database per case, each Miniflare stops once it has
 * handed out all its databases and their cases have ended, so a run holds one
 * at a time; the last stops at `dispose()`. The first database removes what a
 * killed run left.
 *
 * @example
 * // src/test-support.ts
 * export const databases = testD1({ migrations: './drizzle' })
 * export const freshEnv = async () => testEnv({ ...testBindings, DB: await databases.fresh() })
 *
 * // test/preload.ts
 * afterAll(() => databases.dispose())
 */
export function testD1(options: TestD1Options): TestD1 {
  const names = Array.from({ length: options.perMiniflare ?? 64 }, (_, index) => `TEST_D1_${index}`)
  // What the pool holds: each Miniflare it started and has not stopped, each
  // stop under way, and each fresh() under way, all of which dispose() waits
  // for, so nothing the pool started outlives it.
  const started = new Set<StartedMiniflare>()
  const stopping = new Set<Promise<void>>()
  const starting = new Set<Promise<unknown>>()
  let current: StartedMiniflare | undefined
  let disposing: Promise<void> | undefined
  // Read once, and again after a dispose() or a failure: a memo that failed is not kept.
  let miniflare: Promise<new (options: object) => MiniflareLike> | undefined
  let statements: Promise<ReadonlyArray<string>> | undefined
  let directory: Promise<string> | undefined
  const kept = <A>(memo: Promise<A>, forget: () => void): Promise<A> => {
    memo.catch(forget)

    return memo
  }

  /** Stop a Miniflare, which dispose() waits for until it has. */
  const stop = (running: StartedMiniflare): Promise<void> => {
    started.delete(running)

    const stopped = running.miniflare.dispose()
    const tracked = stopped.finally(() => {
      stopping.delete(tracked)
    })

    stopping.add(tracked)

    return tracked
  }

  /** One of a Miniflare's databases is finished with: stop it once they all are, unless `dispose()` already has. */
  const finish = async (running: StartedMiniflare): Promise<void> => {
    running.finished += 1

    if (running.finished === names.length && started.has(running)) await stop(running)
  }

  const open = async (): Promise<RegisteredD1> => {
    const Miniflare = await (miniflare ??= kept(loadMiniflare(), () => {
      miniflare = undefined
    }))
    const files = await (directory ??= kept(poolDirectory(), () => {
      directory = undefined
    }))

    // From here to the next await nothing else runs, so each call takes its own database.
    if (current === undefined || current.next >= names.length) {
      current = {
        miniflare: constructIn(files, () => new Miniflare({ modules: true, script: 'export default {}', d1Databases: names })),
        next: 0,
        finished: 0,
      }
      started.add(current)
    }

    const running = current
    const name = names[running.next] ?? names[0] ?? 'TEST_D1_0'
    running.next += 1

    whenTestCaseEnds(() => finish(running))

    const database = await running.miniflare.getD1Database(name)
    const migrations = await (statements ??= kept(readMigrations(options.migrations), () => {
      statements = undefined
    }))

    if (migrations.length > 0) await database.batch(migrations.map((sql) => database.prepare(sql)))

    // SAFETY: Miniflare's D1 is Cloudflare's, which the application's D1 binding declares.
    return database as RegisteredD1
  }

  return {
    fresh() {
      // One asked for while the pool stops starts once it has stopped.
      const opening = (disposing ?? Promise.resolve()).then(open)
      const tracked = opening.then(() => undefined, () => undefined).then(() => {
        starting.delete(tracked)
      })

      starting.add(tracked)

      return opening
    },
    dispose() {
      // oxlint-disable-next-line effecttsgo/async-function -- The pool stops Miniflare and removes files, outside any Effect, for a test's afterAll.
      disposing ??= (async () => {
        // What fresh() is starting finishes first, so this stops it too.
        await Promise.all(starting)

        const files = directory

        current = undefined
        directory = undefined
        statements = undefined
        await Promise.all([...started].map(stop))

        while (stopping.size > 0) await Promise.allSettled(stopping)

        const path = await files?.catch(() => undefined)

        if (path !== undefined) await removePoolDirectory(path)
      })().finally(() => {
        disposing = undefined
      })

      return disposing
    },
  }
}

/** Whether the default test session fits the application's AuthUser session. */
type DefaultSessionFits = DefaultAuthUser['session'] extends AuthUser['session'] ? true : false

/** The values `signedIn` gives user fields that the input leaves out. */
interface UserDefaults {
  readonly email: string
  readonly name: string
  readonly emailVerified: false
  readonly image: null
  readonly createdAt: Date
  readonly updatedAt: Date
}

type User = AuthUser['user']

/** User fields whose default value fits the application's user type. */
type DefaultedField = {
  [K in keyof User]: K extends keyof UserDefaults
    ? UserDefaults[K] extends User[K] ? K : never
    : never
}[keyof User]

/**
 * A complete `AuthUser`, or the user fields to set on a default test user:
 * `id` and every field without a fitting default, such as the required fields
 * an application adds in setupWeb's `auth.session`. The default session
 * follows Better Auth's; when the application's session does not fit it, pass
 * a complete `AuthUser`.
 */
export type SignedInUser =
  | AuthUser
  | (DefaultSessionFits extends true
      ? Partial<Pick<User, DefaultedField>> & Omit<User, DefaultedField | 'id'> & { readonly id: string }
      : never)

/**
 * A layer that signs the request in as `user`.
 *
 * Unspecified user fields get fixed defaults, and the session expires an hour
 * after the current Effect clock time. It gives only the signed-in user: an
 * action is tested through its route, with the layer in `testEnv`.
 *
 * @example
 * await app.request('/dashboard', {}, testEnv(signedIn({ id: 'user-1', name: 'Ada' }), testBindings))
 * const auth = yield* authorize().pipe(Effect.provide(signedIn({ id: 'user-1' })))
 */
export function signedIn(user: SignedInUser): Layer.Layer<AuthUserService> {
  return Layer.effect(
    AuthUserService,
    Effect.map(DateTime.now, (now) =>
      toAuthUser(user, DateTime.toDateUtc(DateTime.add(now, { hours: 1 })))
    )
  )
}

function toAuthUser(input: SignedInUser, expiresAt: Date): AuthUser {
  if ('session' in input && 'user' in input) return input

  // The user fields given; `never` when the application's session rules out
  // partial input (see SignedInUser).
  const fields: Partial<User> & { readonly id: string } = input

  const defaults: UserDefaults = {
    email: 'test@example.com',
    name: 'Test User',
    emailVerified: false,
    image: null,
    // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture for the Better Auth user contract; it does not read the clock.
    createdAt: new Date(0),
    // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture for the Better Auth user contract; it does not read the clock.
    updatedAt: new Date(0),
  }
  const user = { ...defaults, ...fields }

  const session = {
    id: 'test-session',
    userId: user.id,
    expiresAt,
    token: Redacted.make('test-token'),
    // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture for the Better Auth session contract; it does not read the clock.
    createdAt: new Date(0),
    // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture for the Better Auth session contract; it does not read the clock.
    updatedAt: new Date(0),
  }

  return {
    // SAFETY: SignedInUser requires every user field except those whose
    // UserDefaults value fits the application's user type.
    user: user as User,
    // SAFETY: SignedInUser admits partial input only when DefaultSessionFits,
    // i.e. when this Better Auth-shaped session is an AuthUser['session'].
    session: session as unknown as AuthUser['session'],
  }
}

/** The error page an Inertia request rendered, as a test reads it. */
export interface TestErrorPage {
  readonly component: string
  readonly props: Omit<PagePropsFor<ErrorPageProps>, 'errors'> & { readonly errors: TestFieldErrors }
}

/**
 * Read the error page an Inertia request rendered, typed as the error page
 * component receives it. Rejects when the response is not the error page.
 *
 * @example
 * const page = await readErrorPage(await app.request('/book/ada?tz=Mars/Olympus', { headers: { 'X-Inertia': 'true' } }))
 * expect(page.props.errors.tz).toBe('Unknown time zone')
 */
/** Why a response is not an Inertia page, as a test that expected one needs to know. */
function notAPage(response: Response): string {
  if (response.status === 409 && response.headers.has('X-Inertia-Location')) {
    return "Inertia answered 409 because the request's X-Inertia-Version is not the app's version: send setupWeb's version, or no X-Inertia-Version."
  }

  return 'Request pages with the X-Inertia: true header.'
}

export async function readErrorPage(response: Response): Promise<TestErrorPage> {
  if (response.headers.get('X-Inertia') !== 'true') {
    throw new Error(`Expected the error page, but the response is ${response.status}. ${notAPage(response)}`)
  }

  const page: unknown = await response.json()
  const props: unknown = page instanceof Object ? Reflect.get(page, 'props') : undefined

  if (!(props instanceof Object) || typeof Reflect.get(props, 'status') !== 'number') {
    const rendered: unknown = page instanceof Object ? Reflect.get(page, 'component') : undefined
    throw new Error(`Expected the error page, but the response rendered '${String(rendered)}' (${response.status}).`)
  }

  // SAFETY: the boundary renders the error page with ErrorPageProps, the
  // shared props and errors; the status it carries identifies it.
  return page as TestErrorPage
}

/**
 * Read the error a JSON client received: the envelope every failure answers
 * with, typed. Rejects when the response is a success or not that envelope.
 *
 * @example
 * const res = await app.request('/api/check-in', { method: 'POST', headers: { Accept: 'application/json' } }, env)
 * const error = await readError(res)
 * expect(error.errors).toEqual({ code: 'This field is required' })
 */
export async function readError(response: Response): Promise<TestErrorResponse>
export async function readError<A, I>(
  response: Response,
  body: S.Codec<A, I, never, never>
): Promise<TestErrorResponse & { readonly body: A }>
export async function readError(
  response: Response,
  body?: S.Codec<unknown, unknown, never, never>
): Promise<TestErrorResponse> {
  const contentType = response.headers.get('Content-Type') ?? ''

  if (response.status < 400 || !contentType.includes('application/json')) {
    throw new Error(
      `Expected a JSON error, but the response is ${response.status} ${contentType}. ` +
        'A request that asks for no HTML, or sends Accept: application/json, gets the JSON envelope.'
    )
  }

  const json: unknown = await response.json()

  const envelope = await Effect.runPromise(
    S.decodeUnknownEffect(body === undefined ? ErrorResponse : errorResponseWith(body))(json).pipe(
      Effect.mapError((issue) => new Error(`The JSON error (${response.status}) does not match the envelope: ${issue.message}`))
    )
  )

  return { ...envelope, errors: envelope.errors ?? {} }
}

/**
 * The value a response set for a declared cookie: none when it set none or
 * cleared it, or the value decoded through the cookie's schema.
 *
 * @example
 * const cart = await readCookie(res, cartCookie)
 * expect(Option.getOrNull(cart)).toEqual({ id: 'cart-1' })
 */
export function readCookie<A>(response: Response, declared: Cookie<A>): Option.Option<A> {
  const prefix = `${declared.name}=`
  const written = response.headers.getSetCookie().filter((header) => header.startsWith(prefix)).pop()

  if (written === undefined || /;\s*Max-Age=0\b/i.test(written)) return Option.none()

  return declared.parse(decodeURIComponent(written.slice(prefix.length).split(';', 1)[0]))
}

/** The JSON error a test reads: the envelope, with `errors` empty when no field failed. */
export type TestErrorResponse = ErrorResponseBody & { readonly errors: Readonly<Record<string, string>> }

/**
 * Read a JSON response through the schema the action answered with
 * (`json(Schema, value)`), decoded from its JSON form. Rejects when the
 * response is not JSON or does not match the schema.
 *
 * @example
 * const flags = await readJson(res, FlagsResponse)
 * expect(flags.flags[0].enabled).toBe(true)
 */
export async function readJson<A, I>(response: Response, schema: S.Codec<A, I, never, never>): Promise<A> {
  const contentType = response.headers.get('Content-Type') ?? ''

  if (!contentType.includes('application/json')) {
    throw new Error(`Expected JSON, but the response is ${response.status} ${contentType}.`)
  }

  const body: unknown = await response.json()

  return Effect.runPromise(
    S.decodeUnknownEffect(S.toCodecJson(schema))(body).pipe(
      Effect.mapError((issue) => new Error(`The JSON response (${response.status}) does not match its schema: ${issue.message}`))
    )
  )
}

/** An application a test sends requests to: the Hono app setupWeb configured. */
export interface TestApp {
  request(input: string, init?: RequestInit, env?: TestBindings): Response | Promise<Response>
}

/**
 * A browser for a test: it keeps the cookies responses set, drops the ones
 * they clear, and sends each to the paths it covers, so a session, a cart
 * cookie and flash carry across requests as they do for a visitor. Each
 * browser sends its own client address (`CF-Connecting-IP` and
 * `X-Forwarded-For`), so rate limits per client, such as Better Auth's on
 * signing in, count each browser apart.
 *
 * @example
 * const browser = testBrowser(app, testEnv(layer, testBindings))
 * await browser.request('/r/acme/cart', { method: 'POST', body })
 * const cart = await readPage(await browser.request('/r/acme/cart', { headers: { 'X-Inertia': 'true' } }), 'Cart/Show')
 */
export interface TestBrowser {
  /** Request a path, sending the cookies the browser holds for it, and keep the ones the response sets. */
  request(path: string, init?: RequestInit): Promise<Response>
  /**
   * Follow a redirect as the browser would after a form: request its
   * `Location` as an Inertia visit with the browser's cookies, and the ones
   * the redirect set, so the next page receives its `flash` values and a
   * failed form's `errors`. The redirect may be one the browser received, or
   * one a test requested another way, such as with `app.request`.
   */
  follow(response: Response, init?: RequestInit): Promise<Response>
  /**
   * Send a `Request` as the browser would, with its cookies: so the browser
   * is the `fetch` that `call(endpoint, input, browser)` sends with.
   */
  fetch(request: Request): Promise<Response>
  /** The cookies the browser holds, by name. */
  readonly cookies: ReadonlyMap<string, string>
  /** Give the browser a cookie, as another browser's or one a test makes up. */
  setCookie(name: string, value: string, path?: string): void
  /** Drop the cookie of this name at this path, as the browser does once it expires. */
  clearCookie(name: string, path?: string): void
}

/** How many browsers tests have made, each a client at its own address. */
let browsers = 0

export function testBrowser(app: TestApp, env?: TestBindings): TestBrowser {
  // The browser's cookies, as RFC 6265 keeps them, and when it reads them: a
  // browser expires cookies by its wall clock, outside Effect's clock.
  let jar: CookieJar = []
  // oxlint-disable-next-line effecttsgo/global-date -- A browser expires cookies by its wall clock, outside Effect's clock.
  const now = () => Date.now()
  // Each browser is its own client, at its own address, as Cloudflare and
  // a proxy report it, so per-client rate limits treat browsers apart.
  browsers += 1
  const address = `198.18.${Math.floor(browsers / 250) % 250}.${(browsers % 250) + 1}`

  /** Keep the cookies a response to a request at `url` set. */
  const keep = (response: Response, url: URL): Response => {
    jar = receive(jar, response.headers.getSetCookie(), url.pathname, now())

    return response
  }

  // The page the browser shows, which a form posted from it names as its Referer.
  let page: string | undefined
  // The requests that answered with the responses this browser received:
  // a 307 or 308 repeats one, and a relative Location resolves against it.
  const requests = new WeakMap<Response, { readonly url: URL; readonly init: RequestInit }>()

  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    const url = new URL(path, 'http://localhost')
    const cookies = sent(jar, url.pathname, now()).map((cookie) => `${cookie.name}=${cookie.value}`)
    const given = headers.get('Cookie')
    const method = (init.method ?? 'GET').toUpperCase()

    if (cookies.length > 0) headers.set('Cookie', [given, ...cookies].filter(Boolean).join('; '))
    if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', address)
    if (!headers.has('X-Forwarded-For')) headers.set('X-Forwarded-For', address)
    if (page !== undefined && !headers.has('Referer')) headers.set('Referer', page)
    // A browser names the page's origin on every request that may change
    // something, a same-origin form's included.
    if (!['GET', 'HEAD'].includes(method) && !headers.has('Origin')) headers.set('Origin', new URL(page ?? url.href).origin)

    const response = keep(await app.request(path, { ...init, headers }, env), url)
    requests.set(response, { url, init })

    if (method === 'GET' && response.status < 300) page = url.href

    return response
  }

  return {
    request,
    fetch: async (sent) => {
      const url = new URL(sent.url)
      const method = sent.method.toUpperCase()
      const body = method === 'GET' || method === 'HEAD' ? undefined : await sent.text()

      return request(`${url.pathname}${url.search}`, { method, headers: sent.headers, body })
    },
    follow: async (response, init = {}) => {
      const location = response.headers.get('Location')

      if (location === null || response.status < 300 || response.status >= 400) {
        throw new Error(`Expected a redirect, but the response is ${response.status} without a Location.`)
      }

      const origin = requests.get(response)
      const from = origin?.url ?? new URL(page ?? '/', 'http://localhost')

      // A redirect requested another way hands its cookies to this browser first.
      if (origin === undefined) keep(response, from)

      // A 307 or 308 repeats the request, its method and body; any other
      // redirect is followed with a GET.
      const repeats = response.status === 307 || response.status === 308

      if (repeats && origin === undefined && init.method === undefined) {
        throw new Error(`A ${response.status} repeats the request it answers, which this browser did not send: pass its method and body to follow.`)
      }

      const repeated: RequestInit = repeats && origin !== undefined ? origin.init : {}
      const headers = new Headers(init.headers ?? repeated.headers)
      if (!headers.has('X-Inertia')) headers.set('X-Inertia', 'true')

      // A relative Location resolves against the URL it answered, as a browser's does.
      const target = new URL(location, from)

      return request(`${target.pathname}${target.search}`, { ...repeated, ...init, headers })
    },
    // The cookies it holds that have not expired, by name.
    get cookies() {
      return new Map(held(jar, now()).map((cookie) => [cookie.name, cookie.value]))
    },
    setCookie: (name, value, path = '/') => {
      jar = receive(jar, [`${name}=${value}; Path=${path}`], path, now())
    },
    clearCookie: (name, path = '/') => {
      jar = receive(jar, [`${name}=; Path=${path}; Max-Age=0`], path, now())
    },
  }
}

/**
 * A page's field errors as a test reads them: a field's message, or an error
 * bag's messages by field, so `expect(page.props.errors.name).toBe('...')`
 * type-checks.
 */
export type TestFieldErrors = Readonly<Record<string, string | Readonly<Record<string, string>>>>

/** A page an Inertia request rendered, as a test reads it. */
export interface TestPage<Component extends string> {
  readonly component: Component
  /** The page's props as the browser receives them, with shared props and `errors`. */
  readonly props: Omit<PagePropsFor<Component>, 'errors'> & { readonly errors: TestFieldErrors }
  readonly url: string
  /** The values flashed to this page, as setupWeb's `flash` declares them. */
  readonly flash: FlashData
}

/**
 * Read the page an Inertia request rendered, typed by the page registry.
 * Rejects, failing the test, when the response is not that page.
 *
 * @example
 * const res = await app.request('/projects/p1', { headers: { 'X-Inertia': 'true' } }, testEnv(signedIn({ id: 'user-1' })))
 * const page = await readPage(res, 'Projects/Show')
 * expect(page.props.project.name).toBe('Apollo')
 */
export async function readPage<Component extends PageName>(
  response: Response,
  component: Component
): Promise<TestPage<Component>> {
  if (response.headers.get('X-Inertia') !== 'true') {
    const location = response.headers.get('Location')

    throw new Error(
      `Expected the '${component}' page, but the response is ${response.status}` +
        (location ? ` to ${location}` : ` ${response.headers.get('Content-Type') ?? ''}`) +
        `. ${notAPage(response)}`
    )
  }

  const page: unknown = await response.json()
  const rendered = page instanceof Object ? Object.getOwnPropertyDescriptor(page, 'component')?.value : undefined

  if (rendered !== component) {
    // The error page's props say why, such as a binding a service could not read.
    const props: unknown = page instanceof Object ? Reflect.get(page, 'props') : undefined
    const message: unknown = props instanceof Object ? Reflect.get(props, 'message') : undefined

    throw new Error(
      `Expected the '${component}' page, but the response rendered '${String(rendered)}' (${response.status})` +
        (typeof message === 'string' ? `: ${message}` : '.')
    )
  }

  // SAFETY: the page is the registered component, whose props render encoded
  // through its schema, which PagePropsFor mirrors.
  return page as TestPage<Component>
}

/** The real time `settle` waits with no sleep starting or ending before it moves the clock. */
const SETTLE_QUIET_MILLIS = 50

/** One clock a test moves, which every request the test makes reads. */
export interface TestTime {
  /** The clock, for `testEnv`: `testEnv(Layer.merge(signedIn(user), time.layer))`. */
  readonly layer: Layer.Layer<never>
  /** The clock's current time. */
  now(): Date
  /** Move the clock to a time. */
  set(time: Date | number): Promise<void>
  /** Move the clock forward, as `advance('7 days')` or `advance(Duration.hours(2))`. */
  advance(duration: Duration.Input): Promise<void>
  /**
   * Run `work` that waits on the clock, such as a request whose retries wait
   * on `Schedule.exponential`, to the end: each time it waits, move the clock
   * to the end of the earliest pending sleep, so the waits take exactly their
   * durations. Work is taken to wait on the clock once no sleep has started or
   * ended for 50 milliseconds, so a read that takes less finishes before the
   * clock moves; a slower one sees it move. Two settles at once move it once.
   * Rejects after `maxTurns` turns of the event loop without settling
   * (default 10,000).
   */
  settle<A>(work: A | PromiseLike<A>, maxTurns?: number): Promise<A>
}

/**
 * A clock for testing time-dependent rules, such as an invitation that
 * expires: requests given its layer read `Clock` (and `DateTime.now`) from
 * it, and the test moves it between requests. It starts at `start`, by
 * default 2026-01-01T00:00:00Z. An `Effect.sleep` in a request waits until
 * the test advances the clock past it. Bun shares a module created at the top
 * of a support file between test files: set the clock back in `beforeEach`.
 *
 * @example
 * const time = await testClock(new Date('2026-03-01T09:00:00Z'))
 * const env = testEnv(Layer.merge(signedIn({ id: 'user-1' }), time.layer))
 *
 * await time.advance('8 days')
 * const res = await app.request('/invites/abc', {}, env)
 */
export async function testClock(start: Date | number = Date.UTC(2026, 0, 1)): Promise<TestTime> {
  // The clock lives as long as the test process: tests share it across requests.
  const scope = Effect.runSync(Scope.make())
  const clock = await Effect.runPromise(TestClock.make().pipe(Scope.provide(scope)))
  const set = (time: Date | number) =>
    Effect.runPromise(clock.setTime(time instanceof Date ? time.getTime() : time))

  // When each pending sleep ends, so settle can move the clock to the next,
  // and a count of the sleeps that started or ended and of the clock's moves,
  // which settle watches for the work to go quiet.
  const wakeTimes: number[] = []
  let activity = 0
  const tracked: Clock.Clock = {
    ...clock,
    sleep: (duration) => Effect.suspend(() => {
      const wake = clock.currentTimeMillisUnsafe() + Duration.toMillis(duration)
      wakeTimes.push(wake)
      activity += 1

      return clock.sleep(duration).pipe(
        Effect.ensuring(Effect.sync(() => {
          wakeTimes.splice(wakeTimes.indexOf(wake), 1)
          activity += 1
        }))
      )
    }),
  }

  await set(start)

  return {
    layer: Layer.succeed(Clock.Clock, tracked),
    now: () => new Date(clock.currentTimeMillisUnsafe()),
    set,
    advance: (duration) => Effect.runPromise(clock.adjust(duration)),
    // A turn of the event loop at a time, and once no sleep on the clock has
    // started or ended for SETTLE_QUIET_MILLIS, the earliest sleep ends. Two settles at once each see the other's moves
    // as activity, so the clock moves once for both.
    // oxlint-disable-next-line effecttsgo/async-function -- settle drives the clock from outside Effect, between turns of the event loop that the work's promises run in.
    settle: async (work, maxTurns = 10_000) => {
      let settled = false
      const observed = Promise.resolve(work).then(
        (value) => {
          settled = true

          return value
        },
        (error: unknown) => {
          settled = true

          throw error
        }
      )
      // A rejection is the caller's, through the promise returned below; until
      // then it waits with a handler, or the runtime reports it unhandled.
      observed.catch(() => undefined)
      // oxlint-disable-next-line effecttsgo/global-date -- How long the work has been quiet is real time, which a read waits through.
      let quiet = { activity, at: Date.now() }

      for (let turns = 0; !settled; turns += 1) {
        if (turns >= maxTurns) {
          // The timeout is the failure this test reports; a later rejection of
          // the abandoned work, already handled above, is not.
          throw new Error(`The work did not settle within ${maxTurns} turns of the event loop.`)
        }

        await new Promise((resolve) => setTimeout(resolve, 0))

        // oxlint-disable-next-line effecttsgo/global-date -- As above.
        if (activity !== quiet.activity) quiet = { activity, at: Date.now() }

        // oxlint-disable-next-line effecttsgo/global-date -- As above.
        if (settled || Date.now() - quiet.at < SETTLE_QUIET_MILLIS) continue

        const next = Math.min(...wakeTimes)

        if (Number.isFinite(next)) {
          await Effect.runPromise(clock.setTime(Math.max(next, clock.currentTimeMillisUnsafe())))
          activity += 1
        }
      }

      return observed
    },
  }
}

/** A queue message a test sends, recording whether the handler acknowledged it or left it to retry. */
export interface TestQueueMessage {
  readonly id: string
  readonly body: unknown
  readonly attempts: number
  readonly outcome: 'pending' | 'acked' | 'retried'
  ack(): void
  retry(): void
}

/** A queue batch a test hands to `routes.queue(...)`'s handler. */
export interface TestQueueBatch {
  readonly messages: ReadonlyArray<TestQueueMessage>
  /** The bodies of the messages the handler acknowledged. */
  acked(): ReadonlyArray<unknown>
  /** The bodies of the messages the handler left for the queue to retry. */
  retried(): ReadonlyArray<unknown>
}

/**
 * A queue batch of these bodies, as the platform delivers one to the Worker's
 * `queue` handler, recording each message's outcome.
 *
 * @example
 * const batch = testBatch([{ orderId: 'order-1' }, { orderId: 42 }])
 * await worker.queue(batch, testEnv(fakeMailer, testBindings))
 * expect(batch.acked()).toEqual([{ orderId: 'order-1' }])
 * expect(batch.retried()).toEqual([{ orderId: 42 }])
 */
export function testBatch(bodies: ReadonlyArray<unknown>, options: { readonly attempts?: number } = {}): TestQueueBatch {
  const messages = bodies.map((body, index): TestQueueMessage => {
    let outcome: TestQueueMessage['outcome'] = 'pending'

    return {
      id: `message-${index + 1}`,
      body,
      attempts: options.attempts ?? 1,
      get outcome() {
        return outcome
      },
      ack: () => {
        outcome = 'acked'
      },
      retry: () => {
        outcome = 'retried'
      },
    }
  })

  return {
    messages,
    acked: () => messages.filter((message) => message.outcome === 'acked').map((message) => message.body),
    retried: () => messages.filter((message) => message.outcome === 'retried').map((message) => message.body),
  }
}

/**
 * A Cloudflare Workers Rate Limiting binding for tests, as `wrangler.jsonc`'s
 * `"simple": { "limit", "period" }` declares one: each key may make `limit`
 * calls per `period` seconds. Give it in the test's bindings under the
 * binding's name. Like the real binding it is a class instance, which the
 * page cache tracks: a call to it keeps a page out of the cache here as it
 * does in production.
 *
 * @example
 * const env = testEnv({ ...testBindings, SIGN_IN_LIMITER: testRateLimiter({ limit: 5 }) }, { database })
 */
export class TestRateLimiter {
  /** The keys of the calls it refused, in order. */
  readonly refused: string[] = []
  readonly #max: number
  readonly #periodMillis: number
  readonly #windows = new Map<string, { start: number; count: number }>()

  constructor(options: { readonly limit?: number; readonly period?: number } = {}) {
    this.#max = options.limit ?? 5
    this.#periodMillis = (options.period ?? 60) * 1000
  }

  async limit({ key }: { readonly key: string }): Promise<{ readonly success: boolean }> {
    // oxlint-disable-next-line effecttsgo/global-date -- Cloudflare's binding counts in wall-clock periods, outside Effect's clock.
    const now = Date.now()
    const window = this.#windows.get(key)
    const current = window === undefined || now - window.start >= this.#periodMillis ? { start: now, count: 0 } : window

    current.count += 1
    this.#windows.set(key, current)

    if (current.count > this.#max) this.refused.push(key)

    return { success: current.count <= this.#max }
  }
}

/** A Cloudflare Workers Rate Limiting binding for tests: see {@link TestRateLimiter}. */
export function testRateLimiter(options: { readonly limit?: number; readonly period?: number } = {}): TestRateLimiter {
  return new TestRateLimiter(options)
}

/** A message a test queue was sent: its body, as a consumer receives it, and how long it is held back. */
export interface SentQueueMessage {
  readonly body: unknown
  readonly delaySeconds: number | undefined
}

/** What a send answers, as Cloudflare's binding does: the queue's backlog, which a test queue keeps none of. */
const SENT = { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }

/**
 * A Cloudflare Queues producer binding for tests: it keeps each message it
 * is sent, its body through JSON as a JSON message travels, for `testBatch`
 * to hand the Worker's `queue` handler. Give it in the test's bindings under
 * the binding's name; `fail()` makes the sends after it reject, as a queue
 * that is unavailable does.
 *
 * @example
 * const queue = testQueue()
 * await app.request('/orders', post, testEnv(signedIn(ada), { ...testBindings, REMINDERS: queue }))
 * await worker.queue(testBatch(queue.sent()), testEnv(fakeMailer, testBindings))
 */
export class TestQueue {
  readonly #messages: SentQueueMessage[] = []
  #failure: unknown = undefined

  async send(body: unknown, options: { readonly contentType?: string; readonly delaySeconds?: number } = {}): Promise<typeof SENT> {
    this.#keep([{ body, delaySeconds: options.delaySeconds }])

    return SENT
  }

  async sendBatch(
    messages: Iterable<{ readonly body: unknown; readonly contentType?: string; readonly delaySeconds?: number }>,
    options: { readonly delaySeconds?: number } = {}
  ): Promise<typeof SENT> {
    this.#keep([...messages].map((message) => ({ body: message.body, delaySeconds: message.delaySeconds ?? options.delaySeconds })))

    return SENT
  }

  async metrics(): Promise<{ readonly backlogCount: number; readonly backlogBytes: number }> {
    return { backlogCount: this.#messages.length, backlogBytes: 0 }
  }

  /** The bodies it was sent, in order, as `testBatch` takes them. */
  sent(): unknown[] {
    return this.#messages.map((message) => message.body)
  }

  /** The messages it was sent, with how long each is held back. */
  messages(): ReadonlyArray<SentQueueMessage> {
    return [...this.#messages]
  }

  /** Reject every later send with `error`, as a queue that is unavailable does. */
  fail(error: unknown = new Error('The queue is unavailable.')): void {
    this.#failure = error
  }

  #keep(messages: ReadonlyArray<SentQueueMessage>): void {
    if (this.#failure !== undefined) throw this.#failure

    for (const message of messages) {
      this.#messages.push({ body: JSON.parse(JSON.stringify(message.body)) as unknown, delaySeconds: message.delaySeconds })
    }
  }
}

/** A Cloudflare Queues producer binding for tests: see {@link TestQueue}. */
export function testQueue(): TestQueue {
  return new TestQueue()
}
