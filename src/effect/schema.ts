/**
 * Effect Schema validators for request input
 *
 * Laravel-inspired Effect Schema helpers for common validation patterns.
 */

import {
  Effect,
  Predicate,
  Schema as S,
  SchemaIssue,
  SchemaParser,
  SchemaTransformation,
} from 'effect'
import type { ParseOptions } from 'effect/SchemaAST'

// =============================================================================
// String Types
// =============================================================================

/**
 * Trims whitespace from a string.
 */
export const trimmed = S.String.pipe(
  S.decodeTo(
    S.String,
    SchemaTransformation.transform({
      decode: (s) => s.trim(),
      encode: (s) => s,
    })
  )
)

/**
 * A nullable string that converts empty/whitespace-only strings to null.
 * Useful for optional text fields where empty input should be stored as null.
 */
export const nullableString = S.Unknown.pipe(
  S.decodeTo(
    S.NullOr(S.String),
    SchemaTransformation.transformEffect({
      decode: (value) => {
        if (value === undefined || value === null) return Effect.succeed(null)

        if (S.is(S.String)(value)) {
          const trimmed = value.trim()

          return Effect.succeed(trimmed === '' ? null : trimmed)
        }

        if (S.is(S.Union([S.Finite, S.Boolean, S.BigInt]))(value)) {
          return Effect.succeed(String(value))
        }

        return Effect.fail(new SchemaIssue.InvalidValue(
          { message: 'Expected a string or scalar value' },
          value,
        ))
      },
      encode: Effect.succeed,
    })
  )
).pipe(S.withDecodingDefaultTypeKey(Effect.succeed(null)))

/**
 * A required string that is trimmed. Empty strings fail validation.
 */
export const requiredString = S.String.pipe(
  S.decodeTo(
    S.String,
    SchemaTransformation.transform({
      decode: (s) => s.trim(),
      encode: (s) => s,
    })
  ),
  S.check(S.isMinLength(1, { message: 'This field is required' }))
)

/**
 * Create a required string with a custom message, shown when the field is
 * blank or missing, such as a radio group left unselected.
 */
export const required = (message = 'This field is required') =>
  S.String.pipe(
    S.decodeTo(
      S.String,
      SchemaTransformation.transform({
        decode: (s) => s.trim(),
        encode: (s) => s,
      })
    ),
    S.check(S.isMinLength(1, { message })),
    S.annotateKey({ messageMissingKey: message })
  )

// =============================================================================
// Numeric Types
// =============================================================================

/**
 * Coerces a value to a finite number.
 */
/** A form input left blank, which a browser sends as an empty string. */
const isBlankInput = (value: unknown): boolean => typeof value === 'string' && value.trim() === ''

/** The failure for a blank input to a required field: the message a missing field gets. */
const blankInput = (value: unknown, options: ParseOptions) =>
  Effect.fail(new SchemaIssue.InvalidValue({ message: 'This field is required' }, value, options))

export const coercedNumber = S.Unknown.pipe(
  S.decodeTo(
    S.Finite,
    SchemaTransformation.transformEffect({
      decode: (value, options) => {
        if (S.is(S.Finite)(value)) return Effect.succeed(value)
        if (isBlankInput(value)) return blankInput(value, options)

        if (S.is(S.String)(value)) {
          const parsed = parseFloat(value)

          if (Number.isFinite(parsed)) return Effect.succeed(parsed)
        }

        return Effect.fail(
          new SchemaIssue.InvalidValue({ message: 'Expected a number' }, value, options)
        )
      },
      encode: Effect.succeed,
    })
  )
)

/**
 * Coerces a value to a positive integer.
 */
export const positiveInt = coercedNumber.pipe(
  S.check(
    S.isInt({ message: 'Must be an integer' }),
    S.isGreaterThan(0, { message: 'Must be positive' })
  )
)

/**
 * Coerces a value to a non-negative integer (0 or greater).
 */
export const nonNegativeInt = coercedNumber.pipe(
  S.check(
    S.isInt({ message: 'Must be an integer' }),
    S.isGreaterThanOrEqualTo(0, { message: 'Must be non-negative' })
  )
)

/**
 * Parses a string to a positive integer, returning null on failure.
 */
export function parsePositiveInt(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = parseInt(value, 10)

  if (isNaN(parsed) || parsed <= 0) return null

  return parsed
}

// =============================================================================
// Boolean Types
// =============================================================================

/**
 * Coerces various truthy/falsy values to boolean.
 */
export const coercedBoolean = S.Unknown.pipe(
  S.decodeTo(
    S.Boolean,
    SchemaTransformation.transform({
      decode: (value) => {
        if (S.is(S.Boolean)(value)) return value

        if (S.is(S.String)(value)) {
          const lower = value.toLowerCase().trim()

          if (['true', '1', 'on', 'yes'].includes(lower)) return true

          if (['false', '0', 'off', 'no', ''].includes(lower)) return false
        }

        return Boolean(value)
      },
      encode: (b) => b,
    })
  )
)

/**
 * A checkbox value that defaults to false if not present.
 */
