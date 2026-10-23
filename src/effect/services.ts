/** Effect services exposed by @popcomputer/web. */

import { Context, Effect, Option, type Redacted, type Schema as S } from 'effect'
import { CacheError, UnauthorizedError, ForbiddenError } from './errors.js'
import type { PageProps, PagePropValue, RenderOptions } from '../types.js'
import type { DeclaredFields, PageSchemas } from './pages.js'
import type { Registered } from './register.js'

/** Shown where the database is used when the application registers none. */
interface DatabaseNotConfigured {
  readonly __error: 'No database is registered. Give setupWeb a database factory, and register setupWeb\'s result: declare module "@popcomputer/web" { interface Register { web: typeof web } }'
  readonly __hint: 'If setupWeb has a database factory, another value in its configuration has a type error: TypeScript then infers none of its types. Fix the first error inside the setupWeb call.'
}

/** Shown where the Drizzle schema is used when the application registers none. */
interface SchemaNotConfigured {
  readonly __error: 'No Drizzle schema is registered. Give setupWeb your schema (schema: ...) and register setupWeb\'s result.'
  readonly __hint: 'Only route model binding reads the schema.'
}

/** Shown where Better Auth is used when the application registers none. */
interface AuthNotConfigured {
  readonly __error: 'No auth client is registered. Give setupWeb auth.client, and register setupWeb\'s result.'
  readonly __hint: 'Only AuthService and the Better Auth helpers need it.'
}

/** Shown where bindings are read when the application registers none. */
interface BindingsNotConfigured {
  readonly __error: 'No bindings are registered. Type the Hono app with your Worker bindings (new Hono<{ Bindings: Bindings }>()) and register setupWeb\'s result.'
  readonly __hint: 'BindingsService, Config and testEnv read the bindings type.'
}

/** The client setupWeb's `database` factory returns, as the application registered it. */
export type DatabaseType = Registered<'database', DatabaseNotConfigured>

/** The Drizzle schema setupWeb's `schema` names, as the application registered it. */
export type SchemaType = Registered<'schema', SchemaNotConfigured>

/** The Better Auth client setupWeb's `auth.client` returns, as the application registered it. */
export type AuthType = Registered<'auth', AuthNotConfigured>

/** The Worker's bindings, from the registered Hono app's environment. */
export type BindingsType = Registered<'bindings', BindingsNotConfigured>

/**
 * Database Service - Generic database client
 */
const DatabaseService_base: Context.ServiceClass<
  DatabaseService,
  '@popcomputer/web/Database',
  DatabaseType
> = Context.Service<DatabaseService, DatabaseType>()('@popcomputer/web/Database')

export class DatabaseService extends DatabaseService_base {}

/**
 * Auth Service - Better-auth instance
 */
const AuthService_base: Context.ServiceClass<
  AuthService,
  '@popcomputer/web/Auth',
  AuthType
> = Context.Service<AuthService, AuthType>()('@popcomputer/web/Auth')

export class AuthService extends AuthService_base {}

/**
 * Bindings Service - the Worker's bindings (D1, KV, R2, ...), typed by the
 * Hono environment of the registered application.
 *
 * @example
 * const { KV } = yield* BindingsService
 */
const BindingsService_base: Context.ServiceClass<
  BindingsService,
  '@popcomputer/web/Bindings',
  BindingsType
> = Context.Service<BindingsService, BindingsType>()('@popcomputer/web/Bindings')

export class BindingsService extends BindingsService_base {}

/**
 * Better Auth's default user and session: the signed-in user when setupWeb's
 * `auth.session` declares no other.
 */
export interface DefaultAuthUser {
  user: {
    id: string
    email: string
    name: string | null
    emailVerified: boolean
    image: string | null
    createdAt: Date
    updatedAt: Date
  }
  session: {
    id: string
    userId: string
    expiresAt: Date
    /** The session secret. Read it with `Redacted.value` only where it is needed. */
    token: Redacted.Redacted<string>
    createdAt: Date
    updatedAt: Date
  }
}

/**
 * The signed-in user and session: what setupWeb's `auth.session` decodes, or
 * Better Auth's default user and session.
 */
export type AuthUser = Registered<'user', DefaultAuthUser>

/**
 * Authenticated User Service - Provides the current user session
 */
const AuthUserService_base: Context.ServiceClass<
  AuthUserService,
  '@popcomputer/web/AuthUser',
  AuthUser
> = Context.Service<AuthUserService, AuthUser>()('@popcomputer/web/AuthUser')

