/**
 * Typed errors for actions and the request boundary
 *
 * Each error is a Schema.TaggedError: yieldable in Effect.gen, matched by
 * `_tag`, with fields checked when it is constructed.
 * All errors support conversion to structured format via toStructured().
 */

import { Config, Data, Schema } from 'effect'
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
  value: Schema.optional(Schema.Unknown),
  expected: Schema.String,
  message: Schema.String,
  path: Schema.Array(Schema.String),
  schemaType: Schema.optional(Schema.String),
})

/**
 * Field details without the values an application's own ValidationError may
 * carry: the structured error reaches the error observer, and a rejected
 * value can be a password or a token.
 */
function withoutValues(details: FieldErrors): FieldErrors {
  const fields: FieldErrors = {}

  for (const [name, { expected, message, path, schemaType }] of Object.entries(details)) {
    fields[name] = schemaType === undefined ? { expected, message, path } : { expected, message, path, schemaType }
  }

  return fields
}

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
 * Validation Error - Field-level validation failures.
 *
 * A form submission that fails with it goes back to the form, or to
 * `redirectTo` when set, and that page receives `errors`; a JSON client gets
 * a 422.
 *
 * @example
 * ```ts
 * yield* new ValidationError({ errors: { email: 'Invalid email format' } })
 *
 * // Send a wizard's last step back to the step whose fields are wrong.
 * yield* new ValidationError({ errors: { 'items.0.amount': 'Too large' }, redirectTo: '/claims/1/items' })
 * ```
 */
