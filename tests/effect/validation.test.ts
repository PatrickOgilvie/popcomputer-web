/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Validation Helpers Tests
 */

import { describe, test, expect } from 'bun:test'
import { Option, Effect, Schema as S, Layer, Exit, Cause } from 'effect'
import {
  validateUnknown,
  validateRequest,
} from '../../src/effect/validation.js'
import { RequestService, type RequestContext } from '../../src/effect/services.js'
import { ValidationError } from '../../src/effect/errors.js'
import { ErrorCodes } from '../../src/effect/error-catalog.js'
import { Hono } from 'hono'
import { setupWeb } from '../../src/setup.js'
import { action } from '../../src/effect/action.js'
import { json } from '../../src/effect/responses.js'
import { effectRoutes } from '../../src/effect/routing.js'
import { coercedDate, coercedNumber, ensureArray, nullable, nullableString, required, requiredString } from '../../src/effect/schema.js'
import type { RequestData } from '../../src/effect/validation.js'

// Helper to create a mock request context
const createMockRequest = (options: {
  method?: string
  url?: string
  params?: Record<string, string>
  query?: Record<string, string>
  body?: RequestData
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

  const parseBody = async (): Promise<Record<string, string | File>> => {
    const parsed: Record<string, string | File> = {}

    for (const [key, value] of Object.entries(body)) {
      if (!S.is(S.String)(value) && !(value instanceof File)) {
        throw new TypeError(`Form body field "${key}" must be a string or File`)
      }

      parsed[key] = value
    }

    return parsed
  }

  return {
    method,
    url,
    headers: new Headers({ 'Content-Type': contentType, ...headers }),
    env: {},
    param: (name: string) => params[name],
    params: () => params,
    query: () => query,
    queries: () => ({}),
    json: () => Response.json(body).json(),
    raw: () => new Request('http://localhost/'),
    parseBody,
    header: (name: string) => headers[name] || (name.toLowerCase() === 'content-type' ? contentType : undefined),
  }
}

const runWithRequestAsync = <A, E>(
  effect: Effect.Effect<A, E, RequestService>,
  request: RequestContext
) => {
  const layer = Layer.succeed(RequestService, request)

  return Effect.runPromiseExit(Effect.provide(effect, layer))
}

const withRequest = <A, E>(
  effect: Effect.Effect<A, E, RequestService>,
  request: RequestContext
) => Effect.provide(effect, Layer.succeed(RequestService, request))

describe('validateRequest reads route params, query and body', () => {
  test('merges params, query, and body', async () => {
    const request = createMockRequest({
      method: 'POST',
      params: { id: '123' },
      query: { format: 'json' },
      body: { name: 'Test' },
    })

    const input = await Effect.runPromise(
      withRequest(validateRequest(S.Struct({ id: S.String, format: S.String, name: S.String })), request)
    )

    expect(input).toEqual({ id: '123', format: 'json', name: 'Test' })
  })

  test('a key with different values in two sources fails validation', async () => {
    const request = createMockRequest({
      method: 'POST',
      params: { name: 'from-params' },
      query: { name: 'from-query' },
      body: { name: 'from-body' },
    })

    const error = await Effect.runPromise(
      Effect.flip(withRequest(validateRequest(S.Struct({ name: S.String })), request))
    )

    expect(error.errors.name).toStartWith('Conflicting values for name from params')
  })

  test('does not extract body for GET requests', async () => {
    const request = createMockRequest({
      method: 'GET',
      query: { search: 'test' },
      body: { shouldNotAppear: true },
    })

    const input = await Effect.runPromise(
      withRequest(validateRequest(S.Struct({ search: S.String, shouldNotAppear: S.optional(S.Boolean) })), request)
    )

    expect(input).toEqual({ search: 'test' })
  })
})

describe('validateUnknown with typed input', () => {
  test('validates valid data, decoding it', () => {
    const schema = S.Struct({
      name: S.String,
      age: S.Finite,
      count: S.FiniteFromString,
    })

    const result = Effect.runSync(
      validateUnknown(schema, { name: 'John', age: 30, count: '3' })
    )

    expect(result).toEqual<typeof schema.Type>({ name: 'John', age: 30, count: 3 })
  })

  test('fails with ValidationError on invalid data', () => {
    const schema = S.Struct({
      name: S.String.check(S.isMinLength(3)),
    })

    const error = Effect.runSync(Effect.flip(validateUnknown(schema, { name: 'Jo' })))

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.errors).toEqual({ name: 'Expected a value with a length of at least 3' })
  })

  test('an absent field reads as required, as an empty one does', () => {
    const exit = Effect.runSyncExit(validateUnknown(S.Struct({ name: requiredString, title: requiredString }), { title: '' }))
    const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()

    expect(Option.isSome(failure) && failure.value.errors).toEqual({
      name: 'This field is required',
      title: 'This field is required',
    })
  })

  test('reports every invalid field', () => {
    const schema = S.Struct({
      title: S.String.check(S.isMinLength(1)),
      slug: S.String.check(S.isPattern(/^[a-z-]+$/)),
      body: S.String.check(S.isMinLength(1)),
    })

    const exit = Effect.runSyncExit(validateUnknown(schema, { title: '', slug: 'bad slug!', body: '' }))
    const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()

    expect(Option.isSome(failure) && Object.keys(failure.value.errors).sort()).toEqual(['body', 'slug', 'title'])
  })

  test('uses custom error messages', () => {
    const schema = S.Struct({
      email: S.String.check(S.isMinLength(1)),
    })

    const error = Effect.runSync(Effect.flip(
      validateUnknown(schema, { email: '' }, {
        messages: { email: 'Please enter your email' },
      })
    ))

    expect(error.errors).toEqual({ email: 'Please enter your email' })
  })

  test('uses required-field error code for missing fields', () => {
    const schema = S.Struct({
      name: S.String,
    })

    const error = Effect.runSync(Effect.flip(validateUnknown(schema, {})))

    expect(error.code).toBe(ErrorCodes.VAL_001_FIELD_REQUIRED)
    expect(error.errors).toEqual({ name: 'This field is required' })
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

    expect(result).toEqual<typeof schema.Type>({ name: 'Test' })
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
      const option = Cause.findErrorOption(exit.cause)
      expect(option._tag).toBe('Some')

      if (Option.isSome(option)) {
        const error = option.value
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
        parseOptions: { onExcessProperty: 'error' },
      }),
      request
    )

    expect(Exit.isFailure(exit)).toBe(true)

    if (Exit.isFailure(exit)) {
      const option = Cause.findErrorOption(exit.cause)
      expect(option._tag).toBe('Some')

      if (Option.isSome(option)) {
        const error = option.value
        expect(error).toBeInstanceOf(ValidationError)
        expect(error.errors.workspaceId).toBeDefined()
      }
    }
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
      expect(exit.value).toEqual<typeof schema.Type>({ id: '123', name: 'Test' })
    }
  })

  test('fails with ValidationError on invalid request', async () => {
    const schema = S.Struct({
      name: S.String.check(S.isMinLength(3)),
    })

    const request = createMockRequest({
      method: 'POST',
      body: { name: 'Jo' },
    })

    const error = await Effect.runPromise(Effect.flip(withRequest(validateRequest(schema), request)))

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.errors).toEqual({ name: 'Expected a value with a length of at least 3' })
  })

  test('passes options to validate', async () => {
    const schema = S.Struct({
      email: S.String.check(S.isMinLength(1)),
    })

    const request = createMockRequest({
      method: 'POST',
      body: { email: '' },
    })

    const error = await Effect.runPromise(Effect.flip(withRequest(
      validateRequest(schema, {
        messages: { email: 'Email required' },
      }),
      request
    )))

    expect(error.errors).toEqual({ email: 'Email required' })
  })

  test('uses attributes option for :attribute placeholder', async () => {
    const schema = S.Struct({
      email: S.String.check(S.isMinLength(1, { message: 'The :attribute field is required' })),
    })

    const request = createMockRequest({
      method: 'POST',
      body: { email: '' },
    })

    const error = await Effect.runPromise(Effect.flip(withRequest(
      validateRequest(schema, {
        attributes: { email: 'email address' },
      }),
      request
    )))

    expect(error.errors).toEqual({ email: 'The email address field is required' })
  })

  test('fails with ValidationError for malformed JSON body', async () => {
    const schema = S.Struct({ name: S.String })

    // Create a mock that throws when parsing JSON
    const request: RequestContext = {
      method: 'POST',
      url: 'http://localhost/',
      headers: new Headers({ 'Content-Type': 'application/json' }),
      env: {},
      param: () => undefined,
      params: () => ({}),
      query: () => ({}),
      queries: () => ({}),
      json: async () => { throw new SyntaxError('Unexpected token') },
      raw: () => new Request('http://localhost/'),
      parseBody: async () => ({}),
      header: (name: string) => name.toLowerCase() === 'content-type' ? 'application/json' : undefined,
    }

    const error = await Effect.runPromise(Effect.flip(withRequest(validateRequest(schema), request)))

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.errors.form).toContain('Invalid JSON body.')
    expect(error.errors.form).toContain('Ensure Content-Type is application/json')
    expect(error.code).toBe(ErrorCodes.VAL_003_BODY_PARSE_FAILED)
  })

  test('handles complex nested schemas', async () => {
    const AddressSchema = S.Struct({
      street: S.String,
      city: S.String,
      zip: S.String.check(S.isPattern(/^\d{5}$/)),
    })

    const UserSchema = S.Struct({
      name: S.String.check(S.isMinLength(2)),
      email: S.String.check(S.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
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
      scores: S.Array(S.Finite),
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

  test('excludes route params when the order omits them', async () => {
    const schema = S.Struct({
      id: S.String,
    })

    const request = createMockRequest({
      method: 'POST',
      params: { id: '123' },
      body: {},
    })

    const error = await Effect.runPromise(Effect.flip(withRequest(
      validateRequest(schema, { request: { order: ['query', 'body'] } }),
      request
    )))

    expect(error.errors).toEqual({ id: 'This field is required' })
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

    const error = await Effect.runPromise(Effect.flip(withRequest(
      validateRequest(schema, {
        request: {
          order: ['params', 'body'],
          onConflict: 'error',
        },
      }),
      request
    )))

    expect(error.errors.name).toContain('Conflicting values')
    expect(error.code).toBe(ErrorCodes.VAL_006_SOURCE_CONFLICT)
  })

  test('treats +json content types as JSON parse failures', async () => {
    const schema = S.Struct({ name: S.String })

    const request: RequestContext = {
      method: 'POST',
      url: 'http://localhost/',
      headers: new Headers({ 'Content-Type': 'application/vnd.api+json' }),
      env: {},
      param: () => undefined,
      params: () => ({}),
      query: () => ({}),
      queries: () => ({}),
      json: async () => { throw new SyntaxError('Unexpected token') },
      raw: () => new Request('http://localhost/'),
      parseBody: async () => ({}),
      header: (name: string) => name.toLowerCase() === 'content-type' ? 'application/vnd.api+json' : undefined,
    }

    const error = await Effect.runPromise(Effect.flip(withRequest(validateRequest(schema), request)))

    expect(error.errors.form).toContain('Invalid JSON body.')
    expect(error.code).toBe(ErrorCodes.VAL_003_BODY_PARSE_FAILED)
  })

  test('does not treat application/json-seq as standard JSON media type', async () => {
    const schema = S.Struct({
      name: S.String,
    })

    const request: RequestContext = {
      method: 'POST',
      url: 'http://localhost/',
      headers: new Headers({ 'Content-Type': 'application/json-seq' }),
      env: {},
      param: () => undefined,
      params: () => ({}),
      query: () => ({}),
      queries: () => ({}),
      json: async () => { throw new Error('json parser should not be used') },
      raw: () => new Request('http://localhost/', { method: 'POST', body: '\x1e{"name":"a"}\n\x1e{"name":"b"}\n' }),
      parseBody: async () => { throw new Error('form parser should not be used') },
      header: (name: string) => name.toLowerCase() === 'content-type' ? 'application/json-seq' : undefined,
    }

    const error = await Effect.runPromise(Effect.flip(withRequest(validateRequest(schema), request)))

    expect(error.code).toBe(ErrorCodes.VAL_003_BODY_PARSE_FAILED)
    // Read as an untyped body, not by the JSON parser, whose failure reads 'Invalid JSON body'.
    expect(error.errors.form).toStartWith('Could not read the body as JSON')
  })

  test('reads a body sent without a JSON media type, as fetch sends a string, as JSON', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })
    routes.post('/ingest', action(Effect.gen(function* () {
      return yield* json(yield* validateRequest(S.Struct({ count: S.Number })))
    })))

    const plain = await app.request('/ingest', { method: 'POST', body: '{"count":3}', headers: { 'Content-Type': 'text/plain;charset=UTF-8' } })
    const none = await app.request('/ingest', { method: 'POST', body: new Blob(['{"count":4}']) })
    const garbled = await app.request('/ingest', { method: 'POST', body: 'count=5', headers: { 'Content-Type': 'text/plain', Accept: '*/*' } })

    expect(await plain.json()).toEqual({ count: 3 })
    expect(await none.json()).toEqual({ count: 4 })
    expect(garbled.status).toBe(400)
  })
})

