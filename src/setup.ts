/** Application setup for @popcomputer/web. */

import { createMiddleware } from 'hono/factory'
import type { Hono } from 'hono'
import type { MiddlewareHandler, Env, Context } from 'hono'
import type { Config, Layer, Schema as S } from 'effect'
import { web } from './middleware.js'
import { activeSignInLimits, type RateLimiterName, type SignInLimitsConfig } from './effect/sign-in-limits.js'
import { originRefusal, securityHeaders, type SecurityHeadersConfig, type VerifyOriginConfig } from './security.js'
import type { WebConfig } from './types.js'
import { loadUserMiddleware, shareAuthMiddleware } from './effect/auth.js'
import { openWebContext } from './request-context.js'
import { readTestDatabase } from './effect/test-env.js'
import { pageCache, privateByDefault } from './page-cache.js'
import type {
  AuthService,
  DatabaseService,
  DatabaseType,
  AuthType,
  AuthUser,
  DefaultAuthUser,
} from './effect/services.js'
import type { DefaultPublicUser } from './effect/auth.js'
import type { WebDeclaration, WebTypes } from './effect/register.js'
import {
  EffectRouteBuilder,
  declareAppBindings,
  type BaseServices,
  type CoreServices,
} from './effect/routing.js'
import {
  drainRequestBackground,
  effectBridge,
  getRequestExecutionContextClient,
  type EffectBridgeConfig,
} from './effect/bridge.js'
import {
  renderErrorResponse,
  type ErrorBoundaryConfig,
} from './effect/handler.js'
import { ForbiddenError, HttpError, NotFoundError } from './effect/errors.js'
import { assertBindingsConfig, type RouteBindingsConfig } from './effect/binding.js'
import type { PageSchemas } from './effect/pages.js'

/** Better Auth-compatible owner for deferred promise work. */
export interface AuthBackgroundTasks {
  readonly handler: (promise: Promise<unknown>) => void
}

/** Better Auth: the client, the signed-in user it decodes, and the user pages see. */
export interface WebAuthOptions<
  E extends Env,
  Auth,
  ClientServices,
  User,
  PublicUser extends object,
  SignInPath extends string = string,
> {
  /** Build the Better Auth server client at the request composition seam. */
  readonly client?: (c: Context<E>, services: ClientServices) => Auth
  /**
   * Decode Better Auth's session response into the signed-in user every action
   * sees (`authorize`, `currentUser`, `AuthUserService`). Defaults to Better
   * Auth's default user and session; an application that adds user fields
   * declares them here, and the user type follows.
   */
  readonly session?: S.Codec<User, unknown, never, never>
  /**
   * The user pages receive as `auth.user`, as an Effect Schema. The signed-in
   * user is encoded through it, so a field it does not name never reaches the
   * browser, and `WebPage` types `auth.user` from it. Defaults to `id`, `name`
   * and `image`.
   */
  readonly share?: S.Codec<PublicUser, unknown, never, never>
  readonly sessionCookie?: string
  /**
   * Where a signed-out visitor goes when a route needs a user: `authorize()`
   * and `RequireAuthLayer` redirect here. Defaults to `/login`.
   */
  readonly signInPath?: SignInPath
  /**
   * Where a signed-in visitor goes from a page for guests, such as the
   * sign-in page: `RequireGuestLayer` redirects here. Defaults to `/`.
   */
  readonly homePath?: SignInPath
  /**
   * Slow down password guessing: a Cloudflare Rate Limiting binding counts
   * each client address's sign-in, sign-up and password calls and each
   * account's sign-ins, and Better Auth's `rateLimit` table counts an
   * account's failed sign-ins, cooling it down past `failures.max`.
   *
   * @example
   * signInLimits: { limiter: 'SIGN_IN_LIMITER', table: schema.rateLimit }
   */
  readonly signInLimits?: SignInLimitsConfig<RateLimiterName<E extends { Bindings: infer Bindings } ? Bindings : never>>
}

interface WebSetupOptions<E extends Env> extends WebConfig {

