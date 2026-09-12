/**
 * Schema Validators Tests
 */

import { describe, test, expect } from 'bun:test'
import { Effect, Schema as S } from 'effect'
import {
  // String types
  trimmed,
  nullableString,
  optionalString,
  requiredString,
  required,
  alpha,
  alphaDash,
  alphaNum,
  startsWith,
  endsWith,
  lowercase,
  uppercase,
  // Numeric types
  coercedNumber,
  positiveInt,
  nonNegativeInt,
  between,
  digits,
  digitsBetween,
  gt,
  gte,
  lt,
  lte,
  multipleOf,
  // Boolean types
  coercedBoolean,
  checkbox,
  accepted,
  declined,
  // Date types
  coercedDate,
  nullableDate,
  after,
  afterOrEqual,
  before,
  beforeOrEqual,
  // Array types
  ensureArray,
  distinct,
  minItems,
  maxItems,
  // Enum/In rules
  inArray,
  notIn,
  // Format types
  email,
  nullableEmail,
  url,
  nullableUrl,
  uuid,
  nullableUuid,
  ipv4,
  macAddress,
  jsonString,
  // Confirmation
  confirmed,
  // Size rules
  size,
  min,
  max,
  // Password
  password,
  // Utility
  nullable,
  filled,
  excludeIf,
} from '../../src/effect/schema.js'

const decode = <A, I, Input>(schema: S.Codec<A, I>, value: Input) =>
  Effect.runSync(S.decodeUnknownEffect(schema)(value))

const decodeEither = <A, I, Input>(schema: S.Codec<A, I>, value: Input) =>
  Effect.runSyncExit(S.decodeUnknownEffect(schema)(value))

// =============================================================================
// String Types
// =============================================================================

