/**
 * Honertia Setup
 *
 * Provides a single setup function that configures all Honertia middleware.
 * This is the recommended way to set up Honertia in your Hono app.
 */

import { createMiddleware } from 'hono/factory'
import { Hono } from 'hono'
import type { MiddlewareHandler, Env, Context } from 'hono'
import type { Schema as S } from 'effect'
import { honertia } from './middleware.js'
import { verifyOrigin, type VerifyOriginConfig } from './security.js'
import type { HonertiaConfig } from './types.js'
import { loadUser, shareAuthMiddleware } from './effect/auth.js'
import { openHonertiaContext } from './request-context.js'
import type {
  DatabaseType,
  AuthType,
  BindingsType,
  AuthUser,
} from './effect/services.js'
import { effectBridge, type EffectBridgeConfig } from './effect/bridge.js'
import {
  renderErrorResponse,
  type ErrorBoundaryConfig,
} from './effect/handler.js'
import { NotFoundError } from './effect/errors.js'
import type { RouteBindingsConfig } from './effect/binding.js'
import {
  getAppRouteRegistry,
  type RouteRegistry,
} from './effect/route-registry.js'

/** Default Hono environment derived from Honertia's bindings augmentation. */
type HonertiaSetupEnv = {
  Bindings: BindingsType
}

interface HonertiaCoreConfig extends HonertiaConfig {
  /**
   * Drizzle schema for route model binding.
   * Required if using Laravel-style route model binding.
   *
   * @example
   * ```typescript
   * import * as schema from '~/db/schema'
   *
   * setupHonertia(app, {
   *   honertia: { version, render, schema }
   * })
   * ```
   */
  schema?: Record<string, unknown>
  /** Row parsers and optional scope metadata for route-model bindings. */
  bindings?: RouteBindingsConfig
}

/** Honertia core configuration when a database factory is present. */
interface HonertiaFullConfigWithDatabase<
  E extends Env = HonertiaSetupEnv,
  DB extends object = DatabaseType,
> extends HonertiaCoreConfig {
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
}

/** Honertia core configuration when no database factory is present. */
interface HonertiaFullConfigWithoutDatabase<
  E extends Env = HonertiaSetupEnv,
> extends HonertiaCoreConfig {
  /**
   * A database factory is intentionally absent. This supports applications
   * without persistence and deliberately stateless authentication.
   */
  database?: undefined
}

/**
 * Core Honertia configuration with database, schema, and route bindings.
 *
 * @typeParam E - Hono environment type
 * @typeParam DB - Database client type, or `undefined` when not configured
 */
export type HonertiaFullConfig<
  E extends Env = HonertiaSetupEnv,
  DB = undefined,
> = [DB] extends [undefined]
  ? HonertiaFullConfigWithoutDatabase<E>
  : DB extends object
    ? HonertiaFullConfigWithDatabase<E, DB>
    : never

interface HonertiaSetupOptions<
  E extends Env,
  CustomServices,
  DB = undefined,
  Auth = AuthType,
> {
  /**
   * Effect bridge configuration (optional).
   * Only needed for custom Effect services.
   */
  effect?: Pick<EffectBridgeConfig<E, CustomServices>, 'services'>

  /**
   * Authentication configuration (optional).
   * Owns client construction, session parsing, and public projection.
   */
  auth?: {
    /** Build the Better Auth server client at the request composition seam. */
    client?: [DB] extends [undefined]
      ? (c: Context<E>) => Auth
      : DB extends object
        ? (c: Context<E>, services: { readonly db: DB }) => Auth
        : never
    /** Parse Better Auth's session response before actions receive it. */
    session?: S.Schema<AuthUser, unknown, never>
    /** Explicit public projection placed at `auth.user` in page props. */
    share?: (auth: AuthUser) => unknown
    readonly sessionCookie?: string
  }

  /**
   * Additional middleware to run after core Honertia setup.
   * These run in order after effectBridge.
   */
  middleware?: MiddlewareHandler<E>[]

  /** Optional security hardening. */
  security?: {
    /**
     * Enable CSRF defense-in-depth by verifying the `Origin`/`Referer` of
     * state-changing requests. Opt-in — see {@link VerifyOriginConfig}.
     * Runs before all other Honertia middleware so rejected requests
     * short-circuit cheaply.
     */
    verifyOrigin?: VerifyOriginConfig
  }

  /** Error component and environment policy for the shared error boundary. */
  errors?: ErrorHandlerConfig
}

/** Setup configuration whose auth factory receives a required database. */
interface HonertiaSetupWithDatabaseConfig<
  E extends Env = HonertiaSetupEnv,
  DB extends object = DatabaseType,
  Auth = AuthType,
  CustomServices = never,
