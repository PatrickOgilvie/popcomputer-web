/**
 * Effect Auth Layers and Helpers
 *
 * Authentication and authorization via Effect Layers.
 */

import { Effect, Layer, Option, Schema as S } from 'effect'
import type { Hono, MiddlewareHandler, Env } from 'hono'
import { AuthUserService, AuthService, DatabaseService, HonertiaService, RequestService, type AuthUser } from './services.js'
import { UnauthorizedError, ValidationError } from './errors.js'
import { effectRoutes, type EffectHandler } from './routing.js'
import { openHonertiaContext } from '../request-context.js'
import { render } from './responses.js'
import { validateRequest } from './validation.js'


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
      return yield* Effect.fail(
        new UnauthorizedError({
          message: 'Authentication required',
          redirectTo: '/login',
        })
      )
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
      return yield* Effect.fail(
        new UnauthorizedError({
          message: 'Already authenticated',
          redirectTo: '/',
        })
      )
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
          return yield* Effect.fail(
            new UnauthorizedError({
              message: 'Already authenticated',
              redirectTo,
            })
          )
        }
        // User is allowed (e.g., anonymous user) - continue
      }

      // No user or allowed user - succeed silently
    })
  )
}

/**
 * Check if user is authenticated without failing.
 */
export const isAuthenticated: Effect.Effect<boolean, never, never> =
  Effect.serviceOption(AuthUserService).pipe(Effect.map(Option.isSome))

/**
 * Get the current user if authenticated.
 */
export const currentUser: Effect.Effect<AuthUser | null, never, never> =
  Effect.serviceOption(AuthUserService).pipe(
    Effect.map((option) => (Option.isSome(option) ? option.value : null))
  )

/**
 * Require authentication or redirect.
 */
export const requireAuth = (
  redirectTo = '/login'
): Effect.Effect<AuthUser, UnauthorizedError, never> =>
  Effect.serviceOption(AuthUserService).pipe(
    Effect.flatMap((option) => {
      if (Option.isNone(option)) {
        return Effect.fail(new UnauthorizedError({ message: 'Unauthenticated', redirectTo }))
      }
      return Effect.succeed(option.value)
    })
  )

/**
 * Require guest status or redirect.
 */
export const requireGuest = (
  redirectTo = '/'
): Effect.Effect<void, UnauthorizedError, never> =>
  Effect.serviceOption(AuthUserService).pipe(
    Effect.flatMap((option) => {
      if (Option.isSome(option)) {
        return Effect.fail(new UnauthorizedError({ message: 'Already authenticated', redirectTo }))
      }
      return Effect.void
    })
  )

/**
 * How the authenticated user is shaped before being shared with the client.
 *
 * By default the entire user record is shared as `auth.user`, which mirrors
 * Inertia's convention but also serializes every column (email, role/admin
 * flags, etc.) into the page payload. Use `fields` or `mapUser` to expose only
 * what the client actually needs and keep PII / privileged flags server-side.
 */
export interface ShareAuthUserConfig {
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
  mapUser?: (user: Record<string, unknown>) => unknown
}

/**
 * Apply the field/map projection to a raw user record.
 */
function projectSharedUser(
  user: Record<string, unknown> | null | undefined,
  config: ShareAuthUserConfig
): unknown {
  if (!user) return null
  if (config.mapUser) return config.mapUser(user)
  if (config.fields) {
    const picked: Record<string, unknown> = {}
    for (const key of config.fields) {
      if (key in user) picked[key] = user[key]
    }
    return picked
  }
  return user
}

/**
 * Share auth state with Honertia.
 *
 * Pass a `fields` whitelist or `mapUser` projection to avoid serializing the
 * full user record (email, admin flags, …) into every page payload.
 */
export function shareAuth(
  config: ShareAuthUserConfig = {}
): Effect.Effect<void, never, HonertiaService> {
  return Effect.gen(function* () {
    const honertia = yield* HonertiaService
    const user = yield* currentUser
    honertia.share('auth', {
      user: projectSharedUser(user?.user as Record<string, unknown> | undefined, config),
    })
  })
}

