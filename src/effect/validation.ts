/**
 * Effect Validation Helpers
 *
 * Utilities for validating request data using Effect Schema.
 */

import { Effect, Predicate, Schema as S, SchemaIssue } from 'effect'
import type { ParseOptions } from 'effect/SchemaAST'
import { RequestService } from './services.js'
import { ValidationError } from './errors.js'
import type { FieldError } from './error-types.js'
import { ErrorCodes, type ErrorCode } from './error-catalog.js'

const BODYLESS_METHODS = new Set(['GET', 'HEAD'])

const formatSchemaIssue = SchemaIssue.makeFormatterStandardSchemaV1()

type FormattedSchemaIssue = ReturnType<typeof formatSchemaIssue>['issues'][number]

/** Request input before schema decoding: keys from params, query and body. */
export type RequestData = Record<string, unknown>

/**
 * Request data source for validateRequest input extraction.
 */
export type RequestValidationSource = 'params' | 'query' | 'body'

/**
 * Conflict handling when multiple request sources provide the same key.
 */
export type RequestValidationConflict = 'last-wins' | 'first-wins' | 'error'

/**
 * Which request sources validateRequest reads, and how it treats a key that
 * more than one source provides.
 */
export interface RequestValidationOptions {
  /**
   * Sources to read, in merge order. Defaults to route params, then query,
   * then body. Pass `['body']` to read only the body.
   */
  order?: ReadonlyArray<RequestValidationSource>

  /**
   * How to resolve a key that more than one source provides with different
   * values. Defaults to `'error'`, a ValidationError naming the field and both
   * sources, so a body field cannot silently replace a route parameter.
   * `'last-wins'` keeps the value from the later source in `order`, and
   * `'first-wins'` the earlier.
   */
  onConflict?: RequestValidationConflict
}

interface ResolvedRequestValidationOptions {
  order: ReadonlyArray<RequestValidationSource>
  onConflict: RequestValidationConflict
}

interface SourceConflict {
  field: string
  existingSource: RequestValidationSource
  incomingSource: RequestValidationSource
  existingValue: unknown
  incomingValue: unknown
}

const DEFAULT_ORDER: ReadonlyArray<RequestValidationSource> = ['params', 'query', 'body']

function normalizeRequestValidationOptions(
  config: RequestValidationOptions = {}
): ResolvedRequestValidationOptions {
  const seen = new Set<RequestValidationSource>()

  const order = (config.order ?? DEFAULT_ORDER).filter((source) => {
    if (seen.has(source)) return false
    seen.add(source)

    return true
  })

  return {
    order,
    onConflict: config.onConflict ?? 'error',
  }
}

function isJsonContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase()
  const mediaType = normalized.split(';')[0].trim()

  return mediaType.endsWith('/json') || mediaType.endsWith('+json')
}

function createSourceConflictValidationError(
  conflicts: ReadonlyArray<SourceConflict>,
  component?: string
): ValidationError {
  const errors: Record<string, string> = {}
  const fieldDetails: Record<string, FieldError> = {}

  for (const conflict of conflicts) {
    const message = `Conflicting values for ${conflict.field} from ${conflict.existingSource} and ${conflict.incomingSource}.`
    errors[conflict.field] = message
    fieldDetails[conflict.field] = {
      value: {
        [conflict.existingSource]: conflict.existingValue,
        [conflict.incomingSource]: conflict.incomingValue,
      },
      expected: 'a single unambiguous value from request input',
      message,
      path: conflict.field.split('.'),
      schemaType: 'RequestInput',
    }
  }

  return new ValidationError({
    errors,
    fieldDetails,
    component,
    code: ErrorCodes.VAL_006_SOURCE_CONFLICT,
  })
}

function mergeRequestSources(
  orderedSources: ReadonlyArray<{
    source: RequestValidationSource
    data: RequestData
  }>,
  onConflict: RequestValidationConflict,
  component?: string
): Effect.Effect<RequestData, ValidationError, never> {
  const merged: RequestData = {}
  const sourceOfKey = new Map<string, RequestValidationSource>()
  const conflicts: SourceConflict[] = []

  for (const { source, data } of orderedSources) {
    for (const [key, value] of Object.entries(data)) {
      if (!(key in merged)) {
        merged[key] = value
        sourceOfKey.set(key, source)
        continue
      }

      if (onConflict === 'first-wins') {
        continue
      }

      if (onConflict === 'last-wins') {
        merged[key] = value
        sourceOfKey.set(key, source)
        continue
      }

      const existingValue = merged[key]

      if (Object.is(existingValue, value)) {
        continue
      }

      conflicts.push({
        field: key,
        existingSource: sourceOfKey.get(key) ?? source,
        incomingSource: source,
        existingValue,
        incomingValue: value,
      })
    }
  }

  if (conflicts.length > 0) {
    return Effect.fail(createSourceConflictValidationError(conflicts, component))
  }

  return Effect.succeed(merged)
}

