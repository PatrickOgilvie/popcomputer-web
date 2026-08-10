/** Effect services exposed by @popcomputer/web. */

import { Context, Effect, Option } from 'effect'
import { UnauthorizedError, ForbiddenError } from './errors.js'

/**
 * Augmentable interface for database type.
 * Users can extend this via module augmentation:
 *
 * @example
 * ```typescript
 * // In your project's types.d.ts or similar
 * declare module '@popcomputer/web/effect' {
 *   interface WebDatabaseType {
 *     type: Database // Your database type (Drizzle, Prisma, Kysely, etc.)
 *     schema: typeof schema // Your Drizzle schema for route model binding
 *   }
 * }
 * ```
 *
 * Then use the `DatabaseService` tag to get your typed database.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WebDatabaseType {}

/** @deprecated Augment {@link WebDatabaseType} instead. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HonertiaDatabaseType {}

/**
 * Error type shown when WebDatabaseType.type is not configured.
 * This provides a helpful error message in IDE tooltips.
 */
interface DatabaseNotConfigured {
  readonly __error: 'DatabaseService type not configured. Add module augmentation: declare module "@popcomputer/web/effect" { interface WebDatabaseType { type: YourDbType } }'
  readonly __hint: 'See https://github.com/patrickogilvie/popcomputer-web#typescript-setup'
}

/**
 * Error type shown when WebDatabaseType.schema is not configured.
 */
interface SchemaNotConfigured {
  readonly __error: 'Schema not configured for route model binding. Add module augmentation: declare module "@popcomputer/web/effect" { interface WebDatabaseType { schema: typeof schema } }'
  readonly __hint: 'This is optional - only needed if using bound() for route model binding'
}

/** Extract database type from augmented interface, shows error type if not configured */
export type DatabaseType = WebDatabaseType extends { type: infer T }
  ? T
  : HonertiaDatabaseType extends { type: infer T }
    ? T
    : DatabaseNotConfigured

/** Extract schema type from augmented interface, shows error type if not configured */
export type SchemaType = WebDatabaseType extends { schema: infer T }
  ? T
  : HonertiaDatabaseType extends { schema: infer T }
    ? T
    : SchemaNotConfigured

/**
 * Augmentable interface for auth type.
 * Users can extend this via module augmentation:
 *
 * @example
 * ```typescript
 * declare module '@popcomputer/web/effect' {
 *   interface WebAuthType {
 *     type: ReturnType<typeof betterAuth> // Your auth instance type
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WebAuthType {}

/** @deprecated Augment {@link WebAuthType} instead. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HonertiaAuthType {}

/**
 * Error type shown when WebAuthType.type is not configured.
 */
interface AuthNotConfigured {
  readonly __error: 'AuthService type not configured. Add module augmentation: declare module "@popcomputer/web/effect" { interface WebAuthType { type: YourAuthType } }'
  readonly __hint: 'This is optional - only needed if using AuthService'
}

/** Extract auth type from augmented interface, shows error type if not configured */
export type AuthType = WebAuthType extends { type: infer T }
  ? T
  : HonertiaAuthType extends { type: infer T }
    ? T
    : AuthNotConfigured

/**
 * Augmentable interface for environment bindings type.
 * Users can extend this via module augmentation:
 *
 * @example
 * ```typescript
 * declare module '@popcomputer/web/effect' {
 *   interface WebBindingsType {
 *     type: {
 *       DB: D1Database
 *       KV: KVNamespace
 *       ANALYTICS: AnalyticsEngineDataset
 *     }
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WebBindingsType {}

/** @deprecated Augment {@link WebBindingsType} instead. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HonertiaBindingsType {}

/**
 * Error type shown when WebBindingsType.type is not configured.
 */
interface BindingsNotConfigured {
  readonly __error: 'BindingsService type not configured. Add module augmentation: declare module "@popcomputer/web/effect" { interface WebBindingsType { type: YourBindingsType } }'
  readonly __hint: 'This is optional - BindingsService will still work but be typed as Record<string, unknown>'
}

/** Extract bindings type from augmented interface, defaults to Record<string, unknown> if not configured */
export type BindingsType = WebBindingsType extends { type: infer T }
  ? T
  : HonertiaBindingsType extends { type: infer T }
    ? T
    : Record<string, unknown>

