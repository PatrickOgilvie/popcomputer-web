/**
 * Honertia Setup
 *
 * Provides a single setup function that configures all Honertia middleware.
 * This is the recommended way to set up Honertia in your Hono app.
 */

import { createMiddleware } from 'hono/factory'
import type { MiddlewareHandler, Env, Context } from 'hono'
import { honertia } from './middleware.js'
import { verifyOrigin, type VerifyOriginConfig } from './security.js'
import type { HonertiaConfig } from './types.js'
import { loadUser, shareAuthMiddleware } from './effect/auth.js'
import { openHonertiaContext } from './request-context.js'
import type { DatabaseType, AuthType } from './effect/services.js'
import { effectBridge, type EffectBridgeConfig } from './effect/bridge.js'
import { getStructuredFromThrown } from './effect/handler.js'
import { toStructuredError } from './effect/errors.js'
import { captureErrorContext } from './effect/error-context.js'
import {
  detectOutputFormat,
  JsonErrorFormatter,
  TerminalErrorFormatter,
  InertiaErrorFormatter,
} from './effect/error-formatter.js'
import { createStructuredError, ErrorCodes } from './effect/error-catalog.js'

/**
 * Extended Honertia configuration with database, auth, and schema.
 *
 * @typeParam E - Hono environment type
 * @typeParam DB - Database client type (inferred from database factory return type)
 * @typeParam Auth - Auth client type (inferred from auth factory return type)
 */
export interface HonertiaFullConfig<E extends Env = Env, DB = unknown, Auth = unknown>
  extends HonertiaConfig {
  /**
   * Database factory function.
   * Creates the database client for each request.
   *
   * @example
   * ```typescript
   * database: (c) => createDb(c.env.DATABASE_URL)
   * ```
   */
  database?: (c: Context<E>) => DB

  /**
   * Auth factory function.
   * Creates the auth client for each request. The database created by the
   * `database` factory (if configured) is passed as the second argument.
   *
   * @example
   * ```typescript
   * auth: (c, { db }) => createAuth({
   *   db,
   *   secret: c.env.BETTER_AUTH_SECRET,
   *   baseURL: new URL(c.req.url).origin,
   * })
   * ```
   */
  auth?: (c: Context<E>, services: { db?: DB }) => Auth

  /**
   * Drizzle schema for route model binding.
   * Required if using Laravel-style route model binding.
   *
   * @example
   * ```typescript
   * import * as schema from '~/db/schema'
   *
   * setupHonertia({
   *   honertia: { version, render, schema }
   * })
   * ```
   */
  schema?: Record<string, unknown>
}

/**
 * Configuration for Honertia setup.
 *
 * @typeParam E - Hono environment type
 * @typeParam DB - Database client type (inferred from database factory)
 * @typeParam Auth - Auth client type (inferred from auth factory)
 * @typeParam CustomServices - Custom Effect services
 */
export interface HonertiaSetupConfig<
  E extends Env = Env,
  DB = unknown,
  Auth = unknown,
  CustomServices = never,