export const checkbox = S.Unknown.pipe(
  S.decodeTo(
    S.Boolean,
    SchemaTransformation.transform({
      decode: (value) => {
        if (value === undefined || value === null || value === '') return false

        if (S.is(S.Boolean)(value)) return value

        if (S.is(S.String)(value)) {
          const lower = value.toLowerCase().trim()

          return ['true', '1', 'on', 'yes'].includes(lower)
        }

        return Boolean(value)
      },
      encode: (b) => b,
    })
  )
).pipe(S.withDecodingDefaultTypeKey(Effect.succeed(false)))

// =============================================================================
// Date Types
// =============================================================================

/**
 * Coerces a string or number to a Date object.
 */
export const coercedDate = S.Unknown.pipe(
  S.decodeTo(
    S.Date,
    SchemaTransformation.transformEffect({
      decode: (value, options) => {
        if (S.is(S.Date)(value)) return Effect.succeed(value)
        if (isBlankInput(value)) return blankInput(value, options)

        if (S.is(S.String)(value)) {
          // oxlint-disable-next-line effecttsgo/global-date -- This codec accepts or returns native Date values; parsing this supplied value does not read the clock.
          const date = new Date(value)

          if (!isNaN(date.getTime())) return Effect.succeed(date)
        }

        if (S.is(S.Finite)(value)) {
          // oxlint-disable-next-line effecttsgo/global-date -- This codec accepts or returns native Date values; parsing this supplied value does not read the clock.
          const date = new Date(value)

          if (!isNaN(date.getTime())) return Effect.succeed(date)
        }

        return Effect.fail(
          new SchemaIssue.InvalidValue({ message: 'Expected a valid date' }, value, options)
        )
      },
      encode: Effect.succeed,
    })
  )
)

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** Whether the year, month and day name a day the calendar has: no 31 February. */
function isCalendarDay(year: number, month: number, day: number): boolean {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1]

  return days !== undefined && day >= 1 && day <= days
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

const calendarDayIn = (pattern: RegExp) => (value: string): boolean => {
  const match = pattern.exec(value)

  return match !== null && isCalendarDay(Number(match[1]), Number(match[2]), Number(match[3]))
}

const notBlank = (value: string): boolean => value.trim() !== ''

/**
 * A calendar day written `YYYY-MM-DD`, such as `2030-05-01`, kept as that
 * string: a day has no time zone, so it does not become a `Date` that would
 * fall on another day elsewhere. A day the calendar lacks, such as
 * `2030-02-31`, fails. JSON Schema describes it as `format: date`.
 */
export const isoDate = S.String.check(
  S.makeFilter(notBlank, { message: 'This field is required' }),
  S.makeFilter(calendarDayIn(ISO_DATE), {
    message: 'Enter a date as YYYY-MM-DD, such as 2030-05-01',
    toJsonSchema: () => ({ format: 'date' }),
  })
)

/**
 * A moment written in ISO 8601 with its time zone, such as
 * `2030-05-01T09:00:00Z` or `2030-05-01T10:00+01:00`, as a `Date`. A time
 * without a zone fails rather than being read in the server's zone, as does
 * a day the calendar lacks; it encodes back as an ISO string. JSON Schema
 * describes it as `format: date-time`.
 */
export const isoDateTime = S.String.check(
  S.makeFilter(notBlank, { message: 'This field is required' }),
  S.makeFilter(calendarDayIn(ISO_DATE_TIME), {
    message: 'Enter a date and time with its time zone, such as 2030-05-01T09:00:00Z',
    toJsonSchema: () => ({ format: 'date-time' }),
  })
).pipe(
  S.decodeTo(
    S.Date,
    SchemaTransformation.transform({
      // oxlint-disable-next-line effecttsgo/global-date -- This codec parses the supplied value; it does not read the clock.
      decode: (value: string) => new Date(value),
      encode: (date: Date) => date.toISOString(),
    })
  )
)

/**
 * A nullable date that accepts empty strings as null.
 */
export const nullableDate = S.Unknown.pipe(
  S.decodeTo(
    S.NullOr(S.Date),
    SchemaTransformation.transformEffect({
      decode: (value, options) => {
        if (value === undefined || value === null || value === '') return Effect.succeed(null)

        if (S.is(S.Date)(value)) return Effect.succeed(value)

        if (S.is(S.String)(value)) {
          // oxlint-disable-next-line effecttsgo/global-date -- This codec accepts or returns native Date values; parsing this supplied value does not read the clock.
          const date = new Date(value)

          if (!isNaN(date.getTime())) return Effect.succeed(date)
        }

        if (S.is(S.Finite)(value)) {
          // oxlint-disable-next-line effecttsgo/global-date -- This codec accepts or returns native Date values; parsing this supplied value does not read the clock.
          const date = new Date(value)

          if (!isNaN(date.getTime())) return Effect.succeed(date)
        }

        return Effect.fail(
          new SchemaIssue.InvalidValue({ message: 'Expected a valid date' }, value, options)
        )
      },
      encode: Effect.succeed,
    })
  )
).pipe(S.withDecodingDefaultTypeKey(Effect.succeed(null)))

// =============================================================================
// Array Types
// =============================================================================

/**
 * Ensures a value is always an array.
 */