  /**
   * Additional middleware to run after the framework middleware.
   * These run in order after effectBridge.
   */
  middleware?: MiddlewareHandler<E>[]

  /** Security hardening. */
  security?: {
    /**
     * CSRF defense in depth, on by default: a state-changing request whose
     * `Origin` (or `Referer`) names another site is refused with 403. A
     * request without either, such as a webhook or a server's, passes. List
     * other origins allowed to post, such as a native app's, in
     * `allowedOrigins` (see {@link VerifyOriginConfig}); `false` turns the
     * check off. It runs before the other framework middleware, so a refused
     * request costs no database or auth work.
     */
    verifyOrigin?: VerifyOriginConfig | false
    /**
     * Headers every response gets unless it sets its own, on by default:
     * `X-Content-Type-Options: nosniff`, `Referrer-Policy:
     * strict-origin-when-cross-origin`, and framing refused
     * (`X-Frame-Options: DENY`, `frame-ancestors 'none'`), so another site
     * cannot frame a page to trick a visitor into clicking. `{ frames:
     * 'same-origin' }` lets the application frame its own pages; `false`
     * sends none of them.
     */
    headers?: SecurityHeadersConfig | false
  }

  /** Error component and environment policy for the shared error boundary. */
  errors?: ErrorHandlerConfig

  /**
   * Cache static pages at the edge (default `true`). Pages that read no
   * bindings, headers or request state are served from Cloudflare's Cache API
   * until the next deploy; everything else renders fresh. `false` turns the
   * page cache off for the whole app.
   */
  pageCache?: boolean
}

/** The application's own services, which `web.services(...)` adds to every route. */
export interface WebServices<E extends Env, AppServices, RequestServices> {
  /**
   * Built once, on the first request an isolate serves, and shared by every
   * later request: configuration, clients that open no connection until
   * used, in-memory caches. Never request-bound I/O objects (D1, KV or
   * Hyperdrive handles, open sockets), which Workers forbid using from
   * another request. Effect `Config` reads the Worker's bindings, and a
   * missing one fails requests with a configuration error naming it. A
   * build that fails is retried by the next request.
   */
  readonly app?: Layer.Layer<AppServices, Config.ConfigError>
  /**
   * Built for each request, from its context and bindings, replacing an
   * application service with the same tag. Effect `Config` reads the
   * Worker's bindings here too.
   */
  readonly request?: (c: Context<E>) => Layer.Layer<RequestServices, Config.ConfigError>
}

/**
 * Flat configuration accepted by {@link setupWeb}.
 *
 * Every type the application uses is declared here once and inferred from
 * the values given: the database client, the Better Auth client, the
 * signed-in and public user, the Drizzle schema, route model bindings,
 * pages, shared props and flash data. `setupWeb`'s result carries them, and
 * registering it types the rest of the application.
 */
export interface WebSetupConfig<
  E extends Env = Env,
  DB extends object = never,
  Auth = never,
  User = DefaultAuthUser,
  PublicUser extends object = DefaultPublicUser,
  Schema extends object = never,
  RouteBindings extends RouteBindingsConfig = never,
  Pages extends PageSchemas = never,
  SharedFields extends S.Struct.Fields = never,
  FlashFields extends S.Struct.Fields = never,
  Paths extends RoutePaths = RoutePaths,
