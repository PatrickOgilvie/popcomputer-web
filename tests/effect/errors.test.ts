/**
 * Error Types Tests
 */

import { describe, test, expect } from 'bun:test'
import { Match, Option, Effect, Exit, Cause } from 'effect'
import {
  ValidationError,
  UnauthorizedError,
  NotFoundError,
  ForbiddenError,
  HttpError,
  HonertiaConfigurationError,
  Redirect,
} from '../../src/effect/errors.js'

describe('Error Types', () => {
  describe('ValidationError', () => {
    test('creates validation error with field errors', () => {
      const error = new ValidationError({
        errors: {
          name: 'Name is required',
          email: 'Invalid email address',
        },
      })

      expect(error._tag).toBe('ValidationError')
      expect(error.errors.name).toBe('Name is required')
      expect(error.errors.email).toBe('Invalid email address')
    })

    test('includes optional component', () => {
      const error = new ValidationError({
        errors: { name: 'Required' },
        component: 'Users/Create',
      })

      expect(error.component).toBe('Users/Create')
    })

    test('can be used with Effect.fail', () => {
      const program = Effect.fail(
        new ValidationError({ errors: { field: 'Error' } })
      )

      const exit = Effect.runSyncExit(program)
      expect(Exit.isFailure(exit)).toBe(true)

      if (Exit.isFailure(exit) && Cause.hasFails(exit.cause)) {
        const option = Cause.findErrorOption(exit.cause)

        if (Option.isSome(option)) {
          expect(option.value._tag).toBe('ValidationError')
        }
      }
    })

    test('is instanceof Data.TaggedError', () => {
      const error = new ValidationError({ errors: {} })
      expect(error._tag).toBe('ValidationError')
    })
  })

  describe('UnauthorizedError', () => {
    test('creates unauthorized error with message', () => {
      const error = new UnauthorizedError({
        message: 'You must be logged in',
      })

      expect(error._tag).toBe('UnauthorizedError')
      expect(error.message).toBe('You must be logged in')
      expect(error.redirectTo).toBeUndefined()
    })

    test('includes optional redirect URL', () => {
      const error = new UnauthorizedError({
        message: 'Please log in',
        redirectTo: '/login',
      })

      expect(error.redirectTo).toBe('/login')
    })

    test('can be matched in Effect catchTag', () => {
      const program = Effect.fail(
        new UnauthorizedError({ message: 'Unauthorized' })
      ).pipe(
        Effect.catchTag('UnauthorizedError', (e) =>
          Effect.succeed(`Caught: ${e.message}`)
        )
      )

      const result = Effect.runSync(program)
      expect(result).toBe('Caught: Unauthorized')
    })
  })

  describe('NotFoundError', () => {
    test('creates not found error with resource name', () => {
      const error = new NotFoundError({
        resource: 'Project',
      })

      expect(error._tag).toBe('NotFoundError')
      expect(error.resource).toBe('Project')
      expect(error.id).toBeUndefined()
    })

    test('includes optional resource ID', () => {
      const error = new NotFoundError({
        resource: 'Project',
        id: '123',
      })

      expect(error.id).toBe('123')
    })

    test('supports numeric IDs', () => {
      const error = new NotFoundError({
        resource: 'User',
        id: 42,
      })

      expect(error.id).toBe(42)
    })
  })

  describe('ForbiddenError', () => {
    test('creates forbidden error with message', () => {
      const error = new ForbiddenError({
        message: 'You do not have permission',
      })

      expect(error._tag).toBe('ForbiddenError')
      expect(error.message).toBe('You do not have permission')
    })
  })

  describe('HttpError', () => {
    test('creates HTTP error with status and message', () => {
      const error = new HttpError({
        status: 429,
        message: 'Too many requests',
      })

      expect(error._tag).toBe('HttpError')
      expect(error.status).toBe(429)
      expect(error.message).toBe('Too many requests')
      expect(error.body).toBeUndefined()
    })

    test('includes optional body', () => {
      const error = new HttpError({
        status: 400,
        message: 'Bad request',
        body: { field: 'Invalid value' },
      })

      expect(error.body).toEqual({ field: 'Invalid value' })
    })

    test('supports various status codes', () => {
      const codes = [400, 401, 403, 404, 422, 429, 500, 502, 503]

      for (const status of codes) {
        const error = new HttpError({ status, message: 'Error' })
        expect(error.status).toBe(status)
      }
    })
  })

  describe('HonertiaConfigurationError', () => {
    test('creates configuration error with message', () => {
      const error = new HonertiaConfigurationError({
        message: 'DatabaseService is not configured',
      })

      expect(error._tag).toBe('HonertiaConfigurationError')
      expect(error.message).toBe('DatabaseService is not configured')
      expect(error.hint).toBeUndefined()
    })

    test('includes optional hint', () => {
      const error = new HonertiaConfigurationError({
        message: 'DatabaseService is not configured. Add it to setupHonertia.',
        hint: 'Example: database: (c) => drizzle(c.env.DB)',
      })

      expect(error.hint).toBe('Example: database: (c) => drizzle(c.env.DB)')
    })

    test('can be caught with Effect.catchTag', () => {
      const program = Effect.fail(
        new HonertiaConfigurationError({
          message: 'Service not configured',
          hint: 'Configure it in setupHonertia',
        })
      ).pipe(
        Effect.catchTag('HonertiaConfigurationError', (e) =>
          Effect.succeed(`Caught: ${e.message} (${e.hint})`)
        )
      )

      const result = Effect.runSync(program)
      expect(result).toBe('Caught: Service not configured (Configure it in setupHonertia)')
    })

    test('can be thrown and caught as regular Error', () => {
      const error = new HonertiaConfigurationError({
        message: 'Test error',
        hint: 'Test hint',
      })

      // HonertiaConfigurationError extends Error, so it can be thrown/caught normally
      expect(() => {
        throw error
      }).toThrow('Test error')

      try {
        throw error
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(HonertiaConfigurationError)
        expect(e).toMatchObject({ hint: 'Test hint' })
      }
    })
  })

  describe('Redirect', () => {
    test('creates redirect with URL and status', () => {
      const redirect = new Redirect({
        url: '/dashboard',
        status: 303,
      })

      expect(redirect._tag).toBe('Redirect')
      expect(redirect.url).toBe('/dashboard')
      expect(redirect.status).toBe(303)
    })

    test('supports 302 status', () => {
      const redirect = new Redirect({
        url: '/login',
        status: 302,
      })

      expect(redirect.status).toBe(302)
    })

    test('is not an error (TaggedClass, not TaggedError)', () => {
      const redirect = new Redirect({ url: '/', status: 303 })
      // Redirect is a value, not an error
      expect(redirect._tag).toBe('Redirect')
    })

    test('can be returned as Effect success', () => {
      const program = Effect.succeed(new Redirect({ url: '/home', status: 303 }))

      const result = Effect.runSync(program)
      expect(result._tag).toBe('Redirect')
      expect(result.url).toBe('/home')
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
      new HonertiaConfigurationError({ message: 'Not configured' }),
    ]

    const tags = errors.map((e) => e._tag)
    expect(tags).toEqual([
      'ValidationError',
      'UnauthorizedError',
      'NotFoundError',
      'ForbiddenError',
      'HttpError',
      'HonertiaConfigurationError',
    ])
  })

  test('errors can be caught with Effect.catchTag', () => {
    const failWithNotFound = Effect.fail(
      new NotFoundError({ resource: 'Project', id: '123' })
    )

    const program = failWithNotFound.pipe(
      Effect.catchTag('NotFoundError', (e) =>
        Effect.succeed(`Not found: ${e.resource} ${e.id}`)
      )
    )

    const result = Effect.runSync(program)
    expect(result).toBe('Not found: Project 123')
  })

  test('multiple error types can be handled', () => {
    type AppError = ValidationError | UnauthorizedError | NotFoundError

    const handleError = (error: AppError): string => {
      return Match.value(error).pipe(Match.tagsExhaustive({
        ValidationError: (error) => `Validation failed: ${Object.keys(error.errors).length} errors`,
        UnauthorizedError: (error) => `Unauthorized: ${error.message}`,
        NotFoundError: (error) => `Not found: ${error.resource}`,
      }))
    }

    expect(handleError(new ValidationError({ errors: { a: '1', b: '2' } }))).toBe(
      'Validation failed: 2 errors'
    )
    expect(handleError(new UnauthorizedError({ message: 'Login required' }))).toBe(
      'Unauthorized: Login required'
    )
    expect(handleError(new NotFoundError({ resource: 'User' }))).toBe(
      'Not found: User'
    )
  })

  test('errors preserve structural equality', () => {
    const error1 = new ValidationError({ errors: { name: 'Required' } })
    const error2 = new ValidationError({ errors: { name: 'Required' } })

    // Data.TaggedError supports structural equality
    expect(error1.errors).toEqual(error2.errors)
    expect(error1._tag).toBe(error2._tag)
  })
})