describe('String Types', () => {
  describe('trimmed', () => {
    test('trims whitespace from strings', () => {
      expect(decode(trimmed, '  hello  ')).toBe('hello')
      expect(decode(trimmed, '\t\ntest\n\t')).toBe('test')
    })

    test('handles already trimmed strings', () => {
      expect(decode(trimmed, 'hello')).toBe('hello')
    })
  })

  describe('nullableString', () => {
    test('coerces scalar values and rejects objects', () => {
      expect(decode(nullableString, 42)).toBe('42')
      expect(decode(nullableString, false)).toBe('false')
      expect(decode(nullableString, 42n)).toBe('42')
      expect(decodeEither(nullableString, { value: 'secret' })._tag).toBe('Failure')
      expect(decodeEither(nullableString, ['a', 'b'])._tag).toBe('Failure')
    })

    test('converts empty strings to null', () => {
      expect(decode(nullableString, '')).toBeNull()
      expect(decode(nullableString, '   ')).toBeNull()
    })

    test('preserves non-empty strings', () => {
      expect(decode(nullableString, 'hello')).toBe('hello')
      expect(decode(nullableString, '  hello  ')).toBe('hello')
    })

    test('converts undefined/null to null', () => {
      expect(decode(nullableString, undefined)).toBeNull()
      expect(decode(nullableString, null)).toBeNull()
    })
  })

  describe('optionalString', () => {
    test('is an alias for nullableString', () => {
      expect(decode(optionalString, '')).toBeNull()
      expect(decode(optionalString, 'test')).toBe('test')
    })
  })

  describe('requiredString', () => {
    test('trims and validates non-empty', () => {
      expect(decode(requiredString, '  hello  ')).toBe('hello')
    })

    test('fails on empty strings', () => {
      const exit = decodeEither(requiredString, '')
      expect(exit._tag).toBe('Failure')
    })

    test('fails on whitespace-only strings', () => {
      const exit = decodeEither(requiredString, '   ')
      expect(exit._tag).toBe('Failure')
    })
  })

  describe('required', () => {
    test('creates required string with custom message', () => {
      const schema = required('Name is required')
      expect(decode(schema, 'John')).toBe('John')

      const exit = decodeEither(schema, '')
      expect(exit._tag).toBe('Failure')
    })
  })

  describe('alpha', () => {
    test('accepts letters only', () => {
      expect(decode(alpha, 'Hello')).toBe('Hello')
      expect(decode(alpha, 'ABC')).toBe('ABC')
    })

    test('rejects non-alpha characters', () => {
      expect(decodeEither(alpha, 'Hello123')._tag).toBe('Failure')
      expect(decodeEither(alpha, 'Hello World')._tag).toBe('Failure')
    })
  })

  describe('alphaDash', () => {
    test('accepts letters, numbers, dashes, underscores', () => {
      expect(decode(alphaDash, 'hello-world_123')).toBe('hello-world_123')
    })

    test('rejects other characters', () => {
      expect(decodeEither(alphaDash, 'hello world')._tag).toBe('Failure')
      expect(decodeEither(alphaDash, 'hello@world')._tag).toBe('Failure')
    })
  })

  describe('alphaNum', () => {
    test('accepts letters and numbers', () => {
      expect(decode(alphaNum, 'Hello123')).toBe('Hello123')
    })

    test('rejects special characters', () => {
      expect(decodeEither(alphaNum, 'Hello-123')._tag).toBe('Failure')
    })
  })

  describe('startsWith', () => {
    test('validates string starts with prefix', () => {
      const schema = startsWith(['http://', 'https://'])
      expect(decode(schema, 'https://example.com')).toBe('https://example.com')
      expect(decode(schema, 'http://example.com')).toBe('http://example.com')
    })

    test('fails if no prefix matches', () => {
      const schema = startsWith(['http://', 'https://'])
      expect(decodeEither(schema, 'ftp://example.com')._tag).toBe('Failure')
    })
  })

  describe('endsWith', () => {
    test('validates string ends with suffix', () => {
      const schema = endsWith(['.js', '.ts'])
      expect(decode(schema, 'file.ts')).toBe('file.ts')
    })

    test('fails if no suffix matches', () => {
      const schema = endsWith(['.js', '.ts'])
      expect(decodeEither(schema, 'file.py')._tag).toBe('Failure')
    })
  })

  describe('lowercase', () => {
    test('validates lowercase strings', () => {
      expect(decode(lowercase, 'hello')).toBe('hello')
    })

    test('fails on uppercase', () => {
      expect(decodeEither(lowercase, 'Hello')._tag).toBe('Failure')
    })
  })

  describe('uppercase', () => {
    test('validates uppercase strings', () => {
      expect(decode(uppercase, 'HELLO')).toBe('HELLO')
    })

    test('fails on lowercase', () => {
      expect(decodeEither(uppercase, 'Hello')._tag).toBe('Failure')
    })
  })
})

// =============================================================================
// Numeric Types
// =============================================================================