/**
 * Middleware version of shareAuth for use with app.use().
 *
 * @example
 * // Share only safe fields instead of the whole user record
 * app.use('*', shareAuthMiddleware({ fields: ['id', 'name', 'image'] }))
 */
export function shareAuthMiddleware<E extends Env>(
  config: ShareAuthUserConfig = {}
): MiddlewareHandler<E> {
  return async (c, next) => {
    const { honertia, authUser } = openHonertiaContext(c)
    if (honertia) {
      honertia.share('auth', {
        user: projectSharedUser(
          authUser?.user as Record<string, unknown> | undefined,
          config
        ),
      })
    }
    await next()

    // Return response for proper propagation in forwarding/proxy scenarios
    return c.res
  }
}

/**
 * An auth action effect that returns a Response.
 * Used for loginAction, registerAction, logoutAction, and guestActions.
 *
 * The default service requirement is `RequestService | AuthService` because
 * that's what the factory functions (betterAuthFormAction, betterAuthLogoutAction)
 * return, and effectAuthRoutes provides these services automatically.
 */
export type AuthActionEffect<
  R = RequestService | AuthService | DatabaseService,
  E extends Error = Error
> = EffectHandler<R, E>

/**
 * Configuration for auth routes.
 */
export interface AuthRoutesConfig<E extends Env> {
  loginPath?: string
  registerPath?: string
  logoutPath?: string
  apiPath?: string
  logoutRedirect?: string
  /**
   * Redirect path for authenticated users hitting login/register pages.
   */
  loginRedirect?: string
  loginComponent?: string
  registerComponent?: string
  sessionCookie?: string
  /**
   * CORS configuration for auth API routes.
   * If provided, adds CORS headers to `/api/auth/*` routes.
   */
  cors?: {
    origin: string | string[] | ((origin: string) => string | undefined | null)
    credentials?: boolean
  }
  /**
   * Custom layer for guest-only routes (login, register, guestActions).
   *
   * By default, uses `RequireGuestLayer` which blocks ALL authenticated users.
   * Use `createGuestLayer` to allow certain users through (e.g., anonymous users
   * who should be able to access login/register to upgrade their accounts).
   *
   * @example
   * // Allow anonymous users to access login/register pages
   * effectAuthRoutes(app, {
   *   guestLayer: createGuestLayer((authUser) => authUser.user.isAnonymous),
   *   loginComponent: 'Auth/Login',
   *   registerComponent: 'Auth/Register',
   * })
   */
  guestLayer?: Layer.Layer<never, UnauthorizedError, never>
  /**
   * POST handler for login form submission.
   * Automatically wrapped with guestLayer (or RequireGuestLayer if not specified).
   * Use betterAuthFormAction to create this.
   */
  loginAction?: AuthActionEffect
  /**
   * POST handler for registration form submission.
   * Automatically wrapped with guestLayer (or RequireGuestLayer if not specified).
   * Use betterAuthFormAction to create this.
   */
  registerAction?: AuthActionEffect
  /**
   * POST handler for logout.
   * If not provided, uses a default handler that calls auth.api.signOut.
   * Use betterAuthLogoutAction to create this.
   */
  logoutAction?: AuthActionEffect
  /**
   * Additional guest-only POST routes for extended auth flows.
   * Keys are paths (e.g., '/forgot-password'), values are Effect handlers.
   * All routes are wrapped with guestLayer (or RequireGuestLayer if not specified).
   *
   * @example
   * guestActions: {
   *   '/forgot-password': forgotPasswordAction,
   *   '/reset-password': resetPasswordAction,
   *   '/login/2fa': verify2FAAction,
   * }
   */
  guestActions?: Record<string, AuthActionEffect>
}

/**
 * Register standard auth routes.
 *
 * @example
 * effectAuthRoutes(app, {
 *   loginComponent: 'Auth/Login',
 *   registerComponent: 'Auth/Register',
 *   loginAction: loginUser,
 *   registerAction: registerUser,
 * })
 */
