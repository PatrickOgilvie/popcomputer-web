/**
 * Effect Validation Helpers
 *
 * Utilities for validating request data using Effect Schema.
 */

import { nestFields } from './form-fields.js'
import { Effect, Predicate, Schema as S, SchemaIssue } from 'effect'
import type { ParseOptions } from 'effect/SchemaAST'
import { RequestService, type RequestContext } from './services.js'
import { ValidationError } from './errors.js'
import type { FieldError } from './error-types.js'
import { ErrorCodes, type ErrorCode } from './error-catalog.js'
import { BodyTooLarge, DEFAULT_BODY_LIMIT, formatBytes, readBody } from './body-limit.js'

const BODYLESS_METHODS = new Set(['GET', 'HEAD'])

// An absent field reads as the required-field message validators use for an
// empty one, rather than Effect's "Missing key", unless the schema sets its own.
const formatSchemaIssue = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) => {
    const message = SchemaIssue.defaultLeafHook(issue)

    return issue._tag === 'MissingKey' && message === 'Missing key' ? 'This field is required' : message
  },
})

/** Effect's message for a value matching no member of a union of strings: `Expected "a" | "b"`. */
const STRING_OPTIONS = /^Expected ("(?:[^"\\]|\\.)*"(?: \| "(?:[^"\\]|\\.)*")*)$/

/**
 * A field's message as a form shows it: a value outside a set of options
 * names the options, and one matching no kind of a union of objects says so,
 * rather than printing the schema.
 */
function readableMessage(message: string): string {
  const options = STRING_OPTIONS.exec(message)

  if (options) {
    const names = options[1].split(' | ').map((option): unknown => JSON.parse(option))

    return names.length === 1 ? `Must be ${String(names[0])}` : `Choose one of: ${names.join(', ')}`
  }

  return /^Expected \{.*\} \| /.test(message) ? 'This value is not one of the accepted kinds' : message
}

/**
 * The kinds of a tagged union a value matched none of, read from Effect's
 * message for it: `Expected { readonly "_tag": "Threshold", ... } | ...`.
 */
function unionTags(message: string): ReadonlyArray<string> | undefined {
  if (!/^Expected \{/.test(message)) return undefined

  const tags = [...message.matchAll(/"_tag": "((?:[^"\\]|\\.)*)"/g)].map((match) => match[1])

  return tags.length > 1 ? tags : undefined
}

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
  conflicts: ReadonlyArray<SourceConflict>
): ValidationError {
  const errors: Record<string, string> = {}
  const fieldDetails: Record<string, FieldError> = {}

  for (const conflict of conflicts) {
    const message = `Conflicting values for ${conflict.field} from ${conflict.existingSource} and ${conflict.incomingSource}.`
    errors[conflict.field] = message
    fieldDetails[conflict.field] = {
      expected: 'a single unambiguous value from request input',
      message,
      path: conflict.field.split('.'),
      schemaType: 'RequestInput',
    }
  }

  return new ValidationError({
    errors,
    fieldDetails,
    code: ErrorCodes.VAL_006_SOURCE_CONFLICT,
  })
}

