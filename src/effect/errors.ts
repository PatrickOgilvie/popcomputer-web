/**
 * Typed errors for actions and the request boundary
 *
 * Each error is a Schema.TaggedError: yieldable in Effect.gen, matched by
 * `_tag`, with fields checked when it is constructed.
 * All errors support conversion to structured format via toStructured().
 */

import { Data, Schema } from 'effect'
import type {
  ErrorContext,
  StructuredError,
  FieldErrors,
  ErrorParams,
} from './error-types.js'
import {
  createStructuredError,
  ErrorCodes,
  getConfigErrorCode,
  type ErrorCode,
} from './error-catalog.js'
import { emptyContext } from './error-context.js'
import type { ResponseCachePurgeError } from './response-cache.js'

/** An optional error code from the catalog. */
const OptionalErrorCode = Schema.optional(Schema.Literals(Object.values(ErrorCodes)))

/** Response headers a failure carries, such as cookies from an auth provider. */
const OptionalHeaders = Schema.optional(Schema.instanceOf(Headers))

/** One field's validation failure; see FieldError. */
const FieldErrorSchema = Schema.Struct({
  value: Schema.Unknown,
  expected: Schema.String,
  message: Schema.String,
  path: Schema.Array(Schema.String),
  schemaType: Schema.optional(Schema.String),
})

/**
 * Interface for errors that can be converted to structured format.
 */
export interface StructuredErrorCapable {
  toStructured(context?: ErrorContext): StructuredError
}

interface StructuredOverrides {
  readonly message?: string
  readonly httpStatus?: number
  /** The error's own fix, more specific than the catalog's; listed first. */
  readonly hint?: string
}

/** Build a structured error from the catalog entry for `code`. */
function structured(
  code: string,
  params: ErrorParams,
  context: ErrorContext,
  overrides: StructuredOverrides = {}
): StructuredError {
  const { hint, ...fields } = overrides
  const base = createStructuredError(code, params, context)

  return {
    ...base,
    ...fields,
    fixes: hint === undefined ? base.fixes : [{ description: hint }, ...base.fixes],
  }
}

/**
 * Validation Error - Field-level validation failures
 *
 * @example
 * ```ts
 * yield* new ValidationError({
 *   errors: { email: 'Invalid email format' },
 *   component: 'Auth/Login',
 * })
 * ```
 */
export class ValidationError extends Schema.TaggedError<ValidationError>()('ValidationError', {
  errors: Schema.Record(Schema.String, Schema.String),
  component: Schema.optional(Schema.String),
  fieldDetails: Schema.optional(Schema.Record(Schema.String, FieldErrorSchema)),
  code: OptionalErrorCode,
  /** Verified response headers accumulated by an external provider. */
  headers: OptionalHeaders,
}) implements StructuredErrorCapable {
  get httpStatus(): number {
    return 422
  }

  toStructured(context: ErrorContext = emptyContext()): StructuredError {
    const fieldNames = Object.keys(this.errors)
    const code = this.code ?? ErrorCodes.VAL_004_SCHEMA_MISMATCH

    // SAFETY: The error boundary established the structured-error variant before restoring its precise local contract.
    return {
      ...createStructuredError(code, { fields: fieldNames.join(', '), field: fieldNames[0] ?? 'unknown' }, context),
      message: fieldNames.length === 1
        ? this.errors[fieldNames[0]]
        : `Validation failed for: ${fieldNames.join(', ')}`,
      validation: {
        fields: this.fieldDetails ?? this.createFieldDetails(),
        component: this.component,
      },
    }
  }

  private createFieldDetails(): FieldErrors {
    const details: FieldErrors = {}

    for (const [field, message] of Object.entries(this.errors)) {
      details[field] = {
        value: undefined,
        expected: 'valid value',
        message,
        path: field.split('.'),
      }
    }

    return details
  }

  /**
   * Create a validation error from field errors.
   */
  static fromFields(
    errors: Record<string, string>,
    options?: { component?: string; code?: ErrorCode }
  ): ValidationError {
    return new ValidationError({ errors, ...options })
  }
}

