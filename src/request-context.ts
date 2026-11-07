/** The single owner of framework per-request state. */

import type { ActiveSignInLimits } from './effect/sign-in-limits.js'
import type { Context, Env, MiddlewareHandler } from 'hono'
import type { Config, Context as EffectContext, Layer, ManagedRuntime } from 'effect'
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
import type { WebSetup } from './web-setup.js'
import type { PrivacyReason } from './privacy.js'
import { Visitor } from './visitor.js'

/**
 * A request's services, typed over any services: which ones depends on each
 * application's bridge config, and the route that builds its runtime from
 * them checks its actions against its own.
 */
// oxlint-disable-next-line no-explicit-any -- SAFETY: see doc comment above
export type RequestServicesLayer = Layer.Layer<any, Config.ConfigError>

/**
 * Framework composition state for one request.
 * Populated in middleware order; each field names its writer. Fields are
 * absent until their middleware has run — consumers branch on absence.
 */
export interface WebRequestContext<E extends Env = Env> {
  /**
   * setupWeb() — the application's settings, the same value for every
   * request. The framework reads them with `setupOf(c)`, which a stack
   * composed by hand answers too.
   *
   * @internal
   */
  setup?: WebSetup
  /** webServices() / setupWeb's `database` factory. */
  db?: DatabaseType
  /** webServices() / setupWeb's `auth.client` factory. */
  auth?: AuthType
  /** loadUser() — present only when the request carries a valid session */
  authUser?: AuthUser
  /**
   * loadUser() — who is asking, which `authUser`'s absence cannot say: a
   * guest, or a lookup that failed or never ran. Read it with {@link visitorOf}.
   */
  visitor?: Visitor
  /**
   * privacy.ts — why the response may not be shared, which the page cache,
   * a route's `cache` option and the default Cache-Control read.
   */
  privacy?: ReadonlySet<PrivacyReason>
  /**
   * web()'s render — a page went to a visitor the action's AuthUserService
   * signed in, whichever layer gave it: the session lookup, a layer the
   * route provides, or web.services.
   * @deprecated privacy.ts records it as 'signed-in'. Removed in 2.0.
   */
  signedIn?: boolean
  /**
   * Set when producing the response read a request header, a cookie or
   * request state, none of which a shared cache's key holds: a route's
   * `cache` option then stores nothing.
   * @deprecated privacy.ts records why. Removed in 2.0.
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
   * effectBridge() — the request's services, which its route or job builds
   * the request's one runtime from.
   */
  requestLayer?: RequestServicesLayer
  /**
   * effectBridge() — a runtime of the request's services, built only when
   * read.
   * @deprecated Routes build the request's one runtime from `requestLayer`.
   * Removed in 2.0.
   */
  runtime?: ManagedRuntime.ManagedRuntime<never, Config.ConfigError>
  /** setupWeb() / effectBridge() — owns detached request work and teardown. */
  backgroundSupervisor?: BackgroundSupervisor
  /** effectBridge() — bridge config for downstream route handlers */
  bridgeConfig?: EffectBridgeConfig<E, unknown>
  /**
   * effectBridge() — Drizzle schema for route model binding.
   * @deprecated The application's setupWeb configuration holds it. Removed in 2.0.
   */
  schema?: object
  /**
   * effectBridge() — registered row parsers and scopes.
   * @deprecated The application's setupWeb configuration holds it. Removed in 2.0.
   */
  bindings?: RouteBindingsConfig
  /**
   * setupWeb() — response policy shared by every error entrypoint.
   * @deprecated The application's setupWeb configuration holds it. Removed in 2.0.
   */
  errorBoundary?: ErrorBoundaryConfig
  /**
   * setupWeb() — where a signed-out visitor goes when a route needs a user.
   * @deprecated The application's setupWeb configuration holds it. Removed in 2.0.
   */
  signInPath?: string
  /**
   * setupWeb() — where a signed-in visitor goes from a page for guests.
   * @deprecated The application's setupWeb configuration holds it. Removed in 2.0.
   */
  homePath?: string
  /**
   * setupWeb() — the most bytes the framework reads of a request body.
   * @deprecated The application's setupWeb configuration holds it. Removed in 2.0.
   */
  bodyLimit?: number
  /** setupWeb() — the sign-in limits, with the request's Rate Limiting binding. */
  signInLimits?: ActiveSignInLimits
  /**
   * loadUser() — custom session cookie names registered for this request,
   * which a stack composed by hand tells the cache policies and the history
   * clear through.
   * @deprecated The application's setupWeb configuration holds it. Removed in 2.0.
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
  /**
   * response-output.ts — whether a page this request rendered cleared
   * Inertia's history, and whether the response has been finished with what
   * the request queued.
   */
  output?: { historyCleared: boolean; finished: boolean }
  /** Application cookies an action set, which finishing the response writes. */
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

/** Who is asking this request. */
export const visitorOf = <E extends Env>(c: Context<E>): Visitor => openWebContext(c).visitor ?? Visitor.Unread()

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