export const ensureArray = <InputSchema extends S.Constraint>(schema: InputSchema) => {
  // Decoded as a list, so a failing item's error carries its index.
  const decodeItems = SchemaParser.decodeUnknownEffect(S.Array(schema))
  const encodeItem = SchemaParser.encodeEffect(schema)
  const isUnknownArray = S.is(S.Array(S.Unknown))

  return S.Unknown.pipe(
    S.decodeTo(
      S.Array(S.toType(schema)),
      SchemaTransformation.transformEffect<
        ReadonlyArray<InputSchema['Type']>,
        unknown,
        InputSchema['DecodingServices'],
        InputSchema['EncodingServices']
      >({
        decode: (value, options) => {
          if (value === undefined || value === null) return Effect.succeed([])

          return decodeItems(isUnknownArray(value) ? value : [value], options)
        },
        encode: (values, options) =>
          Effect.forEach(values, (value) => encodeItem(value, options)),
      })
    )
  ).pipe(S.withDecodingDefaultTypeKey(Effect.succeed([])))
}

// =============================================================================
// Common Patterns
// =============================================================================

/**
 * An email address with trimming and lowercase normalization.
 */
export const email = S.String.pipe(
  S.decodeTo(
    S.String,
    SchemaTransformation.transform({
      decode: (s) => s.trim().toLowerCase(),
      encode: (s) => s,
    })
  ),
  S.check(S.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u, { message: 'Invalid email address' }))
)

/**
 * A nullable email address.
 */
export const nullableEmail = S.Unknown.pipe(
  S.decodeTo(
    S.NullOr(S.String),
    SchemaTransformation.transformEffect({
      decode: (value, options) => {
        if (value === undefined || value === null) return Effect.succeed(null)

        if (!S.is(S.String)(value)) {
          return Effect.fail(
            new SchemaIssue.InvalidValue({ message: 'Expected a string' }, value, options)
          )
        }

        const trimmed = value.trim().toLowerCase()

        if (trimmed === '') return Effect.succeed(null)

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
          return Effect.fail(
            new SchemaIssue.InvalidValue({ message: 'Invalid email address' }, value, options)
          )
        }

        return Effect.succeed(trimmed)
      },
      encode: Effect.succeed,
    })
  )
).pipe(S.withDecodingDefaultTypeKey(Effect.succeed(null)))

// A page shows a stored link in an `href`, where any other scheme, such as
// `javascript:` or `data:`, can run script. The scheme is read the way a
// browser reads it, so case, leading control characters and tabs inside it
// make no difference.
const WEB_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:'])
const WEB_URL_MESSAGE = 'Use a link that starts with https:// or http://.'

const isWebUrl = (value: string) => {
  try {
    return WEB_PROTOCOLS.has(new URL(value).protocol)
  } catch {
    return false
  }
}

/**
 * An `http:` or `https:` URL with trimming. Every other scheme fails.
 */
export const url = S.String.pipe(
  S.decodeTo(
    S.String,
    SchemaTransformation.transform({
      decode: (s) => s.trim(),
      encode: (s) => s,
    })
  ),
  S.check(S.makeFilter(isWebUrl, { message: WEB_URL_MESSAGE }))
)

/**
 * A nullable `http:` or `https:` URL. Every other scheme fails.
 */
export const nullableUrl = S.Unknown.pipe(
  S.decodeTo(
    S.NullOr(S.String),
    SchemaTransformation.transformEffect({
      decode: (value, options) => {
        if (value === undefined || value === null) return Effect.succeed(null)

        if (!S.is(S.String)(value)) {
          return Effect.fail(
            new SchemaIssue.InvalidValue({ message: 'Expected a string' }, value, options)
          )
        }

        const trimmed = value.trim()

        if (trimmed === '') return Effect.succeed(null)

        if (!isWebUrl(trimmed)) {
          return Effect.fail(
            new SchemaIssue.InvalidValue({ message: WEB_URL_MESSAGE }, value, options)
          )
        }

        return Effect.succeed(trimmed)
      },
      encode: Effect.succeed,
    })
  )
).pipe(S.withDecodingDefaultTypeKey(Effect.succeed(null)))

// =============================================================================
// Laravel-style String Rules
// =============================================================================

/**
 * Validates that a string contains only alphabetic characters.
 */
export const alpha = S.String.pipe(
  S.decodeTo(
    S.String,
    SchemaTransformation.transform({
      decode: (s) => s.trim(),
      encode: (s) => s,
    })
  ),
  S.check(S.isPattern(/^[a-zA-Z]+$/u, { message: 'Must contain only letters' }))
)

/**
 * Validates that a string contains only alphanumeric characters, dashes, and underscores.
 */
export const alphaDash = S.String.pipe(
  S.decodeTo(
    S.String,
    SchemaTransformation.transform({
      decode: (s) => s.trim(),
      encode: (s) => s,
    })
  ),
  S.check(
    S.isPattern(/^[a-zA-Z0-9_-]+$/u, {
      message: 'Must contain only letters, numbers, dashes, and underscores',
    })
  )
)

/**
 * Validates that a string contains only alphanumeric characters.
 */
export const alphaNum = S.String.pipe(
  S.decodeTo(
    S.String,
    SchemaTransformation.transform({
      decode: (s) => s.trim(),
      encode: (s) => s,
    })
  ),
  S.check(S.isPattern(/^[a-zA-Z0-9]+$/u, { message: 'Must contain only letters and numbers' }))
)

/**
 * Validates a string starts with one of the given values.
 */