/**
 * Unauthorized Error - Authentication required
 *
 * @example
 * ```ts
 * yield* new UnauthorizedError({
 *   message: 'Please log in to continue',
 *   redirectTo: '/login',
 * })
 * ```
 */
export class UnauthorizedError extends Schema.TaggedError<UnauthorizedError>()('UnauthorizedError', {
  message: Schema.String,
  redirectTo: Schema.optional(Schema.String),
  code: OptionalErrorCode,
}) implements StructuredErrorCapable {
  get httpStatus(): number {
    return 401
  }

  toStructured(context: ErrorContext = emptyContext()): StructuredError {
    const code = this.code ?? ErrorCodes.AUTH_100_UNAUTHENTICATED

    return structured(code, { reason: this.message }, context, { message: this.message })
  }

  /**
   * Create an unauthenticated error with redirect.
   */
  static unauthenticated(redirectTo = '/login'): UnauthorizedError {
    return new UnauthorizedError({
      message: 'You must be logged in to access this resource.',
      redirectTo,
      code: ErrorCodes.AUTH_100_UNAUTHENTICATED,
    })
  }

  /**
   * Create a session expired error.
   */
  static sessionExpired(redirectTo = '/login'): UnauthorizedError {
    return new UnauthorizedError({
      message: 'Your session has expired. Please log in again.',
      redirectTo,
      code: ErrorCodes.AUTH_101_SESSION_EXPIRED,
    })
  }
}

/**
 * Not Found Error - Resource not found
 *
 * @example
 * ```ts
 * yield* new NotFoundError({ resource: 'User', id: userId })
 * ```
 */
export class NotFoundError extends Schema.TaggedError<NotFoundError>()('NotFoundError', {
  resource: Schema.String,
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  code: OptionalErrorCode,
}) implements StructuredErrorCapable {
  get httpStatus(): number {
    return 404
  }

  get message(): string {
    return this.id
      ? `${this.resource} with id "${this.id}" was not found.`
      : `${this.resource} was not found.`
  }

  toStructured(context: ErrorContext = emptyContext()): StructuredError {
    const code = this.code ?? ErrorCodes.RES_200_NOT_FOUND

    return structured(code, { resource: this.resource, id: this.id }, context)
  }

  /**
   * Create a not found error for a resource.
   */
  static forResource(resource: string, id?: string | number): NotFoundError {
    return new NotFoundError({ resource, id })
  }
}

/**
 * Forbidden Error - Authenticated but not authorized
 *
 * @example
 * ```ts
 * yield* new ForbiddenError({ message: 'You do not have permission to edit this post.' })
 * ```
 */
export class ForbiddenError extends Schema.TaggedError<ForbiddenError>()('ForbiddenError', {
  message: Schema.String,
  code: OptionalErrorCode,
}) implements StructuredErrorCapable {
  get httpStatus(): number {
    return 403
  }

  toStructured(context: ErrorContext = emptyContext()): StructuredError {
    const code = this.code ?? ErrorCodes.AUTH_102_FORBIDDEN

    return structured(code, { reason: this.message }, context, { message: this.message })
  }

  /**
   * Create a forbidden error with a reason.
   */
  static withReason(reason: string): ForbiddenError {
    return new ForbiddenError({ message: reason })
  }
}

/**
 * Authentication rate limit returned by an auth provider.
 *
 * The original cause is retained for server-side observation but is never
 * included in the client projection. When the provider supplies a retry
 * delay, the HTTP adapter emits it as `Retry-After` and in the structured
 * response body.
 */
export class AuthRateLimitError extends Schema.TaggedError<AuthRateLimitError>()('AuthRateLimitError', {
  retryAfterSeconds: Schema.UndefinedOr(Schema.Number),
  cause: Schema.Unknown,
  headers: OptionalHeaders,
}) implements StructuredErrorCapable {
  get httpStatus(): number {
    return 429
  }

  get message(): string {
    if (this.retryAfterSeconds === undefined) {
      return 'Too many authentication attempts. Please try again later.'
    }

    return `Too many authentication attempts. Please try again in ${this.retryAfterSeconds} seconds.`
  }

  toStructured(context: ErrorContext = emptyContext()): StructuredError {
    const result = structured(
      ErrorCodes.AUTH_104_RATE_LIMITED,
      {},
      context,
      { message: this.message }
    )

    if (this.retryAfterSeconds !== undefined) {
      return Object.assign(result, {
        body: {
          retryAfter: this.retryAfterSeconds,
        },
      })
    }

    return result
  }
}

