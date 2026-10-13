/**
 * Effect Auth Layers and Helpers
 *
 * Authentication and authorization via Effect Layers.
 */

import { Cause, Effect, Exit, Layer, Option, Schema as S } from 'effect'
import type { MiddlewareHandler, Env } from 'hono'
import { AuthUserService, AuthService, PageService, RequestService, type AuthType, type AuthUser, type SessionParserOption, type WebAuthUserType } from './services.js'
import {
  InvalidAuthSession,
  HttpError,
  SessionLookupUnavailable,
  UnauthorizedError,
} from './errors.js'
import type { AuthRateLimitError, AuthRedirect, ValidationError } from './errors.js'
import {
  runBetterAuthApiCall,
  toAuthActionError,
  type BetterAuthActionError,
  type BetterAuthActionResult,
} from './better-auth-boundary.js'
import { openWebContext } from '../request-context.js'
import type { PagePropValue, PageProps } from '../types.js'


/**
 * Layer that requires an authenticated user.
 * Fails with UnauthorizedError if no user is present.
 *
 * @example
 * effectRoutes(app)
 *   .provide(RequireAuthLayer)
 *   .get('/dashboard', showDashboard)
 */
export const RequireAuthLayer = Layer.effect(
  AuthUserService,
  Effect.gen(function* () {
    // Try to get existing AuthUserService
    const maybeUser = yield* Effect.serviceOption(AuthUserService)

    if (Option.isNone(maybeUser)) {
      return yield* new UnauthorizedError({ message: 'Authentication required' })
    }

    return maybeUser.value
  })
)

/**
 * Layer that requires no authenticated user (guest only).
 * Fails if a user is present, succeeds (as a no-op) if no user.
 *
 * For more flexibility (e.g., allowing anonymous users), use `createGuestLayer`.
 *
 * @example
 * effectRoutes(app)
 *   .provide(RequireGuestLayer)
 *   .get('/login', showLogin)
 */
export const RequireGuestLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const maybeUser = yield* Effect.serviceOption(AuthUserService)

    if (Option.isSome(maybeUser)) {
      return yield* new UnauthorizedError({
        message: 'Already authenticated',
        redirectTo: '/',
      })
    }

    // Guest confirmed - no user present, succeed silently
  })
)

/**
 * Create a custom guest layer with a predicate to allow certain authenticated users.
 *
 * This is useful when you have "semi-authenticated" users (like Better Auth's anonymous
 * users) who should still be able to access guest pages like login/register to upgrade
 * their accounts.
 *
 * The predicate receives the authenticated user and returns `true` if they should be
 * allowed through (treated as a "guest" for this route), or `false` to block them.
 *
 * @param allowUser - Predicate that returns true if the user should be allowed access.
 *                    Receives the full AuthUser object (user + session).
 * @param redirectTo - Where to redirect blocked users (default: '/')
 *
 * @example
 * // Allow anonymous users to access login/register pages
 * const AllowAnonymousGuestLayer = createGuestLayer(
 *   (authUser) => authUser.user.isAnonymous === true
 * )
 *
 * effectRoutes(app)
 *   .provide(AllowAnonymousGuestLayer)
 *   .get('/login', showLogin)
 *
 * @example
 * // Use with effectAuthRoutes for anonymous user upgrade flow
 * effectAuthRoutes(app, {
 *   guestLayer: createGuestLayer((authUser) => authUser.user.isAnonymous),
 *   loginComponent: 'Auth/Login',
 *   registerComponent: 'Auth/Register',
 * })
 *
 * @example
 * // Custom redirect for blocked users
 * const GuestOrAnonymousLayer = createGuestLayer(
 *   (authUser) => authUser.user.isAnonymous,
 *   '/dashboard'  // Redirect fully authenticated users to dashboard
 * )
 */
