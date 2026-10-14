/**
 * Error Types Tests
 */

import { describe, test, expect } from 'bun:test'
import {
  ValidationError,
  UnauthorizedError,
  NotFoundError,
  ForbiddenError,
  HttpError,
  ConfigurationError,
  Redirect,
} from '../../src/effect/errors.js'
import { ErrorCodes } from '../../src/effect/error-catalog.js'

describe('Error Types', () => {
  describe('ValidationError', () => {
    test('is a 400 for a body that could not be parsed and a 422 for input that did not validate', () => {
      expect(new ValidationError({ errors: { body: 'Unreadable' }, code: ErrorCodes.VAL_003_BODY_PARSE_FAILED }).httpStatus).toBe(400)
      expect(new ValidationError({ errors: { name: 'Required' }, code: ErrorCodes.VAL_004_SCHEMA_MISMATCH }).httpStatus).toBe(422)
      expect(new ValidationError({ errors: { name: 'Required' } }).httpStatus).toBe(422)
    })
  })

  describe('NotFoundError', () => {
    test('names the resource, and its id when it has one, in its message', () => {
      expect(new NotFoundError({ resource: 'Project' }).message).toBe('Project was not found.')
      expect(new NotFoundError({ resource: 'Project', id: '123' }).message).toBe('Project with id "123" was not found.')
      expect(new NotFoundError({ resource: 'User', id: 42 }).message).toBe('User with id "42" was not found.')
      expect(new NotFoundError({ resource: 'Invoice', id: 0 }).message).toBe('Invoice with id "0" was not found.')
    })
  })

  describe('HttpError', () => {
    test.each([
      [400, 'WEB_HTTP_400_BAD_REQUEST'],
      [404, 'WEB_HTTP_4XX_CLIENT_ERROR'],
      [429, 'WEB_HTTP_429_RATE_LIMITED'],
      [500, 'WEB_HTTP_500_INTERNAL_ERROR'],
      [502, 'WEB_HTTP_502_BAD_GATEWAY'],
      [503, 'WEB_HTTP_503_SERVICE_UNAVAILABLE'],
      [504, 'WEB_HTTP_500_INTERNAL_ERROR'],
    ])('reports status %p with the code %p', (status, code) => {
      expect(new HttpError({ status, message: 'Error' }).toStructured().code).toBe(code)
    })
  })

  describe('Redirect', () => {
    test('is not an error (TaggedClass, not TaggedError)', () => {
      const redirect = new Redirect({ url: '/', status: 303 })
      // Redirect is a value, not an error
      expect(redirect._tag).toBe('Redirect')
      expect(redirect).not.toBeInstanceOf(Error)
    })
  })
})

describe('Error Handling Patterns', () => {
  test('errors can be discriminated by _tag', () => {
    const errors = [
      new ValidationError({ errors: {} }),
      new UnauthorizedError({ message: 'Unauthorized' }),
      new NotFoundError({ resource: 'Item' }),
      new ForbiddenError({ message: 'Forbidden' }),
      new HttpError({ status: 500, message: 'Server error' }),
      new ConfigurationError({ message: 'Not configured' }),
    ]

    const tags = errors.map((e) => e._tag)
    expect(tags).toEqual([
      'ValidationError',
      'UnauthorizedError',
      'NotFoundError',
      'ForbiddenError',
      'HttpError',
      'ConfigurationError',
    ])
  })
})