/**
 * Database Service - Generic database client
 */
const DatabaseService_base: Context.TagClass<
  DatabaseService,
  '@popcomputer/web/Database',
  DatabaseType
> = Context.Tag('@popcomputer/web/Database')<DatabaseService, DatabaseType>()

export class DatabaseService extends DatabaseService_base {}

/**
 * Auth Service - Better-auth instance
 */
const AuthService_base: Context.TagClass<
  AuthService,
  '@popcomputer/web/Auth',
  AuthType
> = Context.Tag('@popcomputer/web/Auth')<AuthService, AuthType>()

export class AuthService extends AuthService_base {}

/**
 * Bindings Service - Environment bindings (Cloudflare D1, KV, R2, etc.)
 *
 * Automatically provided by setupWeb. Use module augmentation for type safety:
 *
 * @example
 * ```typescript
 * // In your types.d.ts
 * declare module '@popcomputer/web/effect' {
 *   interface WebBindingsType {
 *     type: { DB: D1Database; KV: KVNamespace }
 *   }
 * }
 *
 * // In your action
 * const { KV, DB } = yield* BindingsService
 * ```
 */
const BindingsService_base: Context.TagClass<
  BindingsService,
  '@popcomputer/web/Bindings',
  BindingsType
> = Context.Tag('@popcomputer/web/Bindings')<BindingsService, BindingsType>()

export class BindingsService extends BindingsService_base {}

/**
 * Augmentable interface for custom auth user type.
 * Users can extend this via module augmentation to use their own AuthUser type
 * (e.g., with custom fields like isAnonymous, isAdmin, role, etc.):
 *
 * @example
 * ```typescript
 * // In your project's types.d.ts
 * import type { AuthUser as BetterAuthUser } from './auth' // Your custom auth user type
 *
 * declare module '@popcomputer/web/effect' {
 *   interface WebAuthUserType {
 *     type: BetterAuthUser // Your auth user type with custom fields
 *   }
 * }
 * ```
 *
 * Then authorize() and other auth functions will return your custom type:
 * ```typescript
 * const { user } = yield* authorize()
 * // user.isAnonymous, user.role, etc. are now typed correctly
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WebAuthUserType {}

/** @deprecated Augment {@link WebAuthUserType} instead. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HonertiaAuthUserType {}

/**
 * Default auth user structure - used when WebAuthUserType is not configured.
 * Provides the standard Better Auth user and session shape.
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
    token: string
    createdAt: Date
    updatedAt: Date
  }
}

/**
 * Authenticated User - Session with user data.
 * Uses a configured application type, otherwise uses DefaultAuthUser.
 */
export type AuthUser = WebAuthUserType extends { type: infer T }
  ? T
  : HonertiaAuthUserType extends { type: infer T }
    ? T
    : DefaultAuthUser

/**
 * Authenticated User Service - Provides the current user session
 */
const AuthUserService_base: Context.TagClass<
  AuthUserService,
  '@popcomputer/web/AuthUser',
  AuthUser
> = Context.Tag('@popcomputer/web/AuthUser')<AuthUserService, AuthUser>()

export class AuthUserService extends AuthUserService_base {}

/**
 * Email Service - Outbound email delivery
 */
export interface EmailClient {
  send: (to: string, subject: string, body: string) => Effect.Effect<void, Error>
}

export class EmailService extends Context.Tag('@popcomputer/web/Email')<
  EmailService,
  EmailClient
>() {}

/**
 * Inertia-compatible page renderer.
 */
export interface PageRenderer {
  render<T extends Record<string, unknown>>(
    component: string,
    props?: T
  ): Promise<Response>
  share(key: string, value: unknown): void
  setErrors(errors: Record<string, string>): void
}

export class PageService extends Context.Tag('@popcomputer/web/Page')<
  PageService,
  PageRenderer
>() {}

/** @deprecated Use {@link PageRenderer}. */
export type HonertiaRenderer = PageRenderer

/** @deprecated Use {@link PageService}. */
export { PageService as HonertiaService }

/**
 * Request Context - HTTP request data and environment bindings
 */
