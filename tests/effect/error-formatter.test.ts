/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Error Formatter Tests
 *
 * Focused on the client-facing safety guarantees: messages for sensitive
 * categories (internal/database/configuration/service) must never leak raw
 * details to clients in production, across both the JSON and Inertia paths.
 */

import { describe, test, expect } from 'bun:test'
import {
  JsonErrorFormatter,
  InertiaErrorFormatter,
  getClientSafeMessage,
} from '../../src/effect/error-formatter.js'
import { createStructuredError, ErrorCodes } from '../../src/effect/error-catalog.js'
import { HttpError, ValidationError } from '../../src/effect/errors.js'

describe('structured error parameter formatting', () => {
  test('inserts scalar parameters literally', () => {
    const error = createStructuredError(ErrorCodes.VAL_001_FIELD_REQUIRED, { field: '$&' }, {})

    expect(error.message).toContain('$&')
    expect(error.message).not.toContain('{field}')
  })

  test('does not serialize object payloads into diagnostic messages or fixes', () => {
    const error = createStructuredError(
      ErrorCodes.VAL_001_FIELD_REQUIRED,
      { field: { token: 'must-not-appear' } },
      {},
    )

    expect(error.message).toContain('[object]')
    expect(error.message).not.toContain('must-not-appear')

    for (const fix of error.fixes) {
      expect(fix.description).not.toContain('must-not-appear')
    }
  })
})

const SAFE_GENERIC = 'An error occurred. Please try again later.'

// A defect carrying a sensitive raw message, as produced by the Effect handler
// when an unexpected error (e.g. a DB driver error) is thrown.
const internalError = () =>
  createStructuredError(
    ErrorCodes.INT_801_EFFECT_DEFECT,
    { reason: 'connection to db://user:secret@host failed' },
    {}
  )

const validationError = () =>
  createStructuredError(ErrorCodes.VAL_001_FIELD_REQUIRED, { field: 'email' }, {})

describe('getClientSafeMessage', () => {
  test('returns the real message in development', () => {
    const error = internalError()
    expect(getClientSafeMessage(error, true)).toBe(error.message)
    expect(getClientSafeMessage(error, true)).toContain('secret')
  })

  test('scrubs sensitive-category messages in production, whatever their status', () => {
    // A constraint violation answers 409, so only its database category hides the constraint's name.
    const constraint = createStructuredError(ErrorCodes.DB_502_CONSTRAINT_VIOLATION, { constraint: 'users_email_key' }, {})

    expect(constraint.httpStatus).toBe(409)
    expect(getClientSafeMessage(constraint, false)).toBe(SAFE_GENERIC)
  })

  test('passes through non-sensitive messages in production', () => {
    const error = validationError()
    expect(getClientSafeMessage(error, false)).toBe(error.message)
  })

  test('scrubs all 5xx messages regardless of category', () => {
    const error = HttpError.internal('db://user:secret@host').toStructured()
    expect(error.category).toBe('http')
    expect(getClientSafeMessage(error, false)).toBe(SAFE_GENERIC)
  })
})

describe('JsonErrorFormatter safeMessages', () => {
  test('still surfaces validation messages in prod (not sensitive)', () => {
    const error = validationError()

    const out = new JsonErrorFormatter({ safeMessages: true }).format(
      error
    )

    expect(out.message).toBe(error.message)
  })

  test('omits rejected values from production validation details', () => {
    const error = new ValidationError({
      errors: { password: 'Password is too short' },
      fieldDetails: {
        password: {
          value: 'secret-password',
          expected: 'at least 12 characters',
          message: 'Password is too short',
          path: ['password'],
        },
      },
    }).toStructured()

    const out = new JsonErrorFormatter({ safeMessages: true }).format(error)
    expect(JSON.stringify(out)).not.toContain('secret-password')
    expect(out).toMatchObject({
      validation: {
        fields: {
          password: {
            expected: 'at least 12 characters',
            message: 'Password is too short',
            path: ['password'],
          },
        },
      },
    })
  })

  test('omits arbitrary bodies from production 5xx errors', () => {
    const error = new HttpError({
      status: 500,
      message: 'db://user:secret@host',
      body: { connection: 'db://user:secret@host' },
    }).toStructured()

    const out = new JsonErrorFormatter({ safeMessages: true }).format(
      error
    )

    expect(out.message).toBe(SAFE_GENERIC)
    expect(out.body).toBeUndefined()
    expect(JSON.stringify(out)).not.toContain('secret')
  })

  test('retains full extensions in development', () => {
    const error = new HttpError({
      status: 500,
      message: 'diagnostic detail',
      body: { trace: 'full detail' },
    }).toStructured()

    const out = new JsonErrorFormatter({ safeMessages: false }).format(
      error
    )

    expect(out.message).toBe('diagnostic detail')
    expect(out.body).toEqual({ trace: 'full detail' })
  })
})

describe('InertiaErrorFormatter parity', () => {
  test('scrubs internal message in production', () => {
    // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
    const out = new InertiaErrorFormatter({ isDev: false }).format(
      internalError()
    )

    expect(out.message).toBe(SAFE_GENERIC)
  })

  test('shows real message in development', () => {
    // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
    const out = new InertiaErrorFormatter({ isDev: true }).format(
      internalError()
    )

    expect(out.message).toContain('secret')
  })
})

describe('JsonErrorFormatter message safety', () => {
  test('scrubs sensitive messages and omits fixes in the production projection', () => {
    const output = new JsonErrorFormatter({ safeMessages: true, includeFixes: false }).format(
      internalError()
    )
    const serialized = JSON.stringify(output)

    expect(serialized).not.toContain('secret')
    expect(output.message).toBe(SAFE_GENERIC)
    expect(output.fixes).toBeUndefined()
  })

  test('keeps the real message in development', () => {
    expect(new JsonErrorFormatter().format(internalError()).message).toContain('secret')
  })
})