export class AuthUserService extends AuthUserService_base {}

/**
 * Inertia-compatible page renderer.
 */
export interface PageRenderer {
  /** setupWeb's `pages` registry, when the application registered its pages. */
  readonly pages?: PageSchemas
  /** setupWeb's `shared`, which `share` encodes values with. */
  readonly shared?: DeclaredFields
  /** setupWeb's `flash`, which `flash` encodes values with. */
  readonly flashed?: DeclaredFields
  render<T extends PageProps>(
    component: string,
    props?: T,
    options?: RenderOptions
  ): Promise<Response>
  share(key: string, value: PagePropValue): void
  /** Hand a value to the next page the user sees, as Inertia's page `flash`. */
  flash(key: string, value: PagePropValue): void
}

export class PageService extends Context.Service<
  PageService,
  PageRenderer
>()('@popcomputer/web/Page') {}



/**
 * Request Context - HTTP request data and environment bindings
 */
export interface RequestContext<Bindings extends object = object> {
  readonly method: string
  readonly url: string
  readonly headers: Headers
  /** The request's bindings. Actions read typed bindings with `BindingsService`. */
  readonly env: Bindings
  param(name: string): string | undefined
  params(): Record<string, string>
  query(): Record<string, string>
  /** Every value of each query parameter, as `status[]=open&status[]=closed` sends them. */
  queries(): Record<string, string[]>
  /**
   * The parsed JSON body. Decode it with a schema, as `validateRequest` does.
   * A body over the limit rejects with BodyTooLarge.
   */
  json(options?: BodyReadOptions): Promise<unknown>
  /** The request itself, for adapters that forward it, such as `betterAuthHandler`. */
  raw(): Request
  /**
   * A form body's fields; a field sent more than once has each of its values.
   * A body over the limit rejects with BodyTooLarge.
   */
  parseBody(options?: BodyReadOptions): Promise<Record<string, string | File | (string | File)[]>>
  header(name: string): string | undefined
  /** The most bytes `json()`, `parseBody()` and `betterAuthHandler` read: setupWeb's `bodyLimit`, 1 MiB unless it sets one. */
  readonly bodyLimit?: number
}

/** How `json()` and `parseBody()` read the body. */
export interface BodyReadOptions {
  /** The most bytes the body may have, in place of the request's `bodyLimit`. */
  readonly bodyLimit?: number
}

export class RequestService extends Context.Service<
  RequestService,
  RequestContext
>()('@popcomputer/web/Request') {}

/**
 * Request State - request-scoped variables shared with Hono middleware
 *
 * Backed by Hono's context variables (c.set / c.var). Values an action sets
 * are visible to wrapping Hono middleware after next() and to later reads in
 * the same request; values middleware set before the route ran are readable
 * inside the action.
 *
 * @example
 * ```typescript
 * // In the action: publish the verified key's environment
 * const state = yield* RequestStateService
 * state.set('apiKeyEnvironment', apiKey.environment)
 *
 * // In wrapping Hono middleware, after next():
 * const environment = c.var.apiKeyEnvironment
 * ```
 */
export interface RequestStateClient {
  /** Read a request-scoped variable. Returns undefined when unset. */
  get<T>(key: string): T | undefined
  /** Write a request-scoped variable, visible via c.var to middleware. */
  set<T>(key: string, value: T): void
}

export class RequestStateService extends Context.Service<
  RequestStateService,
  RequestStateClient
>()('@popcomputer/web/RequestState') {}

/**
 * Response Factory - Create HTTP responses
 */
export interface ResponseFactory {
  redirect(url: string, status?: number): Response
  json<T>(data: T, status?: number): Response
  text(data: string, status?: number): Response
  notFound(): Response | Promise<Response>
}

export class ResponseFactoryService extends Context.Service<
  ResponseFactoryService,
  ResponseFactory
>()('@popcomputer/web/ResponseFactory') {}

/**
 * Cache Service - KV-backed caching for expensive operations
 *
 * Provide it with `kvCache(kv)` from `@popcomputer/web/cache` in `web.services({ request })`.
 * Falls back to a no-op implementation if KV is not configured.
 *
 * @example
 * ```typescript
 * // In your action
 * const cacheService = yield* CacheService
 * const cached = yield* cacheService.get('user:123')
 * ```
 */
