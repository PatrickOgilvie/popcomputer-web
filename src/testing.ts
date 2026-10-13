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
import { Clock, DateTime, Effect, Layer, Redacted, Scope, type Duration } from 'effect'
import { TestClock } from 'effect/testing'
import { AuthUserService, type AuthUser, type DatabaseType, type DefaultAuthUser } from './effect/services.js'
import type { Registered } from './effect/register.js'
import { attachTestDatabase, attachTestLayer } from './effect/test-env.js'
import type { PageName } from './effect/pages.js'
import type { FlashData, PagePropsFor } from './react.js'

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
  readonly name: null
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
    name: null,
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

/** A page an Inertia request rendered, as a test reads it. */
export interface TestPage<Component extends string> {
  readonly component: Component
  /** The page's props as the browser receives them, with shared props and `errors`. */
  readonly props: PagePropsFor<Component>
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
        '. Request pages with the X-Inertia: true header.'
    )
  }

  const page: unknown = await response.json()
  const rendered = page instanceof Object ? Object.getOwnPropertyDescriptor(page, 'component')?.value : undefined

  if (rendered !== component) {
    throw new Error(`Expected the '${component}' page, but the response rendered '${String(rendered)}' (${response.status}).`)
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
}

/**
 * A clock for testing time-dependent rules, such as an invitation that
 * expires: requests given its layer read `Clock` (and `DateTime.now`) from
 * it, and the test moves it between requests. It starts at `start`, by
 * default 2026-01-01T00:00:00Z. An `Effect.sleep` in a request waits until
 * the test advances the clock past it.
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

  await set(start)

  return {
    layer: Layer.succeed(Clock.Clock, clock),
    now: () => new Date(clock.currentTimeMillisUnsafe()),
    set,
    advance: (duration) => Effect.runPromise(clock.adjust(duration)),
  }
}
