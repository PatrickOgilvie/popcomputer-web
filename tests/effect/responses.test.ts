/**
 * Response Helpers Tests
 */

import { describe, test, expect } from 'bun:test'
import { Effect, Layer, Exit, Cause } from 'effect'
import type { PageProps } from '../../src/types.js'
import {
  redirect,
  render,
  renderWithErrors,
  json,
  text,
  notFound,
  forbidden,
  httpError,
  prefersJson,
  jsonOrRender,
  share,
} from '../../src/effect/responses.js'
import {
  HonertiaService,
  ResponseFactoryService,
  RequestService,
  type HonertiaRenderer,
  type ResponseFactory,
  type RequestContext,
} from '../../src/effect/services.js'
import { Redirect, NotFoundError, ForbiddenError, HttpError } from '../../src/effect/errors.js'

// Mock HonertiaRenderer
const createMockHonertia = (): HonertiaRenderer & {
  renders: Array<{ component: string; props?: PageProps }>
  shared: PageProps
  errors: Record<string, string>
} => {
  const renders: Array<{ component: string; props?: PageProps }> = []
  const shared: PageProps = {}
  let errors: Record<string, string> = {}

  return {
    renders,
    shared,
    get errors() {
      return errors
    },
    render: async (component, props) => {
      renders.push({ component, props })
      return new Response(JSON.stringify({ component, props }), {
        headers: { 'Content-Type': 'application/json' },
      })
    },
    share: (key, value) => {
      shared[key] = value
    },
    setErrors: (newErrors) => {
      Object.assign(errors, newErrors)
    },
  }
}