export function createGuestLayer(
  allowUser: (authUser: AuthUser) => boolean,
  redirectTo = '/'
): Layer.Layer<never, UnauthorizedError, never> {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const maybeUser = yield* Effect.serviceOption(AuthUserService)

      if (Option.isSome(maybeUser)) {
        const authUser = maybeUser.value

        // Check if this user is allowed through
        if (!allowUser(authUser)) {
          return yield* new UnauthorizedError({
            message: 'Already authenticated',
            redirectTo,
          })
        }
        // User is allowed (e.g., anonymous user) - continue
      }

      // No user or allowed user - succeed silently
    })
  )
}

/**
 * Get the current user if authenticated.
 */
export const currentUser: Effect.Effect<AuthUser | null, never, never> =
  Effect.serviceOption(AuthUserService).pipe(
    Effect.map((option) => (Option.isSome(option) ? option.value : null))
  )

/**
 * How the authenticated user is shaped before being shared with the client.
 *
 * The default public shape contains only `id`, `name`, and `image`. Prefer an
 * explicit `project` function when the client needs a different shape.
 */
export interface ShareAuthUserConfig {
  /** Project the parsed server-side auth session into public page data. */
  readonly project?: (auth: AuthUser) => PagePropValue
  /**
   * Whitelist of user fields to include in the shared `auth.user`.
   * Ignored when `mapUser` is provided.
   *
   * @example { fields: ['id', 'name', 'image'] }
   */
  fields?: string[]
  /**
   * Full control over the shared user shape. Receives the raw user record and
   * returns the value placed at `auth.user`. Overrides `fields`.
   *
   * @example { mapUser: (u) => ({ id: u.id, name: u.name }) }
   */
  mapUser?: (user: AuthUser['user']) => PagePropValue
}

/**
 * Apply the field/map projection to a raw user record.
 */
function projectSharedUser(
  authUser: AuthUser | null | undefined,
  config: ShareAuthUserConfig
): PagePropValue {
  if (!authUser) return null

  if (config.project) return config.project(authUser)

  const user = authUser.user

  if (config.mapUser) return config.mapUser(user)

  if (config.fields) {
    const picked: PageProps = {}

    for (const key of config.fields) {
      if (key in user) {
        picked[key] = JSON.parse(JSON.stringify(
          Object.getOwnPropertyDescriptor(user, key)?.value
        ))
      }
    }

    return picked
  }

  return {
    id: String(user.id),
    name: user.name === undefined || user.name === null ? null : String(user.name),
    image: user.image === undefined || user.image === null
      ? null
      : String(user.image),
  }
}

/**
 * Share auth state with the page renderer.
 *
 * The safe default shares only `id`, `name`, and `image`. Pass `project` when
 * the application needs a different public contract.
 */
export function shareAuth(
  config: ShareAuthUserConfig = {}
): Effect.Effect<void, never, PageService> {
  return Effect.gen(function* () {
    const page = yield* PageService
    const user = yield* currentUser
    page.share('auth', {
      user: projectSharedUser(user, config),
    })
  })
}

/**
 * Middleware version of shareAuth for use with app.use().
 *
 * @example
 * app.use('*', shareAuthMiddleware({
 *   project: ({ user }) => ({ id: user.id, name: user.name }),
 * }))
 */
export function shareAuthMiddleware<E extends Env>(
  config: ShareAuthUserConfig = {}
): MiddlewareHandler<E> {
  // oxlint-disable-next-line effecttsgo/async-function -- Hono middleware and renderer contracts use native next()/Response promises; typed Effect work stays inside that request boundary.
  return async (c, next) => {
    const requestContext = openWebContext(c)
    const page = requestContext.web

    // Read the user when the page renders: a user that testEnv signs in is
    // known only once effectBridge has built the request runtime.
    if (page) {
      page.share('auth', () => ({
        user: projectSharedUser(requestContext.authUser, config),
      }))
    }

    await next()

    // Return response for proper propagation in forwarding/proxy scenarios
    return c.res
  }
}

/**
 * Middleware to load the authenticated user, for applications that compose
 * middleware by hand. setupWeb installs it.
 *
 * Pass `session` once the application augments WebAuthUserType.
 */
