/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Response Helpers Tests
 */

import { describe, test, expect } from 'bun:test'
import { Effect, Layer, Stream } from 'effect'
import type { PageProps } from '../../src/types.js'
import {
  redirect,
  render,
  flash,
  json,
  file,
  text,
  notFound,
  forbidden,
  httpError,
  prefersJson,
  jsonOrRender,
  share,
} from '../../src/effect/responses.js'
import {
  PageService,
  ResponseFactoryService,
  RequestService,
  type PageRenderer,
  type ResponseFactory,
  type RequestContext,
} from '../../src/effect/services.js'
import { ForbiddenError, HttpError, NotFoundError, Redirect } from '../../src/effect/errors.js'

// Mock PageRenderer
const createMockPage = (): PageRenderer & {
  renders: Array<{ component: string; props?: PageProps }>
  sharedProps: PageProps
  flashedValues: Record<string, unknown>
} => {
  const renders: Array<{ component: string; props?: PageProps }> = []
  const sharedProps: PageProps = {}
  const flashedValues: Record<string, unknown> = {}

  return {
    renders,
    sharedProps,
    flashedValues,
    render: async (component, props) => {
      renders.push({ component, props })

      return Response.json({ component, props }, {
        headers: { 'Content-Type': 'application/json' },
      })
    },
    share: (key, value) => {
      sharedProps[key] = value
    },
    flash: (key, value) => {
      flashedValues[key] = value
    },
  }
}

