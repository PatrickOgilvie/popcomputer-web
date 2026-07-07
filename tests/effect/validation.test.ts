/**
 * Validation Helpers Tests
 */

import { describe, test, expect } from 'bun:test'
import { Effect, Schema as S, Layer, Exit, Cause } from 'effect'
import {
  getValidationData,
  formatSchemaErrors,
  validate,
  validateUnknown,
  validateRequest,
} from '../../src/effect/validation.js'
import { RequestService, type RequestContext } from '../../src/effect/services.js'
import { ValidationError } from '../../src/effect/errors.js'
import { ErrorCodes } from '../../src/effect/error-catalog.js'

// Helper to create a mock request context
const createMockRequest = (options: {
  method?: string
  url?: string
  params?: Record<string, string>
  query?: Record<string, string>
  body?: Record<string, unknown>
  headers?: Record<string, string>
  contentType?: string
}): RequestContext => {
  const {
    method = 'GET',
    url = 'http://localhost/',
    params = {},
    query = {},
    body = {},
    headers = {},
    contentType = 'application/json',
  } = options

  return {
    method,
    url,
    headers: new Headers({ 'Content-Type': contentType, ...headers }),
    param: (name: string) => params[name],
    params: () => params,
    query: () => query,
    json: async <T>() => body as T,
    parseBody: async () => body,
    header: (name: string) => headers[name] || (name.toLowerCase() === 'content-type' ? contentType : undefined),
  }
}

// Helper to run effect with request service
const runWithRequest = <A, E>(
  effect: Effect.Effect<A, E, RequestService>,
  request: RequestContext
) => {
  const layer = Layer.succeed(RequestService, request)
  return Effect.runSyncExit(Effect.provide(effect, layer))
}

const runWithRequestAsync = <A, E>(
  effect: Effect.Effect<A, E, RequestService>,
  request: RequestContext
) => {
  const layer = Layer.succeed(RequestService, request)
  return Effect.runPromiseExit(Effect.provide(effect, layer))
}

describe('getValidationData', () => {
  test('extracts route params', async () => {
    const request = createMockRequest({
      params: { id: '123', slug: 'test-post' },
    })

    const exit = await runWithRequestAsync(getValidationData, request)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.id).toBe('123')
      expect(exit.value.slug).toBe('test-post')
    }
  })

  test('extracts query params', async () => {
    const request = createMockRequest({
      query: { page: '1', limit: '10' },
    })

    const exit = await runWithRequestAsync(getValidationData, request)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.page).toBe('1')
      expect(exit.value.limit).toBe('10')
    }
  })

  test('extracts body for POST requests', async () => {
    const request = createMockRequest({
      method: 'POST',
      body: { name: 'Test Project', description: 'A test' },
    })

    const exit = await runWithRequestAsync(getValidationData, request)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.name).toBe('Test Project')
      expect(exit.value.description).toBe('A test')
    }
  })

  test('merges params, query, and body', async () => {
    const request = createMockRequest({
      method: 'POST',
      params: { id: '123' },
      query: { format: 'json' },
      body: { name: 'Test' },
    })

    const exit = await runWithRequestAsync(getValidationData, request)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.id).toBe('123')
      expect(exit.value.format).toBe('json')
      expect(exit.value.name).toBe('Test')
    }
  })

  test('body overrides query which overrides params', async () => {
    const request = createMockRequest({
      method: 'POST',
      params: { name: 'from-params' },
      query: { name: 'from-query' },
      body: { name: 'from-body' },
    })

    const exit = await runWithRequestAsync(getValidationData, request)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.name).toBe('from-body')
    }
  })

  test('does not extract body for GET requests', async () => {
    const request = createMockRequest({
      method: 'GET',
      query: { search: 'test' },
      body: { shouldNotAppear: true },
    })

    const exit = await runWithRequestAsync(getValidationData, request)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.search).toBe('test')
      expect(exit.value.shouldNotAppear).toBeUndefined()
    }
  })
})

