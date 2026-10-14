/**
 * Effect Auth Layers and Helpers
 *
 * Authentication and authorization via Effect Layers.
 */

import { CookieService, type Cookie } from './cookies.js'
import { ResponseHeaders } from './response-headers.js'
import type { Jsonify } from './pages.js'
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
import { AuthRateLimitError, type AuthRedirect, type ValidationError } from './errors.js'
import { accountOf, clientAddress, isPasswordSignIn, withinSignInLimits } from './sign-in-limits.js'
import {
  inspectBetterAuthActionResult,
  runBetterAuthApiCall,
  toAuthActionError,
  type BetterAuthActionError,
} from './better-auth-boundary.js'
import { openWebContext } from '../request-context.js'
import type { PagePropValue, PageProps } from '../types.js'


/**
 * Layer that requires an authenticated user: a signed-out visit goes to
 * setupWeb's `auth.signInPath`, and a JSON client is answered 401.
 *
 * @example
 * routes.provide(RequireAuthLayer).get(paths.dashboard, showDashboard)
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
 * Layer for pages only guests see, such as signing in: a signed-in visitor
 * goes to setupWeb's `auth.homePath` (default `/`).
 *
 * To let some signed-in users through, such as anonymous ones, use
 * `createGuestLayer`.
 *
 * @example
 * routes.provide(RequireGuestLayer)
 *   .get(paths.login, action(render('Auth/Login')))
 *   .post(paths.login, signIn)
 */