export function loadUser<E extends Env>(
  ...[config]: WebAuthUserType extends { type: unknown }
    ? [config: LoadUserConfig]
    : [config?: LoadUserConfig]
): MiddlewareHandler<E> {
  return loadUserMiddleware<E>(config ?? {})
}

/** Options for {@link loadUser}. */
export type LoadUserConfig = { readonly sessionCookie?: string } & SessionParserOption

/** loadUser without the augmentation check, for setupWeb, whose own type enforces it. */
export function loadUserMiddleware<E extends Env>(
  config: {
    readonly sessionCookie?: string
    readonly session?: S.Codec<AuthUser, unknown, never, never>
  }
): MiddlewareHandler<E> {
  const { sessionCookie } = config
  const sessionSchema: S.Codec<AuthUser, unknown, never, never> =
    config.session ?? defaultSessionSchema()

  // oxlint-disable-next-line effecttsgo/async-function -- Hono middleware and renderer contracts use native next()/Response promises; typed Effect work stays inside that request boundary.
  return async (c, next) => {
    const requestCtx = openWebContext(c)

    // Register the configured session cookie so the response-cache policy
    // treats it as private request state — even when auth isn't configured,
    // the cookie name is knowledge worth keeping.
    if (sessionCookie) {
      requestCtx.sessionCookies = [...(requestCtx.sessionCookies ?? []), sessionCookie]
    }

    // SAFETY: The Better Auth boundary validated this representation before exposing the narrower adapter contract.
    const auth = requestCtx.auth as
      | {
          api?: {
            getSession?: (input: {
              headers: Headers
            }) => Promise<{ user: unknown; session: unknown } | null>
          }
        }
      | undefined

    if (!auth?.api?.getSession) {
      await next()

      // Return response for proper propagation in forwarding/proxy scenarios
      return c.res
    }

    const cookieHeader = c.req.header('Cookie') ?? ''

    const hasSessionCookie = sessionCookie
      ? cookieHeader.includes(`${sessionCookie}=`) ||
        cookieHeader.includes(`__Secure-${sessionCookie}=`)
      : true

    if (!hasSessionCookie) {
      await next()

      return c.res
    }

    let session: { user: unknown; session: unknown } | null

    try {
      session = await auth.api.getSession({ headers: c.req.raw.headers })
    } catch (cause: unknown) {
      throw new SessionLookupUnavailable({ operation: 'getSession', cause })
    }

    if (session) {
      const exit = await Effect.runPromiseExit(S.decodeEffect(sessionSchema)(session))

      if (Exit.isFailure(exit)) {
        throw new InvalidAuthSession({
          operation: 'parseSession',
          cause: Cause.squash(exit.cause),
        })
      }

      openWebContext(c).authUser = exit.value
    }

    await next()

    // Return response for proper propagation in forwarding/proxy scenarios
    return c.res
  }
}

// AuthUser is the augmentable public contract. Applications that add fields
// provide `auth.session`; this default establishes DefaultAuthUser's shape.
const DefaultAuthSessionSchema = S.Struct({
  user: S.Struct({
    id: S.String,
    email: S.String,
    name: S.NullOr(S.String),
    emailVerified: S.Boolean,
    image: S.NullOr(S.String),
    createdAt: S.Date,
    updatedAt: S.Date,
  }),
  session: S.Struct({
    id: S.String,
    userId: S.String,
    expiresAt: S.Date,
    // Redacted, so serializing the auth user never exposes the session secret.
    token: S.RedactedFromValue(S.String),
    createdAt: S.Date,
    updatedAt: S.Date,
  }),
})

/**
 * The parser used when setupWeb has no `auth.session`. It decodes Better
 * Auth's default user and session, which is AuthUser unless the application
 * augments WebAuthUserType.
 */