> extends WebSetupOptions<E> {
  /**
   * Database factory function. Creates the database client for each request.
   * Leave it out for applications without persistence or with stateless auth.
   *
   * @example
   * ```typescript
   * database: (c) => createDb(c.env.DATABASE_URL)
   * ```
   */
  readonly database?: (c: Context<E>) => DB
  /** Authentication. The client factory receives the request's database when one is configured. */
  // NoInfer: DB comes from `database` alone, never from the client's parameters.
  readonly auth?: WebAuthOptions<E, Auth, AuthClientServices<NoInfer<DB>>, User, PublicUser, NoInfer<RoutePath<Paths>>>
  /** The Drizzle schema route model binding reads tables and relations from. */
  readonly schema?: Schema
  /** Each route model binding's row parser, by route placeholder (`{project}`). */
  readonly bindings?: RouteBindings
  /** Each page component's props schema, which `render` checks and encodes props with. */
  readonly pages?: Pages
  /**
   * Every route's path, as `src/paths.ts` declares them. Routes registered on
   * `routes` must use one of them, so a path that is not declared is a type
   * error at its registration.
   */
  readonly paths?: Paths
  /**
   * Props shared with every page, besides `auth`, as an Effect Schema struct:
   * `share(key, value)` takes its fields, and `WebPage` types them.
   */
  readonly shared?: S.Struct<SharedFields>
  /**
   * The values `flash(key, value)` hands to the next page, as an Effect Schema
   * struct; the page's Inertia `flash` is typed from it.
   */
  readonly flash?: S.Struct<FlashFields>
}

/** The types a setup declares, as its result carries them for registration. */
export interface SetupTypes<
  E extends Env,
  DB,
  Auth,
  User,
  PublicUser,
  Schema,
  RouteBindings,
  Pages,
  SharedFields extends S.Struct.Fields,
  FlashFields extends S.Struct.Fields,
  Paths = never,
> extends WebTypes {
  readonly bindings: E extends { Bindings: infer Bindings } ? Bindings : never
  readonly database: DB
  readonly schema: Schema
  readonly auth: Auth
  readonly user: User
  readonly publicUser: PublicUser
  readonly routeBindings: RouteBindings
  readonly pages: Pages
  readonly shared: [SharedFields] extends [never] ? never : S.Struct.Type<SharedFields>
  readonly flash: [FlashFields] extends [never] ? never : S.Struct.Type<FlashFields>
  readonly paths: Paths
}

/** What the auth client factory receives: the database when one is configured. */
type AuthClientServices<DB> = [DB] extends [never]
  ? { readonly backgroundTasks: AuthBackgroundTasks }
  : { readonly db: DB; readonly backgroundTasks: AuthBackgroundTasks }

/**
 * The services routes can use under a setup: the core services, the database
 * and auth services when configured, and the services `web.services(...)` gives.
 */
export type WebRouteServices<HasDatabase extends boolean, Auth, CustomServices> =
  | CoreServices
  | (HasDatabase extends true ? DatabaseService : never)
  | ([Auth] extends [never] ? never : AuthService)
  | CustomServices

/**
 * The configured application returned by {@link setupWeb}. It carries the
 * types its setup declares: register it once, and the rest of the
 * application is typed by them.
 *
 * @example
 * ```ts
 * declare module '@popcomputer/web' {
 *   interface Register {
 *     web: typeof web
 *   }
 * }
 * ```
 */
/** Route paths by name, as `src/paths.ts` declares them. */
export type RoutePaths = Readonly<Record<string, string>>

/** The paths `routes` registers on: the declared ones, or any path when none are. */
export type RoutePath<Paths extends RoutePaths> = [Paths] extends [never] ? string : Paths[keyof Paths]

export interface WebApplication<
  E extends Env,
  Services = BaseServices,
  Types extends WebTypes = WebTypes,
  Path extends string = string,
> extends WebDeclaration<Types> {
  readonly app: Hono<E>
  /**
   * Registers the application's routes. An action registered here may use
   * exactly the services this setup provides; anything else is a type error
   * naming the missing service. `routes.toJson()` lists every route.
   */
  readonly routes: EffectRouteBuilder<E, Services, Path>
  /**
   * Give the application's own services, after the application is
   * registered, and receive the routes that may use them: an action
   * registered there may use them as it uses the database. Given here
   * rather than in `setupWeb`, a service layer's type is inferred even when
   * it reads `dbQuery`, `config` or `bound`, which `setupWeb`'s registration
   * types. Call it once.
   *
   * @example
   * export const { app, routes } = web.services({
   *   app: ProjectsLive,
   *   request: (c) => auditLogFor(c.env.KV),
   * })
   */
  services<AppServices = never, RequestServices = never>(
    services: WebServices<E, AppServices, RequestServices>
  ): {
    readonly app: Hono<E>
    readonly routes: EffectRouteBuilder<E, Services | AppServices | RequestServices, Path>
  }
}