function getValidationDataWithOptions(
  config?: RequestValidationOptions,
  errorComponent?: string
): Effect.Effect<RequestData, ValidationError, RequestService> {
  return Effect.gen(function* () {
    const request = yield* RequestService
    const { order, onConflict } = normalizeRequestValidationOptions(config)

    const routeParams = order.includes('params') ? request.params() : {}
    const queryParams = order.includes('query') ? request.query() : {}

    let body: RequestData = {}

    if (
      order.includes('body') &&
      !BODYLESS_METHODS.has(request.method.toUpperCase())
    ) {
      const contentType = request.header('Content-Type') ?? ''
      const isJson = isJsonContentType(contentType)

      const parsed = yield* Effect.tryPromise(() =>
        isJson ? request.json<unknown>() : request.parseBody()
      ).pipe(
        Effect.mapError((error) =>
          createBodyParseValidationError(error, contentType)
        )
      )

      if (!Predicate.isObject(parsed)) {
        return yield* createBodyParseValidationError(
          new Error('The request body must be an object of fields.'),
          contentType
        )
      }

      body = parsed
    }

    const sourceData = {
      params: routeParams,
      query: queryParams,
      body,
    } satisfies Record<RequestValidationSource, RequestData>

    return yield* mergeRequestSources(
      order.map((source) => ({ source, data: sourceData[source] })),
      onConflict,
      errorComponent
    )
  })
}

/**
 * Extract validation data from the request.
 * Merges route params, query params, and body (body takes precedence).
 */
export const getValidationData: Effect.Effect<
  RequestData,
  ValidationError,
  RequestService
> = getValidationDataWithOptions()

/**
 * Result of formatting schema errors with details.
 */
export interface FormattedSchemaErrors {
  /** Simple field -> message mapping */
  errors: Record<string, string>
  /** Detailed field errors for structured output */
  details: Record<string, FieldError>
}

function getFormattedIssuePath(
  issue: FormattedSchemaIssue
): ReadonlyArray<PropertyKey> {
  return (issue.path ?? []).map((segment) =>
    segment instanceof Object ? segment.key : segment
  )
}

/**
 * Format Effect Schema parse errors into field-level validation errors.
 * Returns both simple errors and detailed field information.
 */
export function formatSchemaErrorsWithDetails<Input>(
  error: S.SchemaError,
  data: Input,
  messages: Record<string, string> = {},
  attributes: Record<string, string> = {}
): FormattedSchemaErrors {
  const errors: Record<string, string> = {}
  const details: Record<string, FieldError> = {}
  const issues = formatSchemaIssue(error.issue).issues

  for (const issue of issues) {
    const path = getFormattedIssuePath(issue)
    const field = path.length > 0 ? path.map(String).join('.') : 'form'

    if (errors[field]) continue // First error wins

    const attribute = attributes[field] ?? field
    const message = messages[field] ?? issue.message

    errors[field] = message.replace(/:attribute/g, attribute)

    let value: unknown = data

    for (const segment of path) {
      if (!(value instanceof Object)) {
        value = undefined
        break
      }

      value = Object.getOwnPropertyDescriptor(value, segment)?.value
    }

    // Create detailed field error
    details[field] = {
      value,
      expected: issue.message,
      message: errors[field],
      path: path.map(String),
      schemaType: extractSchemaType(issue.message),
    }
  }

  return { errors, details }
}

/**
 * Extract the schema type from an issue for debugging.
 */
function extractSchemaType(message: string): string | undefined {
  // Try to extract type information from the issue
  // Common patterns in Effect Schema messages
  if (message.includes('Expected')) {
    const match = message.match(/Expected\s+([^,]+)/)

    if (match) return match[1].trim()
  }

  return undefined
}

/**
 * Format Effect Schema parse errors into field-level validation errors.
 * Simple version that returns only the error messages.
 */
export interface ValidationMessages {
  [field: string]: string
}

export function formatSchemaErrors(
  error: S.SchemaError,
  messages: Record<string, string> = {},
  attributes: Record<string, string> = {}
): ValidationMessages {
  const errors: ValidationMessages = {}
  const issues = formatSchemaIssue(error.issue).issues

  for (const issue of issues) {
    const path = getFormattedIssuePath(issue)
    const field = path.length > 0 ? path.map(String).join('.') : 'form'

    if (errors[field]) continue // First error wins

    const attribute = attributes[field] ?? field
    const message = messages[field] ?? issue.message

    errors[field] = message.replace(/:attribute/g, attribute)
  }

  return errors
}

/**
 * Nominal brand marker for validated data.
 * Unique symbol prevents the brand from surviving object spreads.
 */
export const ValidatedBrand = Symbol('ValidatedBrand')

export type Validated<A> = A & { readonly [ValidatedBrand]: true }

/** Mark data as validated (type-level only), immediately after schema validation. */
const asValidated = <A>(input: A): Validated<A> => {
  // SAFETY: Validated is a type-only brand applied immediately after schema validation.
  return input as Validated<A>
}