export function effectAuthRoutes<E extends Env>(
  app: Hono<E>,
  config: AuthRoutesConfig<E> = {}
): void {
  const {
    loginPath = '/login',
    registerPath = '/register',
    logoutPath = '/logout',
    apiPath = '/api/auth',
    logoutRedirect = '/login',
    loginRedirect = '/',
    loginComponent = 'Auth/Login',
    registerComponent = 'Auth/Register',
  } = config

  // Use custom guestLayer or create default that respects loginRedirect
  const guestLayer = config.guestLayer ?? createGuestLayer(() => false, loginRedirect)

  const routes = effectRoutes(app)

  // Guest-only routes builder (login, register pages and actions)
  const guestRoutes = routes.provide(guestLayer)

  // Login page - uses custom guestLayer or RequireGuestLayer
  guestRoutes.get(loginPath, render(loginComponent))

  // Register page - uses custom guestLayer or RequireGuestLayer
  guestRoutes.get(registerPath, render(registerComponent))

  // Login action (POST) - uses custom guestLayer
  if (config.loginAction) {
    guestRoutes.post(loginPath, config.loginAction)
  }

  // Register action (POST) - uses custom guestLayer
  if (config.registerAction) {
    guestRoutes.post(registerPath, config.registerAction)
  }

  // Logout (POST) - use provided action or default
  if (config.logoutAction) {
    routes.post(logoutPath, config.logoutAction)
  } else {
    routes.post(
      logoutPath,
      Effect.gen(function* () {
        const auth = yield* AuthService
        const request = yield* RequestService

        // Revoke session server-side
        yield* Effect.tryPromise(() =>
          (auth as any).api.signOut({
            headers: request.headers,
          })
        )

        // Clear cookie(s) and redirect. Clear both the plain and the
        // `__Secure-` prefixed variant so HTTPS sessions are also revoked.
        const sessionCookie = config.sessionCookie ?? 'better-auth.session_token'
        const headers = new Headers({ Location: logoutRedirect })
        appendLogoutCookies(headers, [sessionCookie])
        return new Response(null, { status: 303, headers })
      })
    )
  }

  // Additional guest-only actions (2FA, forgot password, etc.)
  if (config.guestActions) {
    for (const [path, action] of Object.entries(config.guestActions)) {
      guestRoutes.post(path, action)
    }
  }

  // Better-auth API handler (handles sign-in, sign-up, etc.)
  // Apply CORS if configured
  if (config.cors) {
    const corsConfig = config.cors
    app.use(`${apiPath}/*`, async (c, next) => {
      const origin = c.req.header('Origin')

      // Determine allowed origin
      let allowedOrigin: string | null = null
      if (typeof corsConfig.origin === 'function') {
        allowedOrigin = origin ? corsConfig.origin(origin) ?? null : null
      } else if (Array.isArray(corsConfig.origin)) {
        allowedOrigin = origin && corsConfig.origin.includes(origin) ? origin : null
      } else {
        allowedOrigin = corsConfig.origin
      }

      if (allowedOrigin) {
        c.header('Access-Control-Allow-Origin', allowedOrigin)
        if (corsConfig.credentials) {
          c.header('Access-Control-Allow-Credentials', 'true')
        }
      }

      // Handle preflight
      if (c.req.method === 'OPTIONS') {
        c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        c.header('Access-Control-Max-Age', '86400')
        return c.body(null, 204)
      }

      await next()
    })
  }

  app.all(`${apiPath}/*`, async (c) => {
    const auth = openHonertiaContext(c).auth as { handler?: (req: Request) => Response | Promise<Response> } | undefined
    if (!auth?.handler) {
      return c.json({ error: 'Auth not configured' }, 500)
    }
    return auth.handler(c.req.raw)
  })
}

/**
 * Middleware to load the authenticated user.
 * This should be used early in the middleware chain.
 */
export function loadUser<E extends Env>(
  config: {
    sessionCookie?: string
  } = {}
): MiddlewareHandler<E> {
  const { sessionCookie } = config

  return async (c, next) => {
    const requestCtx = openHonertiaContext(c)

    // Register the configured session cookie so the response-cache policy
    // treats it as private request state — even when auth isn't configured,
    // the cookie name is knowledge worth keeping.
    if (sessionCookie) {
      requestCtx.sessionCookies = [...(requestCtx.sessionCookies ?? []), sessionCookie]
    }

    const auth = requestCtx.auth as
      | {
          api: {
            getSession: (input: {
              headers: Headers
            }) => Promise<{ user: unknown; session: unknown } | null>
          }
        }
      | undefined
    if (!auth) {
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

    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers })
      if (session) {
        openHonertiaContext(c).authUser = {
          user: session.user,
          session: session.session,
        } as AuthUser
      }
    } catch {
      // Session fetch failed, continue without user
    }

    await next()

    // Return response for proper propagation in forwarding/proxy scenarios
    return c.res
  }
}