describe('formatSchemaErrors', () => {
  test('formats single field error', async () => {
    const schema = S.Struct({
      name: S.String.pipe(S.minLength(1)),
    })

    const exit = Effect.runSyncExit(
      S.decodeUnknown(schema)({ name: '' })
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })

  test('formats errors with custom messages', async () => {
    const schema = S.Struct({
      name: S.String.pipe(S.minLength(1)),
    })

    const exit = Effect.runSyncExit(
      S.decodeUnknown(schema)({ name: '' })
    )

    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const errors = formatSchemaErrors(option.value as any, {
          name: 'Name is required',
        })
        expect(errors.name).toBe('Name is required')
      }
    }
  })

  test('formats errors with attribute substitution', async () => {
    const schema = S.Struct({
      email: S.String.pipe(S.minLength(1)),
    })

    const exit = Effect.runSyncExit(
      S.decodeUnknown(schema)({ email: '' })
    )

    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const errors = formatSchemaErrors(
          option.value as any,
          { email: 'The :attribute field is required' },
          { email: 'email address' }
        )
        expect(errors.email).toBe('The email address field is required')
      }
    }
  })

  test('handles nested field errors', async () => {
    const schema = S.Struct({
      user: S.Struct({
        name: S.String.pipe(S.minLength(1)),
      }),
    })

    const exit = Effect.runSyncExit(
      S.decodeUnknown(schema)({ user: { name: '' } })
    )

    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const errors = formatSchemaErrors(option.value as any)
        expect(errors['user.name']).toBeDefined()
        expect(errors['user.name']).toContain('at least 1 character')
      }
    }
  })

  test('handles array index in field path', async () => {
    const schema = S.Struct({
      tags: S.Array(S.String.pipe(S.minLength(1))),
    })

    const exit = Effect.runSyncExit(
      S.decodeUnknown(schema)({ tags: ['valid', ''] })
    )

    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const errors = formatSchemaErrors(option.value as any)
        expect(errors['tags.1']).toBeDefined()
        expect(errors['tags.1']).toContain('at least 1 character')
      }
    }
  })

  test('handles deeply nested field paths', async () => {
    const schema = S.Struct({
      company: S.Struct({
        address: S.Struct({
          zip: S.String.pipe(S.minLength(5)),
        }),
      }),
    })

    const exit = Effect.runSyncExit(
      S.decodeUnknown(schema)({ company: { address: { zip: '123' } } })
    )

    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const errors = formatSchemaErrors(option.value as any)
        expect(errors['company.address.zip']).toBeDefined()
      }
    }
  })
})

describe('validate', () => {
  test('validates valid data', () => {
    const schema = S.Struct({
      name: S.String,
      age: S.Number,
    })

    const result = Effect.runSync(
      validate(schema, { name: 'John', age: 30 })
    )

    expect(result).toEqual({ name: 'John', age: 30 })
  })

  test('fails with ValidationError on invalid data', () => {
    const schema = S.Struct({
      name: S.String.pipe(S.minLength(3)),
    })

    const exit = Effect.runSyncExit(validate(schema, { name: 'Jo' }))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const error = option.value as ValidationError
        expect(error._tag).toBe('ValidationError')
        expect(error.errors).toBeDefined()
      }
    }
  })

  test('uses custom error messages', () => {
    const schema = S.Struct({
      email: S.String.pipe(S.minLength(1)),
    })

    const exit = Effect.runSyncExit(
      validate(schema, { email: '' }, {
        messages: { email: 'Please enter your email' },
      })
    )

    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const error = option.value as ValidationError
        expect(error.errors.email).toBe('Please enter your email')
      }
    }
  })

  test('includes error component', () => {
    const schema = S.Struct({
      name: S.String.pipe(S.minLength(1)),
    })

    const exit = Effect.runSyncExit(
      validate(schema, { name: '' }, {
        errorComponent: 'Users/Create',
      })
    )

    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const error = option.value as ValidationError
        expect(error.component).toBe('Users/Create')
      }
    }
  })

  test('uses required-field error code for missing fields', () => {
    const schema = S.Struct({
      name: S.String,
    })

    const exit = Effect.runSyncExit(validateUnknown(schema, {}))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const error = option.value as ValidationError
        expect(error.code).toBe(ErrorCodes.VAL_001_FIELD_REQUIRED)
      }
    }
  })
})

describe('validateUnknown', () => {
  test('validates unknown input', () => {
    const schema = S.Struct({
      id: S.String,
      count: S.NumberFromString,
    })
    const raw: unknown = { id: 'x', count: '3' }

    const result = Effect.runSync(validateUnknown(schema, raw))
    expect(result).toEqual({ id: 'x', count: 3 })
  })
})

