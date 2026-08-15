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
  detectOutputFormat,
} from '../../src/effect/error-formatter.js'
import { createStructuredError, ErrorCodes } from '../../src/effect/error-catalog.js'
import { HttpError, ValidationError } from '../../src/effect/errors.js'
import type { PageProps } from '../../src/types.js'

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

  test('scrubs sensitive-category messages in production', () => {
    expect(getClientSafeMessage(internalError(), false)).toBe(SAFE_GENERIC)
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
  test('leaks raw internal message when safeMessages is off (dev)', () => {
    // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
    const out = new JsonErrorFormatter({ safeMessages: false }).format(
      internalError()
    ) as PageProps
    expect(out.message).toContain('secret')
  })

  test('scrubs raw internal message when safeMessages is on (prod)', () => {
    // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
    const out = new JsonErrorFormatter({ safeMessages: true }).format(
      internalError()
    ) as PageProps
    expect(out.message).toBe(SAFE_GENERIC)
    expect(JSON.stringify(out)).not.toContain('secret')
  })

  test('still surfaces validation messages in prod (not sensitive)', () => {
    const error = validationError()
    // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
    const out = new JsonErrorFormatter({ safeMessages: true }).format(
      error
    ) as PageProps
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

    // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
    const out = new JsonErrorFormatter({ safeMessages: true }).format(
      error
    ) as PageProps

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

    // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
    const out = new JsonErrorFormatter({ safeMessages: false }).format(
      error
    ) as PageProps

    expect(out.message).toBe('diagnostic detail')
    expect(out.body).toEqual({ trace: 'full detail' })
  })
})

describe('InertiaErrorFormatter parity', () => {
  test('scrubs internal message in production', () => {
    // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
    const out = new InertiaErrorFormatter({ isDev: false }).format(
      internalError()
    ) as PageProps
    expect(out.message).toBe(SAFE_GENERIC)
  })

  test('shows real message in development', () => {
    // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
    const out = new InertiaErrorFormatter({ isDev: true }).format(
      internalError()
    ) as PageProps
    expect(out.message).toContain('secret')
  })
})

describe('detectOutputFormat dev heuristic', () => {
  const req = (headers: Record<string, string> = {}) => ({
    header: (name: string) => headers[name.toLowerCase()] ?? headers[name],
    method: 'GET',
    url: 'https://example.com/',
  })

  test('CF_PAGES_BRANCH alone does not enable development/terminal output', () => {
    // A production Pages deployment sets CF_PAGES_BRANCH; it must not be
    // treated as development (which would leak verbose terminal errors).
    expect(detectOutputFormat(req(), { CF_PAGES_BRANCH: 'main' })).toBe('inertia')
  })

  test('explicit ENVIRONMENT=development enables terminal output', () => {
    expect(detectOutputFormat(req(), { ENVIRONMENT: 'development' })).toBe(
      'terminal'
    )
  })
})

describe('createFormatter', () => {
  test('json formatter scrubs sensitive messages in production', async () => {
    const { createFormatter } = await import('../../src/effect/error-formatter.js')

    const output = createFormatter('json', false).format(internalError())
    const serialized = JSON.stringify(output)

    expect(serialized).not.toContain('secret')
    expect(serialized).toContain(SAFE_GENERIC)
  })

  test('json formatter keeps the real message in development', async () => {
    const { createFormatter } = await import('../../src/effect/error-formatter.js')

    const serialized = JSON.stringify(
      createFormatter('json', true).format(internalError())
    )
    expect(serialized).toContain('secret')
  })
})
