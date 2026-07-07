/**
 * Honertia Request Context
 *
 * The single owner of framework per-request state. Framework middleware
 * (setupHonertia's service wiring, honertia(), loadUser(), effectBridge())
 * write to one typed holder stored under a private symbol; app code reads it
 * through honertiaContext(). This replaces the string-keyed c.var contract
 * ('db', 'auth', 'authUser', 'honertia') and the symbol trio the bridge used.
 *
 * App-facing request state is a separate concern: use RequestStateService for
 * values your actions and middleware share. This module is framework wiring.
 */

import type { Context, Env, MiddlewareHandler } from 'hono'
import type { Layer, ManagedRuntime } from 'effect'
import type {
  AuthType,
  AuthUser,
  DatabaseType,
} from './effect/services.js'
import type { HonertiaInstance } from './types.js'
import type { EffectBridgeConfig } from './effect/bridge.js'

/**
 * Framework composition state for one request.
 * Populated in middleware order; each field names its writer. Fields are
 * absent until their middleware has run — consumers branch on absence.
 */
export interface HonertiaRequestContext<E extends Env = Env> {
  /** honertiaServices() / setupHonertia's `database:` factory */
  db?: DatabaseType
  /** honertiaServices() / setupHonertia's `auth:` factory */
  auth?: AuthType
  /** loadUser() — present only when the request carries a valid session */
  authUser?: AuthUser
  /** honertia() middleware — renderer / shared props / errors instance */
  honertia?: HonertiaInstance
  /**
   * effectBridge() — per-request Effect runtime.
   * Typed over `any` services: the concrete union depends on per-app bridge
   * config, matching the existing getEffectRuntime() contract.
   */
  // oxlint-disable-next-line no-explicit-any -- SAFETY: see doc comment above
  runtime?: ManagedRuntime.ManagedRuntime<any, never>
  /** effectBridge() — bridge config for downstream route handlers */
  bridgeConfig?: EffectBridgeConfig<E, unknown>
  /** effectBridge() / effectRoutes() — Drizzle schema for route model binding */
  schema?: Record<string, unknown>
  /**
   * loadUser() — custom session cookie names registered for this request.
   * The response-cache policy treats these (and better-auth's default
   * cookies) as private request state.
   */
  sessionCookies?: readonly string[]
  /**
   * Test-only layer merged into the runtime by effectBridge. Injection
   * semantics are owned by honertia/test; carried here so the request path
   * has a single context surface.
   */
  testLayer?: Layer.Layer<never, never, never>
}

const HONERTIA_REQUEST_CONTEXT: unique symbol = Symbol('honertia:request-context')

/**
 * Get the mutable per-request context holder, creating it on first call.
 *
 * Framework-internal: honertia's own middleware own specific fields (see
 * {@link HonertiaRequestContext}); mutating the returned holder is their
 * contract. App code should read through {@link honertiaContext} instead.
 */
export function openHonertiaContext<E extends Env>(
  c: Context<E>
): HonertiaRequestContext<E> {
  // SAFETY: Hono's ContextVariableMap typing does not carry symbol keys
  // through c.set/c.var. This module is the only reader and writer of this
  // symbol, and the holder is created here with the declared type.
  const vars = c.var as Record<symbol, unknown> | undefined
  const existing = vars?.[HONERTIA_REQUEST_CONTEXT]
  if (existing) {
    return existing as HonertiaRequestContext<E>
  }
  const created: HonertiaRequestContext<E> = {}
  c.set(HONERTIA_REQUEST_CONTEXT as never, created as never)
  return created
}

/**
 * Read Honertia's framework state from plain Hono middleware or handlers.
 *
 * @example
 * app.use('/admin/*', async (c, next) => {
 *   const { authUser } = honertiaContext(c)
 *   if (!authUser) return c.redirect('/login')
 *   await next()
 * })
 */
export function honertiaContext<E extends Env>(
  c: Context<E>
): Readonly<HonertiaRequestContext<E>> {
  return openHonertiaContext(c)
}

/**
 * Services returned by a {@link honertiaServices} provide function.
 * Compute the database first and build auth from it in the same call when
 * auth depends on it.
 */
export interface HonertiaProvidedServices {
  db?: DatabaseType
  auth?: AuthType
}

/**
 * Wire the database and auth clients for apps composing middleware manually
 * (without setupHonertia). This is the only supported way to provide them —
 * effectBridge and route model binding read what this middleware sets.
 *
 * @example
 * app.use('*', honertiaServices((c) => {
 *   const db = drizzle(c.env.DB, { schema })
 *   return { db, auth: createAuth({ db }) }
 * }))
 */
export function honertiaServices<E extends Env>(
  provide: (c: Context<E>) => HonertiaProvidedServices
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