/**
 * Result types from better-auth calls that expose headers.
 */
export type BetterAuthActionResult =
  | Response
  | Headers
  | { headers?: Headers | HeadersInit }

/**
 * Config for better-auth form actions (login/register).
 */
export interface BetterAuthFormActionConfig<A, I, AuthClient = unknown> {
  schema: S.Schema<A, I>
  errorComponent: string
  call: (auth: AuthClient, input: A, request: Request) => Promise<BetterAuthActionResult>
  errorMapper?: (error: unknown) => Record<string, string>
  redirectTo?: string | ((input: A, result: BetterAuthActionResult) => string)
}

/**
 * Create a better-auth form action with Honertia-friendly responses.
 *
 * Copies Set-Cookie headers from better-auth and redirects with 303.
 * Maps errors into ValidationError so the standard error handler can render.
 */
export function betterAuthFormAction<A, I, AuthClient = unknown>(
  config: BetterAuthFormActionConfig<A, I, AuthClient>
): Effect.Effect<Response, ValidationError, RequestService | AuthService> {
  return Effect.gen(function* () {
    const auth = yield* AuthService
    const request = yield* RequestService
    const input = yield* validateRequest(config.schema, {
      errorComponent: config.errorComponent,
    })

    const result = yield* Effect.tryPromise({
      try: () => config.call(auth as AuthClient, input, buildAuthRequest(request)),
      catch: (error) => error,
    }).pipe(
      Effect.mapError((error) =>
        new ValidationError({
          errors: (config.errorMapper ?? defaultAuthErrorMapper)(error),
          component: config.errorComponent,
        })
      )
    )

    const redirectTo = resolveRedirect(config.redirectTo, input, result)
    const responseHeaders = new Headers({ Location: redirectTo })
    const resultHeaders = getHeaders(result)

    if (resultHeaders) {
      appendSetCookies(responseHeaders, resultHeaders)
    }

    return new Response(null, {
      status: 303,
      headers: responseHeaders,
    })
  })
}

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

    const result = yield* Effect.tryPromise({
      try: () =>
        (auth as any).api.signOut({
          headers: request.headers,
          request: buildAuthRequest(request),
          returnHeaders: true,
        }) as Promise<BetterAuthActionResult>,
      catch: () => undefined,
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

    const responseHeaders = new Headers({
      Location: config.redirectTo ?? '/login',
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

function resolveRedirect<A>(
  target: BetterAuthFormActionConfig<A, any>['redirectTo'],
  input: A,
  result: BetterAuthActionResult
): string {
  if (typeof target === 'function') {
    return target(input, result)
  }
  return target ?? '/'
}

function getHeaders(result: BetterAuthActionResult | undefined): Headers | undefined {
  if (!result) return undefined
  if (result instanceof Headers) return result
  if (result instanceof Response) return result.headers
  if (typeof result === 'object' && 'headers' in result && result.headers) {
    return coerceHeaders(result.headers)
  }
  return undefined
}

function coerceHeaders(value: Headers | HeadersInit): Headers {
  return value instanceof Headers ? value : new Headers(value)
}

function defaultAuthErrorMapper(error: unknown): Record<string, string> {
  const message = getAuthErrorMessage(error) ?? 'Unable to complete request. Please try again.'
  return { form: message }
}

function getAuthErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const candidate = error as { body?: { message?: unknown }; message?: unknown }
  if (typeof candidate.body?.message === 'string') return candidate.body.message
  if (typeof candidate.message === 'string') return candidate.message
  return undefined
}

function appendSetCookies(target: Headers, source: Headers): void {
  const sourceWithSetCookie = source as Headers & { getSetCookie?: () => string[] }
  if (typeof sourceWithSetCookie.getSetCookie === 'function') {
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