/**
 * Configure an application with one flat, inferred setup object.
 *
 * Installs the framework middleware (page cache, database and auth clients,
 * Inertia rendering, session loading, the per-request Effect runtime) and the
 * shared error boundary on `app`, and returns the app, the routes to register
 * on, and the types the configuration declares.
 *
 * @example
 * ```ts
 * export const web = setupWeb(new Hono<Env>(), {
 *   version: createVersion(manifest),
 *   render: createTemplate({ title: 'My App' }),
 *   database: (c) => createDb(c.env.DATABASE_URL),
 *   schema,
 *   bindings: { workspace: schema.workspaces },
 *   pages,
 *   paths,
 *   auth: {
 *     client: (c, { db }) => createAuth({ db, secret: c.env.BETTER_AUTH_SECRET }),
 *     session: betterAuthSession(tableSchema(schema.user)),
 *   },
 * })
 *
 * declare module '@popcomputer/web' {
 *   interface Register {
 *     web: typeof web
 *   }
 * }
 *
 * // With services of the application's own; without, `export const { app, routes } = web`.
 * export const { app, routes } = web.services({ app: ClockLive })
 *
 * routes.get(paths.workspace, showWorkspace)
 * ```
 */
export function setupWeb<
  E extends Env = Env,
  DB extends object = never,
  Auth = never,
  User = DefaultAuthUser,
  PublicUser extends object = DefaultPublicUser,
  Schema extends object = never,
  const RouteBindings extends RouteBindingsConfig = never,
  const Pages extends PageSchemas = never,
  SharedFields extends S.Struct.Fields = never,
  FlashFields extends S.Struct.Fields = never,
  const Paths extends RoutePaths = never,
>(
  app: Hono<E>,
  config: WebSetupConfig<
    E, DB, Auth, User, PublicUser, Schema, RouteBindings, Pages, SharedFields, FlashFields, Paths
  >
): WebApplication<
  E,
  WebRouteServices<[DB] extends [never] ? false : true, Auth, never>,
  SetupTypes<E, DB, Auth, User, PublicUser, Schema, RouteBindings, Pages, SharedFields, FlashFields, Paths>,
  RoutePath<Paths>
> {
  assertSetupConfig(config)
  if (config.bindings !== undefined) assertBindingsConfig(config.bindings, config.schema)

  // The application's own services, which `web.services(...)` gives after
  // setup; requests read them from here.
  const services: ServiceSlots<E> = {}
  let servicesGiven = false

  app.use('*', createSetupMiddleware(config, services))
  registerErrorHandlers(app, config.errors)

  declareAppBindings(app, { bindings: config.bindings, schema: config.schema })

  return {
    app,
    routes: new EffectRouteBuilder(app),
    services: (given) => {
      if (servicesGiven) {
        throw new Error('web.services(...) was called twice: give every application service in one call.')
      }

      servicesGiven = true
      // SAFETY: the bridge provides these layers to every request, whose
      // services the returned routes' type adds.
      services.app = given.app as Layer.Layer<never, Config.ConfigError> | undefined
      services.request = given.request as ((c: Context<E>) => Layer.Layer<never, Config.ConfigError>) | undefined

      return { app, routes: new EffectRouteBuilder(app) }
    },
  }
}

/** Where `web.services(...)` puts the application's services for the bridge to read on each request. */
interface ServiceSlots<E extends Env> {
  app?: Layer.Layer<never, Config.ConfigError>
  request?: (c: Context<E>) => Layer.Layer<never, Config.ConfigError>
}

function createSetupMiddleware<
  E extends Env,
  DB extends object,
  Auth,
  User,
  PublicUser extends object,
  Schema extends object,
  RouteBindings extends RouteBindingsConfig,
  Pages extends PageSchemas,
  SharedFields extends S.Struct.Fields,
  FlashFields extends S.Struct.Fields,
