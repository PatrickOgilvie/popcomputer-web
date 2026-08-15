/** The single owner of framework per-request state. */

import type { Context, Env, MiddlewareHandler } from 'hono'
import type { Layer, ManagedRuntime } from 'effect'
import type {
  AuthType,
  AuthUser,
  DatabaseType,
} from './effect/services.js'
import type { WebInstance } from './types.js'
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
  /** web() middleware — renderer / shared props / errors instance */
  web?: WebInstance
  /** @deprecated Use {@link web}. */
  honertia?: WebInstance
  /**
   * effectBridge() — per-request Effect runtime.
   * Typed over `any` services: the concrete union depends on per-app bridge
   * config, matching the existing getEffectRuntime() contract.
   */
  // oxlint-disable-next-line no-explicit-any -- SAFETY: see doc comment above
  runtime?: ManagedRuntime.ManagedRuntime<any, never>
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
  /**
   * loadUser() — custom session cookie names registered for this request.
   * The response-cache policy treats these (and better-auth's default
   * cookies) as private request state.
   */
  sessionCookies?: readonly string[]
  /**
   * Test-only layer merged into the runtime by effectBridge. Injection
   * semantics are owned by @popcomputer/web/effect; carried here so the request path
   * has a single context surface.
   */
  testLayer?: Layer.Layer<never, never, never>
}

/** @deprecated Use {@link WebRequestContext}. */
export type HonertiaRequestContext<E extends Env = Env> = WebRequestContext<E>

const WEB_REQUEST_CONTEXT: unique symbol = Symbol('@popcomputer/web:request-context')

/**
 * Get the mutable per-request context holder, creating it on first call.
 *
 * Framework-internal middleware owns specific fields (see
 * {@link WebRequestContext}); mutating the returned holder is their contract.
 * App code should read through {@link webContext} instead.
 */
export function openHonertiaContext<E extends Env>(
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
  return openHonertiaContext(c)
}

/** @deprecated Use {@link webContext}. */
export const honertiaContext: typeof webContext = webContext

/**
 * Services returned by a {@link webServices} provide function.
 * Compute the database first and build auth from it in the same call when
 * auth depends on it.
 */
export interface WebProvidedServices {
  db?: DatabaseType
  auth?: AuthType
}

/** @deprecated Use {@link WebProvidedServices}. */
export type HonertiaProvidedServices = WebProvidedServices

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
  return async (c, next) => {
    const ctx = openHonertiaContext(c)
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

/** @deprecated Use {@link webServices}. */
export const honertiaServices: typeof webServices = webServices
