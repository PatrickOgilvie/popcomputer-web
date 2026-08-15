/**
 * Honertia Effect Schema Validators
 *
 * Laravel-inspired Effect Schema helpers for common validation patterns.
 */

import {
  Effect,
  Schema as S,
  SchemaIssue,
  SchemaParser,
  SchemaTransformation,
} from 'effect'

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
    SchemaTransformation.transform({
      decode: (value) => {
        if (value === undefined || value === null) return null
        if (S.is(S.String)(value)) {
          const trimmed = value.trim()
          return trimmed === '' ? null : trimmed
        }
        return String(value)
      },
      encode: (s) => s,
    })
  )
)

/**
 * Alias for nullableString.
 */
export const optionalString = nullableString

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
 * Create a required string with a custom message.
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
    S.check(S.isMinLength(1, { message }))
  )

// =============================================================================
// Numeric Types
// =============================================================================

/**
 * Coerces a value to a number.
 */
export const coercedNumber = S.Unknown.pipe(
  S.decodeTo(
    S.Number,
    SchemaTransformation.transformOrFail({
      decode: (value, options) => {
        if (S.is(S.Number)(value)) return Effect.succeed(value)
        if (S.is(S.String)(value)) {
          const parsed = parseFloat(value)
          if (!isNaN(parsed)) return Effect.succeed(parsed)
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
        if (S.is(S.Number)(value)) return value !== 0
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
)

// =============================================================================
// Date Types
// =============================================================================

/**
 * Coerces a string or number to a Date object.
 */
export const coercedDate = S.Unknown.pipe(
  S.decodeTo(
    S.Date,
    SchemaTransformation.transformOrFail({
      decode: (value, options) => {
        if (S.is(S.Date)(value)) return Effect.succeed(value)
        if (S.is(S.String)(value)) {
          const date = new Date(value)
          if (!isNaN(date.getTime())) return Effect.succeed(date)
        }
        if (S.is(S.Number)(value)) {
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

/**
 * A nullable date that accepts empty strings as null.
 */
export const nullableDate = S.Unknown.pipe(
  S.decodeTo(
    S.NullOr(S.Date),
    SchemaTransformation.transformOrFail({
      decode: (value, options) => {
        if (value === undefined || value === null || value === '') return Effect.succeed(null)
        if (S.is(S.Date)(value)) return Effect.succeed(value)
        if (S.is(S.String)(value)) {
          const date = new Date(value)
          if (!isNaN(date.getTime())) return Effect.succeed(date)
        }
        if (S.is(S.Number)(value)) {
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

// =============================================================================
// Array Types
// =============================================================================

/**
 * Ensures a value is always an array.
 */
export const ensureArray = <InputSchema extends S.Constraint>(schema: InputSchema) => {
  const decodeItem = SchemaParser.decodeUnknownEffect(schema)
  const encodeItem = SchemaParser.encodeEffect(schema)
  const isUnknownArray = S.is(S.Array(S.Unknown))

  return S.Unknown.pipe(
    S.decodeTo(
      S.Array(S.toType(schema)),
      SchemaTransformation.transformOrFail<
        ReadonlyArray<InputSchema['Type']>,
        unknown,
        InputSchema['DecodingServices'],
        InputSchema['EncodingServices']
      >({
        decode: (value, options) => {
          if (value === undefined || value === null) return Effect.succeed([])
          if (isUnknownArray(value)) {
            return Effect.forEach(value, (item) => decodeItem(item, options))
          }
          return Effect.map(decodeItem(value, options), (item) => [item])
        },
        encode: (values, options) =>
          Effect.forEach(values, (value) => encodeItem(value, options)),
      })
    )
  )
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
  S.check(S.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { message: 'Invalid email address' }))
)

/**
 * A nullable email address.
 */
export const nullableEmail = S.Unknown.pipe(
  S.decodeTo(
    S.NullOr(S.String),
    SchemaTransformation.transformOrFail({
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
)

/**
 * A URL with trimming.
 */
export const url = S.String.pipe(
  S.decodeTo(
    S.String,
    SchemaTransformation.transform({
      decode: (s) => s.trim(),
      encode: (s) => s,
    })
  ),
  S.check(
    S.makeFilter((s) => {
      try {
        new URL(s)
        return true
      } catch {
        return false
      }
    }, { message: 'Invalid URL' })
  )
)

/**
 * A nullable URL.
 */
export const nullableUrl = S.Unknown.pipe(
  S.decodeTo(
    S.NullOr(S.String),
    SchemaTransformation.transformOrFail({
      decode: (value, options) => {
        if (value === undefined || value === null) return Effect.succeed(null)
        if (!S.is(S.String)(value)) {
          return Effect.fail(
            new SchemaIssue.InvalidValue({ message: 'Expected a string' }, value, options)
          )
        }
        const trimmed = value.trim()
        if (trimmed === '') return Effect.succeed(null)
        try {
          new URL(trimmed)
          return Effect.succeed(trimmed)
        } catch {
          return Effect.fail(
            new SchemaIssue.InvalidValue({ message: 'Invalid URL' }, value, options)
          )
        }
      },
      encode: Effect.succeed,
    })
  )
)

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
  S.check(S.isPattern(/^[a-zA-Z]+$/, { message: 'Must contain only letters' }))
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
    S.isPattern(/^[a-zA-Z0-9_-]+$/, {
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
  S.check(S.isPattern(/^[a-zA-Z0-9]+$/, { message: 'Must contain only letters and numbers' }))
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
      new RegExp(`^\\d{${length}}$`),
      { message: message ?? `Must be exactly ${length} digits` }
    )
  )

/**
 * Validates that a value has between min and max digits.
 */
export const digitsBetween = (min: number, max: number, message?: string) =>
  S.String.check(
    S.isPattern(
      new RegExp(`^\\d{${min},${max}}$`),
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
export const inArray = <T extends readonly string[]>(values: T, message?: string) => {
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
    SchemaTransformation.transformOrFail({
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
)

/**
 * Validates an IPv4 address.
 */
export const ipv4 = S.String.check(
  S.isPattern(
    /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/,
    { message: 'Must be a valid IPv4 address' }
  )
)

/**
 * Validates an IPv6 address.
 */
export const ipv6 = S.String.check(
  S.isPattern(
    /^(?:[a-fA-F0-9]{1,4}:){7}[a-fA-F0-9]{1,4}$|^::(?:[a-fA-F0-9]{1,4}:){0,5}[a-fA-F0-9]{1,4}$|^[a-fA-F0-9]{1,4}::(?:[a-fA-F0-9]{1,4}:){0,4}[a-fA-F0-9]{1,4}$|^(?:[a-fA-F0-9]{1,4}:){2}:(?:[a-fA-F0-9]{1,4}:){0,3}[a-fA-F0-9]{1,4}$|^(?:[a-fA-F0-9]{1,4}:){3}:(?:[a-fA-F0-9]{1,4}:){0,2}[a-fA-F0-9]{1,4}$|^(?:[a-fA-F0-9]{1,4}:){4}:(?:[a-fA-F0-9]{1,4}:)?[a-fA-F0-9]{1,4}$|^(?:[a-fA-F0-9]{1,4}:){5}:[a-fA-F0-9]{1,4}$|^(?:[a-fA-F0-9]{1,4}:){6}:$/,
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
    /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/,
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
        if (S.is(S.Number)(value)) return value === 1
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
        if (S.is(S.Number)(value)) return value === 0
        if (S.is(S.String)(value)) {
          const lower = value.toLowerCase().trim()
          return ['false', '0', 'off', 'no'].includes(lower)
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
    S.isLengthBetween(
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
 * Creates a password schema with configurable rules.
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
    { message: `Password must be at least ${minLength} characters` }
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
      SchemaTransformation.transformOrFail({
        decode: (value, options) =>
          condition(value)
            ? Effect.succeed(undefined)
            : decodeValue(value, options),
        encode: (value, options) =>
          value === undefined
            ? Effect.succeed(undefined)
            : encodeValue(value, options),
      })
    )
  )
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Creates a nullable version of any schema.
 * Converts empty strings to null.
 */
export const nullable = <InputSchema extends S.Constraint>(schema: InputSchema) => {
  const decodeValue = SchemaParser.decodeUnknownEffect(schema)
  const encodeValue = SchemaParser.encodeEffect(schema)

  return S.Unknown.pipe(
    S.decodeTo(
      S.NullOr(S.toType(schema)),
      SchemaTransformation.transformOrFail({
        decode: (value, options) => {
          if (value === undefined || value === null) return Effect.succeed(null)
          if (S.is(S.String)(value) && value.trim() === '') return Effect.succeed(null)
          return decodeValue(value, options)
        },
        encode: (value, options) =>
          value === null
            ? Effect.succeed(null)
            : encodeValue(value, options),
      })
    )
  )
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

  return S.Unknown.pipe(
    S.decodeTo(
      S.toType(schema),
      SchemaTransformation.transformOrFail({
        decode: (value, options) =>
          value === undefined || value === null || value === ''
            ? Effect.succeed(defaultValue)
            : decodeValue(value, options),
        encode: (value, options) => encodeValue(value, options),
      })
    )
  )
}

// =============================================================================
// Schema Helpers
// =============================================================================

/**
 * Re-export Schema namespace for convenience.
 */
export { Schema as S } from 'effect'