> {
  /**
   * Honertia core configuration including database, auth, and schema.
   */
  honertia: HonertiaFullConfig<E, DB, Auth>

  /**
   * Effect bridge configuration (optional).
   * Only needed for custom Effect services.
   */
  effect?: EffectBridgeConfig<E, CustomServices>

  /**
   * Auth loading configuration (optional).
   * Controls how the authenticated user is loaded from the session.
   */
  auth?: {
    sessionCookie?: string
    /**
     * Whitelist of user fields shared with the client as `auth.user`.
     * Without this, the entire user record (email, admin flags, …) is
     * serialized into every page payload. Ignored when `mapSharedUser` is set.
     *
     * @example shareFields: ['id', 'name', 'image']
     */
    shareFields?: string[]
    /**
     * Project the user before sharing with the client. Overrides `shareFields`.
     *
     * @example mapSharedUser: (u) => ({ id: u.id, name: u.name })
     */
    mapSharedUser?: (user: Record<string, unknown>) => unknown
  }

  /**
   * Additional middleware to run after core Honertia setup.
   * These run in order after effectBridge.
   */
  middleware?: MiddlewareHandler<E>[]

  /**
   * Optional security hardening.
   */
  security?: {
    /**
     * Enable CSRF defense-in-depth by verifying the `Origin`/`Referer` of
     * state-changing requests. Opt-in — see {@link VerifyOriginConfig}.
     * Runs before all other Honertia middleware so rejected requests
     * short-circuit cheaply.
     */
    verifyOrigin?: VerifyOriginConfig
  }
}

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
 * app.use('*', setupHonertia({
 *   honertia: {
 *     version: '1.0.0',
 *     render: createTemplate({ title: 'My App', scripts: [...] }),
 *     database: (c) => createDb(c.env.DATABASE_URL),
 *     auth: (c, { db }) => createAuth({
 *       db,
 *       secret: c.env.BETTER_AUTH_SECRET,
 *       baseURL: new URL(c.req.url).origin,
 *     }),
 *     schema,
 *   },
 * }))
 * ```
 */
export function setupHonertia<
  E extends Env,
  DB = unknown,
  Auth = unknown,
  CustomServices = never,
>(config: HonertiaSetupConfig<E, DB, Auth, CustomServices>): MiddlewareHandler<E> {
  const { database, auth, schema, ...honertiaConfig } = config.honertia

  // Middleware to wire db and auth into the typed request context
  const setupServices: MiddlewareHandler<E> = createMiddleware<E>(async (c, next) => {
    const requestCtx = openHonertiaContext(c)

    // Set up database first (auth may depend on it)
    // SAFETY: DB/Auth generics are the app's declared client types; the
    // HonertiaDatabaseType/HonertiaAuthType module augmentations make these
    // the same types DatabaseService/AuthService hand back to handlers.
    const db = database ? database(c) : undefined
    if (db !== undefined) {
      requestCtx.db = db as DatabaseType
    }

    if (auth) {
      requestCtx.auth = auth(c, { db }) as AuthType
    }

    await next()
  })

  // Build effect bridge config, passing schema from honertia config
  const effectConfig: EffectBridgeConfig<E, CustomServices> = {
    ...config.effect,
    schema: schema ?? config.effect?.schema,
  }

  const middlewares: MiddlewareHandler<E>[] = [
    // Origin verification runs first so cross-origin writes are rejected
    // before any per-request setup work (db/auth client creation) happens.
    ...(config.security?.verifyOrigin
      ? [verifyOrigin<E>(config.security.verifyOrigin)]
      : []),
    setupServices,
    honertia(honertiaConfig),
    loadUser<E>(config.auth),
    shareAuthMiddleware<E>({
      fields: config.auth?.shareFields,
      mapUser: config.auth?.mapSharedUser,
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

/**
 * Error handler configuration.
 */
export interface ErrorHandlerConfig {
  /**
   * Component to render for errors.
   * @default 'Error'
   */
  component?: string

  /**
   * Whether to show detailed error messages in development.
   * @default true
   */
  showDevErrors?: boolean

  /**
   * Environment variable key to check for development mode.
   * @default 'ENVIRONMENT'
   */
  envKey?: string

  /**
   * Value that indicates development mode.
   * @default 'development'
   */
  devValue?: string
}

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
  const {
    component = 'Error',
    showDevErrors = true,
    envKey = 'ENVIRONMENT',
    devValue = 'development',
  } = config

  // Memoized formatter instances for dev and production modes
  const formatters = {
    dev: {
      json: new JsonErrorFormatter({
        pretty: true,
        includeSource: true,
        includeContext: true,
        includeFixes: true,
      }),
      terminal: new TerminalErrorFormatter({
        useColors: true,
        showSnippet: true,
        showFixes: true,
      }),
      inertia: new InertiaErrorFormatter({ isDev: true, includeFixes: true }),
    },
    prod: {
      json: new JsonErrorFormatter({
        pretty: false,
        includeSource: false,
        includeContext: false,
        includeFixes: true,
        safeMessages: true,
      }),
      inertia: new InertiaErrorFormatter({ isDev: false, includeFixes: false }),
    },
  }

  const getFormatters = (isDev: boolean) => (isDev ? formatters.dev : formatters.prod)

  const notFound = (c: Context<E>) => {
    const isDev = showDevErrors && (c.env as any)?.[envKey] === devValue
    const context = captureErrorContext(c)
    const format = detectOutputFormat(
      {
        header: (name: string) => c.req.header(name),
        method: c.req.method,
        url: c.req.url,
      },
      (c.env ?? {}) as Record<string, unknown>
    )

    // Create structured not found error
    const structured = createStructuredError(
      ErrorCodes.RES_200_NOT_FOUND,
      { resource: 'page' },
      context
    )

    const fmt = getFormatters(isDev)

    // JSON response for API/AI requests
    if (format === 'json') {
      return c.json(fmt.json.format(structured), 404)
    }

    // Render Inertia error component (if honertia middleware has run)
    const honertiaInstance = openHonertiaContext(c).honertia
    if (honertiaInstance) {
      return honertiaInstance.render(component, fmt.inertia.format(structured) as Record<string, unknown>)
    }

    // Fallback: return JSON if honertia isn't available
    return c.json(fmt.json.format(structured), 404)
  }

  const onError = (err: Error, c: Context<E>) => {
    const isDev = showDevErrors && (c.env as any)?.[envKey] === devValue
    const context = captureErrorContext(c)
    const format = detectOutputFormat(
      {
        header: (name: string) => c.req.header(name),
        method: c.req.method,
        url: c.req.url,
      },
      (c.env ?? {}) as Record<string, unknown>
    )

    // Get structured error (may have been attached by handler.ts)
    let structured = getStructuredFromThrown(err)
    if (!structured) {
      // Convert the error to structured format
      structured = toStructuredError(err, context)
    }

    const fmt = getFormatters(isDev)

    // Log in terminal format for development (suppress during tests)
    const isTest = (typeof Bun !== 'undefined' && Bun.env?.NODE_ENV === 'test')
    if (!isTest) {
      if (isDev) {
        console.error(formatters.dev.terminal.format(structured))
      } else {
        console.error(err)
      }
    }

    // JSON response for API/AI requests
    if (format === 'json') {
      return c.json(fmt.json.format(structured), structured.httpStatus as any)
    }

    // Render Inertia error component (if honertia middleware has run)
    const honertiaInstance = openHonertiaContext(c).honertia
    if (honertiaInstance) {
      return honertiaInstance.render(component, fmt.inertia.format(structured) as Record<string, unknown>)
    }

    // Fallback: return JSON if honertia isn't available
    return c.json(fmt.json.format(structured), structured.httpStatus as any)
  }

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