// Mock ResponseFactory
const createMockResponseFactory = (): ResponseFactory => ({
  redirect: (url, status = 302) =>
    new Response(null, { status, headers: { Location: url } }),
  json: (data, status = 200) =>
    Response.json(data, {
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
  env: {},
  param: () => undefined,
  params: () => ({}),
  query: () => ({}),
  queries: () => ({}),
  json: () => Response.json({}).json(),
  raw: () => new Request('http://localhost/'),
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

  test('redirects with 303 and takes no status', () => {
    // @ts-expect-error a status is not a parameter of a path without placeholders
    redirect('/login', 302)

    expect(Effect.runSync(redirect('/login')).status).toBe(303)
  })
})

describe('render', () => {
  test('renders component with props', async () => {
    const mockPage = createMockPage()
    const layer = Layer.succeed(PageService, mockPage)

    const effect = render('Dashboard/Index', { projects: [] })
    const response = await Effect.runPromise(Effect.provide(effect, layer))

    expect(response).toBeInstanceOf(Response)
    expect(mockPage.renders).toHaveLength(1)
    expect(mockPage.renders[0].component).toBe('Dashboard/Index')
    expect(mockPage.renders[0].props).toEqual({ projects: [] })
  })

  test('renders component without props', async () => {
    const mockPage = createMockPage()
    const layer = Layer.succeed(PageService, mockPage)

    const effect = render('Auth/Login')
    await Effect.runPromise(Effect.provide(effect, layer))

    expect(mockPage.renders[0].component).toBe('Auth/Login')
    expect(mockPage.renders[0].props).toBeUndefined()
  })
})

describe('flash', () => {
  test('hands values to the next page', async () => {
    const mockPage = createMockPage()

    await Effect.runPromise(
      Effect.all([flash('success', 'Project created.'), flash('count', 3)]).pipe(
        Effect.provide(Layer.succeed(PageService, mockPage))
      )
    )

    expect(mockPage.flashedValues).toEqual({ success: 'Project created.', count: 3 })
  })
})

describe('file', () => {
  test('streams an Effect Stream as a download', async () => {
    const rows = Stream.fromIterable([{ id: 'c1', amount: 120 }, { id: 'c2', amount: 80 }])
    const csv = Stream.concat(Stream.make('id,amount\n'), rows.pipe(Stream.map((row) => `${row.id},${row.amount}\n`)))

    const response = await Effect.runPromise(file(csv, { contentType: 'text/csv; charset=utf-8', filename: 'claims Q3.csv' }))

    expect(response.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(response.headers.get('Content-Disposition')).toBe(`attachment; filename="claims Q3.csv"; filename*=UTF-8''claims%20Q3.csv`)
    expect(await response.text()).toBe('id,amount\nc1,120\nc2,80\n')
  })

  test('shows a body inline without a file name', async () => {
    const response = await Effect.runPromise(file('<rss/>', { contentType: 'application/rss+xml' }))

    expect(response.headers.get('Content-Disposition')).toBeNull()
    expect(await response.text()).toBe('<rss/>')
  })

  test('keeps the browser to the declared type', async () => {
    const response = await Effect.runPromise(file(new Uint8Array([1]), { contentType: 'application/pdf' }))

    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Content-Security-Policy')).toBeNull()
  })

  test('sends a type that is not one media type as bytes, since a browser reads a list by its last type', async () => {
    for (const contentType of ['image/png;x=,text/html', 'image/png, text/html', 'text/html\r\nX-Injected: 1', '']) {
      const response = await Effect.runPromise(file('<script>alert(1)</script>', { contentType }))

      expect({ contentType, sent: response.headers.get('Content-Type') }).toEqual({ contentType, sent: 'application/octet-stream' })
    }
  })

  test('shows any XML inline without script, as it may embed a page', async () => {
    const response = await Effect.runPromise(file('<rss/>', { contentType: 'application/rss+xml' }))

    expect(response.headers.get('Content-Security-Policy')).toBe('sandbox')
  })

  test('shows a type a browser runs script in, such as an SVG, without script, inline or as a download', async () => {
    const inline = await Effect.runPromise(file('<svg/>', { contentType: 'image/svg+xml' }))
    const download = await Effect.runPromise(file('<svg/>', { contentType: 'image/svg+xml', filename: 'logo.svg' }))

    expect(inline.headers.get('Content-Security-Policy')).toBe('sandbox')
    expect(download.headers.get('Content-Security-Policy')).toBe('sandbox')
    expect(download.headers.get('Content-Disposition')).toStartWith('attachment;')
  })
})

describe('json', () => {
  test('sets the headers it is given', async () => {
    const layer = Layer.succeed(ResponseFactoryService, createMockResponseFactory())

    const response = await Effect.runPromise(
      Effect.provide(json({ ok: true }, { status: 201, headers: { 'Cache-Control': 'no-store' } }), layer)
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  test('creates JSON response with default 200 status', async () => {
    const layer = Layer.succeed(ResponseFactoryService, createMockResponseFactory())

    const effect = json({ success: true, data: [1, 2, 3] })
    const response = await Effect.runPromise(Effect.provide(effect, layer))

    expect(response.status).toBe(200)

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
    const error = Effect.runSync(Effect.flip(notFound('Project')))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.resource).toBe('Project')
    expect(error.id).toBeUndefined()
    expect(error.httpStatus).toBe(404)
  })

  test('includes resource ID', () => {
    const error = Effect.runSync(Effect.flip(notFound('User', 42)))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.resource).toBe('User')
    expect(error.id).toBe(42)
  })

  test('supports string ID', () => {
    const error = Effect.runSync(Effect.flip(notFound('Post', 'abc-123')))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.id).toBe('abc-123')
  })
})

describe('forbidden', () => {
  test('fails with ForbiddenError with default message', () => {
    const error = Effect.runSync(Effect.flip(forbidden()))

    expect(error).toBeInstanceOf(ForbiddenError)
    expect(error.message).toBe('Forbidden')
    expect(error.httpStatus).toBe(403)
  })

  test('fails with ForbiddenError with custom message', () => {
    const error = Effect.runSync(Effect.flip(forbidden('You cannot edit this resource')))

    expect(error).toBeInstanceOf(ForbiddenError)
    expect(error.message).toBe('You cannot edit this resource')
  })
})

describe('httpError', () => {
  test('fails with HttpError', () => {
    const error = Effect.runSync(Effect.flip(httpError(429, 'Too many requests')))

    expect(error).toBeInstanceOf(HttpError)
    expect(error.status).toBe(429)
    expect(error.message).toBe('Too many requests')
    expect(error.body).toBeUndefined()
  })

  test('includes optional body', () => {
    const error = Effect.runSync(Effect.flip(httpError(400, 'Bad request', { field: 'Invalid' })))

    expect(error).toBeInstanceOf(HttpError)
    expect(error.status).toBe(400)
    expect(error.message).toBe('Bad request')
    expect(error.body).toEqual({ field: 'Invalid' })
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
    const mockPage = createMockPage()
    const mockResponse = createMockResponseFactory()

    const layer = Layer.mergeAll(
      Layer.succeed(RequestService, request),
      Layer.succeed(PageService, mockPage),
      Layer.succeed(ResponseFactoryService, mockResponse)
    )

    const effect = jsonOrRender('Projects/Index', { projects: [1, 2, 3] })
    const response = await Effect.runPromise(Effect.provide(effect, layer))

    const body = await response.json()
    expect(body).toEqual({ projects: [1, 2, 3] })
    expect(mockPage.renders).toHaveLength(0)
  })

  test('renders when client prefers HTML', async () => {
    const request = createMockRequest({ accept: 'text/html' })
    const mockPage = createMockPage()
    const mockResponse = createMockResponseFactory()

    const layer = Layer.mergeAll(
      Layer.succeed(RequestService, request),
      Layer.succeed(PageService, mockPage),
      Layer.succeed(ResponseFactoryService, mockResponse)
    )

    const effect = jsonOrRender('Projects/Index', { projects: [1, 2, 3] })
    await Effect.runPromise(Effect.provide(effect, layer))

    expect(mockPage.renders).toHaveLength(1)
    expect(mockPage.renders[0].component).toBe('Projects/Index')
  })
})

describe('share', () => {
  test('shares data with the page renderer', () => {
    const mockPage = createMockPage()
    const layer = Layer.succeed(PageService, mockPage)

    const effect = share('user', { id: 1, name: 'John' })
    Effect.runSync(Effect.provide(effect, layer))

    expect(mockPage.sharedProps.user).toEqual({ id: 1, name: 'John' })
  })
})