export const startsWith = (prefixes: string[], message?: string) =>
  S.String.check(
    S.makeFilter(
      (val) => prefixes.some((prefix) => val.startsWith(prefix)),
      { message: message ?? `Must start with one of: ${prefixes.join(', ')}` }
    )
  )

/**
 * Validates a string ends with one of the given values.
 */
export const endsWith = (suffixes: string[], message?: string) =>
  S.String.check(
    S.makeFilter(
      (val) => suffixes.some((suffix) => val.endsWith(suffix)),
      { message: message ?? `Must end with one of: ${suffixes.join(', ')}` }
    )
  )

/**
 * Validates that a string is all lowercase.
 */
export const lowercase = S.String.check(
  S.makeFilter(
    (val) => val === val.toLowerCase(),
    { message: 'Must be lowercase' }
  )
)

/**
 * Validates that a string is all uppercase.
 */
export const uppercase = S.String.check(
  S.makeFilter(
    (val) => val === val.toUpperCase(),
    { message: 'Must be uppercase' }
  )
)

// =============================================================================
// Laravel-style Numeric Rules
// =============================================================================

/**
 * Validates a number is between min and max (inclusive).
 */
export const between = (min: number, max: number, message?: string) =>
  coercedNumber.pipe(
    S.check(
      S.isBetween(
        { minimum: min, maximum: max },
        { message: message ?? `Must be between ${min} and ${max}` }
      )
    )
  )

/**
 * Validates that a value has exactly the specified number of digits.
 */
export const digits = (length: number, message?: string) =>
  S.String.check(
    S.isPattern(
      new RegExp(`^\\d{${length}}$`, 'u'),
      { message: message ?? `Must be exactly ${length} digits` }
    )
  )

/**
 * Validates that a value has between min and max digits.
 */
export const digitsBetween = (min: number, max: number, message?: string) =>
  S.String.check(
    S.isPattern(
      new RegExp(`^\\d{${min},${max}}$`, 'u'),
      { message: message ?? `Must be between ${min} and ${max} digits` }
    )
  )

/**
 * Validates a number is greater than the given value.
 */
export const gt = (value: number, message?: string) =>
  coercedNumber.pipe(
    S.check(S.isGreaterThan(value, { message: message ?? `Must be greater than ${value}` }))
  )

/**
 * Validates a number is greater than or equal to the given value.
 */
export const gte = (value: number, message?: string) =>
  coercedNumber.pipe(
    S.check(S.isGreaterThanOrEqualTo(value, { message: message ?? `Must be at least ${value}` }))
  )

/**
 * Validates a number is less than the given value.
 */
export const lt = (value: number, message?: string) =>
  coercedNumber.pipe(
    S.check(S.isLessThan(value, { message: message ?? `Must be less than ${value}` }))
  )

/**
 * Validates a number is less than or equal to the given value.
 */
export const lte = (value: number, message?: string) =>
  coercedNumber.pipe(
    S.check(S.isLessThanOrEqualTo(value, { message: message ?? `Must be at most ${value}` }))
  )

/**
 * Validates a number is a multiple of another number.
 */
export const multipleOf = (value: number, message?: string) =>
  coercedNumber.pipe(
    S.check(S.isMultipleOf(value, { message: message ?? `Must be a multiple of ${value}` }))
  )

// =============================================================================
// Laravel-style Enum/In Rules
// =============================================================================

/**
 * Validates that a value is one of the allowed values.
 */
export const inArray = <const T extends readonly string[]>(values: T, message?: string) => {
  const allowedValues = new Set<string>(values)
  const isAllowed = (value: string): value is T[number] => allowedValues.has(value)

  return S.String.pipe(
    S.refine(
      isAllowed,
      { message: message ?? `Must be one of: ${values.join(', ')}` }
    )
  )
}

/**
 * Validates that a value is NOT one of the disallowed values.
 */
export const notIn = <T>(values: T[], message?: string) =>
  S.Unknown.check(
    S.makeFilter(
      (value) => !values.some((disallowed) => Object.is(disallowed, value)),
      { message: message ?? `Must not be one of: ${values.join(', ')}` }
    )
  )

// =============================================================================
// Laravel-style Format Rules
// =============================================================================

/**
 * Validates a UUID.
 */
export const uuid = S.String.check(S.isUUID())

/**
 * Validates a nullable UUID.
 */
export const nullableUuid = S.Unknown.pipe(
  S.decodeTo(
    S.NullOr(uuid),
    SchemaTransformation.transformEffect({
      decode: (value, options) => {
        if (value === undefined || value === null || value === '') return Effect.succeed(null)

        if (S.is(S.String)(value)) return Effect.succeed(value)

        return Effect.fail(
          new SchemaIssue.InvalidValue({ message: 'Expected a string' }, value, options)
        )
      },
      encode: Effect.succeed,
    })
  )
).pipe(S.withDecodingDefaultTypeKey(Effect.succeed(null)))

/**
 * Validates an IPv4 address.
 */
export const ipv4 = S.String.check(
  S.isPattern(
    /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/u,
    { message: 'Must be a valid IPv4 address' }
  )
)

/**
 * Validates an IPv6 address.
 */
