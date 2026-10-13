/** Application setup for @popcomputer/web. */

import { createMiddleware } from 'hono/factory'
import type { Hono } from 'hono'
import type { MiddlewareHandler, Env, Context } from 'hono'
import type { Schema as S } from 'effect'
import { web } from './middleware.js'
import { verifyOrigin, type VerifyOriginConfig } from './security.js'
import type { PagePropValue, WebConfig } from './types.js'
import { loadUser, shareAuthMiddleware } from './effect/auth.js'
import { openWebContext } from './request-context.js'
import { pageCache } from './page-cache.js'
import type {
  AuthService,
  DatabaseService,
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

/** Default Hono environment derived from the application's bindings augmentation. */
type DefaultEnv = {
  Bindings: BindingsType
}

/** Better Auth-compatible owner for deferred promise work. */
export interface AuthBackgroundTasks {
  readonly handler: (promise: Promise<unknown>) => void
}

/** Better Auth configuration: client construction, session parsing and projection. */
interface WebAuthOptions<E extends Env, Auth, ClientServices> {
  /** Build the Better Auth server client at the request composition seam. */
  client?: (c: Context<E>, services: ClientServices) => Auth
  /**
   * Parse Better Auth's session response before actions receive it.
   * The encoded side is intentionally unconstrained because decodeUnknown
   * owns the external boundary; the decoded AuthUser and context stay strict.
   */
  session?: S.Codec<AuthUser, unknown, never, never>
  /** Explicit public projection placed at `auth.user` in page props. */
  share?: (auth: AuthUser) => PagePropValue
  readonly sessionCookie?: string
}

interface WebSetupOptions<E extends Env, CustomServices> extends WebConfig {
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
   * Services every route can use, built for each request. Their types join
   * the services the returned `routes` accept.
   */
  effect?: Pick<EffectBridgeConfig<E, CustomServices>, 'services'>

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

/** Complete framework configuration when a database factory is present. */
interface WebSetupWithDatabaseConfig<
  E extends Env = DefaultEnv,
  DB extends object = DatabaseType,
  Auth = never,
  CustomServices = never,
> extends WebSetupOptions<E, CustomServices> {
  /**
   * Database factory function.
   * Creates the database client for each request.
   *
   * @example
   * ```typescript
   * database: (c) => createDb(c.env.DATABASE_URL)
   * ```
   */
  database: (c: Context<E>) => DB
  /** Authentication. The client factory receives the request's database. */
  auth?: WebAuthOptions<E, Auth, {
    readonly db: DB
    readonly backgroundTasks: AuthBackgroundTasks
  }>
}

/** Complete framework configuration for applications without a database. */
interface WebSetupWithoutDatabaseConfig<
  E extends Env = DefaultEnv,
  Auth = never,
  CustomServices = never,
> extends WebSetupOptions<E, CustomServices> {
  /**
   * A database factory is intentionally absent. This supports applications
   * without persistence and deliberately stateless authentication.
   */
  database?: undefined
  /** Authentication without a database (Better Auth stateless mode). */
  auth?: WebAuthOptions<E, Auth, { readonly backgroundTasks: AuthBackgroundTasks }>
}

/**
 * Flat configuration accepted by {@link setupWeb}.
 *
 * Database, schema, rendering, auth, and Effect composition are configured at
 * one application boundary. Types are inferred from the supplied factories.
 */
export type WebSetupConfig<
  E extends Env = DefaultEnv,
  DB = undefined,
  Auth = never,
  CustomServices = never,
> = [DB] extends [undefined]
  ? WebSetupWithoutDatabaseConfig<E, Auth, CustomServices>
  : DB extends object
    ? WebSetupWithDatabaseConfig<E, DB, Auth, CustomServices>
    : never

/**
 * The services routes can use under a setup: the core services, the database
 * and auth services when configured, and `effect.services`.
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
  DB extends object = DatabaseType,
  Auth = never,
  CustomServices = never,
>(
  app: Hono<E>,
  config: WebSetupWithDatabaseConfig<E, DB, Auth, CustomServices>
): WebApplication<E, WebRouteServices<true, Auth, CustomServices>>
export function setupWeb<
  E extends Env = DefaultEnv,
  Auth = never,
  CustomServices = never,
>(
  app: Hono<E>,
  config: WebSetupWithoutDatabaseConfig<E, Auth, CustomServices>
): WebApplication<E, WebRouteServices<false, Auth, CustomServices>>
export function setupWeb<
  E extends Env,
  DB extends object,
  Auth,
  CustomServices,
>(
  app: Hono<E>,
  config:
    | WebSetupWithDatabaseConfig<E, DB, Auth, CustomServices>
    | WebSetupWithoutDatabaseConfig<E, Auth, CustomServices>
): WebApplication<E, WebRouteServices<boolean, Auth, CustomServices>> {
  assertSetupConfig(config)
  app.use('*', createSetupMiddleware(config))
  registerErrorHandlers(app, config.errors)

  return {
    app,
    routes: new EffectRouteBuilder<E, WebRouteServices<boolean, Auth, CustomServices>>(app),
  }
}

function createSetupMiddleware<
  E extends Env,
  DB extends object,
  Auth,
  CustomServices,
>(
  config:
    | WebSetupWithDatabaseConfig<E, DB, Auth, CustomServices>
    | WebSetupWithoutDatabaseConfig<E, Auth, CustomServices>
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
    const executionContext = getRequestExecutionContextClient(c)

    const backgroundTasks: AuthBackgroundTasks = {
      handler: executionContext.waitUntil,
    }

    try {
      // Set up database first (auth may depend on it)
      // SAFETY: DB/Auth generics are the app's declared client types; the
      // WebDatabaseType/WebAuthType module augmentations make these
      // the same types DatabaseService/AuthService hand back to handlers.
      if (config.database !== undefined) {
        const db = config.database(c)
        // SAFETY: Setup owns this request-scoped value and stores it under the matching private key, preserving the generic contract on retrieval.
        requestCtx.db = db as DatabaseType

        if (config.auth?.client !== undefined) {
          // SAFETY: Setup owns this request-scoped value and stores it under the matching private key, preserving the generic contract on retrieval.
          requestCtx.auth = config.auth.client(c, { db, backgroundTasks }) as AuthType
        }
      } else if (config.auth?.client !== undefined) {
        // SAFETY: Setup owns this request-scoped value and stores it under the matching private key, preserving the generic contract on retrieval.
        requestCtx.auth = config.auth.client(c, { backgroundTasks }) as AuthType
      }

      await next()
    } finally {
      await drainRequestBackground(c)
    }
  })

  const effectConfig: EffectBridgeConfig<E, CustomServices> = {
    services: config.effect?.services,
    schema: config.schema,
    bindings: config.bindings,
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
    loadUser<E>({
      sessionCookie: config.auth?.sessionCookie,
      session: config.auth?.session,
    }),
    shareAuthMiddleware<E>({
      project: config.auth?.share,
    }),
    effectBridge<E, CustomServices>(effectConfig),
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

function assertSetupConfig(config: {
  readonly auth?: unknown
  readonly effect?: object
}): void {
  if (config.auth instanceof Function) {
    throw new Error(
      'Invalid setupWeb configuration: pass the auth factory as auth.client.'
    )
  }

  if (config.effect === undefined) return

  if (Object.prototype.hasOwnProperty.call(config.effect, 'schema')) {
    throw new Error(
      'Invalid setupWeb configuration: move effect.schema to top-level schema.'
    )
  }

  if (Object.prototype.hasOwnProperty.call(config.effect, 'bindings')) {
    throw new Error(
      'Invalid setupWeb configuration: move effect.bindings to top-level bindings.'
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
