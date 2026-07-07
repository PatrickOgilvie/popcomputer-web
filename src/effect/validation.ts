/**
 * Effect Validation Helpers
 *
 * Utilities for validating request data using Effect Schema.
 */

import { Effect, Schema as S, ParseResult } from 'effect'
import type { ParseOptions } from 'effect/SchemaAST'
import { RequestService } from './services.js'
import { ValidationError } from './errors.js'
import type { FieldError } from './error-types.js'
import { ErrorCodes, type ErrorCode } from './error-catalog.js'

const BODYLESS_METHODS = new Set(['GET', 'HEAD'])

/**
 * Request data source for validateRequest input extraction.
 */
export type RequestValidationSource = 'params' | 'query' | 'body'

/**
 * Built-in request extraction profiles.
 */
export type RequestValidationProfile = 'legacy' | 'laravel'

/**
 * Conflict handling when multiple request sources provide the same key.
 */
export type RequestValidationConflict = 'last-wins' | 'first-wins' | 'error'

/**
 * Advanced request extraction options for validateRequest.
 */
export interface RequestValidationOptions {
  /**
   * Built-in extraction behavior profile.
   * - legacy: params -> query -> body
   * - laravel: query -> body
   */
  profile?: RequestValidationProfile

  /**
   * Merge order for request sources.
   * Later sources override earlier ones when `onConflict` is `last-wins`.
   */
  order?: ReadonlyArray<RequestValidationSource>

  /**
   * How to resolve duplicate keys across sources.
   */
  onConflict?: RequestValidationConflict
}

/**
 * Request extraction config accepted by validateRequest.
 * Pass a profile string for quick setup or an object for full control.
 */
export type RequestValidationConfig =
  | RequestValidationProfile
  | RequestValidationOptions

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

function getProfileOrder(profile: RequestValidationProfile): ReadonlyArray<RequestValidationSource> {
  return profile === 'laravel'
    ? ['query', 'body']
    : ['params', 'query', 'body']
}