export const RequireGuestLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const maybeUser = yield* Effect.serviceOption(AuthUserService)

    if (Option.isSome(maybeUser)) {
      return yield* new UnauthorizedError({ message: 'Already authenticated', home: true })
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
 * @param redirectTo - Where a blocked user goes: by default setupWeb's `auth.homePath`.
 *
 * @example
 * // Let anonymous users reach the sign-up page to upgrade their accounts
 * const AllowAnonymous = createGuestLayer((authUser) => authUser.user.isAnonymous === true)
 *
 * routes.provide(AllowAnonymous).get(paths.register, action(render('Auth/Register')))
 */
export function createGuestLayer<const Path extends string = string>(
  allowUser: (authUser: AuthUser) => boolean,
  redirectTo?: Path & PathTarget<Path>
): Layer.Layer<never, UnauthorizedError, never> {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const maybeUser = yield* Effect.serviceOption(AuthUserService)

      if (Option.isSome(maybeUser)) {
        const authUser = maybeUser.value

        // Check if this user is allowed through
        if (!allowUser(authUser)) {
          return yield* new UnauthorizedError(
            redirectTo === undefined
              ? { message: 'Already authenticated', home: true }
              : { message: 'Already authenticated', redirectTo }
          )
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
 * return yield* betterAuthRedirect('signInEmail', { body: input }, { redirectTo })
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
              returnHeaders: true
            }) => Promise<unknown>
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

    let looked: unknown

    try {
      looked = await auth.api.getSession({ headers: c.req.raw.headers, returnHeaders: true })
    } catch (cause: unknown) {
      throw new SessionLookupUnavailable({ operation: 'getSession', cause })
    }

    // Better Auth answers with the cookies the lookup sets: the session's,
    // renewed when it extends the session, or expired when the session is
    // gone. They reach the response, so the browser's cookie lives as long
    // as the session.
    const { session, cookies } = sessionLookup(looked)

    if (cookies.length > 0) {
      requestCtx.responseCookies = [...(requestCtx.responseCookies ?? []), ...cookies]
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

/**
 * A session lookup's result: `{ headers, response }` from Better Auth's
 * `returnHeaders`, or the session itself from a client that returns it
 * plainly.
 */
function sessionLookup(looked: unknown): { readonly session: unknown; readonly cookies: ReadonlyArray<string> } {
  if (looked instanceof Object && Reflect.get(looked, 'headers') instanceof Headers && Object.hasOwn(looked, 'response')) {
    const headers: Headers = Reflect.get(looked, 'headers')

    return { session: Reflect.get(looked, 'response'), cookies: headers.getSetCookie() }
  }

  return { session: looked, cookies: [] }
}

/** The session's token, Redacted, so serializing the auth user never exposes it. */
const SessionToken = S.RedactedFromValue(S.String)

/** Better Auth's session record, as its `getSession` returns it. */
export const BetterAuthSessionRecord = S.Struct({
  id: S.String,
  userId: S.String,
  expiresAt: S.Date,
  token: SessionToken,
  createdAt: S.Date,
  updatedAt: S.Date,
})

/** A session table's fields, with its token Redacted. */
export type BetterAuthSessionFields<Fields extends S.Struct.Fields> = {
  readonly [Key in keyof Fields]: Key extends 'token' ? typeof SessionToken : Fields[Key]
}

/**
 * setupWeb's `auth.session` for an application whose users have fields of
 * their own: Better Auth's session with the user as `user` decodes it,
 * typically the `user` table's row, so the user's fields are declared once,
 * in the table. Give the `session` table's row too when plugins add session
 * fields, such as the organization plugin's `activeOrganizationId`, and
 * `authorize()` returns them; its token stays Redacted.
 *
 * @example
 * auth: { client, session: betterAuthSession(tableSchema(schema.user), tableSchema(schema.session)) }
 */
export function betterAuthSession<User extends S.Codec<unknown, unknown, never, never>>(
  user: User
): S.Struct<{ readonly user: User; readonly session: typeof BetterAuthSessionRecord }>
export function betterAuthSession<
  User extends S.Codec<unknown, unknown, never, never>,
  Fields extends S.Struct.Fields & { readonly token: S.Codec<string, unknown, never, never> },
>(
  user: User,
  session: S.Struct<Fields>
): S.Struct<{ readonly user: User; readonly session: S.Struct<BetterAuthSessionFields<Fields>> }>
export function betterAuthSession(
  user: S.Codec<unknown, unknown, never, never>,
  session?: S.Struct<S.Struct.Fields>
): S.Struct<S.Struct.Fields> {
  return S.Struct({
    user: withAbsentNulls(structFields(user)) ?? user,
    session: session === undefined ? BetterAuthSessionRecord : withAbsentNulls({ ...session.fields, token: SessionToken }),
  })
}

/**
 * A struct whose nullable fields decode a missing or undefined value as null.
 * Better Auth leaves a field it never set undefined, such as the image of a
 * user an OAuth provider gave none, where it keeps the user without a
 * database: its memory adapter and its stateless sessions. A row from a table
 * has the column, null.
 */
function withAbsentNulls(fields: S.Struct.Fields): S.Struct<S.Struct.Fields>
function withAbsentNulls(fields: S.Struct.Fields | undefined): S.Struct<S.Struct.Fields> | undefined
function withAbsentNulls(fields: S.Struct.Fields | undefined): S.Struct<S.Struct.Fields> | undefined {
  if (fields === undefined) return undefined

  const decoded: { [name: string]: S.Struct.Fields[string] } = {}

  for (const [name, field] of Object.entries(fields)) {
    decoded[name] = S.is(S.toEncoded(field))(null) ? S.withDecodingDefault(Effect.succeed(null))(field) : field
  }

  return S.Struct(decoded)
}

/** A struct schema's fields, or none for another schema. */
function structFields(schema: unknown): Record<string, S.Top> | undefined {
  const fields: unknown = schema instanceof Object ? Reflect.get(schema, 'fields') : undefined

  if (!(fields instanceof Object)) return undefined

  const found: Record<string, S.Top> = {}

  for (const [name, field] of Object.entries(fields)) {
    if (!S.isSchema(field)) return undefined
    found[name] = field
  }

  return found
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

export type { BetterAuthActionError } from './better-auth-boundary.js'

/** Better Auth's server API, from the registered auth client, or none when no client is registered. */
type AuthApi = AuthType extends { readonly api: infer Api } ? Api : never

/**
 * The name of one of Better Auth's endpoints on `auth.api`, such as
 * `'signInEmail'` or `'signUpEmail'`, including the endpoints its plugins add.
 */
export type BetterAuthEndpoint = [AuthApi] extends [never] ? string : EndpointNames<AuthApi>

// Distributed over the API, so an auth client typed as a union of clients names each one's endpoints.
type EndpointNames<Api> = Api extends unknown
  ? { readonly [Name in keyof Api]: Api[Name] extends { readonly path: string } ? Name : never }[keyof Api] & string
  : never

type EndpointOf<Api, Name> = Api extends unknown ? (Name extends keyof Api ? Api[Name] : never) : never

type EndpointArgument<Name> = EndpointOf<AuthApi, Name> extends (...args: infer Args) => unknown
  ? NonNullable<Args[0]>
  : never

/** What an endpoint is sent: its `body`, or for a GET its `query`, as `auth.api` takes them. */
export type BetterAuthEndpointInput<Name extends string> = [AuthApi] extends [never]
  ? { readonly body?: unknown; readonly query?: Readonly<Record<string, unknown>> }
  : Pick<EndpointArgument<Name>, Extract<keyof EndpointArgument<Name>, 'body' | 'query'>>

/**
 * What an endpoint answers on success, such as sign-up's `{ token, user }`,
 * as the JSON Better Auth's handler sends: dates are ISO strings, so decode
 * one with `S.Date` (or `S.toCodecJson(Schema)`) before using it as a `Date`.
 */
export type BetterAuthEndpointResult<Name extends string> = [AuthApi] extends [never]
  ? unknown
  : EndpointOf<AuthApi, Name> extends (...args: never) => infer Result
    ? Jsonify<Awaited<Result>>
    : unknown

/** Options for {@link betterAuthRedirect}. */
export interface BetterAuthRedirectOptions<Result, E = never, R = never, Path extends string = string> {
  /**
   * Where to send the user once Better Auth accepts the call: a path, or a
   * function of the endpoint's result returning a path or an Effect that
   * computes one, such as a lookup of the new user's first team.
   */
  readonly redirectTo: (Path & PathTarget<Path>) | ((result: Result) => string | Effect.Effect<string, E, R>)
  /** Field errors for a rejected call, such as wrong credentials, keyed by the form's fields. */
  readonly errors?: (error: BetterAuthActionError) => Readonly<Record<string, string | undefined>>
}

/** A field error mapper's result, without the fields it left out. */
function definedErrors(
  errors: ((error: BetterAuthActionError) => Readonly<Record<string, string | undefined>>) | undefined
): ((error: BetterAuthActionError) => Record<string, string>) | undefined {
  if (errors === undefined) return undefined

  return (error) => {
    const defined: Record<string, string> = {}

    for (const [field, message] of Object.entries(errors(error))) {
      if (message !== undefined) defined[field] = message
    }

    return defined
  }
}

/** A Better Auth instance as the framework sends calls through it. */
interface BetterAuthInstance {
  readonly api: object
  readonly handler: (request: Request) => Response | Promise<Response>
  readonly $context?: Promise<{ readonly baseURL?: string }>
  readonly options?: { readonly basePath?: string }
}

function isBetterAuthInstance(auth: unknown): auth is BetterAuthInstance {
  return auth instanceof Object && Reflect.get(auth, 'api') instanceof Object && Reflect.get(auth, 'handler') instanceof Function
}

/** An endpoint on `auth.api`, by name, and its path under Better Auth's base path. */
function endpointOf(auth: BetterAuthInstance, name: string): { readonly endpoint: object; readonly path: string } {
  const endpoint: unknown = Reflect.get(auth.api, name)
  const path: unknown = endpoint instanceof Object ? Reflect.get(endpoint, 'path') : undefined

  if (!(endpoint instanceof Object) || typeof path !== 'string') {
    throw new Error(`Better Auth has no endpoint named '${name}' on auth.api; a plugin's endpoint needs the plugin in betterAuth({ plugins }).`)
  }

  return { endpoint, path }
}

/** The headers of the request that reach Better Auth: its cookies, client address and origin, not its body's. */
const BODY_HEADERS = ['content-length', 'content-type', 'content-encoding', 'transfer-encoding']

/**
 * Send an endpoint call through Better Auth's request handler, as its own
 * client does, rather than its server API: the handler applies Better Auth's
 * rate limits, origin checks and plugin hooks, which server calls skip.
 */
async function sendThroughHandler(
  auth: unknown,
  original: Request,
  name: string,
  input: { readonly body?: unknown; readonly query?: unknown }
): Promise<Response> {
  if (!isBetterAuthInstance(auth)) {
    throw new Error('Better Auth is not configured: setupWeb has no auth.client, or it returned something that is not a Better Auth instance.')
  }

  const { endpoint, path } = endpointOf(auth, name)
  const endpointOptions: unknown = Reflect.get(endpoint, 'options')
  const declared: unknown = endpointOptions instanceof Object ? Reflect.get(endpointOptions, 'method') : undefined
  const methods = (Array.isArray(declared) ? declared : [declared]).filter((method): method is string => typeof method === 'string')
  const method = input.body !== undefined && methods.includes('POST') ? 'POST' : methods[0] ?? 'POST'

  const context = auth.$context === undefined ? undefined : await auth.$context
  const base = context?.baseURL !== undefined && context.baseURL !== ''
    ? context.baseURL
    : `${new URL(original.url).origin}${auth.options?.basePath ?? '/api/auth'}`
  const url = new URL(`${base.replace(/\/$/, '')}${path}`)

  if (input.query instanceof Object) {
    for (const [key, value] of Object.entries(input.query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }
  }

  const headers = new Headers(original.headers)
  for (const header of BODY_HEADERS) headers.delete(header)
  headers.set('accept', 'application/json')

  if (input.body !== undefined) headers.set('content-type', 'application/json')

  return auth.handler(new Request(url, {
    method,
    headers,
    body: input.body === undefined || method === 'GET' ? undefined : JSON.stringify(input.body),
  }))
}

/** An endpoint's success as the action receives it: its JSON body, and the response carrying its cookies. */
function readEndpointResult(response: Response): Effect.Effect<unknown> {
  return Effect.promise(async () => {
    const text = await response.clone().text()

    if (text.trim() === '') return null

    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  })
}

/** Call an endpoint through the handler, with its failures classified and its cookies kept for the response. */
function callEndpoint(
  name: string,
  input: { readonly body?: unknown; readonly query?: unknown },
  errors: ((error: BetterAuthActionError) => Record<string, string>) | undefined
): Effect.Effect<{ readonly result: unknown; readonly response: Response }, AuthRedirect | ValidationError | AuthRateLimitError | HttpError, RequestService | AuthService> {
  return Effect.gen(function* () {
    const auth = yield* AuthService
    const request = yield* RequestService
    const raw = request.raw()

    if (!isBetterAuthInstance(auth)) {
      return yield* Effect.die(new Error('Better Auth is not configured: setupWeb has no auth.client, or it returned something that is not a Better Auth instance.'))
    }

    const { path } = yield* Effect.try({ try: () => endpointOf(auth, name), catch: (cause) => cause }).pipe(Effect.orDie)
    const attempt = { path, address: clientAddress(raw.headers), account: accountOf(input.body) }

    const response = yield* withinSignInLimits(
      attempt,
      runBetterAuthApiCall(() => sendThroughHandler(auth, raw, name, input), { inspectResult: false })
    ).pipe(
      Effect.flatMap(inspectBetterAuthActionResult),
      Effect.mapError((failure) => failure instanceof AuthRateLimitError ? failure : toAuthActionError(failure, errors))
    )

    // Once Better Auth has signed the visitor in, its session cookie reaches
    // whatever response the request ends with, even if the action fails
    // after it, as a sign-up whose follow-up refuses.
    const jar = yield* Effect.serviceOption(CookieService)

    if (Option.isSome(jar)) {
      for (const cookie of response.headers.getSetCookie()) jar.value.append(cookie)
    }

    // A session token Better Auth's bearer plugin hands a client that sends no cookies.
    const token = response.headers.get('set-auth-token')
    const headers = yield* Effect.serviceOption(ResponseHeaders)

    if (token !== null && Option.isSome(headers)) {
      headers.value.append('set-auth-token', token)
      headers.value.append('Access-Control-Expose-Headers', 'set-auth-token')
    }

    return { result: yield* readEndpointResult(response), response }
  })
}

/**
 * Call one of Better Auth's endpoints, by its name on `auth.api`, and answer
 * with a 303 redirect carrying the cookies it sets, such as the session after
 * signing in or up.
 *
 * The call goes through Better Auth's request handler, as its own client's
 * do, so its rate limits, origin checks and plugins' hooks apply: a sign-in
 * form is limited as Better Auth's own route is. Run it in an action after
 * `validateRequest`. A rejection, such as wrong credentials or a registered
 * email, fails with ValidationError, so the form shows it; a rate limit fails
 * with AuthRateLimitError, and a Better Auth failure with HttpError.
 *
 * @example
 * export const signIn = action(Effect.gen(function* () {
 *   const input = yield* validateRequest(SignIn)
 *
 *   return yield* betterAuthRedirect('signInEmail', { body: input }, {
 *     redirectTo: '/projects',
 *     errors: (error) => ({ email: error.message }),
 *   })
 * }))
 */
export function betterAuthRedirect<
  const Name extends BetterAuthEndpoint,
  E = never,
  R = never,
  const Path extends string = string,
>(
  endpoint: Name,
  input: BetterAuthEndpointInput<Name>,
  options: BetterAuthRedirectOptions<BetterAuthEndpointResult<Name>, E, R, Path>
): Effect.Effect<
  Response,
  AuthRedirect | ValidationError | AuthRateLimitError | HttpError | E,
  RequestService | AuthService | R
> {
  return Effect.gen(function* () {
    const { result, response } = yield* callEndpoint(endpoint, input, definedErrors(options.errors))

    // SAFETY: the endpoint's JSON body is what auth.api's endpoint returns.
    const typed = result as BetterAuthEndpointResult<Name>
    const destination = typeof options.redirectTo === 'string' ? options.redirectTo : options.redirectTo(typed)
    const location = Effect.isEffect(destination) ? yield* destination : destination
    const headers = new Headers({ Location: location })
    const jar = yield* Effect.serviceOption(CookieService)

    // Without the request's cookie jar, the redirect carries the cookies itself.
    if (Option.isNone(jar)) appendSetCookies(headers, response.headers)

    return new Response(null, { status: 303, headers })
  }).pipe(Effect.withSpan('Web.betterAuthRedirect'))
}

/**
 * Call one of Better Auth's endpoints, by its name on `auth.api`, for a
 * result the action uses, such as the secret that enabling two-factor returns
 * or a password check, through Better Auth's request handler as
 * `betterAuthRedirect` does. A rejection becomes the field errors `errors`
 * returns, and a rate limit a typed error; cookies the call sets reach the
 * response the request ends with.
 *
 * @example
 * const enrolment = yield* betterAuthCall('enableTwoFactor', { body: { password } }, {
 *   errors: (error) => ({ password: error.message }),
 * })
 */
export function betterAuthCall<const Name extends BetterAuthEndpoint>(
  endpoint: Name,
  input: BetterAuthEndpointInput<Name>,
  options: { readonly errors?: (error: BetterAuthActionError) => Readonly<Record<string, string | undefined>> } = {}
): Effect.Effect<BetterAuthEndpointResult<Name>, AuthRedirect | ValidationError | AuthRateLimitError | HttpError, RequestService | AuthService> {
  return callEndpoint(endpoint, input, definedErrors(options.errors)).pipe(
    // SAFETY: the endpoint's JSON body is what auth.api's endpoint returns.
    Effect.map(({ result }) => result as BetterAuthEndpointResult<Name>),
    Effect.withSpan('Web.betterAuthCall')
  )
}

/** The options the registered Better Auth was configured with. */
type AuthOptions = AuthType extends { readonly options: infer Options } ? Options : never

type InputFieldsOf<Options> = Options extends { readonly user?: { readonly additionalFields?: infer Fields } }
  ? { readonly [Name in keyof NonNullable<Fields>]: NonNullable<Fields>[Name] extends { readonly input: false } ? never : Name }[keyof NonNullable<Fields>] & string
  : never

/**
 * The user fields a visitor may set at sign-up, as the registered Better
 * Auth's `user.additionalFields` declares them: each whose `input` is not
 * false.
 */
export type BetterAuthInputField = [AuthOptions] extends [never] ? string : InputFieldsOf<AuthOptions>

/** Options for {@link betterAuthHandler}. */
export interface BetterAuthHandlerOptions {
  /**
   * The user fields declared `input: true` that a visitor may set through
   * Better Auth's own API, at sign-up and later with its update-user, where
   * the application's actions do not validate them. A request setting any
   * other is refused.
   */
  readonly settable: ReadonlyArray<BetterAuthInputField>
}

/** Options are required once the registered Better Auth declares user fields a visitor may set. */
type BetterAuthHandlerArguments = [InputFieldsOf<AuthOptions>] extends [never]
  ? [options?: BetterAuthHandlerOptions]
  : [options: BetterAuthHandlerOptions]

/** Better Auth's endpoints that write the user from the request's body. */
const writesUser = (path: string): boolean => path.startsWith('/sign-up/') || path === '/update-user'

/** The user fields Better Auth lets a visitor set: its `additionalFields` whose `input` is not false. */
function inputUserFields(auth: BetterAuthInstance): ReadonlyArray<string> {
  const user: unknown = auth.options === undefined ? undefined : Reflect.get(auth.options, 'user')
  const fields: unknown = user instanceof Object ? Reflect.get(user, 'additionalFields') : undefined

  if (!(fields instanceof Object)) return []

  return Object.entries(fields)
    .filter(([, field]) => !(field instanceof Object && Reflect.get(field, 'input') === false))
    .map(([name]) => name)
}

/**
 * Forward the request to Better Auth's own API, for browser code that calls
 * it directly (Better Auth's client SDK, an OAuth provider's callback).
 * Register it under Better Auth's base path:
 *
 * ```ts
 * routes.all(paths.authApi, betterAuthHandler())
 * ```
 *
 * It exposes every endpoint Better Auth and its plugins define, including
 * sign-up and update-user, which write user fields declared `input: true`
 * without the application's validation. Name the ones a visitor may set there
 * in `settable`, which TypeScript asks for once the registered Better Auth
 * declares any; a request setting another is refused with a 400. A
 * server-rendered app that signs users in with `betterAuthRedirect` needs it
 * only for OAuth callbacks.
 */
export function betterAuthHandler(
  ...[options]: BetterAuthHandlerArguments
): Effect.Effect<Response, HttpError | AuthRateLimitError, RequestService | AuthService> {
  const settable = new Set<string>(options?.settable ?? [])

  return Effect.gen(function* () {
    const auth = yield* AuthService
    const request = yield* RequestService

    if (!isBetterAuthInstance(auth)) {
      return yield* new HttpError({ status: 500, message: 'Better Auth is not configured: setupWeb has no auth.client.' })
    }

    const raw = request.raw()
    const path = yield* Effect.promise(() => handlerPath(auth, raw))
    // The body, for the endpoints the framework checks; the handler then reads it itself.
    const body = isPasswordSignIn(path) || writesUser(path) ? yield* Effect.promise(() => bodyOf(raw)) : undefined

    if (writesUser(path) && body instanceof Object) {
      const refused = inputUserFields(auth).filter((field) => !settable.has(field) && Object.hasOwn(body, field))

      if (refused.length > 0) {
        return yield* new HttpError({
          status: 400,
          message: `This request sets ${refused.join(', ')}, which visitors may not set through this API.`,
        })
      }
    }

    return yield* withinSignInLimits(
      { path, address: clientAddress(raw.headers), account: isPasswordSignIn(path) ? accountOf(body) : undefined },
      Effect.tryPromise({
        try: (): Promise<Response> => Promise.resolve(auth.handler(raw)),
        catch: (cause) => new HttpError({ status: 502, message: 'Authentication service failed.', cause }),
      })
    )
  })
}

/** The request's path under Better Auth's base path, as its endpoints name theirs. */
async function handlerPath(auth: BetterAuthInstance, request: Request): Promise<string> {
  const context = auth.$context === undefined ? undefined : await auth.$context
  const base = context?.baseURL !== undefined && context.baseURL !== ''
    ? new URL(context.baseURL).pathname
    : auth.options?.basePath ?? '/api/auth'
  const pathname = new URL(request.url).pathname
  const prefix = base.replace(/\/$/, '')

  return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : pathname
}

/** A JSON or form body, read from a copy, or none. */
async function bodyOf(request: Request): Promise<unknown> {
  const type = request.headers.get('content-type') ?? ''

  try {
    if (type.includes('application/json')) return await request.clone().json()
    if (type.includes('form')) return Object.fromEntries(await request.clone().formData())
  } catch {
    // A body the handler will refuse itself.
  }

  return undefined
}

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
 * Sign the visitor out and redirect. Signing out goes through Better Auth's
 * request handler, as every call does, and the session cookies it expires
 * reach the redirect; a sign-out Better Auth refuses, such as one without a
 * session, still expires them.
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

    const answered = yield* Effect.tryPromise(() => sendThroughHandler(auth, request.raw(), 'signOut', {})).pipe(
      Effect.orElseSucceed(() => undefined)
    )

    const headers = new Headers({ Location: config.redirectTo ?? '/' })

    if (answered !== undefined) appendSetCookies(headers, answered.headers)
    if (!headers.has('set-cookie')) appendLogoutCookies(headers, config.cookieNames)

    return new Response(null, { status: 303, headers })
  })
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
