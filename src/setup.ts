/** Application setup for @popcomputer/web. */

import { createMiddleware } from 'hono/factory'
import type { Hono } from 'hono'
import type { MiddlewareHandler, Env, Context } from 'hono'
import type { Config, Layer, Schema as S } from 'effect'
import { web } from './middleware.js'
import { verifyOrigin, type VerifyOriginConfig } from './security.js'
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
import { NotFoundError } from './effect/errors.js'
import type { RouteBindingsConfig } from './effect/binding.js'
import type { PageSchemas } from './effect/pages.js'

/** Better Auth-compatible owner for deferred promise work. */
export interface AuthBackgroundTasks {
  readonly handler: (promise: Promise<unknown>) => void
}

/** Better Auth: the client, the signed-in user it decodes, and the user pages see. */
export interface WebAuthOptions<E extends Env, Auth, ClientServices, User, PublicUser extends object> {
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
  readonly signInPath?: string
}

interface WebSetupOptions<E extends Env, AppServices, RequestServices> extends WebConfig {

  /**
   * Application services every route can use. Their types join the services
   * the returned `routes` accept.
   */
  services?: {
    /**
     * Built once, on the first request an isolate serves, and shared by every
     * later request: configuration, clients that open no connection until
     * used, in-memory caches. Never request-bound I/O objects (D1, KV or
     * Hyperdrive handles, open sockets), which Workers forbid using from
     * another request. Effect `Config` reads the Worker's bindings, and a
     * missing one fails requests with a configuration error naming it.
     */
    app?: Layer.Layer<AppServices, Config.ConfigError>
    /**
     * Built for each request, from its context and bindings. Effect `Config`
     * reads the Worker's bindings here too.
     */
    request?: (c: Context<E>) => Layer.Layer<RequestServices, Config.ConfigError>
  }

  /**
   * Additional middleware to run after the framework middleware.
   * These run in order after effectBridge.
   */
  middleware?: MiddlewareHandler<E>[]