/**
 * Nominal brand marker for trusted (server-derived) data.
 * Unique symbol prevents the brand from surviving object spreads.
 */
export const TrustedBrand = Symbol('TrustedBrand')

export type Trusted<A> = A & { readonly [TrustedBrand]: true }

/**
 * Mark data as trusted (type-level only).
 */
export const asTrusted = <A>(input: A): Trusted<A> => {
  // SAFETY: Trusted is a type-only brand applied only by server-side trusted-data helpers.
  return input as Trusted<A>
}

/**
 * Options for validation functions.
 */
export interface ValidateOptions {
  /**
   * Custom error messages keyed by field name.
   * Overrides the default messages from Effect Schema.
   *
   * @example
   * { email: 'Please enter a valid email address' }
   */
  messages?: Record<string, string>

  /**
   * Human-readable names for fields, used with the `:attribute` placeholder.
   * If a message contains `:attribute`, it will be replaced with the value here.
   *
   * @example
   * // With attributes: { email: 'email address' }
   * // And message: 'The :attribute field is required'
   * // Produces: 'The email address field is required'
   */
  attributes?: Record<string, string>

  /**
   * The Inertia component to re-render when validation fails.
   * If set, a ValidationError will trigger a re-render of this component
   * with the errors passed as props. If not set, redirects back.
   *
   * @example
   * 'Projects/Create'
   */
  errorComponent?: string

  /**
   * Which request sources to read and how to treat keys that more than one
   * source provides. By default route params, query and body are merged, and
   * a key with different values in two sources fails validation.
   */
  request?: RequestValidationOptions

  /**
   * Effect Schema ParseOptions passed to the decode call.
   * Use `{ onExcessProperty: 'error' }` to reject request payloads that
   * carry fields the schema does not declare (mass-assignment hardening).
   *
   * @example
   * validateRequest(CreateProject, { parseOptions: { onExcessProperty: 'error' } })
   */
  parseOptions?: ParseOptions
}

/**
 * Build a parse error with concrete guidance for malformed request bodies.
 */
export function createBodyParseValidationError(
  cause: unknown,
  contentType: string
): ValidationError {
  const isJson = isJsonContentType(contentType)
  const reason = cause instanceof Error ? cause.message : String(cause)
  const base = isJson ? 'Invalid JSON body' : 'Could not parse request body'

  const hint = isJson
    ? 'Ensure Content-Type is application/json and the body is valid JSON.'
    : 'Ensure the body encoding matches Content-Type and can be parsed by the request parser.'

  const message = `${base}. ${hint}`

  return new ValidationError({
    errors: { form: message },
    fieldDetails: {
      form: {
        value: reason,
        expected: isJson ? 'valid JSON payload' : 'parsable request body',
        message,
        path: ['form'],
        schemaType: isJson ? 'JSON' : 'Body',
      },
    },
    code: ErrorCodes.VAL_003_BODY_PARSE_FAILED,
  })
}

function determineValidationCode(
  details: Record<string, FieldError>
): ErrorCode {
  const hasMissingValues = Object.entries(details).some(([field, detail]) =>
    field !== 'form' && (detail.value === undefined || detail.value === null)
  )

  const hasRequiredLanguage = Object.values(details).some(
    d => d.expected?.toLowerCase().includes('required') ||
         d.message?.toLowerCase().includes('required')
  )

  return (hasMissingValues || hasRequiredLanguage)
    ? ErrorCodes.VAL_001_FIELD_REQUIRED
    : ErrorCodes.VAL_004_SCHEMA_MISMATCH
}

function runValidation<A, I, Input>(
  schema: S.Codec<A, I>,
  data: Input,
  options: ValidateOptions
): Effect.Effect<Validated<A>, ValidationError, never> {
  return S.decodeUnknownEffect(schema, options.parseOptions)(data).pipe(
    Effect.mapError((error) => {
      const { errors, details } = formatSchemaErrorsWithDetails(
        error,
        data,
        options.messages,
        options.attributes
      )

      return new ValidationError({
        errors,
        fieldDetails: details,
        component: options.errorComponent,
        code: determineValidationCode(details),
      })
    }),
    Effect.map((value) => asValidated(value))
  )
}

/**
 * Validate unknown data against a schema.
 * Use this for raw payloads (e.g. parsed request body, external JSON).
 */
export function validateUnknown<A, I, Input>(
  schema: S.Codec<A, I>,
  data: Input,
  options: ValidateOptions = {}
): Effect.Effect<Validated<A>, ValidationError, never> {
  return runValidation(schema, data, options)
}

/**
 * Validate request data against a schema.
 * Extracts data from request and validates in one step.
 */
export function validateRequest<A, I>(
  schema: S.Codec<A, I>,
  options: ValidateOptions = {}
): Effect.Effect<Validated<A>, ValidationError, RequestService> {
  return Effect.gen(function* () {
    const data = yield* getValidationDataWithOptions(
      options.request,
      options.errorComponent
    )

    return yield* validateUnknown(schema, data, options)
  })
}
