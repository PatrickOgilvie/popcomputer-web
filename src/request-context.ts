/** The single owner of framework per-request state. */

import type { ActiveSignInLimits } from './effect/sign-in-limits.js'
import type { Context, Env, MiddlewareHandler } from 'hono'
import type { Config, Context as EffectContext, ManagedRuntime } from 'effect'
import type {
  AuthType,
  AuthUser,
  DatabaseType,
} from './effect/services.js'
import type { WebInstance } from './types.js'
import type { PageCacheState } from './page-cache.js'
import type { FlashStore } from './flash.js'
import type {
  BackgroundSupervisor,
  EffectBridgeConfig,
} from './effect/bridge.js'
import type { ErrorBoundaryConfig } from './effect/handler.js'
import type { RouteBindingsConfig } from './effect/binding.js'

/**
 * Framework composition state for one request.
 * Populated in middleware order; each field names its writer. Fields are
 * absent until their middleware has run — consumers branch on absence.
 */
export interface WebRequestContext<E extends Env = Env> {
  /** webServices() / setupWeb's `database` factory. */
  db?: DatabaseType
  /** webServices() / setupWeb's `auth.client` factory. */
  auth?: AuthType
  /** loadUser() — present only when the request carries a valid session */
  authUser?: AuthUser
  /**
   * Set when producing the response read a request header, a cookie or
   * request state, none of which a shared cache's key holds: a route's
   * `cache` option then stores nothing.
   */
  readRequestState?: boolean
  /**
   * The services testEnv's layer built for this request, recorded when the
   * request's runtime builds it, so a route gives them over its own layers.
   */
  testServices?: EffectContext.Context<never>
  /** web() middleware — renderer / shared props / errors instance */
  web?: WebInstance
  /** web() middleware — flash data from the previous request and for the next. */
  flash?: FlashStore
  /**
   * effectBridge() — per-request Effect runtime.
   * Typed over `any` services: the concrete union depends on per-app bridge
   * config, matching the existing getEffectRuntime() contract.
   */
  // oxlint-disable-next-line no-explicit-any -- SAFETY: see doc comment above
  runtime?: ManagedRuntime.ManagedRuntime<any, Config.ConfigError>
  /** setupWeb() / effectBridge() — owns detached request work and teardown. */
  backgroundSupervisor?: BackgroundSupervisor
  /** effectBridge() — bridge config for downstream route handlers */
  bridgeConfig?: EffectBridgeConfig<E, unknown>
  /** effectBridge() / effectRoutes() — Drizzle schema for route model binding */
  schema?: object
  /** effectBridge() / effectRoutes() — registered row parsers and scopes. */
  bindings?: RouteBindingsConfig
  /** setupWeb() — response policy shared by every error entrypoint. */
  errorBoundary?: ErrorBoundaryConfig
  /** setupWeb() — where a signed-out visitor goes when a route needs a user. */
  signInPath?: string
  /** setupWeb() — where a signed-in visitor goes from a page for guests. */
  homePath?: string
  /** setupWeb() — the most bytes the framework reads of a request body. */
  bodyLimit?: number
  /** setupWeb() — the sign-in limits, with the request's Rate Limiting binding. */
  signInLimits?: ActiveSignInLimits
  /**
   * loadUser() — custom session cookie names registered for this request.
   * The response-cache policy treats these (and better-auth's default
   * cookies) as private request state.
   */
  sessionCookies?: readonly string[]
  /** pageCache() — present while a request may still be served from or stored in the page cache. */
  pageCache?: PageCacheState
  /**
   * privateByDefault() — set before the route runs: it gives the response a
   * Cache-Control when it states none, so web() leaves that to it.
   */
  cacheControlByDefault?: boolean
  /** routes.jsonApi() — every request to the route is a JSON client. */
  jsonApi?: boolean
  /**
   * The route's registration: the page its form is on, which a failed form
   * goes back to when the request names no page of this site as its Referer.
   */
  formPage?: string
  /** Application cookies an action set, which web() writes on the response. */
  responseCookies?: string[]
  /**
   * The cookies Better Auth's session lookup set, renewing the session or
   * clearing a revoked one, which web() writes unless the response sets the
   * same cookie, as a sign-in does.
   */
  sessionLookupCookies?: string[]
  /** Headers an action or layer added with responseHeader, which web() writes on the response. */
  responseHeaders?: ReadonlyArray<readonly [string, string]>
}


const WEB_REQUEST_CONTEXT: unique symbol = Symbol('@popcomputer/web:request-context')

/**
 * Get the mutable per-request context holder, creating it on first call.
 *
 * Framework-internal middleware owns specific fields (see
 * {@link WebRequestContext}); mutating the returned holder is their contract.
 * App code should read through {@link webContext} instead.
 */
export function openWebContext<E extends Env>(
  c: Context<E>
): WebRequestContext<E> {
  // SAFETY: Hono's ContextVariableMap typing does not carry symbol keys
  // through c.set/c.var. This module is the only reader and writer of this
  // symbol, and the holder is created here with the declared type.
  const existing = Object.getOwnPropertyDescriptor(
    c.var,
    WEB_REQUEST_CONTEXT
  )?.value

  if (existing) {
    // SAFETY: Setup owns this request-scoped value and stores it under the matching private key, preserving the generic contract on retrieval.
    return existing as WebRequestContext<E>
  }

  const created: WebRequestContext<E> = {}
  // SAFETY: Setup owns this request-scoped value and stores it under the matching private key, preserving the generic contract on retrieval.
  c.set(WEB_REQUEST_CONTEXT as never, created as never)

  return created
}

/**
 * Read framework state from plain Hono middleware or handlers.
 *
 * @example
 * app.use('/admin/*', async (c, next) => {
 *   const { authUser } = webContext(c)
 *   if (!authUser) return c.redirect('/login')
 *   await next()
 * })
 */
export function webContext<E extends Env>(
  c: Context<E>
): Readonly<WebRequestContext<E>> {
  return openWebContext(c)
}


/**
 * Services returned by a {@link webServices} provide function.
 * Compute the database first and build auth from it in the same call when
 * auth depends on it.
 */
export interface WebProvidedServices {
  db?: DatabaseType
  auth?: AuthType
}


/**
 * Wire the database and auth clients for apps composing middleware manually
 * (without setupWeb). This is the only supported way to provide them —
 * effectBridge and route model binding read what this middleware sets.
 *
 * @example
 * app.use('*', webServices((c) => {
 *   const db = drizzle(c.env.DB, { schema })
 *   return { db, auth: createAuth({ db }) }
 * }))
 */
export function webServices<E extends Env>(
  provide: (c: Context<E>) => WebProvidedServices
): MiddlewareHandler<E> {
  // oxlint-disable-next-line effecttsgo/async-function -- Hono middleware and renderer contracts use native next()/Response promises; typed Effect work stays inside that request boundary.
  return async (c, next) => {
    const ctx = openWebContext(c)
    const services = provide(c)

    if (services.db !== undefined) {
      ctx.db = services.db
    }

    if (services.auth !== undefined) {
      ctx.auth = services.auth
    }

    await next()
  }
}

