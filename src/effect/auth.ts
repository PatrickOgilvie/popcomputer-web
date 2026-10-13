/**
 * Effect Auth Layers and Helpers
 *
 * Authentication and authorization via Effect Layers.
 */

import { CookieService, type Cookie } from './cookies.js'
import type { PathTarget } from '../paths.js'
import { Cause, Effect, Exit, Layer, Option, Schema as S } from 'effect'
import type { MiddlewareHandler, Env } from 'hono'
import { AuthUserService, AuthService, PageService, RequestService, type AuthType, type AuthUser } from './services.js'
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
 *
 * @example
 * // Custom redirect for blocked users
 * const GuestOrAnonymousLayer = createGuestLayer(
 *   (authUser) => authUser.user.isAnonymous,
 *   '/dashboard'  // Redirect fully authenticated users to dashboard
 * )
 */
export function createGuestLayer<const Path extends string = '/'>(
  allowUser: (authUser: AuthUser) => boolean,
  redirectTo: Path & PathTarget<Path> = '/' as Path & PathTarget<Path>
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
 * The page a visitor was on their way to when a route sent them to sign in,
 * as the sign-in page's `redirect` query parameter carries it, or `fallback`.
 * A sign-in form posts from that page, so its `Referer` carries the parameter
 * too. Only a path on this site is returned, so a crafted link cannot send a
 * signed-in user elsewhere.
 *
 * @example
 * const redirectTo = yield* intendedUrl(paths.dashboard)
 * return yield* betterAuthRedirect((auth, request) => auth.api.signInEmail({ ... }), { redirectTo })
 */
export const intendedUrl = <const Path extends string>(
  fallback: Path & PathTarget<Path>
): Effect.Effect<string, never, RequestService> =>
  Effect.gen(function* () {
    const request = yield* RequestService
    const requestUrl = new URL(request.url)
    const referer = parseUrl(request.header('Referer'))
    const fromReferer = referer?.origin === requestUrl.origin ? referer.searchParams.get('redirect') : null
    const intended = requestUrl.searchParams.get('redirect') ?? fromReferer

    return intended !== null && isLocalPath(intended) ? intended : fallback
  })

function parseUrl(value: string | undefined): URL | undefined {
  if (value === undefined) return undefined

  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

/** A path on this site: not `//host` or `/\\host`, which browsers treat as other sites. */
function isLocalPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') && !/[\u0000-\u001f]/.test(value)
}

/**
 * Get the current user if authenticated.
 */
export const currentUser: Effect.Effect<AuthUser | null, never, never> =
  Effect.serviceOption(AuthUserService).pipe(
    Effect.map((option) => (Option.isSome(option) ? option.value : null))
  )

/** The user pages receive as `auth.user` unless setupWeb's `auth.share` declares another. */
export const DefaultPublicUser = S.Struct({
  id: S.String,
  name: S.NullOr(S.String),
  image: S.NullOr(S.String),
})

/** The default public user: `id`, `name` and `image`. */
export interface DefaultPublicUser extends S.Schema.Type<typeof DefaultPublicUser> {}

/** How the signed-in user is shared with pages. */
export interface ShareAuthUserConfig {
  /**
   * The public user, as an Effect Schema the signed-in user is encoded
   * through: fields it does not name never reach the browser. Defaults to
   * `id`, `name` and `image`.
   */
  readonly schema?: S.Codec<object, unknown, never, never>
}

/** The signed-in user's public fields, encoded as JSON through `schema`. */
function projectSharedUser(
  authUser: AuthUser | null | undefined,
  schema: S.Codec<object, unknown, never, never>
): PagePropValue {
  if (!authUser) return null

  const encoded = S.encodeUnknownExit(S.toCodecJson(S.toType(schema)))(authUser.user)

  if (encoded._tag === 'Failure') {
    // A schema that does not fit the user type is a programming error, which
    // the error boundary reports with the schema's own message.
    throw new Error(`setupWeb's auth.share schema does not match the signed-in user: ${String(encoded.cause)}`)
  }

  // SAFETY: a JSON codec's encoded value is JSON, which is a page prop value.
  return encoded.value as PagePropValue
}

/**
 * Share the signed-in user with the page as `auth.user`, encoded through the
 * public user schema (by default `id`, `name` and `image`).
 */
export function shareAuth(
  config: ShareAuthUserConfig = {}
): Effect.Effect<void, never, PageService> {
  return Effect.gen(function* () {
    const page = yield* PageService
    const user = yield* currentUser
    page.share('auth', {
      user: projectSharedUser(user, config.schema ?? DefaultPublicUser),
    })
  })
}

/**
 * Middleware version of shareAuth for use with app.use().
 *
 * @example
 * app.use('*', shareAuthMiddleware({ schema: S.Struct({ id: S.String, name: S.NullOr(S.String) }) }))
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
        user: projectSharedUser(requestContext.authUser, config.schema ?? DefaultPublicUser),
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
 */
export function loadUser<E extends Env>(config: LoadUserConfig = {}): MiddlewareHandler<E> {
  return loadUserMiddleware<E>(config)
}

/** Options for {@link loadUser}. */
export interface LoadUserConfig {
  readonly sessionCookie?: string
  /**
   * Parse Better Auth's session response into the signed-in user. Defaults to
   * Better Auth's default user and session; pass the schema the application
   * registers as `auth.session` when it declares another.
   */
  readonly session?: S.Codec<AuthUser, unknown, never, never>
}

/** loadUser, for setupWeb. */
export function loadUserMiddleware<E extends Env>(config: LoadUserConfig): MiddlewareHandler<E> {
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

/** Better Auth's session record, as its `getSession` returns it. */
export const BetterAuthSessionRecord = S.Struct({
  id: S.String,
  userId: S.String,
  expiresAt: S.Date,
  // Redacted, so serializing the auth user never exposes the session secret.
  token: S.RedactedFromValue(S.String),
  createdAt: S.Date,
  updatedAt: S.Date,
})

/**
 * setupWeb's `auth.session` for an application whose users have fields of
 * their own: Better Auth's session with the user as `user` decodes it,
 * typically the `user` table's row, so the user's fields are declared once,
 * in the table.
 *
 * @example
 * auth: { client, session: betterAuthSession(tableSchema(schema.user)) }
 */
export function betterAuthSession<User extends S.Codec<unknown, unknown, never, never>>(
  user: User
): S.Struct<{ readonly user: User; readonly session: typeof BetterAuthSessionRecord }> {
  return S.Struct({ user, session: BetterAuthSessionRecord })
}

// Better Auth's default user and session, which the signed-in user is unless
// setupWeb's `auth.session` declares another.
const DefaultAuthSessionSchema = betterAuthSession(S.Struct({
  id: S.String,
  email: S.String,
  name: S.NullOr(S.String),
  emailVerified: S.Boolean,
  image: S.NullOr(S.String),
  createdAt: S.Date,
  updatedAt: S.Date,
}))

/**
 * The parser used when setupWeb has no `auth.session`. It decodes Better
 * Auth's default user and session, which the registered user then is.
 */
function defaultSessionSchema(): S.Codec<AuthUser, unknown, never, never> {
  // SAFETY: the registered user is what setupWeb's `auth.session` decodes, and
  // Better Auth's default user when it has none, which is when this runs.
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
export interface BetterAuthRedirectOptions<Result, E = never, R = never, Path extends string = string> {
  /**
   * Where to send the user once Better Auth accepts the call: a path, or a
   * function of Better Auth's result returning a path or an Effect that
   * computes one, such as a lookup of the new user's first team. Call Better
   * Auth with `returnHeaders: true` to receive its result with the cookies.
   */
  readonly redirectTo: (Path & PathTarget<Path>) | ((result: Result) => string | Effect.Effect<string, E, R>)
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
export function betterAuthRedirect<
  Result extends BetterAuthActionResult,
  E = never,
  R = never,
  const Path extends string = string,
>(
  call: (auth: AuthType, request: Request) => Promise<Result>,
  options: BetterAuthRedirectOptions<Result, E, R, Path>
): Effect.Effect<
  Response,
  AuthRedirect | ValidationError | AuthRateLimitError | HttpError | E,
  RequestService | AuthService | R
> {
  return Effect.gen(function* () {
    const auth = yield* AuthService
    const request = yield* RequestService

    const result = yield* runBetterAuthApiCall(() => call(auth, buildAuthRequest(request))).pipe(
      Effect.mapError((failure) => toAuthActionError(failure, options.errors))
    )
    const resultHeaders = getHeaders(result)

    // Once Better Auth has signed the visitor in, its session cookie reaches
    // whatever response the request ends with, even if redirectTo fails
    // after it created the user.
    const jar = yield* Effect.serviceOption(CookieService)

    if (resultHeaders && Option.isSome(jar)) {
      const carried = new Headers()
      appendSetCookies(carried, resultHeaders)
      for (const cookie of carried.getSetCookie()) jar.value.append(cookie)
    }

    const destination = typeof options.redirectTo === 'string' ? options.redirectTo : options.redirectTo(result)
    const location = Effect.isEffect(destination) ? yield* destination : destination
    const responseHeaders = new Headers({ Location: location })

    if (resultHeaders && Option.isNone(jar)) {
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
export interface BetterAuthLogoutConfig<Path extends string = string> {
  /** Where to send the signed-out visitor: a declared path. Defaults to `/`. */
  redirectTo?: Path & PathTarget<Path>
  /**
   * The session cookies to expire when Better Auth's sign-out sets none, in
   * place of Better Auth's default names: for an application that renamed
   * them. Application cookies go in `clear`.
   */
  cookieNames?: string[]
  /**
   * Application cookies to clear on every sign-out, such as an impersonation
   * pointer: their `cookie(...)` declarations.
   */
  clear?: ReadonlyArray<Cookie<unknown>>
}

/**
 * Create a better-auth logout action that clears cookies and redirects.
 */
export function betterAuthLogoutAction<const Path extends string = '/'>(
  config: BetterAuthLogoutConfig<Path> = {}
): Effect.Effect<Response, never, RequestService | AuthService> {
  return Effect.gen(function* () {
    const auth = yield* AuthService
    const request = yield* RequestService
    // A route always has the cookie jar; a direct call without one clears none.
    const jar = yield* Effect.serviceOption(CookieService)

    if (Option.isSome(jar)) {
      for (const declared of config.clear ?? []) {
        yield* Effect.provideService(declared.clear, CookieService, jar.value)
      }
    }

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