function defaultSessionSchema(): S.Codec<AuthUser, unknown, never, never> {
  // SAFETY: setupWeb and loadUser require a session parser once the
  // application augments WebAuthUserType (SessionParserOption), so this
  // default runs only when AuthUser is DefaultAuthUser, which it decodes.
  return DefaultAuthSessionSchema as unknown as S.Codec<AuthUser, unknown, never, never>
}

export {
  effectifyBetterAuth,
  type BetterAuthActionError,
  type BetterAuthActionResult,
  type BetterAuthBoundaryFailure,
  type BetterAuthEffectApi,
  type BetterAuthEffectClient,
} from './better-auth-boundary.js'

/** Options for {@link betterAuthRedirect}. */
export interface BetterAuthRedirectOptions {
  /** Where to send the user once Better Auth accepts the call. */
  readonly redirectTo: string
  /** Field errors for a rejected call, such as wrong credentials, keyed by the form's fields. */
  readonly errors?: (error: BetterAuthActionError) => Record<string, string>
}

/**
 * Call Better Auth and answer with a 303 redirect that carries the cookies
 * it sets, such as the session after signing in or up.
 *
 * Run it in an action after `validateRequest`, so the action decides what to
 * validate and what else to do. A rejection, such as wrong credentials or a
 * registered email, fails with ValidationError, so the form shows it; a rate
 * limit fails with AuthRateLimitError, and a Better Auth failure with
 * HttpError.
 *
 * @example
 * export const signIn = action(Effect.gen(function* () {
 *   const input = yield* validateRequest(SignIn)
 *
 *   return yield* betterAuthRedirect(
 *     (auth, request) => auth.api.signInEmail({ body: input, headers: request.headers, asResponse: true }),
 *     { redirectTo: '/projects' }
 *   )
 * }))
 */
export function betterAuthRedirect(
  call: (auth: AuthType, request: Request) => Promise<BetterAuthActionResult>,
  options: BetterAuthRedirectOptions
): Effect.Effect<
  Response,
  AuthRedirect | ValidationError | AuthRateLimitError | HttpError,
  RequestService | AuthService
> {
  return Effect.gen(function* () {
    const auth = yield* AuthService
    const request = yield* RequestService

    const result = yield* runBetterAuthApiCall(() => call(auth, buildAuthRequest(request))).pipe(
      Effect.mapError((failure) => toAuthActionError(failure, options.errors))
    )

    const responseHeaders = new Headers({ Location: options.redirectTo })
    const resultHeaders = getHeaders(result)

    if (resultHeaders) {
      appendSetCookies(responseHeaders, resultHeaders)
    }

    return new Response(null, { status: 303, headers: responseHeaders })
  }).pipe(Effect.withSpan('Web.betterAuthRedirect'))
}

/**
 * Forward the request to Better Auth's own API, for browser code that calls
 * it directly (Better Auth's client SDK, OAuth callbacks). Register it under
 * Better Auth's base path:
 *
 * ```ts
 * routes.all('/api/auth/*', betterAuthHandler)
 * ```
 *
 * It exposes every endpoint Better Auth and its plugins define, including
 * sign-up: user fields declared with `input: true` become settable by anyone.
 * A server-rendered app that signs users in with `betterAuthRedirect` does
 * not need it.
 */
export const betterAuthHandler: Effect.Effect<Response, HttpError, RequestService | AuthService> =
  Effect.gen(function* () {
    const auth = yield* AuthService
    const request = yield* RequestService
    const handler: unknown = auth instanceof Object
      ? Object.getOwnPropertyDescriptor(auth, 'handler')?.value
      : undefined

    if (!(handler instanceof Function)) {
      return yield* new HttpError({ status: 500, message: 'Better Auth is not configured: setupWeb has no auth.client.' })
    }

    return yield* Effect.tryPromise({
      try: (): Promise<Response> => Promise.resolve(handler.call(auth, request.raw())),
      catch: (cause) => new HttpError({ status: 502, message: 'Authentication service failed.', cause }),
    })
  })

/**
 * Config for better-auth logout actions.
 */
export interface BetterAuthLogoutConfig {
  redirectTo?: string
  cookieNames?: string[]
}