/**
 * HTTP Error - Generic HTTP error with custom status
 *
 * @example
 * ```ts
 * yield* new HttpError({
 *   status: 429,
 *   message: 'Too many requests',
 *   body: { retryAfter: 60 },
 * })
 * ```
 */
export class HttpError extends Schema.TaggedError<HttpError>()('HttpError', {
  status: Schema.Number,
  message: Schema.String,
  body: Schema.optional(Schema.Unknown),
  code: OptionalErrorCode,
  cause: Schema.optional(Schema.Unknown),
  headers: OptionalHeaders,
}) implements StructuredErrorCapable {
  get httpStatus(): number {
    return this.status
  }

  toStructured(context: ErrorContext = emptyContext()): StructuredError {
    const code = this.code ?? this.statusToCode()

    const result = structured(code, { reason: this.message }, context, {
      httpStatus: this.status,
      message: this.message,
    })

    if (this.body !== undefined) {
      // SAFETY: The error boundary established the structured-error variant before restoring its precise local contract.
      (result as StructuredError & { body: unknown }).body = this.body
    }

    return result
  }

  private statusToCode(): ErrorCode {
    switch (this.status) {
      case 400: return ErrorCodes.HTTP_400_BAD_REQUEST
      case 429: return ErrorCodes.HTTP_429_RATE_LIMITED
      case 502: return ErrorCodes.HTTP_502_BAD_GATEWAY
      case 503: return ErrorCodes.HTTP_503_SERVICE_UNAVAILABLE
      default:
        return this.status < 500 ? ErrorCodes.HTTP_4XX_CLIENT_ERROR : ErrorCodes.HTTP_500_INTERNAL_ERROR
    }
  }

  /**
   * Create a bad request error.
   */
  static badRequest<Body>(message: string, body?: Body): HttpError {
    return new HttpError({ status: 400, message, body, code: ErrorCodes.HTTP_400_BAD_REQUEST })
  }

  /**
   * Create a rate limited error.
   */
  static rateLimited(retryAfter: number): HttpError {
    return new HttpError({
      status: 429,
      message: `Too many requests. Please try again in ${retryAfter} seconds.`,
      body: { retryAfter },
      code: ErrorCodes.HTTP_429_RATE_LIMITED,
    })
  }

  /**
   * Create an internal server error.
   */
  static internal(message = 'An unexpected error occurred.'): HttpError {
    return new HttpError({ status: 500, message, code: ErrorCodes.HTTP_500_INTERNAL_ERROR })
  }
}

/** Verified redirect control flow emitted by an authentication provider. */
export class AuthRedirect extends Data.TaggedClass('AuthRedirect')<{
  readonly status: number
  readonly headers: Headers
}> {}

/** A database write failed outside a transaction. */
export class DatabaseMutationFailed extends Schema.TaggedError<DatabaseMutationFailed>()('DatabaseMutationFailed', {
  operation: Schema.Literal('mutation'),
  cause: Schema.Unknown,
}) implements StructuredErrorCapable {
  get message(): string {
    return 'Database mutation failed.'
  }

  get httpStatus(): number {
    return 500
  }

  toStructured(context: ErrorContext = emptyContext()): StructuredError {
    return structured(
      ErrorCodes.DB_501_QUERY_FAILED,
      { reason: 'mutation failed' },
      context,
      { message: this.message }
    )
  }
}

/** A database transaction failed and was rolled back. */
export class DatabaseTransactionFailed extends Schema.TaggedError<DatabaseTransactionFailed>()('DatabaseTransactionFailed', {
  operation: Schema.Literal('transaction'),
  cause: Schema.Unknown,
}) implements StructuredErrorCapable {
  get message(): string {
    return 'Database transaction failed and was rolled back.'
  }

  get httpStatus(): number {
    return 500
  }

  toStructured(context: ErrorContext = emptyContext()): StructuredError {
    return structured(
      ErrorCodes.DB_503_TRANSACTION_FAILED,
      { reason: 'transaction failed' },
      context,
      { message: this.message }
    )
  }
}