  /** Optional security hardening. */
  security?: {
    /**
     * Enable CSRF defense-in-depth by verifying the `Origin`/`Referer` of
     * state-changing requests. Opt-in — see {@link VerifyOriginConfig}.
     * Runs before all other framework middleware so rejected requests
     * short-circuit cheaply.
     */
    verifyOrigin?: VerifyOriginConfig
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
  AppServices = never,
  RequestServices = never,
  User = DefaultAuthUser,
  PublicUser extends object = DefaultPublicUser,
  Schema extends object = never,
  RouteBindings extends RouteBindingsConfig = never,
  Pages extends PageSchemas = never,
  SharedFields extends S.Struct.Fields = never,
  FlashFields extends S.Struct.Fields = never,
> extends WebSetupOptions<E, AppServices, RequestServices> {
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
  readonly auth?: WebAuthOptions<E, Auth, AuthClientServices<NoInfer<DB>>, User, PublicUser>
  /** The Drizzle schema route model binding reads tables and relations from. */
  readonly schema?: Schema
  /** Each route model binding's row parser, by route placeholder (`{project}`). */
  readonly bindings?: RouteBindings
  /** Each page component's props schema, which `render` checks and encodes props with. */
  readonly pages?: Pages
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
}

/** What the auth client factory receives: the database when one is configured. */
type AuthClientServices<DB> = [DB] extends [never]
  ? { readonly backgroundTasks: AuthBackgroundTasks }
  : { readonly db: DB; readonly backgroundTasks: AuthBackgroundTasks }

/**
 * The services routes can use under a setup: the core services, the database
 * and auth services when configured, and `services.app` and `services.request`.
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
export interface WebApplication<E extends Env, Services = BaseServices, Types extends WebTypes = WebTypes>
  extends WebDeclaration<Types> {
  readonly app: Hono<E>
  /**
   * Registers the application's routes. An action registered here may use
   * exactly the services this setup provides; anything else is a type error
   * naming the missing service. `routes.toJson()` lists every route.
   */
  readonly routes: EffectRouteBuilder<E, Services>
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
 *   bindings: { workspace: Workspace },
 *   pages,
 *   auth: { client: (_c, { db }) => createAuth({ db }), session: AuthSession },
 * })
 *
 * declare module '@popcomputer/web' {
 *   interface Register {
 *     web: typeof web
 *   }
 * }
 *
 * web.routes.get('/workspaces/{workspace}', showWorkspace)
 * ```
 */
export function setupWeb<
  E extends Env = Env,
  DB extends object = never,
  Auth = never,
  AppServices = never,
  RequestServices = never,
  User = DefaultAuthUser,
  PublicUser extends object = DefaultPublicUser,
  Schema extends object = never,
  const RouteBindings extends RouteBindingsConfig = never,
  const Pages extends PageSchemas = never,
  SharedFields extends S.Struct.Fields = never,
  FlashFields extends S.Struct.Fields = never,
>(
  app: Hono<E>,
  config: WebSetupConfig<
    E, DB, Auth, AppServices, RequestServices, User, PublicUser, Schema, RouteBindings, Pages, SharedFields, FlashFields
  >
): WebApplication<
  E,
  WebRouteServices<[DB] extends [never] ? false : true, Auth, AppServices | RequestServices>,
  SetupTypes<E, DB, Auth, User, PublicUser, Schema, RouteBindings, Pages, SharedFields, FlashFields>
> {
  assertSetupConfig(config)
  app.use('*', createSetupMiddleware(config))
  registerErrorHandlers(app, config.errors)

  return { app, routes: new EffectRouteBuilder(app) }
}

function createSetupMiddleware<
  E extends Env,
  DB extends object,
  Auth,
  AppServices,
  RequestServices,
  User,
  PublicUser extends object,
  Schema extends object,
  RouteBindings extends RouteBindingsConfig,
  Pages extends PageSchemas,
  SharedFields extends S.Struct.Fields,
  FlashFields extends S.Struct.Fields,
>(
  config: WebSetupConfig<
    E, DB, Auth, AppServices, RequestServices, User, PublicUser, Schema, RouteBindings, Pages, SharedFields, FlashFields
  >
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
    app: config.services?.app,
    services: config.services?.request,
    schema: config.schema,
    bindings: config.bindings,
    pages: config.pages,
    shared: config.shared,
    flash: config.flash,
  }

  const middlewares: MiddlewareHandler<E>[] = [
    // Outermost, so it sees every response, including the page cache's own.
    privateByDefault<E>(),
    // Origin verification runs first so cross-origin writes are rejected
    // before any per-request setup work (db/auth client creation) happens.
    ...(config.security?.verifyOrigin
      ? [verifyOrigin<E>(config.security.verifyOrigin)]
      : []),
    // A cached page is served before db/auth setup, session lookup or rendering.
    ...(config.pageCache === false
      ? []
      : [
          pageCache<E>({
            version: config.version,
            sessionCookie: config.auth?.sessionCookie,
          }),
        ]),
    setupServices,
    web(webConfig),
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

function assertSetupConfig(config: object): void {
  const auth: unknown = Object.getOwnPropertyDescriptor(config, 'auth')?.value

  if (auth instanceof Function) {
    throw new Error(
      'Invalid setupWeb configuration: pass the auth factory as auth.client.'
    )
  }

  if (Object.hasOwn(config, 'effect')) {
    throw new Error(
      'Invalid setupWeb configuration: effect.services is now services.request, and schema and bindings are top-level options.'
    )
  }
}

/**
 * Error handler configuration.
 */
export type ErrorHandlerConfig = ErrorBoundaryConfig

/**
 * Creates error handlers for the shared error boundary.
 *
 * Returns an object with `notFound` and `onError` handlers
 * that you can pass to app.notFound() and app.onError().
 *
 * @example
 * ```ts
 * const { notFound, onError } = createErrorHandlers()
 * app.notFound(notFound)
 * app.onError(onError)
 * ```
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