>(
  config: WebSetupConfig<
    E, DB, Auth, User, PublicUser, Schema, RouteBindings, Pages, SharedFields, FlashFields
  >,
  services: ServiceSlots<E>
): MiddlewareHandler<E> {
  const webConfig: WebConfig = {
    version: config.version,
    render: config.render,
  }

  // Middleware to wire db and auth into the typed request context
  // oxlint-disable-next-line effecttsgo/async-function -- Hono middleware and renderer contracts use native next()/Response promises; typed Effect work stays inside that request boundary.
  const setupServices: MiddlewareHandler<E> = createMiddleware<E>(async (c, next) => {
    const requestCtx = openWebContext(c)
    requestCtx.errorBoundary = config.errors
    requestCtx.signInPath = config.auth?.signInPath
    requestCtx.homePath = config.auth?.homePath
    const signInLimits = config.auth?.signInLimits
    requestCtx.signInLimits = signInLimits === undefined ? undefined : activeSignInLimits(signInLimits, c.env ?? {})
    const executionContext = getRequestExecutionContextClient(c)

    const backgroundTasks: AuthBackgroundTasks = {
      handler: executionContext.waitUntil,
    }

    try {
      // Set up database first (auth may depend on it). A test request may
      // bring its own database (testEnv's `database`).
      const testDatabase = readTestDatabase(c.env)
      // SAFETY: testEnv types the database as DatabaseType, which the
      // application's registration makes this setup's DB.
      const db = testDatabase === undefined ? config.database?.(c) : testDatabase as DB

      if (db !== undefined) {
        // SAFETY: Setup owns this request-scoped value and stores it under the matching private key, preserving the generic contract on retrieval.
        requestCtx.db = db as DatabaseType
      }

      if (config.auth?.client !== undefined) {
        // SAFETY: AuthClientServices<DB> carries `db` exactly when `database`
        // is configured, which is when `db` is defined here; the conditional
        // type cannot be resolved for the generic DB inside this function.
        const createAuth = config.auth.client as (
          c: Context<E>,
          services: { readonly db?: DB; readonly backgroundTasks: AuthBackgroundTasks }
        ) => Auth

        // SAFETY: Setup owns this request-scoped value and stores it under the matching private key, preserving the generic contract on retrieval.
        requestCtx.auth = createAuth(c, db === undefined ? { backgroundTasks } : { db, backgroundTasks }) as AuthType
      }

      await next()
    } finally {
      await drainRequestBackground(c)
    }
  })

  const effectConfig: EffectBridgeConfig<E, never> = {
    // Read on each request, so services given after setup apply.
    get app() {
      return services.app
    },
    get services() {
      return services.request
    },
    schema: config.schema,
    bindings: config.bindings,
    pages: config.pages,
    shared: config.shared,
    flash: config.flash,
  }

  const middlewares: MiddlewareHandler<E>[] = [
    // Outermost, so they see every response, including the page cache's own.
    ...(config.security?.headers === false ? [] : [securityHeaders<E>(config.security?.headers ?? {})]),
    privateByDefault<E>(),
    // A cached page is served before db/auth setup, session lookup or rendering.
    ...(config.pageCache === false
      ? []
      : [
          pageCache<E>({
            version: config.version ?? '',
            sessionCookie: config.auth?.sessionCookie,
          }),
        ]),
    setupServices,
    web(webConfig),
    // Origin verification runs once the error page can render, before the
    // session lookup, so a refused request costs no database work and every
    // client gets the boundary's answer: an error page or the JSON envelope.
    ...(config.security?.verifyOrigin === false
      ? []
      : [refuseForeignOrigins<E>(config.security?.verifyOrigin ?? {}, config.errors)]),
    loadUserMiddleware<E>({
      sessionCookie: config.auth?.sessionCookie,
      // SAFETY: the registered AuthUser is this setup's User, the type
      // `auth.session` decodes; inside setupWeb the two are not yet related.
      session: config.auth?.session as S.Codec<AuthUser, unknown, never, never> | undefined,
    }),
    shareAuthMiddleware<E>({
      schema: config.auth?.share,
    }),
    effectBridge<E, never>(effectConfig),
    ...(config.middleware ?? []),
  ]

  // oxlint-disable-next-line effecttsgo/async-function -- Hono middleware and renderer contracts use native next()/Response promises; typed Effect work stays inside that request boundary.
  return createMiddleware<E>(async (c, next) => {
    // Mirrors Hono's compose contract: next() resolves to void, wrapper
    // middleware observe downstream responses via c.res after awaiting it,
    // and a middleware that returns a Response (without finalizing the
    // context) has that response adopted — exactly like hono/compose.
    // oxlint-disable-next-line effecttsgo/async-function -- Hono middleware and renderer contracts use native next()/Response promises; typed Effect work stays inside that request boundary.
    const dispatch = async (i: number): Promise<void> => {
      if (i >= middlewares.length) {
        await next()

        return
      }

      // oxlint-disable-next-line effecttsgo/async-function -- Hono middleware and renderer contracts use native next()/Response promises; typed Effect work stays inside that request boundary.
      const res = await middlewares[i](c, async () => {
        await dispatch(i + 1)
      })

      if (res instanceof Response && !c.finalized) {
        // oxlint-disable-next-line no-param-reassign -- Hono middleware replaces c.res to apply the framework's response policy.
        c.res = res
      }
    }

    await dispatch(0)

    // Return the response for proper propagation in forwarding/proxy scenarios
    return c.res
  })
}