> extends HonertiaSetupOptions<E, CustomServices, DB, Auth> {
  honertia: HonertiaFullConfigWithDatabase<E, DB>
}

/** Setup configuration whose auth factory receives no database. */
interface HonertiaSetupWithoutDatabaseConfig<
  E extends Env = HonertiaSetupEnv,
  Auth = AuthType,
  CustomServices = never,
> extends HonertiaSetupOptions<E, CustomServices, undefined, Auth> {
  honertia: HonertiaFullConfigWithoutDatabase<E>
}

/**
 * Configuration for Honertia setup.
 *
 * Prefer calling `setupHonertia(app, {...})` without explicit generics. Module
 * augmentation supplies the binding environment while database, auth, and
 * custom Effect service types are inferred from their factories.
 *
 * @typeParam E - Hono environment type
 * @typeParam DB - Database client type, or `undefined` when not configured
 * @typeParam Auth - Auth client type
 * @typeParam CustomServices - Custom Effect services
 */
export type HonertiaSetupConfig<
  E extends Env = HonertiaSetupEnv,
  DB = undefined,
  Auth = AuthType,
  CustomServices = never,
> = [DB] extends [undefined]
  ? HonertiaSetupWithoutDatabaseConfig<E, Auth, CustomServices>
  : DB extends object
    ? HonertiaSetupWithDatabaseConfig<E, DB, Auth, CustomServices>
    : never

/**
 * Sets up all Honertia middleware in the correct order.
 *
 * This bundles:
 * - Database and auth setup in the typed Honertia request context
 * - `honertia()` - Core Honertia middleware
 * - `loadUser()` - Loads authenticated user into context
 * - `shareAuthMiddleware()` - Shares auth state with pages
 * - `effectBridge()` - Sets up Effect runtime for each request
 *
 * @example
 * ```ts
 * import { setupHonertia, createTemplate } from 'honertia'
 * import * as schema from '~/db/schema'
 *
 * setupHonertia(app, {
 *   honertia: {
 *     version: '1.0.0',
 *     render: createTemplate({ title: 'My App', scripts: [...] }),
 *     database: (c) => createDb(c.env.DATABASE_URL),
 *     schema,
 *     bindings: { workspace: Workspace },
 *   },
 *   auth: {
 *     client: (c, { db }) => createAuth({ db }),
 *     session: AuthSession,
 *     share: ({ user }) => ({ id: user.id, name: user.name }),
 *   },
 *   errors: { component: 'Error' },
 * })
 * ```
 */
export interface HonertiaApplication<E extends Env> {
  readonly app: Hono<E>
  readonly routes: RouteRegistry
}

export function setupHonertia<
  E extends Env = HonertiaSetupEnv,
  DB extends object = DatabaseType,
  Auth = AuthType,
  CustomServices = never,
>(
  app: Hono<E>,
  config: HonertiaSetupWithDatabaseConfig<E, DB, Auth, CustomServices>
): HonertiaApplication<E>
export function setupHonertia<
  E extends Env = HonertiaSetupEnv,
  Auth = AuthType,
  CustomServices = never,
>(
  app: Hono<E>,
  config: HonertiaSetupWithoutDatabaseConfig<E, Auth, CustomServices>
): HonertiaApplication<E>
export function setupHonertia<
  E extends Env = HonertiaSetupEnv,
  DB extends object = DatabaseType,
  Auth = AuthType,
  CustomServices = never,
>(
  config: HonertiaSetupWithDatabaseConfig<E, DB, Auth, CustomServices>
): MiddlewareHandler<E>
export function setupHonertia<
  E extends Env = HonertiaSetupEnv,
  Auth = AuthType,
  CustomServices = never,
>(
  config: HonertiaSetupWithoutDatabaseConfig<E, Auth, CustomServices>
): MiddlewareHandler<E>
export function setupHonertia<
  E extends Env,
  DB extends object,
  Auth,
  CustomServices,
>(
  appOrConfig:
    | Hono<E>
    | HonertiaSetupWithDatabaseConfig<E, DB, Auth, CustomServices>
    | HonertiaSetupWithoutDatabaseConfig<E, Auth, CustomServices>,
  maybeConfig?:
    | HonertiaSetupWithDatabaseConfig<E, DB, Auth, CustomServices>
    | HonertiaSetupWithoutDatabaseConfig<E, Auth, CustomServices>
): MiddlewareHandler<E> | HonertiaApplication<E> {
  // SAFETY: overloads guarantee a config-only call or an app/config pair.
  const config = (maybeConfig ?? appOrConfig) as
    | HonertiaSetupWithDatabaseConfig<E, DB, Auth, CustomServices>
    | HonertiaSetupWithoutDatabaseConfig<E, Auth, CustomServices>
  const middleware = createSetupMiddleware(config)

  if (maybeConfig === undefined) {
    return middleware
  }

  const app = appOrConfig as Hono<E>
  app.use('*', middleware)
  registerErrorHandlers(app, config.errors)
  return { app, routes: getAppRouteRegistry(app) }
}