export const ipv6 = S.String.check(
  S.isPattern(
    /^(?:[a-fA-F0-9]{1,4}:){7}[a-fA-F0-9]{1,4}$|^::(?:[a-fA-F0-9]{1,4}:){0,5}[a-fA-F0-9]{1,4}$|^[a-fA-F0-9]{1,4}::(?:[a-fA-F0-9]{1,4}:){0,4}[a-fA-F0-9]{1,4}$|^(?:[a-fA-F0-9]{1,4}:){2}:(?:[a-fA-F0-9]{1,4}:){0,3}[a-fA-F0-9]{1,4}$|^(?:[a-fA-F0-9]{1,4}:){3}:(?:[a-fA-F0-9]{1,4}:){0,2}[a-fA-F0-9]{1,4}$|^(?:[a-fA-F0-9]{1,4}:){4}:(?:[a-fA-F0-9]{1,4}:)?[a-fA-F0-9]{1,4}$|^(?:[a-fA-F0-9]{1,4}:){5}:[a-fA-F0-9]{1,4}$|^(?:[a-fA-F0-9]{1,4}:){6}:$/u,
    { message: 'Must be a valid IPv6 address' }
  )
)

/**
 * Validates an IP address (v4 or v6).
 */
export const ip = S.String.check(
  S.makeFilter(
    (val) =>
      /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/.test(val) ||
      /^(?:[a-fA-F0-9]{1,4}:){7}[a-fA-F0-9]{1,4}$/.test(val),
    { message: 'Must be a valid IP address' }
  )
)

/**
 * Validates a MAC address.
 */
export const macAddress = S.String.check(
  S.isPattern(
    /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/u,
    { message: 'Must be a valid MAC address' }
  )
)

/**
 * Validates valid JSON string.
 */
export const jsonString = S.String.check(
  S.makeFilter(
    (val) => {
      try {
        JSON.parse(val)

        return true
      } catch {
        return false
      }
    },
    { message: 'Must be valid JSON' }
  )
)

// =============================================================================
// Laravel-style Confirmation Rules
// =============================================================================

/**
 * Helper for password confirmation validation.
 * Use with S.Struct and filter for cross-field validation.
 */
export function confirmed(
  fieldName: string,
  confirmationFieldName = `${fieldName}_confirmation`,
  message = 'Confirmation does not match'
) {
  return {
    fieldName,
    confirmationFieldName,
    refine: <T extends object>(data: T) =>
      Object.getOwnPropertyDescriptor(data, fieldName)?.value ===
      Object.getOwnPropertyDescriptor(data, confirmationFieldName)?.value,
    message,
    path: [confirmationFieldName],
  }
}

// =============================================================================
// Laravel-style Accepted Rules
// =============================================================================

/**
 * Validates that a value is "accepted" (true, "yes", "on", "1", 1).
 */
export const accepted = S.Unknown.pipe(
  S.decodeTo(
    S.Boolean,
    SchemaTransformation.transform<boolean, unknown>({
      decode: (value) => {
        if (S.is(S.Boolean)(value)) return value

        if (value === 1) return true

        if (S.is(S.String)(value)) {
          const lower = value.toLowerCase().trim()

          return ['true', '1', 'on', 'yes'].includes(lower)
        }

        return false
      },
      encode: () => true,
    })
  ),
  S.refine((value): value is true => value === true, { message: 'Must be accepted' })
)

/**
 * Validates that a value is "declined" (false, "no", "off", "0", 0).
 */
export const declined = S.Unknown.pipe(
  S.decodeTo(
    S.Boolean,
    SchemaTransformation.transform<boolean, unknown>({
      decode: (value) => {
        if (S.is(S.Boolean)(value)) return value

        if (value === 0) return false

        if (S.is(S.String)(value)) {
          const lower = value.toLowerCase().trim()

          return !['false', '0', 'off', 'no'].includes(lower)
        }

        return true
      },
      encode: () => false,
    })
  ),
  S.refine((value): value is false => value === false, { message: 'Must be declined' })
)

// =============================================================================
// Laravel-style Size Rules
// =============================================================================

/**
 * Validates exact string length.
 */
export const size = (length: number, message?: string) =>
  S.String.check(
    S.isBetweenLength(
      length,
      length,
      { message: message ?? `Must be exactly ${length} characters` }
    )
  )

/**
 * Validates minimum string length.
 */
export const min = (length: number, message?: string) =>
  S.String.check(
    S.isMinLength(
      length,
      { message: message ?? `Must be at least ${length} characters` }
    )
  )

/**
 * Validates maximum string length.
 */
export const max = (length: number, message?: string) =>
  S.String.check(
    S.isMaxLength(
      length,
      { message: message ?? `Must be at most ${length} characters` }
    )
  )

// =============================================================================
// Laravel-style Date Rules
// =============================================================================

/**
 * Validates a date is after the given date.
 */
export const after = (date: Date | string, message?: string) => {
  // oxlint-disable-next-line effecttsgo/global-date -- This codec accepts or returns native Date values; parsing this supplied value does not read the clock.
  const compareDate = S.is(S.String)(date) ? new Date(date) : date

  return coercedDate.check(S.isGreaterThanDate(
    compareDate,
    { message: message ?? `Must be after ${compareDate.toISOString()}` }
  ))
}

/**
 * Validates a date is after or equal to the given date.
 */