/** Origin verification answered through the error boundary. */
function refuseForeignOrigins<E extends Env>(
  verify: VerifyOriginConfig,
  errors: ErrorHandlerConfig | undefined
): MiddlewareHandler<E> {
  // oxlint-disable-next-line effecttsgo/async-function -- Hono middleware and renderer contracts use native next()/Response promises; typed Effect work stays inside that request boundary.
  return createMiddleware<E>(async (c, next) => {
    const refused = originRefusal(c, verify)

    if (refused === undefined) return next()

    const status = verify.status ?? 403
    const error = status === 403
      ? new ForbiddenError({ message: refused })
      : new HttpError({ status, message: refused })

    return renderErrorResponse(error, c, errors)
  })
}

function assertSetupConfig(config: object): void {
  const auth: unknown = Object.getOwnPropertyDescriptor(config, 'auth')?.value

  if (auth instanceof Function) {
    throw new Error(
      'Invalid setupWeb configuration: pass the auth factory as auth.client.'
    )
  }

  if (Object.hasOwn(config, 'services')) {
    throw new Error(
      "Invalid setupWeb configuration: give the application's services after registering it, as `export const { app, routes } = web.services({ app, request })`."
    )
  }

  if (Object.hasOwn(config, 'effect')) {
    throw new Error(
      "Invalid setupWeb configuration: effect.services is now web.services({ request }), and schema and bindings are top-level options."
    )
  }
}

/**
 * Error handler configuration.
 */
export type ErrorHandlerConfig = ErrorBoundaryConfig

/**
 * The shared error boundary's `notFound` and `onError` handlers, which
 * `registerErrorHandlers` installs.
 *
 * @internal
 */
export function createErrorHandlers<E extends Env>(config: ErrorHandlerConfig = {}) {
  const notFound = (c: Context<E>) =>
    renderErrorResponse(new NotFoundError({ resource: 'page' }), c, {
      ...config,
      log: false,
    })

  const onError = (error: Error, c: Context<E>) =>
    renderErrorResponse(error, c, config)

  return { notFound, onError }
}

/**
 * Registers error handlers on a Hono app.
 *
 * @example
 * ```ts
 * import { registerErrorHandlers } from '@popcomputer/web'
 *
 * registerErrorHandlers(app)
 * ```
 */
export function registerErrorHandlers<E extends Env>(
  app: Pick<Hono<E>, 'notFound' | 'onError'>,
  config: ErrorHandlerConfig = {}
): void {
  const { notFound, onError } = createErrorHandlers<E>(config)
  app.notFound(notFound)
  app.onError(onError)
}