describe('Numeric Types', () => {
  describe('coercedNumber', () => {
    test('coerces strings to numbers', () => {
      expect(decode(coercedNumber, '42')).toBe(42)
      expect(decode(coercedNumber, '3.14')).toBe(3.14)
    })

    test('passes through numbers', () => {
      expect(decode(coercedNumber, 42)).toBe(42)
    })

    test('throws on non-numeric strings', () => {
      expect(() => decode(coercedNumber, 'abc')).toThrow()
    })

    test('rejects non-finite values and overflowing numeric strings', () => {
      for (const value of [NaN, Infinity, -Infinity, 'NaN', 'Infinity', '-Infinity', '1e999']) {
        expect(decodeEither(coercedNumber, value)._tag).toBe('Failure')
      }
    })
  })

  describe('positiveInt', () => {
    test('accepts positive integers', () => {
      expect(decode(positiveInt, '5')).toBe(5)
      expect(decode(positiveInt, 100)).toBe(100)
    })

    test('rejects zero', () => {
      expect(decodeEither(positiveInt, 0)._tag).toBe('Failure')
    })

    test('rejects negative numbers', () => {
      expect(decodeEither(positiveInt, -5)._tag).toBe('Failure')
    })

    test('rejects non-integers', () => {
      expect(decodeEither(positiveInt, 3.14)._tag).toBe('Failure')
    })
  })

  describe('nonNegativeInt', () => {
    test('accepts zero and positive integers', () => {
      expect(decode(nonNegativeInt, 0)).toBe(0)
      expect(decode(nonNegativeInt, 5)).toBe(5)
    })

    test('rejects negative numbers', () => {
      expect(decodeEither(nonNegativeInt, -1)._tag).toBe('Failure')
    })
  })

  describe('between', () => {
    test('accepts values in range', () => {
      const schema = between(1, 10)
      expect(decode(schema, 5)).toBe(5)
      expect(decode(schema, 1)).toBe(1)
      expect(decode(schema, 10)).toBe(10)
    })

    test('rejects values outside range', () => {
      const schema = between(1, 10)
      expect(decodeEither(schema, 0)._tag).toBe('Failure')
      expect(decodeEither(schema, 11)._tag).toBe('Failure')
    })
  })

  describe('digits', () => {
    test('validates exact digit count', () => {
      const schema = digits(4)
      expect(decode(schema, '1234')).toBe('1234')
    })

    test('rejects wrong digit count', () => {
      const schema = digits(4)
      expect(decodeEither(schema, '123')._tag).toBe('Failure')
      expect(decodeEither(schema, '12345')._tag).toBe('Failure')
    })
  })

  describe('digitsBetween', () => {
    test('validates digit count in range', () => {
      const schema = digitsBetween(3, 5)
      expect(decode(schema, '123')).toBe('123')
      expect(decode(schema, '12345')).toBe('12345')
    })
  })

  describe('gt', () => {
    test('validates greater than', () => {
      const schema = gt(5)
      expect(decode(schema, 6)).toBe(6)
      expect(decodeEither(schema, 5)._tag).toBe('Failure')
    })
  })

  describe('gte', () => {
    test('validates greater than or equal', () => {
      const schema = gte(5)
      expect(decode(schema, 5)).toBe(5)
      expect(decode(schema, 6)).toBe(6)
      expect(decodeEither(schema, 4)._tag).toBe('Failure')
    })
  })

  describe('lt', () => {
    test('validates less than', () => {
      const schema = lt(5)
      expect(decode(schema, 4)).toBe(4)
      expect(decodeEither(schema, 5)._tag).toBe('Failure')
    })
  })

  describe('lte', () => {
    test('validates less than or equal', () => {
      const schema = lte(5)
      expect(decode(schema, 5)).toBe(5)
      expect(decode(schema, 4)).toBe(4)
      expect(decodeEither(schema, 6)._tag).toBe('Failure')
    })
  })

  describe('multipleOf', () => {
    test('validates multiples', () => {
      const schema = multipleOf(5)
      expect(decode(schema, 10)).toBe(10)
      expect(decode(schema, 15)).toBe(15)
      expect(decodeEither(schema, 7)._tag).toBe('Failure')
    })
  })
})

// =============================================================================
// Boolean Types
// =============================================================================