describe('parseOptions', () => {
  const schema = S.Struct({
    name: S.String,
  })

  test('excess properties are ignored by default', () => {
    const result = Effect.runSync(
      validateUnknown(schema, { name: 'Test', extra: 'field' })
    )
    expect(result).toEqual({ name: 'Test' })
  })

  test('validateUnknown rejects excess properties with onExcessProperty error', () => {
    const exit = Effect.runSyncExit(
      validateUnknown(
        schema,
        { name: 'Test', extra: 'field' },
        { parseOptions: { onExcessProperty: 'error' } }
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const option = Cause.failureOption(exit.cause)
      expect(option._tag).toBe('Some')
      if (option._tag === 'Some') {
        const error = option.value as ValidationError
        expect(error).toBeInstanceOf(ValidationError)
        expect(error.errors.extra).toBeDefined()
        expect(error.code).toBe(ErrorCodes.VAL_004_SCHEMA_MISMATCH)
      }
    }
  })

  test('validateRequest rejects excess body properties with onExcessProperty error', async () => {
    const request = createMockRequest({
      method: 'POST',
      body: { name: 'Test', workspaceId: 'attacker-ws' },
    })

    const exit = await runWithRequestAsync(
      validateRequest(schema, {
        request: 'laravel',
        parseOptions: { onExcessProperty: 'error' },
      }),
      request
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const option = Cause.failureOption(exit.cause)
      expect(option._tag).toBe('Some')
      if (option._tag === 'Some') {
        const error = option.value as ValidationError
        expect(error).toBeInstanceOf(ValidationError)
        expect(error.errors.workspaceId).toBeDefined()
      }
    }
  })

  test('validate rejects excess properties with onExcessProperty error', () => {
    const exit = Effect.runSyncExit(
      validate(
        schema,
        { name: 'Test', extra: 'field' } as unknown as { name: string },
        { parseOptions: { onExcessProperty: 'error' } }
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe('validateRequest', () => {
  test('validates request data against schema', async () => {
    const schema = S.Struct({
      id: S.String,
      name: S.String,
    })

    const request = createMockRequest({
      method: 'POST',
      params: { id: '123' },
      body: { name: 'Test' },
    })

    const exit = await runWithRequestAsync(validateRequest(schema), request)

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({ id: '123', name: 'Test' })
    }
  })

  test('fails with ValidationError on invalid request', async () => {
    const schema = S.Struct({
      name: S.String.pipe(S.minLength(3)),
    })

    const request = createMockRequest({
      method: 'POST',
      body: { name: 'Jo' },
    })

    const exit = await runWithRequestAsync(validateRequest(schema), request)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        expect((option.value as ValidationError)._tag).toBe('ValidationError')
      }
    }
  })

  test('passes options to validate', async () => {
    const schema = S.Struct({
      email: S.String.pipe(S.minLength(1)),
    })

    const request = createMockRequest({
      method: 'POST',
      body: { email: '' },
    })

    const exit = await runWithRequestAsync(
      validateRequest(schema, {
        messages: { email: 'Email required' },
        errorComponent: 'Auth/Register',
      }),
      request
    )

    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const error = option.value as ValidationError
        expect(error.errors.email).toBe('Email required')
        expect(error.component).toBe('Auth/Register')
      }
    }
  })

  test('uses attributes option for :attribute placeholder', async () => {
    const schema = S.Struct({
      email: S.String.pipe(S.minLength(1, { message: () => 'The :attribute field is required' })),
    })

    const request = createMockRequest({
      method: 'POST',
      body: { email: '' },
    })

    const exit = await runWithRequestAsync(
      validateRequest(schema, {
        attributes: { email: 'email address' },
      }),
      request
    )

    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const error = option.value as ValidationError
        expect(error.errors.email).toBe('The email address field is required')
      }
    }
  })

  test('fails with ValidationError for malformed JSON body', async () => {
    const schema = S.Struct({ name: S.String })

    // Create a mock that throws when parsing JSON
    const request: RequestContext = {
      method: 'POST',
      url: 'http://localhost/',
      headers: new Headers({ 'Content-Type': 'application/json' }),
      param: () => undefined,
      params: () => ({}),
      query: () => ({}),
      json: async () => { throw new SyntaxError('Unexpected token') },
      parseBody: async () => ({}),
      header: (name: string) => name.toLowerCase() === 'content-type' ? 'application/json' : undefined,
    }

    const exit = await runWithRequestAsync(validateRequest(schema), request)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const error = option.value as ValidationError
        expect(error._tag).toBe('ValidationError')
        expect(error.errors.form).toContain('Invalid JSON body.')
        expect(error.errors.form).toContain('Ensure Content-Type is application/json')
        expect(error.code).toBe(ErrorCodes.VAL_003_BODY_PARSE_FAILED)
      }
    }
  })

  test('handles complex nested schemas', async () => {
    const AddressSchema = S.Struct({
      street: S.String,
      city: S.String,
      zip: S.String.pipe(S.pattern(/^\d{5}$/)),
    })

    const UserSchema = S.Struct({
      name: S.String.pipe(S.minLength(2)),
      email: S.String.pipe(S.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
      address: AddressSchema,
    })

    const validRequest = createMockRequest({
      method: 'POST',
      body: {
        name: 'John Doe',
        email: 'john@example.com',
        address: {
          street: '123 Main St',
          city: 'Springfield',
          zip: '12345',
        },
      },
    })

    const exit = await runWithRequestAsync(validateRequest(UserSchema), validRequest)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.name).toBe('John Doe')
      expect(exit.value.address.city).toBe('Springfield')
    }
  })

  test('handles array fields', async () => {
    const schema = S.Struct({
      tags: S.Array(S.String),
      scores: S.Array(S.Number),
    })

    const request = createMockRequest({
      method: 'POST',
      body: {
        tags: ['one', 'two', 'three'],
        scores: [1, 2, 3],
      },
    })

    const exit = await runWithRequestAsync(validateRequest(schema), request)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.tags).toEqual(['one', 'two', 'three'])
      expect(exit.value.scores).toEqual([1, 2, 3])
    }
  })

  test('handles optional fields', async () => {
    const schema = S.Struct({
      name: S.String,
      bio: S.optional(S.String),
    })

    const request = createMockRequest({
      method: 'POST',
      body: { name: 'John' },
    })

    const exit = await runWithRequestAsync(validateRequest(schema), request)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.name).toBe('John')
      expect(exit.value.bio).toBeUndefined()
    }
  })

  test('supports laravel profile that excludes route params', async () => {
    const schema = S.Struct({
      id: S.String,
    })

    const request = createMockRequest({
      method: 'POST',
      params: { id: '123' },
      body: {},
    })

    const exit = await runWithRequestAsync(
      validateRequest(schema, { request: 'laravel' }),
      request
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const error = option.value as ValidationError
        expect(error.errors.id).toBeDefined()
      }
    }
  })

  test('supports first-wins conflict handling with custom order', async () => {
    const schema = S.Struct({
      name: S.String,
    })

    const request = createMockRequest({
      method: 'POST',
      params: { name: 'from-params' },
      query: { name: 'from-query' },
      body: { name: 'from-body' },
    })

    const exit = await runWithRequestAsync(
      validateRequest(schema, {
        request: {
          order: ['params', 'query', 'body'],
          onConflict: 'first-wins',
        },
      }),
      request
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.name).toBe('from-params')
    }
  })

  test('custom order takes precedence over profile when both are provided', async () => {
    const schema = S.Struct({
      id: S.String,
    })

    const request = createMockRequest({
      method: 'POST',
      params: { id: '123' },
      body: {},
    })

    const exit = await runWithRequestAsync(
      validateRequest(schema, {
        request: {
          profile: 'laravel',
          order: ['params', 'body'],
        },
      }),
      request
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.id).toBe('123')
    }
  })

  test('supports explicit last-wins conflict handling with custom order', async () => {
    const schema = S.Struct({
      name: S.String,
    })

    const request = createMockRequest({
      method: 'POST',
      params: { name: 'from-params' },
      body: { name: 'from-body' },
    })

    const exit = await runWithRequestAsync(
      validateRequest(schema, {
        request: {
          order: ['body', 'params'],
          onConflict: 'last-wins',
        },
      }),
      request
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.name).toBe('from-params')
    }
  })

  test('can fail when request sources conflict', async () => {
    const schema = S.Struct({
      name: S.String,
    })

    const request = createMockRequest({
      method: 'POST',
      params: { name: 'from-params' },
      body: { name: 'from-body' },
    })

    const exit = await runWithRequestAsync(
      validateRequest(schema, {
        request: {
          order: ['params', 'body'],
          onConflict: 'error',
        },
      }),
      request
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const error = option.value as ValidationError
        expect(error.errors.name).toContain('Conflicting values')
        expect(error.code).toBe(ErrorCodes.VAL_006_SOURCE_CONFLICT)
      }
    }
  })

  test('treats +json content types as JSON parse failures', async () => {
    const schema = S.Struct({ name: S.String })

    const request: RequestContext = {
      method: 'POST',
      url: 'http://localhost/',
      headers: new Headers({ 'Content-Type': 'application/vnd.api+json' }),
      param: () => undefined,
      params: () => ({}),
      query: () => ({}),
      json: async () => { throw new SyntaxError('Unexpected token') },
      parseBody: async () => ({}),
      header: (name: string) => name.toLowerCase() === 'content-type' ? 'application/vnd.api+json' : undefined,
    }

    const exit = await runWithRequestAsync(validateRequest(schema), request)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const error = option.value as ValidationError
        expect(error.errors.form).toContain('Invalid JSON body.')
        expect(error.code).toBe(ErrorCodes.VAL_003_BODY_PARSE_FAILED)
      }
    }
  })

  test('does not treat application/json-seq as standard JSON media type', async () => {
    const schema = S.Struct({
      name: S.String,
    })

    const request: RequestContext = {
      method: 'POST',
      url: 'http://localhost/',
      headers: new Headers({ 'Content-Type': 'application/json-seq' }),
      param: () => undefined,
      params: () => ({}),
      query: () => ({}),
      json: async () => { throw new Error('json parser should not be used') },
      parseBody: async () => ({ name: 'from-parse-body' }),
      header: (name: string) => name.toLowerCase() === 'content-type' ? 'application/json-seq' : undefined,
    }

    const exit = await runWithRequestAsync(validateRequest(schema), request)

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.name).toBe('from-parse-body')
    }
  })
})
