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
import { DateTime, Effect, Layer, Redacted } from 'effect'
import { AuthUserService, type AuthUser, type DefaultAuthUser, type WebBindingsType } from './effect/services.js'
import { attachTestLayer } from './effect/test-env.js'

/**
 * The bindings a test passes to `testEnv`: any of the application's bindings
 * (WebBindingsType), each with its declared type, once it declares them.
 */
export type TestBindings = WebBindingsType extends { type: infer Bindings } ? Partial<Bindings> : object

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
export function testEnv<ROut>(layer: Layer.Layer<ROut>, bindings: TestBindings = {}): TestBindings {
  const env = { ...bindings }
  attachTestLayer(env, layer)

  return env
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
 * an application adds by augmenting WebAuthUserType. The default session
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