// Mock ResponseFactory
const createMockResponseFactory = (): ResponseFactory => ({
  redirect: (url, status = 302) =>
    new Response(null, { status, headers: { Location: url } }),
  json: (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  text: (data, status = 200) =>
    new Response(data, {
      status,
      headers: { 'Content-Type': 'text/plain' },
    }),
  notFound: () => new Response('Not Found', { status: 404 }),
})

// Mock RequestContext
const createMockRequest = (headers: Record<string, string> = {}): RequestContext => ({
  method: 'GET',
  url: 'http://localhost/',
  headers: new Headers(headers),
  param: () => undefined,
  params: () => ({}),
  query: () => ({}),
  json: async () => ({}),
  parseBody: async () => ({}),
  header: (name: string) => headers[name.toLowerCase()],
})

describe('redirect', () => {
  test('creates Redirect with default 303 status', () => {
    const result = Effect.runSync(redirect('/dashboard'))

    expect(result).toBeInstanceOf(Redirect)
    expect(result.url).toBe('/dashboard')
    expect(result.status).toBe(303)
  })

  test('creates Redirect with custom status', () => {
    const result = Effect.runSync(redirect('/login', 302))

    expect(result.status).toBe(302)
  })

  test('is a pure effect (no dependencies)', () => {
    const effect = redirect('/home')
    const result = Effect.runSync(effect)

    expect(result._tag).toBe('Redirect')
  })
})

describe('render', () => {
  test('renders component with props', async () => {
    const mockHonertia = createMockHonertia()
    const layer = Layer.succeed(HonertiaService, mockHonertia)

    const effect = render('Dashboard/Index', { projects: [] })
    const response = await Effect.runPromise(Effect.provide(effect, layer))

    expect(response).toBeInstanceOf(Response)
    expect(mockHonertia.renders).toHaveLength(1)
    expect(mockHonertia.renders[0].component).toBe('Dashboard/Index')
    expect(mockHonertia.renders[0].props).toEqual({ projects: [] })
  })

  test('renders component without props', async () => {
    const mockHonertia = createMockHonertia()
    const layer = Layer.succeed(HonertiaService, mockHonertia)

    const effect = render('Auth/Login')
    await Effect.runPromise(Effect.provide(effect, layer))

    expect(mockHonertia.renders[0].component).toBe('Auth/Login')
    expect(mockHonertia.renders[0].props).toBeUndefined()
  })
})

describe('renderWithErrors', () => {
  test('sets errors before rendering', async () => {
    const mockHonertia = createMockHonertia()
    const layer = Layer.succeed(HonertiaService, mockHonertia)

    const effect = renderWithErrors('Users/Create', {
      name: 'Name is required',
      email: 'Invalid email',
    })

    await Effect.runPromise(Effect.provide(effect, layer))

    expect(mockHonertia.errors).toEqual({
      name: 'Name is required',
      email: 'Invalid email',
    })
    expect(mockHonertia.renders[0].component).toBe('Users/Create')
  })

  test('includes props with errors', async () => {
    const mockHonertia = createMockHonertia()
    const layer = Layer.succeed(HonertiaService, mockHonertia)

    const effect = renderWithErrors(
      'Users/Create',
      { name: 'Required' },
      { existingUser: { id: 1 } }
    )

    await Effect.runPromise(Effect.provide(effect, layer))

    expect(mockHonertia.renders[0].props).toEqual({ existingUser: { id: 1 } })
  })
})

describe('json', () => {
  test('creates JSON response with default 200 status', async () => {
    const layer = Layer.succeed(ResponseFactoryService, createMockResponseFactory())

    const effect = json({ success: true, data: [1, 2, 3] })
    const response = await Effect.runPromise(Effect.provide(effect, layer))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/json')

    const body = await response.json()
    expect(body).toEqual({ success: true, data: [1, 2, 3] })
  })

  test('creates JSON response with custom status', async () => {
    const layer = Layer.succeed(ResponseFactoryService, createMockResponseFactory())

    const effect = json({ error: 'Not found' }, 404)
    const response = await Effect.runPromise(Effect.provide(effect, layer))

    expect(response.status).toBe(404)
  })
})

describe('text', () => {
  test('creates text response with default 200 status', async () => {
    const layer = Layer.succeed(ResponseFactoryService, createMockResponseFactory())

    const effect = text('Hello, World!')
    const response = await Effect.runPromise(Effect.provide(effect, layer))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/plain')

    const body = await response.text()
    expect(body).toBe('Hello, World!')
  })

  test('creates text response with custom status', async () => {
    const layer = Layer.succeed(ResponseFactoryService, createMockResponseFactory())

    const effect = text('Error occurred', 500)
    const response = await Effect.runPromise(Effect.provide(effect, layer))

    expect(response.status).toBe(500)
  })
})

describe('notFound', () => {
  test('fails with NotFoundError', () => {
    const exit = Effect.runSyncExit(notFound('Project'))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && Cause.hasFails(exit.cause)) {
      const option = Cause.findErrorOption(exit.cause)
      if (option._tag === 'Some') {
        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        const error = option.value as NotFoundError
        expect(error._tag).toBe('NotFoundError')
        expect(error.resource).toBe('Project')
      }
    }
  })

  test('includes resource ID', () => {
    const exit = Effect.runSyncExit(notFound('User', 42))

    if (Exit.isFailure(exit) && Cause.hasFails(exit.cause)) {
      const option = Cause.findErrorOption(exit.cause)
      if (option._tag === 'Some') {
        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        const error = option.value as NotFoundError
        expect(error.id).toBe(42)
      }
    }
  })

  test('supports string ID', () => {
    const exit = Effect.runSyncExit(notFound('Post', 'abc-123'))

    if (Exit.isFailure(exit) && Cause.hasFails(exit.cause)) {
      const option = Cause.findErrorOption(exit.cause)
      if (option._tag === 'Some') {
        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        const error = option.value as NotFoundError
        expect(error.id).toBe('abc-123')
      }
    }
  })
})

describe('forbidden', () => {
  test('fails with ForbiddenError with default message', () => {
    const exit = Effect.runSyncExit(forbidden())

    if (Exit.isFailure(exit) && Cause.hasFails(exit.cause)) {
      const option = Cause.findErrorOption(exit.cause)
      if (option._tag === 'Some') {
        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        const error = option.value as ForbiddenError
        expect(error._tag).toBe('ForbiddenError')
        expect(error.message).toBe('Forbidden')
      }
    }
  })

  test('fails with ForbiddenError with custom message', () => {
    const exit = Effect.runSyncExit(forbidden('You cannot edit this resource'))

    if (Exit.isFailure(exit) && Cause.hasFails(exit.cause)) {
      const option = Cause.findErrorOption(exit.cause)
      if (option._tag === 'Some') {
        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        const error = option.value as ForbiddenError
        expect(error.message).toBe('You cannot edit this resource')
      }
    }
  })
})

describe('httpError', () => {
  test('fails with HttpError', () => {
    const exit = Effect.runSyncExit(httpError(429, 'Too many requests'))

    if (Exit.isFailure(exit) && Cause.hasFails(exit.cause)) {
      const option = Cause.findErrorOption(exit.cause)
      if (option._tag === 'Some') {
        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        const error = option.value as HttpError
        expect(error._tag).toBe('HttpError')
        expect(error.status).toBe(429)
        expect(error.message).toBe('Too many requests')
      }
    }
  })

  test('includes optional body', () => {
    const exit = Effect.runSyncExit(
      httpError(400, 'Bad request', { field: 'Invalid' })
    )

    if (Exit.isFailure(exit) && Cause.hasFails(exit.cause)) {
      const option = Cause.findErrorOption(exit.cause)
      if (option._tag === 'Some') {
        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        const error = option.value as HttpError
        expect(error.body).toEqual({ field: 'Invalid' })
      }
    }
  })
})