describe('Boolean Types', () => {
  describe('coercedBoolean', () => {
    test('coerces truthy strings', () => {
      expect(decode(coercedBoolean, 'true')).toBe(true)
      expect(decode(coercedBoolean, '1')).toBe(true)
      expect(decode(coercedBoolean, 'on')).toBe(true)
      expect(decode(coercedBoolean, 'yes')).toBe(true)
    })

    test('coerces falsy strings', () => {
      expect(decode(coercedBoolean, 'false')).toBe(false)
      expect(decode(coercedBoolean, '0')).toBe(false)
      expect(decode(coercedBoolean, 'off')).toBe(false)
      expect(decode(coercedBoolean, 'no')).toBe(false)
    })

    test('passes through booleans', () => {
      expect(decode(coercedBoolean, true)).toBe(true)
      expect(decode(coercedBoolean, false)).toBe(false)
    })
  })

  describe('checkbox', () => {
    test('defaults to false for missing values', () => {
      expect(decode(checkbox, undefined)).toBe(false)
      expect(decode(checkbox, null)).toBe(false)
      expect(decode(checkbox, '')).toBe(false)
    })

    test('returns true for checked values', () => {
      expect(decode(checkbox, 'on')).toBe(true)
      expect(decode(checkbox, '1')).toBe(true)
      expect(decode(checkbox, true)).toBe(true)
    })
  })

  describe('accepted', () => {
    test('validates accepted values', () => {
      expect(decode(accepted, 'yes')).toBe(true)
      expect(decode(accepted, '1')).toBe(true)
      expect(decode(accepted, true)).toBe(true)
    })

    test('fails on non-accepted values', () => {
      expect(decodeEither(accepted, 'no')._tag).toBe('Failure')
      expect(decodeEither(accepted, false)._tag).toBe('Failure')
    })
  })

  describe('declined', () => {
    test('accepts declined form values', () => {
      for (const value of [0, '0', 'false', 'no', 'off']) {
        expect(decode(declined, value)).toBe(false)
      }
    })

    test('rejects affirmative form values', () => {
      for (const value of [1, '1', 'true', 'yes', 'on']) {
        expect(decodeEither(declined, value)._tag).toBe('Failure')
      }
    })

    test('validates false literal', () => {
      // The declined schema validates that a value represents "declined"
      // The literal false value passes directly
      expect(decode(declined, false)).toBe(false)
    })

    test('rejects truthy values', () => {
      // true should fail because it's not a declined value
      expect(decodeEither(declined, true)._tag).toBe('Failure')
    })
  })
})

// =============================================================================
// Date Types
// =============================================================================

describe('Date Types', () => {
  describe('coercedDate', () => {
    test('coerces strings to dates', () => {
      const result = decode(coercedDate, '2024-01-15')
      expect(result).toBeInstanceOf(Date)
      expect(result.getFullYear()).toBe(2024)
    })

    test('coerces timestamps to dates', () => {
      const timestamp = 1_704_067_200_000
      const result = decode(coercedDate, timestamp)
      expect(result).toBeInstanceOf(Date)
    })

    test('passes through dates', () => {
      // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture exercises the public Date/Better Auth contract; it does not read the clock.
      const date = new Date('2024-01-01T00:00:00Z')
      expect(decode(coercedDate, date)).toEqual(date)
    })

    test('throws on invalid dates', () => {
      expect(() => decode(coercedDate, 'not-a-date')).toThrow()
    })
  })

  describe('nullableDate', () => {
    test('converts empty to null', () => {
      expect(decode(nullableDate, '')).toBeNull()
      expect(decode(nullableDate, null)).toBeNull()
      expect(decode(nullableDate, undefined)).toBeNull()
    })

    test('parses valid dates', () => {
      const result = decode(nullableDate, '2024-01-15')
      expect(result).toBeInstanceOf(Date)
    })
  })

  describe('after', () => {
    test('validates date is after reference', () => {
      const schema = after('2024-01-01')
      const result = decode(schema, '2024-06-15')
      expect(result).toBeInstanceOf(Date)
    })

    test('fails if date is before reference', () => {
      const schema = after('2024-01-01')
      expect(decodeEither(schema, '2023-01-01')._tag).toBe('Failure')
    })
  })

  describe('afterOrEqual', () => {
    test('validates date is on or after reference', () => {
      const schema = afterOrEqual('2024-01-01')
      expect(decode(schema, '2024-01-01')).toBeInstanceOf(Date)
      expect(decode(schema, '2024-06-15')).toBeInstanceOf(Date)
    })
  })

  describe('before', () => {
    test('validates date is before reference', () => {
      const schema = before('2024-12-31')
      const result = decode(schema, '2024-06-15')
      expect(result).toBeInstanceOf(Date)
    })

    test('fails if date is after reference', () => {
      const schema = before('2024-01-01')
      expect(decodeEither(schema, '2024-06-15')._tag).toBe('Failure')
    })
  })

  describe('beforeOrEqual', () => {
    test('validates date is on or before reference', () => {
      const schema = beforeOrEqual('2024-12-31')
      expect(decode(schema, '2024-12-31')).toBeInstanceOf(Date)
      expect(decode(schema, '2024-01-01')).toBeInstanceOf(Date)
    })
  })
})