function createSetupMiddleware<
  E extends Env,
  DB extends object,
  Auth,
  CustomServices,
>(
  config:
    | HonertiaSetupWithDatabaseConfig<E, DB, Auth, CustomServices>
    | HonertiaSetupWithoutDatabaseConfig<E, Auth, CustomServices>
): MiddlewareHandler<E> {
  assertCanonicalSetupConfig(config)

  const configured = config.honertia
  const schema = configured.schema
  const bindings = configured.bindings
  const honertiaConfig: HonertiaConfig = {
    version: configured.version,
    render: configured.render,
  }

  // Middleware to wire db and auth into the typed request context
  const setupServices: MiddlewareHandler<E> = createMiddleware<E>(async (c, next) => {
    const requestCtx = openHonertiaContext(c)
    requestCtx.errorBoundary = config.errors

    // Set up database first (auth may depend on it)
    // SAFETY: DB/Auth generics are the app's declared client types; the
    // HonertiaDatabaseType/HonertiaAuthType module augmentations make these
    // the same types DatabaseService/AuthService hand back to handlers.
    if (configured.database !== undefined) {
      const db = configured.database(c)
      requestCtx.db = db as DatabaseType

      if (config.auth?.client !== undefined) {
        requestCtx.auth = config.auth.client(c, { db }) as AuthType
      }
    } else if (config.auth?.client !== undefined) {
      // SAFETY: the no-database setup overload only accepts a one-argument
      // client factory; the implementation union cannot retain that branch.
      const createStatelessAuth = config.auth.client as (context: Context<E>) => Auth
      requestCtx.auth = createStatelessAuth(c) as AuthType
    }

    await next()
  })

  // Build effect bridge config, passing schema from honertia config
  const effectConfig: EffectBridgeConfig<E, CustomServices> = {
    services: config.effect?.services,
    schema,
    bindings,
  }

  const middlewares: MiddlewareHandler<E>[] = [
    // Origin verification runs first so cross-origin writes are rejected
    // before any per-request setup work (db/auth client creation) happens.
    ...(config.security?.verifyOrigin
      ? [verifyOrigin<E>(config.security.verifyOrigin)]
      : []),
    setupServices,
    honertia(honertiaConfig),
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

  return createMiddleware<E>(async (c, next) => {
    // Mirrors Hono's compose contract: next() resolves to void, wrapper
    // middleware observe downstream responses via c.res after awaiting it,
    // and a middleware that returns a Response (without finalizing the
    // context) has that response adopted — exactly like hono/compose.
    const dispatch = async (i: number): Promise<void> => {
      if (i >= middlewares.length) {
        await next()
        return
      }
      const res = await middlewares[i](c, async () => {
        await dispatch(i + 1)
      })
      if (res instanceof Response && !c.finalized) {
        c.res = res
      }
    }

    await dispatch(0)

    // Return the response for proper propagation in forwarding/proxy scenarios
    return c.res
  })
}

function assertCanonicalSetupConfig(config: {
  readonly honertia: HonertiaCoreConfig
  readonly effect?: object
}): void {
  if (Object.prototype.hasOwnProperty.call(config.honertia, 'auth')) {
    throw new Error(
      'Invalid setupHonertia configuration: move honertia.auth to top-level auth.client.'
    )
  }

  if (config.effect === undefined) return

  if (Object.prototype.hasOwnProperty.call(config.effect, 'schema')) {
    throw new Error(
      'Invalid setupHonertia configuration: move effect.schema to honertia.schema.'
    )
  }

  if (Object.prototype.hasOwnProperty.call(config.effect, 'bindings')) {
    throw new Error(
      'Invalid setupHonertia configuration: move effect.bindings to honertia.bindings.'
    )
  }
}

/**
 * Error handler configuration.
 */
export type ErrorHandlerConfig = ErrorBoundaryConfig

/**
 * Creates error handlers for Hono apps using Honertia.
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
 * import { registerErrorHandlers } from 'honertia'
 *
 * registerErrorHandlers(app)
 * ```
 */
export function registerErrorHandlers<E extends Env>(
  app: { notFound: (handler: any) => void; onError: (handler: any) => void },
  config: ErrorHandlerConfig = {}
): void {
  const { notFound, onError } = createErrorHandlers<E>(config)
  app.notFound(notFound)
  app.onError(onError)
}