function normalizeRequestValidationOptions(
  config?: RequestValidationConfig
): ResolvedRequestValidationOptions {
  const objectConfig =
    typeof config === 'string'
      ? { profile: config }
      : (config ?? {})

  const profile = objectConfig.profile ?? 'legacy'
  const profileOrder = getProfileOrder(profile)
  const seen = new Set<RequestValidationSource>()
  const order = (objectConfig.order ?? profileOrder).filter((source) => {
    if (seen.has(source)) return false
    seen.add(source)
    return true
  })

  return {
    order,
    onConflict: objectConfig.onConflict ?? 'last-wins',
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
    data: Record<string, unknown>
  }>,
  onConflict: RequestValidationConflict,
  component?: string
): Effect.Effect<Record<string, unknown>, ValidationError, never> {
  const merged: Record<string, unknown> = {}
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
  config?: RequestValidationConfig,
  errorComponent?: string
): Effect.Effect<Record<string, unknown>, ValidationError, RequestService> {
  return Effect.gen(function* () {
    const request = yield* RequestService
    const { order, onConflict } = normalizeRequestValidationOptions(config)

    const routeParams = order.includes('params') ? request.params() : {}
    const queryParams = order.includes('query') ? request.query() : {}

    let body: Record<string, unknown> = {}
    if (
      order.includes('body') &&
      !BODYLESS_METHODS.has(request.method.toUpperCase())
    ) {
      const contentType = request.header('Content-Type') ?? ''
      const isJson = isJsonContentType(contentType)

      body = yield* Effect.tryPromise(() =>
        isJson ? request.json<Record<string, unknown>>() : request.parseBody()
      ).pipe(
        Effect.mapError((error) =>
          createBodyParseValidationError(error, contentType)
        )
      )
    }

    const sourceData: Record<RequestValidationSource, Record<string, unknown>> = {
      params: routeParams,
      query: queryParams,
      body,
    }

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
  Record<string, unknown>,
  ValidationError,
  RequestService
> = getValidationDataWithOptions('legacy')

/**
 * Result of formatting schema errors with details.
 */
export interface FormattedSchemaErrors {
  /** Simple field -> message mapping */
  errors: Record<string, string>
  /** Detailed field errors for structured output */
  details: Record<string, FieldError>
}

/**
 * Format Effect Schema parse errors into field-level validation errors.
 * Returns both simple errors and detailed field information.
 */
export function formatSchemaErrorsWithDetails(
  error: ParseResult.ParseError,
  data: unknown,
  messages: Record<string, string> = {},
  attributes: Record<string, string> = {}
): FormattedSchemaErrors {
  const errors: Record<string, string> = {}
  const details: Record<string, FieldError> = {}
  const issues = ParseResult.ArrayFormatter.formatErrorSync(error)

  // Get the input data for extracting actual values
  const inputData = (typeof data === 'object' && data !== null) ? data as Record<string, unknown> : {}

  for (const issue of issues) {
    const field = issue.path.length > 0 ? issue.path.map(String).join('.') : 'form'

    if (errors[field]) continue // First error wins

    const attribute = attributes[field] ?? field
    const message = messages[field] ?? issue.message

    errors[field] = message.replace(/:attribute/g, attribute)

    // Extract the actual value from the input data
    let value: unknown = inputData
    for (const segment of issue.path) {
      if (typeof value === 'object' && value !== null) {
        value = (value as Record<string | number, unknown>)[segment as string | number]
      } else {
        value = undefined
        break
      }
    }

    // Create detailed field error
    details[field] = {
      value,
      expected: issue.message,
      message: errors[field],
      path: issue.path.map(String),
      schemaType: extractSchemaType(issue),
    }
  }

  return { errors, details }
}

/**
 * Extract the schema type from an issue for debugging.
 */
function extractSchemaType(issue: ParseResult.ArrayFormatterIssue): string | undefined {
  // Try to extract type information from the issue
  const message = issue.message

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
export function formatSchemaErrors(
  error: ParseResult.ParseError,
  messages: Record<string, string> = {},
  attributes: Record<string, string> = {}
): Record<string, string> {
  const errors: Record<string, string> = {}
  const issues = ParseResult.ArrayFormatter.formatErrorSync(error)

  for (const issue of issues) {
    const field = issue.path.length > 0 ? issue.path.map(String).join('.') : 'form'

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

/**
 * Mark data as validated (type-level only).
 */
export const asValidated = <A>(input: A): Validated<A> =>
  input as Validated<A>

/**
 * Nominal brand marker for trusted (server-derived) data.
 * Unique symbol prevents the brand from surviving object spreads.
 */
export const TrustedBrand = Symbol('TrustedBrand')

export type Trusted<A> = A & { readonly [TrustedBrand]: true }

/**
 * Mark data as trusted (type-level only).
 */
export const asTrusted = <A>(input: A): Trusted<A> =>
  input as Trusted<A>

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
   * Request extraction behavior for validateRequest.
   * Pass a profile string ('legacy' | 'laravel') or an object
   * with merge order and conflict policy controls.
   */
  request?: RequestValidationConfig

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
  error: unknown,
  contentType: string
): ValidationError {
  const isJson = isJsonContentType(contentType)
  const reason = error instanceof Error ? error.message : String(error)
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

function runValidation<A, I>(
  schema: S.Schema<A, I>,
  data: unknown,
  options: ValidateOptions
): Effect.Effect<Validated<A>, ValidationError, never> {
  return S.decodeUnknown(schema, options.parseOptions)(data).pipe(
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
    Effect.map(asValidated)
  )
}

/**
 * Validate data against a schema.
 * Returns validated data or fails with ValidationError.
 */
export function validate<A, I>(
  schema: S.Schema<A, I>,
  data: I,
  options: ValidateOptions = {}
): Effect.Effect<Validated<A>, ValidationError, never> {
  return runValidation(schema, data, options)
}

/**
 * Validate unknown data against a schema.
 * Use this for raw payloads (e.g. parsed request body, external JSON).
 */
export function validateUnknown<A, I>(
  schema: S.Schema<A, I>,
  data: unknown,
  options: ValidateOptions = {}
): Effect.Effect<Validated<A>, ValidationError, never> {
  return runValidation(schema, data, options)
}

/**
 * Validate request data against a schema.
 * Extracts data from request and validates in one step.
 */
export function validateRequest<A, I>(
  schema: S.Schema<A, I>,
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