/**
 * Create a better-auth logout action that clears cookies and redirects.
 */
export function betterAuthLogoutAction(
  config: BetterAuthLogoutConfig = {}
): Effect.Effect<Response, never, RequestService | AuthService> {
  return Effect.gen(function* () {
    const auth = yield* AuthService
    const request = yield* RequestService

    const result = yield* runBetterAuthApiCall(() =>
      callBetterAuthSignOut(auth, {
        headers: request.headers,
        request: buildAuthRequest(request),
        returnHeaders: true,
      })
    ).pipe(Effect.orElseSucceed(() => undefined))

    const responseHeaders = new Headers({
      Location: config.redirectTo ?? '/',
    })

    const resultHeaders = getHeaders(result)

    if (resultHeaders) {
      appendSetCookies(responseHeaders, resultHeaders)
    }

    if (!responseHeaders.has('set-cookie')) {
      appendLogoutCookies(responseHeaders, config.cookieNames)
    }

    return new Response(null, {
      status: 303,
      headers: responseHeaders,
    })
  })
}

function buildAuthRequest(request: {
  url: string
  method: string
  headers: Headers
}): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
  })
}

function callBetterAuthSignOut<Auth>(
  auth: Auth,
  input: {
    readonly headers: Headers
    readonly request?: Request
    readonly returnHeaders?: boolean
  }
): Promise<BetterAuthActionResult> {
  if (!(auth instanceof Object)) {
    return Promise.reject(new Error('Better Auth client is not configured'))
  }

  const api = Object.getOwnPropertyDescriptor(auth, 'api')?.value

  if (!(api instanceof Object)) {
    return Promise.reject(new Error('Better Auth API is not configured'))
  }

  const signOut = Object.getOwnPropertyDescriptor(api, 'signOut')?.value

  if (!(signOut instanceof Function)) {
    return Promise.reject(new Error('Better Auth signOut endpoint is not configured'))
  }

  return Promise.resolve(signOut.apply(api, [input]))
}

function getHeaders(result: BetterAuthActionResult | undefined): Headers | undefined {
  if (!result) return undefined

  if (result instanceof Headers) return result

  if (result instanceof Response) return result.headers

  if (result instanceof Object && 'headers' in result && result.headers) {
    return coerceHeaders(result.headers)
  }

  return undefined
}

function coerceHeaders(value: Headers | HeadersInit): Headers {
  return value instanceof Headers ? value : new Headers(value)
}

function appendSetCookies(target: Headers, source: Headers): void {
  // SAFETY: The Better Auth boundary validated this representation before exposing the narrower adapter contract.
  const sourceWithSetCookie = source as Headers & { getSetCookie?: () => string[] }

  if (sourceWithSetCookie.getSetCookie instanceof Function) {
    for (const cookie of sourceWithSetCookie.getSetCookie()) {
      target.append('set-cookie', cookie)
    }

    return
  }

  const setCookie = source.get('set-cookie')

  if (!setCookie) {
    return
  }

  // Split on cookie boundaries without breaking Expires attributes.
  const parts = setCookie
    .split(/,(?=[^;]+?=)/g)
    .map((part) => part.trim())
    .filter(Boolean)

  for (const cookie of parts) {
    target.append('set-cookie', cookie)
  }
}

function appendExpiredCookie(
  target: Headers,
  name: string,
  options: { secure?: boolean } = {}
): void {
  const base = `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax`
  const value = options.secure ? `${base}; Secure` : base
  target.append('set-cookie', value)
}

function appendLogoutCookies(target: Headers, cookieNames?: string[]): void {
  const defaults = [
    'better-auth.session_token',
    'better-auth.session_data',
    'better-auth.account_data',
    'better-auth.dont_remember',
  ]

  const names = cookieNames?.length ? cookieNames : defaults

  for (const name of names) {
    appendExpiredCookie(target, name)
    appendExpiredCookie(target, `__Secure-${name}`, { secure: true })
  }
}
