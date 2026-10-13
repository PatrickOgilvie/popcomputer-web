/** Application setup for @popcomputer/web. */

import { createMiddleware } from 'hono/factory'
import type { Hono } from 'hono'
import type { MiddlewareHandler, Env, Context } from 'hono'
import type { Config, Layer, Schema as S } from 'effect'
import { web } from './middleware.js'
import { verifyOrigin, type VerifyOriginConfig } from './security.js'
import type { PagePropValue, WebConfig } from './types.js'
import { loadUserMiddleware, shareAuthMiddleware } from './effect/auth.js'
import { openWebContext } from './request-context.js'
import { readTestDatabase } from './effect/test-env.js'
import { pageCache } from './page-cache.js'
import type {
  AuthService,
  DatabaseService,
  WebAuthUserType,
  DatabaseType,
  AuthType,
  BindingsType,
  AuthUser,
} from './effect/services.js'
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
import type { PagesOption } from './effect/pages.js'

/** Default Hono environment derived from the application's bindings augmentation. */
type DefaultEnv = {
  Bindings: BindingsType
}

/** Better Auth-compatible owner for deferred promise work. */
export interface AuthBackgroundTasks {
  readonly handler: (promise: Promise<unknown>) => void
}

/** Better Auth configuration: client construction, session parsing and projection. */
interface WebAuthBaseOptions<E extends Env, Auth, ClientServices> {
  /** Build the Better Auth server client at the request composition seam. */
  client?: (c: Context<E>, services: ClientServices) => Auth
  /** Explicit public projection placed at `auth.user` in page props. */
  share?: (auth: AuthUser) => PagePropValue
  readonly sessionCookie?: string
  /**
   * Where a signed-out visitor goes when a route needs a user: `authorize()`
   * and `RequireAuthLayer` redirect here. Defaults to `/login`.
   */
  readonly signInPath?: string
}

interface WebAuthOptionsWithDefaultUser<E extends Env, Auth, ClientServices>
  extends WebAuthBaseOptions<E, Auth, ClientServices> {
  /**
   * Parse Better Auth's session response before actions receive it.
   * Defaults to Better Auth's default user and session.
   */
  readonly session?: S.Codec<AuthUser, unknown, never, never>
}

interface WebAuthOptionsWithCustomUser<E extends Env, Auth, ClientServices>
  extends WebAuthBaseOptions<E, Auth, ClientServices> {
  /**
   * Parse Better Auth's session response into the augmented AuthUser.
   * Required: the default parser decodes only Better Auth's default user.
   */
  readonly session: S.Codec<AuthUser, unknown, never, never>
}

/**
 * Better Auth configuration. `session` is required once the application
 * augments WebAuthUserType.
 */
type WebAuthOptions<E extends Env, Auth, ClientServices> =
  WebAuthUserType extends { type: unknown }
    ? WebAuthOptionsWithCustomUser<E, Auth, ClientServices>
    : WebAuthOptionsWithDefaultUser<E, Auth, ClientServices>

interface WebSetupOptions<E extends Env, AppServices, RequestServices> extends WebConfig {
  /**
   * Drizzle schema for route model binding.
   *
   * @example
   * ```typescript
   * import * as schema from '~/db/schema'
   *
   * setupWeb(app, { version, render, schema })
   * ```
   */
  schema?: object
  /** Row parsers and optional scope metadata for route-model bindings. */
  bindings?: RouteBindingsConfig

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
 * Database, schema, rendering, auth and services are configured at one
 * application boundary. Types are inferred from the supplied factories: the
 * auth client receives the request's database only when `database` is set.
 */
export interface WebSetupConfig<
  E extends Env = DefaultEnv,
  DB extends object = never,
  Auth = never,
  AppServices = never,
  RequestServices = never,
> extends WebSetupOptions<E, AppServices, RequestServices>, WebPagesOption {
  /**
   * Database factory function. Creates the database client for each request.
   * Leave it out for applications without persistence or with stateless auth.
   *
   * @example
   * ```typescript
   * database: (c) => createDb(c.env.DATABASE_URL)
   * ```
   */
  database?: (c: Context<E>) => DB
  /** Authentication. The client factory receives the request's database when one is configured. */
  // NoInfer: DB comes from `database` alone, never from the client's parameters.
  auth?: WebAuthOptions<E, Auth, AuthClientServices<NoInfer<DB>>>
}

/**
 * Each page component's props schema, which `render` checks and encodes props
 * with. Required once the application augments WebPagesType, and then the
 * same registry.
 */
type WebPagesOption = PagesOption

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

/** The configured application returned by {@link setupWeb}. */
export interface WebApplication<E extends Env, Services = BaseServices> {
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
 * shared error boundary on `app`, and returns the routes to register on.
 *
 * @example
 * ```ts
 * export const { app, routes } = setupWeb(new Hono<Env>(), {
 *   version: createVersion(manifest),
 *   render: createTemplate({ title: 'My App' }),
 *   database: (c) => createDb(c.env.DATABASE_URL),
 *   schema,
 *   bindings: { workspace: Workspace },
 *   auth: {
 *     client: (_c, { db }) => createAuth({ db }),
 *     session: AuthSession,
 *   },
 * })
 *
 * routes.get('/workspaces/{workspace}', showWorkspace)
 * ```
 */
export function setupWeb<
  E extends Env = DefaultEnv,
  DB extends object = never,
  Auth = never,
  AppServices = never,
  RequestServices = never,
>(
  app: Hono<E>,
  config: WebSetupConfig<E, DB, Auth, AppServices, RequestServices>
): WebApplication<
  E,
  WebRouteServices<[DB] extends [never] ? false : true, Auth, AppServices | RequestServices>
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
>(
  config: WebSetupConfig<E, DB, Auth, AppServices, RequestServices>
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
      // Set up database first (auth may depend on it)
      // SAFETY: DB/Auth generics are the app's declared client types; the
      // WebDatabaseType/WebAuthType module augmentations make these
      // the same types DatabaseService/AuthService hand back to handlers.
      // A test request may bring its own database (testEnv's `database`).
      const testDatabase = readTestDatabase(c.env)
      // SAFETY: testEnv types the database as DatabaseType, which the
      // application's WebDatabaseType augmentation makes the factory's DB.
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
  }

  const middlewares: MiddlewareHandler<E>[] = [
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
      session: config.auth?.session,
    }),
    shareAuthMiddleware<E>({
      project: config.auth?.share,
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