export const afterOrEqual = (date: Date | string, message?: string) => {
  // oxlint-disable-next-line effecttsgo/global-date -- This codec accepts or returns native Date values; parsing this supplied value does not read the clock.
  const compareDate = S.is(S.String)(date) ? new Date(date) : date

  return coercedDate.check(S.isGreaterThanOrEqualToDate(
    compareDate,
    { message: message ?? `Must be on or after ${compareDate.toISOString()}` }
  ))
}

/**
 * Validates a date is before the given date.
 */
export const before = (date: Date | string, message?: string) => {
  // oxlint-disable-next-line effecttsgo/global-date -- This codec accepts or returns native Date values; parsing this supplied value does not read the clock.
  const compareDate = S.is(S.String)(date) ? new Date(date) : date

  return coercedDate.check(S.isLessThanDate(
    compareDate,
    { message: message ?? `Must be before ${compareDate.toISOString()}` }
  ))
}

/**
 * Validates a date is before or equal to the given date.
 */
export const beforeOrEqual = (date: Date | string, message?: string) => {
  // oxlint-disable-next-line effecttsgo/global-date -- This codec accepts or returns native Date values; parsing this supplied value does not read the clock.
  const compareDate = S.is(S.String)(date) ? new Date(date) : date

  return coercedDate.check(S.isLessThanOrEqualToDate(
    compareDate,
    { message: message ?? `Must be on or before ${compareDate.toISOString()}` }
  ))
}

// =============================================================================
// Laravel-style Array Rules
// =============================================================================

/**
 * Validates array has distinct/unique values.
 */
export const distinct = <InputSchema extends S.Constraint>(schema: InputSchema, message?: string) =>
  S.Array(schema).check(
    S.makeFilter(
      (arr) => new Set(arr).size === arr.length,
      { message: message ?? 'Must contain unique values' }
    )
  )

/**
 * Validates array has minimum number of items.
 */
export const minItems = <InputSchema extends S.Constraint>(
  schema: InputSchema,
  minCount: number,
  message?: string
) => S.Array(schema).check(S.isMinLength(
  minCount,
  { message: message ?? `Must have at least ${minCount} items` }
))

/**
 * Validates array has maximum number of items.
 */
export const maxItems = <InputSchema extends S.Constraint>(
  schema: InputSchema,
  maxCount: number,
  message?: string
) => S.Array(schema).check(S.isMaxLength(
  maxCount,
  { message: message ?? `Must have at most ${maxCount} items` }
))

// =============================================================================
// Laravel-style Password Rules
// =============================================================================

/**
 * A password as the visitor typed it, to sign in with or to confirm a
 * change: required, and kept exactly as typed, spaces included, so it
 * matches the password `password(...)` accepted when it was chosen.
 * `requiredString` trims, which would refuse a password with outer spaces.
 */
export const currentPassword = S.String.check(
  S.makeFilter((value: string) => value !== '', { message: 'This field is required' })
)

/**
 * A password a visitor chooses, as signing up or changing it asks for one:
 * at least `min` characters (8 unless given), and the other rules given.
 * It is kept exactly as typed. Sign a visitor in with `currentPassword`,
 * which checks no rules: the password's strength was checked when it was
 * chosen.
 */