/** A database constraint rejected a mutation or transaction. */
export class DatabaseConstraintViolation extends Schema.TaggedError<DatabaseConstraintViolation>()('DatabaseConstraintViolation', {
  operation: Schema.Literals(['mutation', 'transaction']),
  constraint: Schema.Literals(['unique', 'foreign-key', 'not-null', 'check', 'unknown']),
  cause: Schema.Unknown,
}) implements StructuredErrorCapable {
  get message(): string {
    return 'Database constraint violation.'
  }

  get httpStatus(): number {
    return 409
  }

  toStructured(context: ErrorContext = emptyContext()): StructuredError {
    return structured(
      ErrorCodes.DB_502_CONSTRAINT_VIOLATION,
      { constraint: this.constraint },
      context,
      { message: this.message }
    )
  }
}

/** Better Auth could not determine the current session. */
export class SessionLookupUnavailable extends Schema.TaggedError<SessionLookupUnavailable>()('SessionLookupUnavailable', {
  operation: Schema.Literal('getSession'),
  cause: Schema.Unknown,
}) implements StructuredErrorCapable {
  get message(): string {
    return 'Authentication service is unavailable.'
  }

  get httpStatus(): number {
    return 503
  }

  toStructured(context: ErrorContext = emptyContext()): StructuredError {
    return structured(
      ErrorCodes.SVC_700_SERVICE_UNAVAILABLE,
      { service: 'authentication' },
      context,
      { message: this.message, httpStatus: this.httpStatus }
    )
  }
}

/** Better Auth returned a session that did not satisfy the configured parser. */
export class InvalidAuthSession extends Schema.TaggedError<InvalidAuthSession>()('InvalidAuthSession', {
  operation: Schema.Literal('parseSession'),
  cause: Schema.Unknown,
}) implements StructuredErrorCapable {
  get message(): string {
    return 'Authentication provider returned an invalid session.'
  }

  get httpStatus(): number {
    return 500
  }

  toStructured(context: ErrorContext = emptyContext()): StructuredError {
    return structured(
      ErrorCodes.SVC_701_SERVICE_ERROR,
      { service: 'authentication', reason: 'invalid session response' },
      context,
      { message: this.message }
    )
  }
}

/**
 * Route Configuration Error - Developer error in route setup
 *
 * @example
 * ```ts
 * yield* new RouteConfigurationError({
 *   message: 'No table found for binding "project"',
 *   table: 'project',
 *   code: ErrorCodes.RTE_601_TABLE_NOT_FOUND,
 * })
 * ```
 */