export class ValidationError extends Schema.TaggedError<ValidationError>()('ValidationError', {
  errors: Schema.Record(Schema.String, Schema.String),
  /** The page the errors belong on, when it is not the page the form came from. */
  redirectTo: Schema.optional(Schema.String),
  fieldDetails: Schema.optional(Schema.Record(Schema.String, FieldErrorSchema)),
  code: OptionalErrorCode,
  /** Verified response headers accumulated by an external provider. */
  headers: OptionalHeaders,
}) implements StructuredErrorCapable {
  /** 400 for a body that could not be parsed, 422 for input that did not validate. */
  get httpStatus(): number {
    return this.code === ErrorCodes.VAL_003_BODY_PARSE_FAILED ? 400 : 422
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
        fields: this.fieldDetails === undefined ? this.createFieldDetails() : withoutValues(this.fieldDetails),
      },
    }
  }

  private createFieldDetails(): FieldErrors {
    const details: FieldErrors = {}

    for (const [field, message] of Object.entries(this.errors)) {
      details[field] = {
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
    options?: { code?: ErrorCode }
  ): ValidationError {
    return new ValidationError({ errors, ...options })
  }
}

/**
 * Unauthorized Error - Authentication required.
 *
 * A page visit goes to `redirectTo`, or to setupWeb's `auth.signInPath`
 * (default `/login`); a JSON client gets a 401.
 *
 * @example
 * ```ts
 * yield* new UnauthorizedError({ message: 'Please sign in to continue' })
 * ```
 */
export class UnauthorizedError extends Schema.TaggedError<UnauthorizedError>()('UnauthorizedError', {
  message: Schema.String,
  redirectTo: Schema.optional(Schema.String),
  code: OptionalErrorCode,
  /**
   * The authentication scheme a JSON client is told to use, as
   * `WWW-Authenticate`: `'Bearer'` for an API key. Without one, a request
   * that sent a bearer token is told `Bearer`.
   */
  challenge: Schema.optional(Schema.String),
  /**
   * A signed-in visitor on a page for guests: a page visit goes to
   * setupWeb's `auth.homePath` (default `/`) rather than to sign in.
   */
  home: Schema.optional(Schema.Boolean),
}) implements StructuredErrorCapable {
  get httpStatus(): number {
    return 401
  }

  toStructured(context: ErrorContext = emptyContext()): StructuredError {
    const code = this.code ?? ErrorCodes.AUTH_100_UNAUTHENTICATED

    return structured(code, { reason: this.message }, context, { message: this.message })
  }

  /**
   * Create an unauthenticated error, redirecting to `redirectTo` or the sign-in path.
   */
  static unauthenticated(redirectTo?: string): UnauthorizedError {
    return new UnauthorizedError({
      message: 'You must be logged in to access this resource.',
      redirectTo,
      code: ErrorCodes.AUTH_100_UNAUTHENTICATED,
    })
  }

  /**
   * Create a session expired error.
   */
  static sessionExpired(redirectTo?: string): UnauthorizedError {
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
    return this.id !== undefined && this.id !== null
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
  /**
   * The `tag` the JSON envelope reports in place of `HttpError`: the `_tag`
   * of a failure an endpoint declares, so a client tells its failures apart.
   */
  tag: Schema.optional(Schema.String),
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

    if (this.tag !== undefined) result.tag = this.tag

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
   * Create a rate limited error: a 429 with `Retry-After`, in seconds, as a
   * header and in the body.
   */
  static rateLimited(retryAfter: number): HttpError {
    return new HttpError({
      status: 429,
      message: `Too many requests. Please try again in ${retryAfter} seconds.`,
      body: { retryAfter },
      code: ErrorCodes.HTTP_429_RATE_LIMITED,
      headers: new Headers({ 'Retry-After': String(retryAfter) }),
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

/** The database operations an action runs: see `dbQuery`, `dbMutation`, `dbTransaction` and `dbBatch`. */
const DatabaseOperation = Schema.Literals(['query', 'mutation', 'transaction', 'batch'])

/** A database operation failed for a reason other than a constraint. */
export class DatabaseError extends Schema.TaggedError<DatabaseError>()('DatabaseError', {
  operation: DatabaseOperation,
  cause: Schema.Unknown,
}) implements StructuredErrorCapable {
  get message(): string {
    return this.operation === 'transaction' || this.operation === 'batch'
      ? `Database ${this.operation} failed and was rolled back.`
      : `Database ${this.operation} failed.`
  }

  get httpStatus(): number {
    return 500
  }

  toStructured(context: ErrorContext = emptyContext()): StructuredError {
    const cause = describeCause(this.cause)

    // Database messages are sensitive: production replaces them, so the
    // driver's own words reach only development pages and logs.
    return structured(
      ErrorCodes.DB_501_OPERATION_FAILED,
      { operation: this.operation },
      context,
      { message: cause ? `${this.message} ${cause}` : this.message }
    )
  }
}

/**
 * The messages along an error's cause chain, such as Drizzle's failed query
 * and the driver's reason beneath it, each once and in order.
 */
function describeCause(cause: unknown): string {
  const messages: string[] = []
  let current: unknown = cause

  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const message = current.message.trim()

    if (message && !messages.some((seen) => seen.includes(message))) {
      messages.push(message.length > 500 ? `${message.slice(0, 500)}...` : message)
    }

    current = current.cause
  }

  return messages.join(' Caused by: ')
}

/**
 * A database constraint rejected a write. `columns` names the columns of a
 * unique, not-null or foreign-key constraint when the driver reports them.
 */
export class DatabaseConstraintViolation extends Schema.TaggedError<DatabaseConstraintViolation>()('DatabaseConstraintViolation', {
  operation: DatabaseOperation,
  constraint: Schema.Literals(['unique', 'foreign-key', 'not-null', 'check', 'exclusion', 'trigger', 'unknown']),
  columns: Schema.Array(Schema.String),
  constraintName: Schema.optional(Schema.String),
  cause: Schema.Unknown,
}) implements StructuredErrorCapable {
  get message(): string {
    return this.constraint === 'unique'
      ? 'A record with these values already exists.'
      : 'The change conflicts with existing data.'
  }

  get httpStatus(): number {
    return 409
  }

  toStructured(context: ErrorContext = emptyContext()): StructuredError {
    const name = this.constraintName === undefined ? '' : ` "${this.constraintName}"`
    const columns = this.columns.length === 0 ? '' : ` on ${this.columns.join(', ')}`
    const key = this.constraintName ?? (this.columns.length === 0 ? undefined : this.columns.join(','))
    const mapping = this.constraint === 'unique' && key !== undefined
      ? ` Show it on a form field with uniqueFieldErrors(messages, { constraints: { '${key}': 'field' } }).`
      : this.constraintName !== undefined
        ? ` Show it on a form field with constraintFieldErrors({ '${this.constraintName}': { field: 'message' } }).`
        : ''

    // Database messages are sensitive: production replaces this one, so the
    // constraint's name and columns reach only development pages and logs,
    // where they say which field a uniqueFieldErrors mapping belongs on.
    return structured(
      ErrorCodes.DB_502_CONSTRAINT_VIOLATION,
      { constraint: this.constraint },
      context,
      { message: `${this.message} (${this.constraint} constraint${name}${columns}).${mapping}` }
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

  /**
   * This error as thrown while the application starts, where no error page
   * shows its hint: the message carries the fix.
   */
  atStartup(): RouteConfigurationError {
    return this.hint === undefined || this.message.endsWith(this.hint)
      ? this
      : new RouteConfigurationError({ ...this, message: `${this.message} ${this.hint}` })
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

  /** Create an error for `purges: true` on a route whose path names no record. */
  static purgesWithoutBindings(path: string): RouteConfigurationError {
    return new RouteConfigurationError({
      message: `Route '${path}' has purges: true, but its path has no {param} that binds a model whose record it could purge.`,
      hint: "List the tags it changes instead, such as purges: ['posts'] for the table a create route writes.",
      code: ErrorCodes.CFG_305_INVALID_CONFIG,
    })
  }

  /** Create an error for a route whose records were asked for before a guard read its guarded one. */
  static guardedWithoutGuard(binding: string): RouteConfigurationError {
    return new RouteConfigurationError({
      message: `Route binding "${binding}" is guarded: true, but this route's records were asked for before a guard(...) read it, so nothing had decided who may load it.`,
      hint: `Wrap the layer that decides in guard(...), as guard(CurrentMember, Effect.gen(...)), have it read bound('${binding}'), and provide it to every route whose path names {${binding}}, before any other layer that reads a record.`,
      binding,
      code: ErrorCodes.RTE_606_BINDING_ACCESS_INVALID,
    })
  }

  /** Create an error for a route that caches a record that depends on who is visiting. */
  static cacheOnPersonalRoute(path: string, bindings: readonly string[]): RouteConfigurationError {
    const named = bindings.map((binding) => `"${binding}"`).join(' and ')

    return new RouteConfigurationError({
      message: `Route '${path}' caches its response, but who may load ${named} depends on the visitor: a shared cache answers before the Worker runs, so it would hand one visitor's record to the next.`,
      hint: `Remove cache from this route. A page anyone may see binds the table a second time with publicWhen or public: true, under a path of its own, and caches there.`,
      code: ErrorCodes.CFG_305_INVALID_CONFIG,
    })
  }

  /** Create an error for an endpoint registered on routes with a prefix. */
  static endpointUnderPrefix(path: string, prefix: string): RouteConfigurationError {
    return new RouteConfigurationError({
      message: `The endpoint on ${path} is registered under the prefix '${prefix}', which its path does not start with.`,
      hint: 'Register the endpoint on routes whose prefix its declared path starts with, or on routes without one.',
      code: ErrorCodes.CFG_305_INVALID_CONFIG,
    })
  }

  /** Create an error for a path registered twice for one method. */
  static routeRegisteredTwice(method: string, path: string): RouteConfigurationError {
    const verb = method === 'all' ? 'ALL' : method.toUpperCase()

    return new RouteConfigurationError({
      message: `${verb} ${path} is registered twice; the second registration is never reached.`,
      hint: 'Remove one registration, or give the second its own path.',
      code: ErrorCodes.CFG_305_INVALID_CONFIG,
    })
  }

  /** Create an error for a route an earlier route's path answers first. */
  static routeShadowed(method: string, path: string, earlierMethod: string, earlier: string): RouteConfigurationError {
    const verb = (name: string) => name === 'all' ? 'ALL' : name.toUpperCase()
    const hint = `Register ${path} before ${earlier}.`

    return new RouteConfigurationError({
      message: `${verb(method)} ${path} is registered after ${verb(earlierMethod)} ${earlier}, whose path matches it, so it is never reached: routes answer in the order they are registered.`,
      hint,
      code: ErrorCodes.CFG_305_INVALID_CONFIG,
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
  static tableNotFound(table: string, available?: readonly string[]): RouteConfigurationError {
    return new RouteConfigurationError({
      message: `No table "${table}" found in schema for route model binding.`,
      ...(available === undefined ? {} : { hint: `Name one of setupWeb's schema keys: ${available.map((key) => `"${key}"`).join(', ')}.` }),
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

  /** Create an error for a binding scope that names no single earlier binding of its route. */
  static scopeNotInRoute(binding: string, scope: string, earlier: readonly string[]): RouteConfigurationError {
    return new RouteConfigurationError({
      message: `Route binding "${binding}" is scoped to "${scope}", which is not one binding before it on this route.`,
      hint: earlier.length > 0
        ? `Name one of the bindings before "${binding}" in its scope: ${earlier.map((name) => `"${name}"`).join(', ')}.`
        : `"${binding}" is the route's first binding, so it has no parent to scope to: remove its scope.`,
      binding,
      code: ErrorCodes.RTE_603_RELATION_NOT_FOUND,
    })
  }

  /** Create an error for a binding whose scope names no other binding. */
  static scopeNotABinding(binding: string, scope: string, bindings: readonly string[]): RouteConfigurationError {
    return new RouteConfigurationError({
      message: `Route binding "${binding}" is scoped to "${scope}", which is not another of setupWeb's bindings.`,
      hint: bindings.length > 0
        ? `Name the binding of its parent in its scope: one of ${bindings.map((name) => `"${name}"`).join(', ')}.`
        : `Add the parent's binding to setupWeb's bindings, or remove "${binding}"'s scope.`,
      binding,
      code: ErrorCodes.RTE_603_RELATION_NOT_FOUND,
    })
  }

  /** Create an error for a binding that says more than one thing about who may load it. */
  static bindingAccessConflict(binding: string, given: readonly string[]): RouteConfigurationError {
    return new RouteConfigurationError({
      message: `Route binding "${binding}" gives ${given.join(' and ')}: it can say only one of ownedBy, public, publicWhen and guarded.`,
      hint: `Keep the one that says who may load "${binding}": ownedBy for its owner only, public: true for anyone, publicWhen for anyone when its columns hold the values it gives, or guarded: true when a guard layer decides.`,
      binding,
      code: ErrorCodes.RTE_606_BINDING_ACCESS_INVALID,
    })
  }

  /**
   * Create an error for a binding whose owner column does not reference the
   * users table, so it would compare another table's ids with the user's.
   */
  static bindingOwnerNotUser(
    binding: string,
    table: string,
    column: string,
    users: string,
    referenced: string | undefined,
    parent = 'parent'
  ): RouteConfigurationError {
    return new RouteConfigurationError({
      message: referenced === undefined
        ? `Route binding "${binding}" is ownedBy "${column}", which does not reference "${users}": nothing says it holds a user's id.`
        : `Route binding "${binding}" is ownedBy "${column}", which references "${referenced}", not "${users}": compared with the signed-in user's id, it would match no record.`,
      hint: referenced === undefined
        ? `Declare the reference on "${table}", ${column}: text(...).references(() => ${users}.id), and generate a migration.`
        : `Put "${binding}" under the "${referenced}" row it belongs to: its binding in the path before "{${binding}}", "${binding}" scoped to it with scope: { ${parent}: { foreignKey: '${column}' } }, and the "${parent}" binding saying who may load it (guarded: true when a membership guard decides).`,
      binding,
      table,
      code: ErrorCodes.RTE_607_BINDING_OWNER_NOT_USER,
    })
  }

  /**
   * Create an error for a binding that says anyone may load it, nested under
   * a parent that says who may.
   */
  static publicUnderRestrictedParent(binding: string, parent: string, foreignKeys: readonly string[]): RouteConfigurationError {
    const foreignKey = foreignKeys.length === 1 ? `'${foreignKeys[0]}'` : `[${foreignKeys.map((key) => `'${key}'`).join(', ')}]`

    return new RouteConfigurationError({
      message: `Route binding "${binding}" says public: true, but loads under "${parent}" here, which says who may load it: anyone may load "${binding}" on a path without "${parent}".`,
      hint: `Give "${binding}" scope: { ${parent}: { foreignKey: ${foreignKey} } } instead, so it loads only under its ${parent} and the ${parent}'s option decides; bind the table a second time for a page anyone may see.`,
      binding,
      code: ErrorCodes.RTE_606_BINDING_ACCESS_INVALID,
    })
  }

  /** Create an error for a binding whose publicWhen names no column. */
  static bindingPublicWhenEmpty(binding: string): RouteConfigurationError {
    return new RouteConfigurationError({
      message: `Route binding "${binding}" gives publicWhen with no column, which would make every record public.`,
      hint: `Name the column and the value that make a record public, as publicWhen: { visibility: 'public' }, or give public: true if every record is.`,
      binding,
      code: ErrorCodes.RTE_606_BINDING_ACCESS_INVALID,
    })
  }

  /**
   * Create an error for a binding whose publicWhen gives a column the value
   * undefined, which a SQLite boolean column compares as false: its private
   * records would be the public ones.
   */
  static bindingPublicWhenUndefined(binding: string, column: string): RouteConfigurationError {
    return new RouteConfigurationError({
      message: `Route binding "${binding}" gives publicWhen the value undefined for "${column}", which says no value that makes a record public: on a SQLite boolean column it matches the private records.`,
      hint: `Give "${column}" the value that makes a record public, as publicWhen: { ${column}: true }. When the value comes from settings or another module, make sure it is set before setupWeb is called.`,
      binding,
      code: ErrorCodes.RTE_606_BINDING_ACCESS_INVALID,
    })
  }

  /** Create an error for a binding whose lookup column matched more than one row. */
  static ambiguousBinding(binding: string, table: string, column: string): RouteConfigurationError {
    return new RouteConfigurationError({
      message: `Route binding "${binding}" matched more than one row of "${table}" by "${column}".`,
      hint: `Look "${binding}" up by a unique column, scope it under the binding that makes "${column}" unique (/orgs/{org:slug}/events/{${binding}:${column}}), or make "${column}" unique.`,
      binding,
      table,
      code: ErrorCodes.RTE_605_BINDING_AMBIGUOUS,
    })
  }

  /** Create an error when a persisted row fails its registered parser. */
  static invalidBoundRow(binding: string, table: string, issue?: string): RouteConfigurationError {
    return new RouteConfigurationError({
      message: `A row loaded for route binding "${binding}" did not satisfy its registered schema` +
        (issue === undefined ? '.' : `: ${issue}`),
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
  | DatabaseError
  | DatabaseConstraintViolation
  | SessionLookupUnavailable
  | InvalidAuthSession
  | AuthRedirect
  | Redirect
  | RouteConfigurationError
  | ConfigurationError
  | CacheError
  | ResponseCachePurgeError
  | Config.ConfigError

/**
 * Cache Error - The cache store failed an explicit cache operation.
 *
 * `cache()` never fails with it: a cache that cannot be read or written
 * computes the value instead, and the invalidation helpers report it.
 * `cacheGet` and `cacheSet` fail with it, which the boundary renders as 503.
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

  if (cause instanceof Config.ConfigError) {
    return new ConfigurationError({
      message: `Missing or invalid configuration: ${cause.message}`,
      hint: 'Set the binding in wrangler.jsonc (vars or secrets), or pass it to testEnv in tests.',
      code: ErrorCodes.CFG_305_INVALID_CONFIG,
    }).toStructured(context)
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