export function password(options: {
  min?: number
  max?: number
  letters?: boolean
  mixedCase?: boolean
  numbers?: boolean
  symbols?: boolean
} = {}) {
  const {
    min: minLength = 8,
    max: maxLength,
    letters = false,
    mixedCase = false,
    numbers = false,
    symbols = false,
  } = options

  let schema = S.String.check(S.isMinLength(
    minLength,
    { message: `Password must be at least ${minLength} ${minLength === 1 ? 'character' : 'characters'}` }
  ))

  if (maxLength) {
    schema = schema.check(S.isMaxLength(
      maxLength,
      { message: `Password must be at most ${maxLength} characters` }
    ))
  }

  if (letters) {
    schema = schema.check(S.makeFilter(
      (val) => /[a-zA-Z]/.test(val),
      { message: 'Password must contain at least one letter' }
    ))
  }

  if (mixedCase) {
    schema = schema.check(S.makeFilter(
      (val) => /[a-z]/.test(val) && /[A-Z]/.test(val),
      { message: 'Password must contain both uppercase and lowercase letters' }
    ))
  }

  if (numbers) {
    schema = schema.check(S.makeFilter(
      (val) => /\d/.test(val),
      { message: 'Password must contain at least one number' }
    ))
  }

  if (symbols) {
    schema = schema.pipe(
      S.check(S.makeFilter(
        (val) => /[!@#$%^&*(),.?":{}|<>]/.test(val),
        { message: 'Password must contain at least one special character' }
      ))
    )
  }

  return schema
}

// =============================================================================
// Laravel-style Conditional Rules
// =============================================================================

/**
 * Excludes a field (sets to undefined) when a condition is met.
 */
export const excludeIf = <InputSchema extends S.Constraint>(
  schema: InputSchema,
  condition: (value: S.Schema.Type<typeof S.Unknown>) => boolean
) => {
  const decodeValue = SchemaParser.decodeUnknownEffect(schema)
  const encodeValue = SchemaParser.encodeEffect(schema)

  return S.Unknown.pipe(
    S.decodeTo(
      S.Union([S.toType(schema), S.Undefined]),
      SchemaTransformation.transformEffect({
        decode: (value, options) =>
          condition(value)
            // oxlint-disable-next-line effecttsgo/effect-succeed-with-void -- Schema transformations distinguish the undefined value from the wider void type.
            ? Effect.succeed(undefined)
            : decodeValue(value, options),
        encode: (value, options) =>
          value === undefined
            // oxlint-disable-next-line effecttsgo/effect-succeed-with-void -- Preserve the optional field's exact undefined type for the encoder.
            ? Effect.succeed(undefined)
            : encodeValue(value, options),
      })
    )
  )
}

// =============================================================================
// Utility Functions
// =============================================================================

/** A form group, such as `condition[questionId]` and `condition[equals]`, whose every field is blank. */
const isBlankGroup = (value: unknown): boolean =>
  Predicate.isObject(value) && !Array.isArray(value) && !(value instanceof File) &&
  Object.keys(value).length > 0 &&
  Object.values(value).every((field) =>
    field === undefined || field === null || (typeof field === 'string' && field.trim() === '') || isBlankGroup(field)
  )

/**
 * Creates a nullable version of any schema. An empty string, and a form group
 * whose every field is blank, are null.
 */
export const nullable = <InputSchema extends S.Constraint>(schema: InputSchema) => {
  const decodeValue = SchemaParser.decodeUnknownEffect(schema)
  const encodeValue = SchemaParser.encodeEffect(schema)

  return S.Unknown.pipe(
    S.decodeTo(
      S.NullOr(S.toType(schema)),
      SchemaTransformation.transformEffect({
        decode: (value, options) => {
          if (value === undefined || value === null) return Effect.succeed(null)

          if (S.is(S.String)(value) && value.trim() === '') return Effect.succeed(null)

          // A form sends a group's fields even when every one is blank.
          if (isBlankGroup(value)) return Effect.succeed(null)

          return decodeValue(value, options)
        },
        encode: (value, options) =>
          value === null
            ? Effect.succeed(null)
            : encodeValue(value, options),
      })
    )
  ).pipe(S.withDecodingDefaultTypeKey(Effect.succeed(null)))
}

/** What an uploaded file may be. */
export interface UploadOptions {
  /**
   * Accepted media types, such as `'image/png'`, or a family such as
   * `'image/*'`. A family leaves out types a browser runs script in, such as
   * `image/svg+xml`, which are accepted only when named. The type is the one
   * the browser declares for the file.
   */
  readonly types?: ReadonlyArray<string>
  /** The largest accepted size, in bytes. */
  readonly maxBytes?: number
}

/** A file input left empty, which browsers send as a nameless empty file. */
const isEmptyFileInput = (value: unknown): boolean =>
  value instanceof File && value.size === 0 && !value.name

/** A media type without its parameters, lowercased: `text/plain;charset=utf-8` is `text/plain`. */
const essence = (type: string): string => type.split(';', 1)[0].trim().toLowerCase()

/**
 * Media types a browser runs script in when it opens them, such as an SVG
 * image. A family such as `image/*` accepts them only when they are named,
 * since an uploaded file served back as one runs on the application's origin.
 */
export const ACTIVE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
  'text/xsl',
])