export class RouteConfigurationError extends Schema.TaggedError<RouteConfigurationError>()('RouteConfigurationError', {
  message: Schema.String,
  hint: Schema.optional(Schema.String),
  code: OptionalErrorCode,
  binding: Schema.optional(Schema.String),
  table: Schema.optional(Schema.String),
  parent: Schema.optional(Schema.String),
  child: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) implements StructuredErrorCapable {
  get httpStatus(): number {
    return 500
  }

  toStructured(context: ErrorContext = emptyContext()): StructuredError {
    const code = this.code ?? this.inferCode()

    return structured(
      code,
      { binding: this.binding, table: this.table, parent: this.parent, child: this.child },
      context,
      { message: this.message, hint: this.hint }
    )
  }

  private inferCode(): ErrorCode {
    if (this.table) return ErrorCodes.RTE_601_TABLE_NOT_FOUND

    if (this.parent && this.child) return ErrorCodes.RTE_603_RELATION_NOT_FOUND

    return ErrorCodes.RTE_600_BINDING_NOT_FOUND
  }

  /**
   * Create an error for missing schema binding.
   */
  static schemaNotConfigured(binding: string): RouteConfigurationError {
    return new RouteConfigurationError({
      message: `Route model binding requires schema configuration. Cannot resolve bound('${binding}') without schema.`,
      binding,
      code: ErrorCodes.CFG_302_SCHEMA_NOT_CONFIGURED,
    })
  }

  /** Create an error for bound(key) in an action whose route has no {key} placeholder. */
  static bindingNotInRoute(binding: string): RouteConfigurationError {
    return new RouteConfigurationError({
      message: `bound('${binding}') was called, but this route does not bind "${binding}".`,
      hint: `Add {${binding}} to the route path, for example /${binding}s/{${binding}}, or read the value another way.`,
      binding,
      code: ErrorCodes.RTE_600_BINDING_NOT_FOUND,
    })
  }

  /**
   * Create an error for missing table in schema.
   */
  static tableNotFound(table: string): RouteConfigurationError {
    return new RouteConfigurationError({
      message: `No table "${table}" found in schema for route model binding.`,
      table,
      code: ErrorCodes.RTE_601_TABLE_NOT_FOUND,
    })
  }

  /** Create an error for a route binding without a registered row parser. */
  static bindingParserNotConfigured(binding: string): RouteConfigurationError {
    return new RouteConfigurationError({
      message: `No row parser is configured for route binding "${binding}".`,
      hint: `Register it once in setupWeb(app, { bindings: { ${binding}: YourSchema }, version, render }).`,
      binding,
      code: ErrorCodes.RTE_600_BINDING_NOT_FOUND,
    })
  }

  /** Create an error for a lookup column missing from its Drizzle table. */
  static bindingColumnNotFound(
    binding: string,
    table: string,
    column: string
  ): RouteConfigurationError {
    return new RouteConfigurationError({
      message: `Column "${column}" for route binding "${binding}" does not exist on table "${table}".`,
      binding,
      table,
      code: ErrorCodes.RTE_601_TABLE_NOT_FOUND,
    })
  }

  /** Create an error when a nested binding cannot be scoped to its parent. */
  static relationNotFound(
    parent: string,
    child: string,
    binding?: string
  ): RouteConfigurationError {
    return new RouteConfigurationError({
      message: `Nested route binding "${binding ?? child}" cannot be scoped because no usable relation exists between "${child}" and parent "${parent}".`,
      hint: 'Define the Drizzle relation or register an explicit parent scope with routeBinding(...).',
      binding,
      parent,
      child,
      code: ErrorCodes.RTE_603_RELATION_NOT_FOUND,
    })
  }

  /** Create an error when route model binding runs without drizzle-orm installed. */
  static drizzleNotInstalled(cause: unknown): RouteConfigurationError {
    return new RouteConfigurationError({
      message: 'Route model binding needs drizzle-orm, but it could not be loaded.',
      hint: 'Install drizzle-orm in the app (bun add drizzle-orm). It is an optional peer of @popcomputer/web, needed only for route bindings.',
      cause,
      code: ErrorCodes.CFG_305_INVALID_CONFIG,
    })
  }

  /** Create an error when a persisted row fails its registered parser. */
  static invalidBoundRow(binding: string, table: string): RouteConfigurationError {
    return new RouteConfigurationError({
      message: `A row loaded for route binding "${binding}" did not satisfy its registered schema.`,
      hint: `Align the "${binding}" parser with persisted rows from "${table}" or repair the invalid data.`,
      binding,
      table,
      code: ErrorCodes.RTE_604_BOUND_ROW_INVALID,
    })
  }
}

/**
 * Configuration Error - Missing service configuration
 *
 * @example
 * ```ts
 * throw new ConfigurationError({
 *   message: 'DatabaseService is not configured',
 *   service: 'DatabaseService',
 *   code: ErrorCodes.CFG_300_DATABASE_NOT_CONFIGURED,
 * })
 * ```
 */
export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()('ConfigurationError', {
  message: Schema.String,
  hint: Schema.optional(Schema.String),
  code: OptionalErrorCode,
  service: Schema.optional(Schema.String),
}) implements StructuredErrorCapable {
  get httpStatus(): number {
    return 500
  }

  toStructured(context: ErrorContext = emptyContext()): StructuredError {
    const code = this.code ?? getConfigErrorCode(this.service, this.message)

    const location = context.route
      ? `${context.route.method} ${context.route.path}`
      : 'unknown'

    return structured(code, { location, reason: this.message }, context, {
      message: this.message,
      hint: this.hint,
    })
  }

  /**
   * Create an error for missing database configuration.
   */
  static databaseNotConfigured(): ConfigurationError {
    return new ConfigurationError({
      message: 'DatabaseService is not configured. Add it to setupWeb.',
      service: 'DatabaseService',
      code: ErrorCodes.CFG_300_DATABASE_NOT_CONFIGURED,
    })
  }

  /**
   * Create an error for missing auth configuration.
   */
  static authNotConfigured(): ConfigurationError {
    return new ConfigurationError({
      message: 'AuthService is not configured. Add it to setupWeb.',
      service: 'AuthService',
      code: ErrorCodes.CFG_301_AUTH_NOT_CONFIGURED,
    })
  }

  /**
   * Create an error for missing schema configuration.
   */
  static schemaNotConfigured(): ConfigurationError {
    return new ConfigurationError({
      message: 'Schema is not configured for route model binding.',
      service: 'Schema',
      code: ErrorCodes.CFG_302_SCHEMA_NOT_CONFIGURED,
    })
  }
}


/**
 * Redirect - Control flow for HTTP redirects (not an error)
 */
export class Redirect extends Data.TaggedClass('Redirect')<{
  readonly url: string
  readonly status: 302 | 303
}> {
  /**
   * Create a redirect to a URL.
   */
  static to(url: string, status: 302 | 303 = 302): Redirect {
    return new Redirect({ url, status })
  }

  /**
   * Create a redirect back (303 for POST/PUT/DELETE).
   */
  static back(fallback = '/'): Redirect {
    return new Redirect({ url: fallback, status: 303 })
  }
}

/**
 * Union of all application errors
 */
export type AppError =
  | ValidationError
  | UnauthorizedError
  | NotFoundError
  | ForbiddenError
  | AuthRateLimitError
  | HttpError
  | DatabaseMutationFailed
  | DatabaseTransactionFailed
  | DatabaseConstraintViolation
  | SessionLookupUnavailable
  | InvalidAuthSession
  | AuthRedirect
  | RouteConfigurationError
  | ConfigurationError
  | CacheError
  | ResponseCachePurgeError

/**
 * Cache Error - The cache store failed an explicit cache operation.
 *
 * `cache()` never fails with it: a cache that cannot be read or written
 * computes the value instead. `cacheGet`, `cacheSet` and the invalidation
 * helpers fail with it, which the boundary renders as 503.
 */
export class CacheError extends Schema.TaggedError<CacheError>()('CacheError', {
  reason: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) implements StructuredErrorCapable {
  get httpStatus(): number {
    return 503
  }

  toStructured(context: ErrorContext = emptyContext()): StructuredError {
    return structured(ErrorCodes.SVC_702_CACHE_UNAVAILABLE, { reason: this.reason }, context, {
      message: this.reason,
    })
  }
}

/**
 * Check if an error supports structured conversion.
 */
export function isStructuredError(cause: unknown): cause is StructuredErrorCapable {
  return (
    cause instanceof Object &&
    'toStructured' in cause &&
    cause.toStructured instanceof Function
  )
}

/**
 * Convert any error to a structured error format.
 *
 * Handles the package's errors by calling their `toStructured()` method.
 * Falls back to a generic internal error for unknown error types.
 *
 * @param error - Any error value (Error, AppError, or unknown).
 * @param context - Optional error context with route/request info.
 * @returns A fully structured error with code, message, fixes, and docs.
 */
export function toStructuredError(
  cause: unknown,
  context: ErrorContext = emptyContext()
): StructuredError {
  if (isStructuredError(cause)) {
    return cause.toStructured(context)
  }

  if (cause instanceof Error) {
    return createStructuredError(
      ErrorCodes.INT_800_UNEXPECTED,
      { reason: cause.message },
      context
    )
  }

  return createStructuredError(
    ErrorCodes.INT_800_UNEXPECTED,
    { reason: String(cause) },
    context
  )
}