export interface CacheClient {
  get(key: string): Effect.Effect<string | null, CacheError>
  put(key: string, value: string, options?: { expirationTtl?: number }): Effect.Effect<void, CacheError>
  delete(key: string): Effect.Effect<void, CacheError>
  list(options?: { prefix?: string; cursor?: string }): Effect.Effect<{
    keys: Array<{ name: string }>
    list_complete: boolean
    cursor?: string
  }, CacheError>
}

export class CacheService extends Context.Service<
  CacheService,
  CacheClient
>()('@popcomputer/web/Cache') {}

// ============================================================================
// Execution Context Service
// ============================================================================

/**
 * Client interface for background execution.
 * Wraps Cloudflare's ExecutionContext with Effect-native methods.
 *
 * @example
 * ```typescript
 * const ctx = yield* ExecutionContextService
 *
 * // Effect-native: run an Effect in the background
 * yield* ctx.runInBackground(
 *   sendAnalyticsEvent({ userId, page: 'dashboard' })
 * )
 *
 * // Raw API: for promises from external libraries
 * ctx.waitUntil(externalLib.doSomething())
 *
 * // Check availability before optional background work
 * if (ctx.isAvailable) {
 *   yield* ctx.runInBackground(touchSession())
 * }
 * ```
 */
export interface ExecutionContextClient {
  /**
   * Whether background execution is available.
   * False in tests or non-Worker environments.
   */
  readonly isAvailable: boolean

  /**
   * Run an Effect in the background after the response is sent.
   * Errors are observed and won't crash the worker.
   *
   * The Effect's requirements (R) must be satisfied by the current context.
   * Returns immediately - the actual work happens asynchronously.
   */
  runInBackground: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<void, never, R>

  /** Schedule named detached work for safe observation and correlation. */
  schedule: <A, E, R>(
    operation: string,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<void, never, R>

  /**
   * Raw waitUntil - extends worker lifetime for a Promise.
   * Use this for promises from external libraries.
   * Non-Worker runtimes await the promise before request teardown.
   */
  waitUntil: (promise: Promise<unknown>) => void
}

/**
 * Execution Context Service - Background task execution for Cloudflare Workers.
 *
 * Automatically provided by the Effect bridge. Uses Cloudflare's `waitUntil`
 * to run work after the response is sent.
 *
 * @example
 * ```typescript
 * // In an action - send analytics without blocking response
 * const ctx = yield* ExecutionContextService
 * yield* ctx.runInBackground(
 *   Effect.tryPromise(() => fetch('https://analytics.example.com/events', {
 *     method: 'POST',
 *     body: JSON.stringify({ event: 'page_view', userId })
 *   }))
 * )
 * ```
 */
export class ExecutionContextService extends Context.Service<
  ExecutionContextService,
  ExecutionContextClient
>()('@popcomputer/web/ExecutionContext') {}

/**
 * Authorization helper - opt-in to auth check.
 *
 * Returns the authenticated user if authorized.
 * Fails with UnauthorizedError if no user is present, and, given a check,
 * with ForbiddenError, carrying `message`, if the check returns false.
 *
 * @example
 * // Just require authentication: fails only with UnauthorizedError
 * const auth = yield* authorize()
 *
 * // Require specific role (if your user type has a role field)
 * const auth = yield* authorize((a) => a.user.role === 'admin', 'Only admins can do this.')
 *
 * // Require resource ownership
 * const auth = yield* authorize((a) => a.user.id === project.userId)
 */
const authorizeUser = Effect.fn('Web.authorize')(function* (
  check?: (user: AuthUser) => boolean,
  message = 'Not authorized'
) {
  const maybeUser = yield* Effect.serviceOption(AuthUserService)

  if (Option.isNone(maybeUser)) {
    return yield* new UnauthorizedError({ message: 'Authentication required' })
  }

  const user: AuthUser = maybeUser.value

  if (check && !check(user)) {
    return yield* new ForbiddenError({ message })
  }

  return user
})

// The annotation keeps `AuthUser` unresolved in the emitted declaration, so it
// resolves against the application's registered user.
export const authorize: {
  (): Effect.Effect<AuthUser, UnauthorizedError>
  (check: (user: AuthUser) => boolean, message?: string): Effect.Effect<AuthUser, UnauthorizedError | ForbiddenError>
} = authorizeUser as {
  // SAFETY: without a check, authorizeUser never reaches its ForbiddenError.
  (): Effect.Effect<AuthUser, UnauthorizedError>
  (check: (user: AuthUser) => boolean, message?: string): Effect.Effect<AuthUser, UnauthorizedError | ForbiddenError>
}