/**
 * One media type, `type/subtype` and its parameters. A browser reads a
 * `Content-Type` holding a comma-separated list by its last type, so
 * `image/png;x=,text/html` is a page to it, however its first type reads.
 */
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*[a-z0-9!#$&^_.+-]+=(?:[a-z0-9!#$&^_.+-]+|"[^"\\,]*"))*\s*$/i

/** The media type a header or an upload declares, when it declares exactly one. */
export const singleMediaType = (type: string): string | undefined => (MEDIA_TYPE.test(type) ? type.trim() : undefined)

/** Whether a browser runs script in a body of this type: the active types, and any XML, which may embed XHTML. */
export const isActiveContentType = (type: string): boolean => {
  const named = essence(type)

  return ACTIVE_CONTENT_TYPES.has(named) || named.endsWith('+xml')
}

const acceptsType = (types: ReadonlyArray<string>, type: string): boolean => {
  const sent = essence(type)

  return types.some((accepted) => {
    const expected = essence(accepted)

    return expected.endsWith('/*')
      ? sent.startsWith(expected.slice(0, -1)) && !isActiveContentType(sent)
      : sent === expected
  })
}

/** A size as people read it: decimal units, so `maxBytes: 10_000_000` reads `10 MB`. */
const formatBytes = (bytes: number): string =>
  bytes >= 1_000_000 ? `${Math.round(bytes / 100_000) / 10} MB`
  : bytes >= 1000 ? `${Math.round(bytes / 100) / 10} KB`
  : `${bytes} bytes`

/** The bytes a file of a type starts with, at an offset, as `[offset, bytes]` pairs any of which may match. */
const SIGNATURES: Readonly<Record<string, { readonly label: string; readonly starts: ReadonlyArray<readonly [number, string]> }>> = {
  'image/png': { label: 'PNG image', starts: [[0, '\x89PNG\r\n\x1a\n']] },
  'image/jpeg': { label: 'JPEG image', starts: [[0, '\xff\xd8\xff']] },
  'image/gif': { label: 'GIF image', starts: [[0, 'GIF87a'], [0, 'GIF89a']] },
  'image/webp': { label: 'WebP image', starts: [[8, 'WEBP']] },
  'image/avif': { label: 'AVIF image', starts: [[4, 'ftypavif'], [4, 'ftypavis']] },
  'image/heic': { label: 'HEIC image', starts: [[4, 'ftypheic'], [4, 'ftypheix'], [4, 'ftypmif1']] },
  'image/bmp': { label: 'BMP image', starts: [[0, 'BM']] },
  'application/pdf': { label: 'PDF', starts: [[0, '%PDF-']] },
  'application/zip': { label: 'ZIP archive', starts: [[0, 'PK\x03\x04']] },
}

/** Whether bytes begin as markup a browser could run: `<html`, `<svg`, `<?xml`, `<!DOCTYPE`. */
const looksLikeMarkup = (head: string): boolean => /^(?:\xef\xbb\xbf)?\s*<(?:[!?a-z])/i.test(head)

/**
 * Whether a file's first bytes are what its declared type says: a type with
 * a known signature must start with it, and any other image must not be
 * markup. A file whose declared type is neither passes.
 */
const contentMatches = (type: string, head: string): boolean => {
  const signature = SIGNATURES[essence(type)]

  // An active type, such as an SVG, is markup by nature: it is accepted only when named.
  if (isActiveContentType(type)) return true

  if (signature !== undefined) return signature.starts.some(([offset, bytes]) => head.startsWith(bytes, offset))

  return !(essence(type).startsWith('image/') && looksLikeMarkup(head))
}

const labelOf = (type: string): string => SIGNATURES[essence(type)]?.label ?? essence(type)

/** A file whose contents are what its declared type says, as `contentMatches` checks them. */
const fileOfItsType = S.File.pipe(
  S.decodeTo(
    S.File,
    SchemaTransformation.transformEffect({
      decode: (file: File, options) =>
        Effect.promise(() => file.slice(0, 32).arrayBuffer()).pipe(
          Effect.flatMap((buffer) => {
            const head = String.fromCharCode(...new Uint8Array(buffer))

            // The file keeps only its type's essence, as `image/png`, so what
            // is stored and later served is one media type.
            return contentMatches(file.type, head)
              ? Effect.succeed(new File([file], file.name, { type: essence(file.type) || 'application/octet-stream', lastModified: file.lastModified }))
              : Effect.fail(new SchemaIssue.InvalidValue({ message: `The file is not a ${labelOf(file.type)}` }, file, options))
          })
        ),
      encode: (file: File) => Effect.succeed(file),
    })
  )
)

/**
 * A file uploaded through a multipart form, checked for type and size, and
 * for contents that match its type: a PNG must start as a PNG does, so an
 * HTML page sent as `image/png` is refused, and no image may be markup a
 * browser would run. `validateRequest` reads multipart bodies; a file input
 * left empty is no file.
 *
 * @example
 * const PostForm = S.Struct({ title: requiredString, cover: upload({ types: ['image/*'], maxBytes: 5_000_000 }) })
 */
export const upload = (options: UploadOptions = {}) =>
  S.File.check(
    S.makeFilter((file: File) => !isEmptyFileInput(file), { message: 'Choose a file' }),
    S.makeFilter((file: File) => file.type === '' || singleMediaType(file.type) !== undefined, { message: 'The file must have one media type' }),
    S.makeFilter(
      (file: File) => options.types === undefined || acceptsType(options.types, file.type),
      { message: `The file must be ${(options.types ?? []).join(', ')}` }
    ),
    S.makeFilter(
      (file: File) => options.maxBytes === undefined || file.size <= options.maxBytes,
      { message: `The file must be at most ${formatBytes(options.maxBytes ?? 0)}` }
    )
  ).pipe(S.decodeTo(fileOfItsType))

/** An optional upload: an absent field or a file input left empty decodes to `null`. */
export const nullableUpload = (options: UploadOptions = {}) => {
  const file = upload(options)
  const decodeFile = SchemaParser.decodeUnknownEffect(file)

  return S.Unknown.pipe(
    S.decodeTo(
      S.NullOr(S.File),
      SchemaTransformation.transformEffect({
        decode: (value, parseOptions) =>
          value === undefined || value === null || value === '' || isEmptyFileInput(value)
            ? Effect.succeed(null)
            : decodeFile(value, parseOptions),
        encode: (value) => Effect.succeed(value),
      })
    )
  ).pipe(S.withDecodingDefaultTypeKey(Effect.succeed(null)))
}

/**
 * Creates a schema that fills in a default value when empty/null/undefined.
 */
export const filled = <InputSchema extends S.Constraint>(
  schema: InputSchema,
  defaultValue: InputSchema['Type']
) => {
  const decodeValue = SchemaParser.decodeUnknownEffect(schema)
  const encodeValue = SchemaParser.encodeEffect(schema)

  const field = S.Unknown.pipe(
    S.decodeTo(
      S.toType(schema),
      SchemaTransformation.transformEffect({
        decode: (value, options) =>
          value === undefined || value === null || value === ''
            ? Effect.succeed(defaultValue)
            : decodeValue(value, options),
        encode: (value, options) => encodeValue(value, options),
      })
    )
  )

  return field.pipe(S.withDecodingDefaultTypeKey<typeof field>(Effect.succeed(defaultValue)))
}