describe('prefersJson', () => {
  test('returns false for Inertia requests', () => {
    const request = createMockRequest({
      'x-inertia': 'true',
      accept: 'application/json',
    })

    const layer = Layer.succeed(RequestService, request)
    const result = Effect.runSync(Effect.provide(prefersJson, layer))

    expect(result).toBe(false)
  })

  test('returns true for Accept: application/json', () => {
    const request = createMockRequest({
      accept: 'application/json',
    })

    const layer = Layer.succeed(RequestService, request)
    const result = Effect.runSync(Effect.provide(prefersJson, layer))

    expect(result).toBe(true)
  })

  test('returns true for Content-Type: application/json', () => {
    const request = createMockRequest({
      'content-type': 'application/json',
    })

    const layer = Layer.succeed(RequestService, request)
    const result = Effect.runSync(Effect.provide(prefersJson, layer))

    expect(result).toBe(true)
  })

  test('returns false for HTML requests', () => {
    const request = createMockRequest({
      accept: 'text/html',
    })

    const layer = Layer.succeed(RequestService, request)
    const result = Effect.runSync(Effect.provide(prefersJson, layer))

    expect(result).toBe(false)
  })
})

describe('jsonOrRender', () => {
  test('returns JSON when client prefers JSON', async () => {
    const request = createMockRequest({ accept: 'application/json' })
    const mockHonertia = createMockHonertia()
    const mockResponse = createMockResponseFactory()

    const layer = Layer.mergeAll(
      Layer.succeed(RequestService, request),
      Layer.succeed(HonertiaService, mockHonertia),
      Layer.succeed(ResponseFactoryService, mockResponse)
    )

    const effect = jsonOrRender('Projects/Index', { projects: [1, 2, 3] })
    const response = await Effect.runPromise(Effect.provide(effect, layer))

    const body = await response.json()
    expect(body).toEqual({ projects: [1, 2, 3] })
    expect(mockHonertia.renders).toHaveLength(0)
  })

  test('renders when client prefers HTML', async () => {
    const request = createMockRequest({ accept: 'text/html' })
    const mockHonertia = createMockHonertia()
    const mockResponse = createMockResponseFactory()

    const layer = Layer.mergeAll(
      Layer.succeed(RequestService, request),
      Layer.succeed(HonertiaService, mockHonertia),
      Layer.succeed(ResponseFactoryService, mockResponse)
    )

    const effect = jsonOrRender('Projects/Index', { projects: [1, 2, 3] })
    await Effect.runPromise(Effect.provide(effect, layer))

    expect(mockHonertia.renders).toHaveLength(1)
    expect(mockHonertia.renders[0].component).toBe('Projects/Index')
  })

  test('renders for Inertia requests even with JSON accept', async () => {
    const request = createMockRequest({
      'x-inertia': 'true',
      accept: 'application/json',
    })
    const mockHonertia = createMockHonertia()
    const mockResponse = createMockResponseFactory()

    const layer = Layer.mergeAll(
      Layer.succeed(RequestService, request),
      Layer.succeed(HonertiaService, mockHonertia),
      Layer.succeed(ResponseFactoryService, mockResponse)
    )

    const effect = jsonOrRender('Projects/Index', { projects: [] })
    await Effect.runPromise(Effect.provide(effect, layer))

    expect(mockHonertia.renders).toHaveLength(1)
  })
})

describe('share', () => {
  test('shares data with Honertia', () => {
    const mockHonertia = createMockHonertia()
    const layer = Layer.succeed(HonertiaService, mockHonertia)

    const effect = share('user', { id: 1, name: 'John' })
    Effect.runSync(Effect.provide(effect, layer))

    expect(mockHonertia.shared.user).toEqual({ id: 1, name: 'John' })
  })

  test('shares multiple values', () => {
    const mockHonertia = createMockHonertia()
    const layer = Layer.succeed(HonertiaService, mockHonertia)

    const effect = Effect.gen(function* () {
      yield* share('flash', { message: 'Success!' })
      yield* share('auth', { user: null })
    })

    Effect.runSync(Effect.provide(effect, layer))

    expect(mockHonertia.shared.flash).toEqual({ message: 'Success!' })
    expect(mockHonertia.shared.auth).toEqual({ user: null })
  })
})