function mergeRequestSources(
  orderedSources: ReadonlyArray<{
    source: RequestValidationSource
    data: RequestData
  }>,
  onConflict: RequestValidationConflict
): Effect.Effect<RequestData, ValidationError, never> {
  const merged: RequestData = {}
  const sourceOfKey = new Map<string, RequestValidationSource>()
  const conflicts: SourceConflict[] = []

  for (const { source, data } of orderedSources) {
    for (const [key, value] of Object.entries(data)) {
      // A JSON body's `__proto__` key would set the merged object's prototype,
      // and a field named like an inherited method, `toString`, is no conflict.
      if (key === '__proto__') continue

      if (!Object.hasOwn(merged, key)) {
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

      if (Object.is(merged[key], value)) {
        continue
      }

      conflicts.push({
        field: key,
        existingSource: sourceOfKey.get(key) ?? source,
        incomingSource: source,
      })
    }
  }

  if (conflicts.length > 0) {
    return Effect.fail(createSourceConflictValidationError(conflicts))
  }

  return Effect.succeed(merged)
}

/** A form post's media type, urlencoded or multipart. */
function isFormContentType(contentType: string): boolean {
  return /^\s*(?:application\/x-www-form-urlencoded|multipart\/form-data)\b/i.test(contentType)
}

/**
 * A body sent without a JSON or form media type, as `fetch` sends a string
 * (`text/plain`) or a client sends one with none: read as JSON, an empty body
 * as no fields. One that is not JSON fails as a body that could not be parsed.
 */
async function untypedBody(request: RequestContext, limit: number): Promise<unknown> {
  const text = new TextDecoder().decode(await readBody(request.raw(), limit, { copy: true }))

  return text.trim() === '' ? {} : JSON.parse(text)
}

/**
 * A form body's fields, nested: a field sent more than once under a `[]`
 * name is a list, and under any other name keeps the last value sent.
 */
function formFields(body: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return nestFields(Object.fromEntries(Object.entries(body).map(([key, value]) => [
    key,
    Array.isArray(value) && !key.endsWith('[]') ? value[value.length - 1] : value,
  ])))
}

/** The query string's parameters, nested, with every value of a `[]` name. */
function queryFields(request: RequestContext): Record<string, unknown> {
  const all = request.queries()

  return nestFields(Object.fromEntries(Object.entries(request.query()).map(([key, value]) => [
    key,
    key.endsWith('[]') ? all[key] ?? [value] : value,
  ])))
}

function getValidationDataWithOptions(
  config?: RequestValidationOptions,
  bodyLimit?: number
): Effect.Effect<RequestData, ValidationError, RequestService> {
  return Effect.gen(function* () {
    const request = yield* RequestService
    const { order, onConflict } = normalizeRequestValidationOptions(config)

    const routeParams = order.includes('params') ? request.params() : {}
    const queryParams = order.includes('query') ? queryFields(request) : {}

    let body: RequestData = {}

    if (
      order.includes('body') &&
      !BODYLESS_METHODS.has(request.method.toUpperCase())
    ) {
      const contentType = request.header('Content-Type') ?? ''
      const isJson = isJsonContentType(contentType)
      const limit = bodyLimit ?? request.bodyLimit ?? DEFAULT_BODY_LIMIT

      if (!(limit >= 0)) {
        return yield* Effect.die(new RangeError(`bodyLimit is a number of bytes, not ${String(limit)}.`))
      }

      const parsed = yield* Effect.tryPromise({
        try: async () => isJson
          ? request.json({ bodyLimit: limit })
          : isFormContentType(contentType) ? formFields(await request.parseBody({ bodyLimit: limit })) : untypedBody(request, limit),
        catch: (cause) => cause instanceof BodyTooLarge
          ? createBodyTooLargeValidationError(cause.limit)
          : createBodyParseValidationError(cause, contentType),
      })

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
      onConflict
    )
  })
}

/**
 * Result of formatting schema errors with details.
 */
export interface FormattedSchemaErrors {
  /** Simple field -> message mapping */
  errors: Record<string, string>
  /** Detailed field errors for structured output, without the rejected values */
  details: Record<string, FieldError>
  /** The fields sent empty: absent or null */
  missing: ReadonlySet<string>
}

/**
 * The most fields one failed validation lists. Each invalid item of a list
 * is a field of its own, so a request of thousands of invalid items would
 * otherwise be kept, observed and answered with an error for each.
 */
const MAX_REPORTED_FIELDS = 100

const TOO_MANY_FIELDS = `More than ${MAX_REPORTED_FIELDS} fields are invalid; the first ${MAX_REPORTED_FIELDS} are listed.`

function getFormattedIssuePath(
  issue: FormattedSchemaIssue
): ReadonlyArray<PropertyKey> {
  return (issue.path ?? []).map((segment) =>
    segment instanceof Object ? segment.key : segment
  )
}

/**
 * Format Effect Schema parse errors into field-level validation errors.
 * Returns both simple errors and detailed field information. The details
 * keep no submitted value: they reach the error observer, and a rejected
 * value can be a password, or a cookie or a token in a headers schema.
 */
export function formatSchemaErrorsWithDetails<Input>(
  error: S.SchemaError,
  data: Input,
  messages: Record<string, string> = {},
  attributes: Record<string, string> = {}
): FormattedSchemaErrors {
  const errors: Record<string, string> = {}
  const details: Record<string, FieldError> = {}
  const missing = new Set<string>()
  const issues = formatSchemaIssue(error.issue).issues
  let reported = 0

  for (const issue of issues) {
    // A tagged union's unknown kind belongs on its _tag, the field a form chooses it with.
    const tags = unionTags(issue.message)
    const path = tags === undefined ? getFormattedIssuePath(issue) : [...getFormattedIssuePath(issue), '_tag']
    const field = path.length > 0 ? path.map(String).join('.') : 'form'

    if (errors[field]) continue // First error wins

    if (reported === MAX_REPORTED_FIELDS) {
      if (errors.form === undefined) {
        errors.form = TOO_MANY_FIELDS
        details.form = { expected: `at most ${MAX_REPORTED_FIELDS} invalid fields`, message: TOO_MANY_FIELDS, path: [] }
      }

      break
    }

    reported += 1

    const attribute = attributes[field] ?? field
    const message = messages[field] ?? (tags === undefined ? readableMessage(issue.message) : `Choose one of: ${tags.join(', ')}`)

    errors[field] = message.replace(/:attribute/g, attribute)

    let value: unknown = data

    for (const segment of path) {
      if (!(value instanceof Object)) {
        value = undefined
        break
      }

      value = Object.getOwnPropertyDescriptor(value, segment)?.value
    }

    if (value === undefined || value === null) missing.add(field)

    details[field] = {
      expected: issue.message,
      message: errors[field],
      path: path.map(String),
      schemaType: extractSchemaType(issue.message),
    }
  }

  return { errors, details, missing }
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
   * Which request sources to read and how to treat keys that more than one
   * source provides. By default route params, query and body are merged, and
   * a key with different values in two sources fails validation.
   */
  request?: RequestValidationOptions

  /**
   * Effect Schema ParseOptions passed to the decode call. Validation reports
   * every invalid field (`errors: 'all'`) unless this says otherwise.
   * Use `{ onExcessProperty: 'error' }` to reject request payloads that
   * carry fields the schema does not declare (mass-assignment hardening).
   *
   * @example
   * validateRequest(CreateProject, { parseOptions: { onExcessProperty: 'error' } })
   */
  parseOptions?: ParseOptions

  /**
   * The most bytes the request body may have, in place of setupWeb's
   * `bodyLimit` (1 MiB unless it sets one): raise it for a form that uploads
   * files. A larger body is refused before it is parsed, with a 413 for a
   * JSON client and the form's `form` error for a page.
   *
   * @example
   * validateRequest(Receipt, { bodyLimit: 6_000_000 })
   */
  bodyLimit?: number

  /**
   * Where a form that fails validation goes back to, with its errors,
   * instead of the page it was posted from: a wizard's step, when the final
   * submit carries every step's fields.
   *
   * @example
   * validateRequest(Experience, { redirectTo: href(paths.applyStep, { job: job.slug, step: 'experience' }) })
   */
  redirectTo?: string
}

/**
 * Build a parse error with concrete guidance for malformed request bodies.
 * The parser's error is not kept: its message can quote the body.
 */
export function createBodyParseValidationError(
  _cause: unknown,
  contentType: string
): ValidationError {
  const isJson = isJsonContentType(contentType)
  const isForm = isFormContentType(contentType)
  const base = isJson ? 'Invalid JSON body' : isForm ? 'Could not parse the form body' : 'Could not read the body as JSON'

  const hint = isJson
    ? 'Ensure Content-Type is application/json and the body is valid JSON.'
    : isForm
      ? 'Ensure the body encoding matches Content-Type and can be parsed by the request parser.'
      : 'Send a JSON object, or a form with Content-Type application/x-www-form-urlencoded or multipart/form-data.'

  const message = `${base}. ${hint}`

  return new ValidationError({
    errors: { form: message },
    fieldDetails: {
      form: {
        expected: isJson ? 'valid JSON payload' : 'parsable request body',
        message,
        path: ['form'],
        schemaType: isJson ? 'JSON' : 'Body',
      },
    },
    code: ErrorCodes.VAL_003_BODY_PARSE_FAILED,
  })
}

/** A body refused for passing `limit` bytes before it was parsed. */
function createBodyTooLargeValidationError(limit: number): ValidationError {
  const message = `This request is too large: send at most ${formatBytes(limit)}.`

  return new ValidationError({
    errors: { form: message },
    fieldDetails: {
      form: { expected: `a body of at most ${limit} bytes`, message, path: ['form'], schemaType: 'Body' },
    },
    code: ErrorCodes.VAL_007_BODY_TOO_LARGE,
  })
}

function determineValidationCode(
  { details, missing }: FormattedSchemaErrors
): ErrorCode {
  // Required only when every invalid field is missing; a value of the wrong
  // kind beside a missing one is a schema mismatch.
  const isMissing = (field: string, detail: FieldError): boolean =>
    field !== 'form' && (
      missing.has(field) ||
      detail.expected.toLowerCase().includes('required') ||
      detail.message.toLowerCase().includes('required')
    )
  const entries = Object.entries(details)

  return entries.length > 0 && entries.every(([field, detail]) => isMissing(field, detail))
    ? ErrorCodes.VAL_001_FIELD_REQUIRED
    : ErrorCodes.VAL_004_SCHEMA_MISMATCH
}

function runValidation<A, I, Input>(
  schema: S.Codec<A, I>,
  data: Input,
  options: ValidateOptions
): Effect.Effect<A, ValidationError, never> {
  // Report every invalid field, so a form shows all of its errors at once.
  return S.decodeUnknownEffect(schema, { errors: 'all', ...options.parseOptions })(data).pipe(
    Effect.mapError((error) => {
      const formatted = formatSchemaErrorsWithDetails(
        error,
        data,
        options.messages,
        options.attributes
      )

      return new ValidationError({
        errors: formatted.errors,
        fieldDetails: formatted.details,
        code: determineValidationCode(formatted),
      })
    })
  )
}

/**
 * Validate unknown data against a schema.
 * Use this for raw payloads (e.g. parsed request body, external JSON).
 */
export const validateUnknown = Effect.fn('Web.validateUnknown')(function* <A, I, Input>(
  schema: S.Codec<A, I>,
  data: Input,
  options: ValidateOptions = {}
) {
  return yield* runValidation(schema, data, options)
})

/**
 * Validate request data against a schema.
 * Extracts data from request and validates in one step.
 */
export const validateRequest = Effect.fn('Web.validateRequest')(function* <A, I>(
  schema: S.Codec<A, I>,
  options: ValidateOptions = {}
) {
  const redirectTo = options.redirectTo
  const validated = Effect.flatMap(getValidationDataWithOptions(options.request, options.bodyLimit), (data) => validateUnknown(schema, data, options))

  return yield* redirectTo === undefined
    ? validated
    : Effect.mapError(validated, (error) => new ValidationError({ ...error, redirectTo }))
})