// =============================================================================
// Array Types
// =============================================================================

describe('Array Types', () => {
  describe('ensureArray', () => {
    test('wraps single values in array', () => {
      const schema = ensureArray(S.String)
      expect(decode(schema, 'hello')).toEqual(['hello'])
    })

    test('passes through arrays', () => {
      const schema = ensureArray(S.String)
      expect(decode(schema, ['a', 'b'])).toEqual(['a', 'b'])
    })

    test('returns empty array for null/undefined', () => {
      const schema = ensureArray(S.String)
      expect(decode(schema, null)).toEqual([])
      expect(decode(schema, undefined)).toEqual([])
    })
  })

  describe('distinct', () => {
    test('validates unique values', () => {
      const schema = distinct(S.String)
      expect(decode(schema, ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
    })

    test('fails on duplicates', () => {
      const schema = distinct(S.String)
      expect(decodeEither(schema, ['a', 'b', 'a'])._tag).toBe('Failure')
    })
  })

  describe('minItems', () => {
    test('validates minimum items', () => {
      const schema = minItems(S.String, 2)
      expect(decode(schema, ['a', 'b'])).toEqual(['a', 'b'])
      expect(decode(schema, ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
    })

    test('fails with too few items', () => {
      const schema = minItems(S.String, 2)
      expect(decodeEither(schema, ['a'])._tag).toBe('Failure')
    })
  })

  describe('maxItems', () => {
    test('validates maximum items', () => {
      const schema = maxItems(S.String, 3)
      expect(decode(schema, ['a', 'b'])).toEqual(['a', 'b'])
    })

    test('fails with too many items', () => {
      const schema = maxItems(S.String, 2)
      expect(decodeEither(schema, ['a', 'b', 'c'])._tag).toBe('Failure')
    })
  })
})

// =============================================================================
// Enum/In Rules
// =============================================================================

describe('Enum/In Rules', () => {
  describe('inArray', () => {
    test('validates value is in list', () => {
      const schema = inArray(['active', 'pending', 'completed'] as const)
      expect(decode(schema, 'active')).toBe('active')
      expect(decode(schema, 'pending')).toBe('pending')
    })

    test('fails if value not in list', () => {
      const schema = inArray(['active', 'pending'] as const)
      expect(decodeEither(schema, 'deleted')._tag).toBe('Failure')
    })
  })

  describe('notIn', () => {
    test('validates value is not in list', () => {
      const schema = notIn(['admin', 'root'])
      expect(decode(schema, 'user')).toBe('user')
    })

    test('fails if value is in list', () => {
      const schema = notIn(['admin', 'root'])
      expect(decodeEither(schema, 'admin')._tag).toBe('Failure')
    })
  })
})

// =============================================================================
// Format Types
// =============================================================================

describe('Format Types', () => {
  describe('email', () => {
    test('validates email addresses', () => {
      expect(decode(email, 'test@example.com')).toBe('test@example.com')
      expect(decode(email, '  TEST@Example.COM  ')).toBe('test@example.com')
    })

    test('fails on invalid emails', () => {
      expect(decodeEither(email, 'not-an-email')._tag).toBe('Failure')
      expect(decodeEither(email, 'missing@domain')._tag).toBe('Failure')
    })
  })

  describe('nullableEmail', () => {
    test('allows null for empty', () => {
      expect(decode(nullableEmail, '')).toBeNull()
      expect(decode(nullableEmail, null)).toBeNull()
    })

    test('validates non-empty emails', () => {
      expect(decode(nullableEmail, 'test@example.com')).toBe('test@example.com')
    })
  })

  describe('url', () => {
    test('validates URLs', () => {
      expect(decode(url, 'https://example.com')).toBe('https://example.com')
      expect(decode(url, 'http://localhost:3000/path')).toBe('http://localhost:3000/path')
    })

    test('fails on invalid URLs', () => {
      expect(decodeEither(url, 'not-a-url')._tag).toBe('Failure')
    })
  })

  describe('nullableUrl', () => {
    test('allows null for empty', () => {
      expect(decode(nullableUrl, '')).toBeNull()
    })

    test('validates non-empty URLs', () => {
      expect(decode(nullableUrl, 'https://example.com')).toBe('https://example.com')
    })
  })

  describe('uuid', () => {
    test('validates UUIDs', () => {
      const validUuid = '550e8400-e29b-41d4-a716-446655440000'
      expect(decode(uuid, validUuid)).toBe(validUuid)
    })

    test('fails on invalid UUIDs', () => {
      expect(decodeEither(uuid, 'not-a-uuid')._tag).toBe('Failure')
    })
  })

  describe('nullableUuid', () => {
    test('allows null for empty', () => {
      expect(decode(nullableUuid, '')).toBeNull()
      expect(decode(nullableUuid, null)).toBeNull()
    })
  })

  describe('ipv4', () => {
    test('validates IPv4 addresses', () => {
      expect(decode(ipv4, '192.168.1.1')).toBe('192.168.1.1')
      expect(decode(ipv4, '0.0.0.0')).toBe('0.0.0.0')
      expect(decode(ipv4, '255.255.255.255')).toBe('255.255.255.255')
    })

    test('fails on invalid IPv4', () => {
      expect(decodeEither(ipv4, '256.1.1.1')._tag).toBe('Failure')
      expect(decodeEither(ipv4, '192.168.1')._tag).toBe('Failure')
    })
  })

  describe('macAddress', () => {
    test('validates MAC addresses', () => {
      expect(decode(macAddress, '00:1B:44:11:3A:B7')).toBe('00:1B:44:11:3A:B7')
      expect(decode(macAddress, '00-1B-44-11-3A-B7')).toBe('00-1B-44-11-3A-B7')
    })

    test('fails on invalid MAC', () => {
      expect(decodeEither(macAddress, 'invalid')._tag).toBe('Failure')
    })
  })

  describe('jsonString', () => {
    test('validates JSON strings', () => {
      expect(decode(jsonString, '{"key": "value"}')).toBe('{"key": "value"}')
      expect(decode(jsonString, '[1, 2, 3]')).toBe('[1, 2, 3]')
    })

    test('fails on invalid JSON', () => {
      expect(decodeEither(jsonString, '{invalid}')._tag).toBe('Failure')
    })
  })
})

// =============================================================================
// Confirmation
// =============================================================================

describe('Confirmation', () => {
  describe('confirmed', () => {
    test('creates confirmation validator config', () => {
      const config = confirmed('password')
      expect(config.fieldName).toBe('password')
      expect(config.confirmationFieldName).toBe('password_confirmation')

      expect(config.refine({ password: 'secret', password_confirmation: 'secret' })).toBe(true)
      expect(config.refine({ password: 'secret', password_confirmation: 'different' })).toBe(false)
    })

    test('supports custom confirmation field name', () => {
      const config = confirmed('password', 'confirm_password')
      expect(config.confirmationFieldName).toBe('confirm_password')
    })
  })
})

// =============================================================================
// Size Rules
// =============================================================================

describe('Size Rules', () => {
  describe('size', () => {
    test('validates exact length', () => {
      const schema = size(5)
      expect(decode(schema, 'hello')).toBe('hello')
    })

    test('fails on wrong length', () => {
      const schema = size(5)
      expect(decodeEither(schema, 'hi')._tag).toBe('Failure')
      expect(decodeEither(schema, 'hello world')._tag).toBe('Failure')
    })
  })

  describe('min', () => {
    test('validates minimum length', () => {
      const schema = min(3)
      expect(decode(schema, 'hello')).toBe('hello')
      expect(decode(schema, 'abc')).toBe('abc')
    })

    test('fails on too short', () => {
      const schema = min(3)
      expect(decodeEither(schema, 'ab')._tag).toBe('Failure')
    })
  })

  describe('max', () => {
    test('validates maximum length', () => {
      const schema = max(5)
      expect(decode(schema, 'hello')).toBe('hello')
      expect(decode(schema, 'hi')).toBe('hi')
    })

    test('fails on too long', () => {
      const schema = max(5)
      expect(decodeEither(schema, 'hello world')._tag).toBe('Failure')
    })
  })
})

// =============================================================================
// Password
// =============================================================================

describe('Password', () => {
  describe('password', () => {
    test('validates minimum length', () => {
      const schema = password({ min: 8 })
      expect(decode(schema, 'password123')).toBe('password123')
      expect(decodeEither(schema, 'short')._tag).toBe('Failure')
    })

    test('validates maximum length', () => {
      const schema = password({ min: 8, max: 20 })
      expect(decodeEither(schema, 'a'.repeat(21))._tag).toBe('Failure')
    })

    test('validates letters requirement', () => {
      const schema = password({ min: 8, letters: true })
      expect(decode(schema, 'password123')).toBe('password123')
      expect(decodeEither(schema, '12345678')._tag).toBe('Failure')
    })

    test('validates mixed case requirement', () => {
      const schema = password({ min: 8, mixedCase: true })
      expect(decode(schema, 'PassWord123')).toBe('PassWord123')
      expect(decodeEither(schema, 'password123')._tag).toBe('Failure')
    })

    test('validates numbers requirement', () => {
      const schema = password({ min: 8, numbers: true })
      expect(decode(schema, 'password1')).toBe('password1')
      expect(decodeEither(schema, 'password')._tag).toBe('Failure')
    })

    test('validates symbols requirement', () => {
      const schema = password({ min: 8, symbols: true })
      expect(decode(schema, 'password!')).toBe('password!')
      expect(decodeEither(schema, 'password1')._tag).toBe('Failure')
    })

    test('validates all requirements together', () => {
      const schema = password({
        min: 8,
        letters: true,
        mixedCase: true,
        numbers: true,
        symbols: true,
      })

      expect(decode(schema, 'Password1!')).toBe('Password1!')
      expect(decodeEither(schema, 'password')._tag).toBe('Failure')
    })
  })
})

// =============================================================================
// Utility
// =============================================================================

describe('Utility', () => {
  describe('nullable', () => {
    test('makes schema nullable', () => {
      const schema = nullable(S.Finite)
      expect(decode(schema, null)).toBeNull()
      expect(decode(schema, undefined)).toBeNull()
      expect(decode(schema, '')).toBeNull()
      expect(decode(schema, 42)).toBe(42)
    })
  })

  describe('filled', () => {
    test('provides default for empty values', () => {
      const schema = filled(S.String, 'default')
      expect(decode(schema, '')).toBe('default')
      expect(decode(schema, null)).toBe('default')
      expect(decode(schema, undefined)).toBe('default')
      expect(decode(schema, 'value')).toBe('value')
    })
  })

  describe('excludeIf', () => {
    test('excludes value when condition met', () => {
      const schema = excludeIf(S.String, (v) => v === 'EXCLUDE')
      expect(decode(schema, 'EXCLUDE')).toBeUndefined()
      expect(decode(schema, 'keep')).toBe('keep')
    })
  })
})
