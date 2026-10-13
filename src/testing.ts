/**
 * Test seams for applications built on @popcomputer/web.
 *
 * Route tests call the application's real routes with `app.request` and pass
 * `testEnv(layer)` as the request env, so the layer's services replace or add
 * to what the request runtime provides. Action tests run the action Effect
 * directly and provide the same layers with `Effect.provide`.
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
import type { PageName } from './effect/pages.js'
import type { ErrorPageProps, FlashData, PagePropsFor } from './react.js'
import { ErrorResponse, errorResponseWith, type ErrorResponseBody } from './effect/error-response.js'

type RegisteredBindings = Registered<'bindings', never>

/**
 * The bindings a test passes to `testEnv`: any of the application's
 * registered bindings, each with its declared type.
 */
export type TestBindings = [RegisteredBindings] extends [never] ? object : Partial<RegisteredBindings>

/**
 * Build a request env that adds `layer` to the request's Effect runtime.
 *
 * Services in `layer` replace the ones effectBridge provides for the request,
 * such as `AuthUserService` and `DatabaseService`, and supply services the
 * application provides through `setupWeb`'s `services`. A layer that a
 * route registers with `.provide()` still takes precedence for that route.
 *
 * @param bindings - Bindings the request reads from `c.env` and Effect `Config`.
 */
export function testEnv<ROut>(
  layer: Layer.Layer<ROut>,
  bindings: TestBindings = {},
  options: TestEnvOptions = {}
): TestBindings {
  const env = { ...bindings }
  attachTestLayer(env, layer)

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
  const { readdir, readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const files = (await readdir(folder)).filter((name) => name.endsWith('.sql')).sort()

  for (const file of files) {
    const statements = (await readFile(join(folder, file), 'utf8')).split('--> statement-breakpoint')

    for (const statement of statements) {
      if (statement.trim()) await run(statement)
    }
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
 * after the current Effect clock time.
 *
 * @example
 * yield* showDashboard.pipe(Effect.provide(signedIn({ id: 'user-1', name: 'Ada' })))
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
 * Follow a redirect as the browser would after a form: request its
 * `Location` as an Inertia visit, sending the cookies the response set. The
 * next page then receives what the redirect carried, such as `flash` values
 * and a failed form's `errors`.
 *
 * @example
 * const res = await app.request('/projects', { method: 'POST', body, headers: { Referer: 'http://localhost/projects/new' } }, env)
 * const form = await readPage(await followRedirect(app, res, env), 'Projects/New')
 * expect(form.props.errors.name).toBe('This field is required')
 */
export async function followRedirect(
  app: TestApp,
  response: Response,
  env?: TestBindings,
  init: RequestInit = {}
): Promise<Response> {
  const location = response.headers.get('Location')

  if (location === null || response.status < 300 || response.status >= 400) {
    throw new Error(`Expected a redirect, but the response is ${response.status} without a Location.`)
  }

  const headers = new Headers(init.headers)
  const cookies = [
    ...(headers.get('Cookie')?.split(';').map((cookie) => cookie.trim()).filter(Boolean) ?? []),
    ...setCookies(response),
  ]

  if (!headers.has('X-Inertia')) headers.set('X-Inertia', 'true')
  if (cookies.length > 0) headers.set('Cookie', cookies.join('; '))

  return app.request(location, { ...init, headers }, env)
}

/** The `name=value` pairs a response's cookies set, without the ones it clears. */
function setCookies(response: Response): readonly string[] {
  return response.headers
    .getSetCookie()
    .filter((cookie) => !/;\s*max-age=0\b/i.test(cookie))
    .map((cookie) => cookie.split(';', 1)[0].trim())
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
   * durations. Rejects after `maxTurns` turns of the event loop without
   * settling (default 10,000).
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

  // When each pending sleep ends, so settle can move the clock to the next.
  const wakeTimes: number[] = []
  const tracked: Clock.Clock = {
    ...clock,
    sleep: (duration) => Effect.suspend(() => {
      const wake = clock.currentTimeMillisUnsafe() + Duration.toMillis(duration)
      wakeTimes.push(wake)

      return clock.sleep(duration).pipe(
        Effect.ensuring(Effect.sync(() => {
          wakeTimes.splice(wakeTimes.indexOf(wake), 1)
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

      for (let turns = 0; !settled; turns += 1) {
        if (turns >= maxTurns) {
          // The timeout is the failure this test reports; a later rejection of
          // the abandoned work is not.
          observed.catch(() => undefined)

          throw new Error(`The work did not settle within ${maxTurns} turns of the event loop.`)
        }

        // Let the work run until it waits, then end the earliest sleep. Work
        // waiting on anything else, such as a database, gets another turn.
        await new Promise((resolve) => setTimeout(resolve, 0))

        const next = Math.min(...wakeTimes)

        if (!settled && Number.isFinite(next)) {
          await Effect.runPromise(clock.setTime(Math.max(next, clock.currentTimeMillisUnsafe())))
        }
      }

      return observed
    },
  }
}