describe('validateRequest through a route', () => {
  const ProjectInput = S.Struct({ id: S.String, name: S.String })

  const createApp = () => {
    const app = new Hono()
    setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

    effectRoutes(app).post('/projects/{id}', action(Effect.gen(function* () {
      const input = yield* validateRequest(ProjectInput)

      return yield* json({ id: input.id, name: input.name })
    })))

    return app
  }

  const post = (body: string) =>
    createApp().request('/projects/project-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
    })

  test('a body field cannot replace a route parameter', async () => {
    const res = await post(JSON.stringify({ id: 'project-2', name: 'Renamed' }))

    expect(res.status).toBe(422)
    expect(JSON.stringify(await res.json())).toContain('Conflicting values for id from params and body')
  })

  test('a body field equal to the route parameter is accepted', async () => {
    const res = await post(JSON.stringify({ id: 'project-1', name: 'Renamed' }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'project-1', name: 'Renamed' })
  })

  test('a JSON body that is not an object is a bad request, not a crash, whose envelope agrees', async () => {
    for (const body of ['null', '[1, 2]', '"text"', '3', '{"readings": [']) {
      const res = await post(body)

      expect(res.status).toBe(400)
      expect((await res.json()).httpStatus).toBe(400)
    }
  })
})

describe('field messages a form shows', () => {
  const errorsOf = async (schema: S.Codec<unknown, unknown, never, never>, input: unknown) => {
    const exit = await Effect.runPromiseExit(validateUnknown(schema, input))
    const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()

    return Option.isSome(failure) && failure.value instanceof ValidationError ? failure.value.errors : {}
  }

  test('a tagged union\'s unknown kind is reported on its _tag, naming the kinds', async () => {
    const Rule = S.Union([
      S.TaggedStruct('Threshold', { above: S.Number }),
      S.TaggedStruct('Absence', { minutes: S.Number }),
    ])

    expect(await errorsOf(S.Struct({ spec: Rule }), { spec: { _tag: 'Spike', above: 3 } }))
      .toEqual({ 'spec._tag': 'Choose one of: Threshold, Absence' })
  })

  test('a value outside a set of options names the options', async () => {
    expect(await errorsOf(S.Struct({ stage: S.Literals(['approver', 'finance']) }), { stage: 'ceo' }))
      .toEqual({ stage: 'Choose one of: approver, finance' })
  })

  test('required(message) shows its message when the field is missing as well as blank', async () => {
    const Answer = S.Struct({ answer: required('Answer this question.') })

    expect(await errorsOf(Answer, {})).toEqual({ answer: 'Answer this question.' })
    expect(await errorsOf(Answer, { answer: '  ' })).toEqual({ answer: 'Answer this question.' })
  })

  test('a blank number or date input reads as missing, as a form sends it', async () => {
    const Order = S.Struct({ quantity: coercedNumber, pickupAt: coercedDate })

    expect(await errorsOf(Order, { quantity: '', pickupAt: ' ' }))
      .toEqual({ quantity: 'This field is required', pickupAt: 'This field is required' })
    expect(await errorsOf(Order, { quantity: 'two', pickupAt: 'soon' }))
      .toEqual({ quantity: 'Expected a number', pickupAt: 'Expected a valid date' })
  })

  test('ensureArray reports a failing item under its index', async () => {
    expect(await errorsOf(S.Struct({ tags: ensureArray(coercedNumber) }), { tags: ['1', 'x'] }))
      .toEqual({ 'tags.1': 'Expected a number' })
  })

  test('nullable reads a form group whose every field is blank as null', async () => {
    const Condition = S.Struct({ questionId: requiredString, equals: nullableString })
    const exit = await Effect.runPromiseExit(validateUnknown(
      S.Struct({ condition: nullable(Condition) }),
      { condition: { questionId: '', equals: ' ' } }
    ))

    expect(Exit.isSuccess(exit) && exit.value).toEqual({ condition: null })
    expect(await errorsOf(S.Struct({ condition: nullable(Condition) }), { condition: { questionId: '', equals: 'yes' } }))
      .toEqual({ 'condition.questionId': 'This field is required' })
  })
})

describe('validateRequest redirectTo', () => {
  test('sends a failed step back to the page given, with its errors', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

    routes.post('/apply', action(Effect.gen(function* () {
      const input = yield* validateRequest(S.Struct({ company: requiredString }), { redirectTo: '/apply/experience' })

      return yield* json(input)
    })))

    const res = await app.request('/apply', {
      method: 'POST',
      body: new URLSearchParams('company='),
      headers: { Accept: 'text/html', Referer: 'http://localhost/apply/review' },
    })

    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/apply/experience')
  })
})