export interface RequestContext<Bindings = Record<string, unknown>> {
  readonly method: string
  readonly url: string
  readonly headers: Headers
  /**
   * Environment bindings (Cloudflare D1, KV, R2, etc.)
   * Access via: `request.env.DB`, `request.env.KV`, etc.
   *
   * For full type safety, cast to your Bindings type:
   * ```typescript
   * const { DB, KV } = request.env as Bindings
   * ```
   */
  readonly env: Bindings
  param(name: string): string | undefined
  params(): Record<string, string>
  query(): Record<string, string>
  json<T = unknown>(): Promise<T>
  parseBody(): Promise<Record<string, unknown>>
  header(name: string): string | undefined
}

export class RequestService extends Context.Tag('@popcomputer/web/Request')<
  RequestService,
  RequestContext
>() {}

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
  get<T = unknown>(key: string): T | undefined
  /** Write a request-scoped variable, visible via c.var to middleware. */
  set(key: string, value: unknown): void
}

export class RequestStateService extends Context.Tag('@popcomputer/web/RequestState')<
  RequestStateService,
  RequestStateClient
>() {}

/**
 * Response Factory - Create HTTP responses
 */
export interface ResponseFactory {
  redirect(url: string, status?: number): Response
  json<T>(data: T, status?: number): Response
  text(data: string, status?: number): Response
  notFound(): Response | Promise<Response>
}

export class ResponseFactoryService extends Context.Tag('@popcomputer/web/ResponseFactory')<
  ResponseFactoryService,
  ResponseFactory
>() {}

/**
 * Cache Service - KV-backed caching for expensive operations
 *
 * Automatically provided by setupHonertia when KV binding is available.
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
  get(key: string): Effect.Effect<string | null, CacheClientError>
  put(key: string, value: string, options?: { expirationTtl?: number }): Effect.Effect<void, CacheClientError>
  delete(key: string): Effect.Effect<void, CacheClientError>
  list(options?: { prefix?: string; cursor?: string }): Effect.Effect<{
    keys: Array<{ name: string }>
    list_complete: boolean
    cursor?: string
  }, CacheClientError>
}

/**
 * Error from cache client operations.
 */
export class CacheClientError {
  readonly _tag = 'CacheClientError'
  constructor(
    readonly reason: string,
    readonly cause?: unknown
  ) {}
}

export class CacheService extends Context.Tag('@popcomputer/web/Cache')<
  CacheService,
  CacheClient
>() {}

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
   * No-op if background execution is unavailable.
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
export class ExecutionContextService extends Context.Tag('@popcomputer/web/ExecutionContext')<
  ExecutionContextService,
  ExecutionContextClient
>() {}

/**
 * Authorization helper - opt-in to auth check.
 *
 * Returns the authenticated user if authorized.
 * Fails with UnauthorizedError if no user is present.
 * Fails with ForbiddenError if the check returns false.
 * The check function is optional - if not provided, just requires authentication.
 *
 * NOTE: This function is defined in services.ts (same file as AuthUser)
 * to ensure module augmentation of HonertiaAuthUserType works correctly.
 * If moved to a separate file, TypeScript resolves the AuthUser type
 * before the user's module augmentation is applied.
 *
 * @example
 * // Just require authentication
 * const auth = yield* authorize()
 *
 * // Require specific role (if your user type has a role field)
 * const auth = yield* authorize((a) => a.user.role === 'admin')
 *
 * // Require resource ownership
 * const auth = yield* authorize((a) => a.user.id === project.userId)
 */
export function authorize(
  check?: (user: AuthUser) => boolean
): Effect.Effect<AuthUser, UnauthorizedError | ForbiddenError, never> {
  return Effect.gen(function* () {
    const maybeUser = yield* Effect.serviceOption(AuthUserService)
    if (Option.isNone(maybeUser)) {
      return yield* Effect.fail(
        new UnauthorizedError({
          message: 'Authentication required',
          redirectTo: '/login',
        })
      )
    }

    const user = maybeUser.value
    if (check && !check(user)) {
      return yield* Effect.fail(
        new ForbiddenError({ message: 'Not authorized' })
      )
    }
    return user
  })
}
