/* oxlint-disable effecttsgo/async-function -- Test entrypoints keep native Promise contracts; inner Effect programs remain composable. */
/**
 * Endpoint contracts: one declaration gives the action its decoded input,
 * the route its method and path, the response its encoding and status, and a
 * client its typed result.
 */

import { describe, expect, test } from 'bun:test'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../../src/setup.js'
import { action } from '../../src/effect/action.js'
import { notFound } from '../../src/effect/responses.js'
import { responseHeader } from '../../src/effect/response-headers.js'
import { call, endpoint, endpointRequest, openApi } from '../../src/endpoint.js'
import { coercedNumber, maxItems, nullableString, requiredString } from '../../src/effect/schema.js'
import { href } from '../../src/paths.js'
import { signedIn, testBrowser, testEnv } from '../../src/testing.js'

const paths = {
  places: '/api/places',
  place: '/api/places/{place}',
  rename: '/api/places/{place}/name',
} as const

const Place = S.Struct({ id: S.String, name: S.String, rating: S.Number, createdAt: S.Date })

class PlaceExists extends S.TaggedError<PlaceExists>()('PlaceExists', {
  placeId: S.String,
  message: S.String,
}) {}

class PlaceClosed extends S.TaggedError<PlaceClosed>()('PlaceClosed', { reopensAt: S.Date }) {}

const endpoints = {
  listPlaces: endpoint.get(paths.places, {
    summary: 'List places.',
    query: S.Struct({ minRating: coercedNumber, q: nullableString }),
    success: S.Struct({ data: S.Array(Place) }),
  }),
  createPlace: endpoint.post(paths.places, {
    body: S.Struct({ name: requiredString, rating: coercedNumber }),
    headers: S.Struct({ 'idempotency-key': S.optional(S.String) }),
    success: Place,
    status: 201,
    errors: { 409: [PlaceExists, PlaceClosed] },
  }),
  showPlace: endpoint.get(paths.place, { success: Place }),
  deletePlace: endpoint.delete(paths.place),
  rename: endpoint.post(paths.rename, {
    auth: true,
    body: S.Struct({ name: requiredString.check(S.isMaxLength(40)) }),
    success: S.Struct({ by: S.String, name: S.String }),
  }),
}

const created = new Date(Date.UTC(2026, 9, 13))

const rows = [
  { id: 'p1', name: 'Café Nero', rating: 4, createdAt: created, ownerSecret: 'hidden' },
  { id: 'p2', name: 'Bistro', rating: 2, createdAt: created, ownerSecret: 'hidden' },
]

const listPlaces = action(endpoints.listPlaces, ({ query }) =>
  Effect.succeed({
    data: rows.filter((row) => row.rating >= query.minRating && (query.q === null || row.name.includes(query.q))),
  })
)

const createPlace = action(endpoints.createPlace, ({ body, headers }) =>
  Effect.gen(function* () {
    if (body.name === 'Café Nero') return yield* new PlaceExists({ placeId: 'p1', message: 'Café Nero is already listed.' })
    if (body.name === 'Closed') return yield* new PlaceClosed({ reopensAt: created })

    yield* responseHeader('Location', href(paths.place, { place: 'p3' }))
    if (headers['idempotency-key'] !== undefined) yield* responseHeader('Idempotent-Replay', 'false')

    return { id: 'p3', name: body.name, rating: body.rating, createdAt: created }
  })
)

const showPlace = action(endpoints.showPlace, ({ params }) =>
  Effect.gen(function* () {
    const place = rows.find((row) => row.id === params.place)

    if (!place) return yield* notFound('Place')

    return place
  })
)

const deletePlace = action(endpoints.deletePlace, () => Effect.void)

const rename = action(endpoints.rename, ({ auth, body }) => Effect.succeed({ by: auth.user.id, name: body.name }))

function createApp() {
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

  routes
    .endpoint(listPlaces)
    .endpoint(createPlace, { name: 'places.store' })
    .endpoint(showPlace)
    .endpoint(deletePlace)
    .endpoint(rename)

  return { app, routes }
}

const through = (app: Hono) => ({ fetch: (request: Request) => app.request(request) })

describe('endpoint actions', () => {
  test('receive the query decoded and answer the success encoded through its schema', async () => {
    const { app } = createApp()
    const res = await app.request('/api/places?minRating=3')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ data: [{ id: 'p1', name: 'Café Nero', rating: 4, createdAt: created.toISOString() }] })
  })

  test('answer a create with its status and the headers the action adds', async () => {
    const { app } = createApp()
    const res = await app.request('/api/places', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k1' },
      body: JSON.stringify({ name: 'Diner', rating: 5 }),
    })

    expect(res.status).toBe(201)
    expect(res.headers.get('Location')).toBe('/api/places/p3')
    expect(res.headers.get('Idempotent-Replay')).toBe('false')
  })

  test('answer input that does not decode with 422 and each field, before the action runs', async () => {
    const { app } = createApp()
    const res = await app.request('/api/places', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', rating: 'many' }),
    })
    const body = await res.json()

    expect(res.status).toBe(422)
    expect(Object.keys(body.errors).sort()).toEqual(['name', 'rating'])
  })

  test('answer a declared failure with its status, its tag and its fields', async () => {
    const { app } = createApp()
    const res = await app.request('/api/places', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Café Nero', rating: 4 }),
    })
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toMatchObject({
      tag: 'PlaceExists',
      message: 'Café Nero is already listed.',
      body: { _tag: 'PlaceExists', placeId: 'p1' },
    })
  })

  test('answer JSON failures even to a client asking for HTML', async () => {
    const { app } = createApp()
    const res = await app.request('/api/places/p9', { headers: { Accept: 'text/html' } })

    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toContain('application/json')
  })

  test('answer an endpoint with no success with 204 and no body', async () => {
    const { app } = createApp()
    const res = await app.request('/api/places/p1', { method: 'DELETE' })

    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })

  test('answer a signed-out client 401 before reading its input, when the contract requires a user', async () => {
    const { app } = createApp()
    const send = (env?: object) => app.request('/api/places/p1/name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    }, env)

    expect((await send()).status).toBe(401)
    expect((await send(testEnv(signedIn({ id: 'user-1' })))).status).toBe(422)

    const renamed = await app.request('/api/places/p1/name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Diner' }),
    }, testEnv(signedIn({ id: 'user-1' })))

    expect(await renamed.json()).toEqual({ by: 'user-1', name: 'Diner' })
  })

  test('register on the method and path their contract declares', () => {
    const { routes } = createApp()

    expect(routes.toJson().map((route) => `${route.method} ${route.path}`)).toEqual([
      'get /api/places',
      'post /api/places',
      'get /api/places/{place}',
      'delete /api/places/{place}',
      'post /api/places/{place}/name',
    ])
  })

  test('refuse to register under a prefix, whose path the contract does not include', () => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

    expect(() => routes.prefix('/v1').endpoint(listPlaces)).toThrow("registered under the prefix '/v1'")
  })
})

describe('call', () => {
  test('sends typed input and reads the success decoded', async () => {
    const { app } = createApp()
    const result = await call(endpoints.listPlaces, { query: { minRating: 1, q: 'Bis' } }, through(app))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.data.map((place) => place.name)).toEqual(['Bistro'])
    expect(result.value.data[0]?.createdAt).toBeInstanceOf(Date)
  })

  test('reads a declared failure as the failure itself', async () => {
    const { app } = createApp()
    const result = await call(endpoints.createPlace, {
      body: { name: 'Closed', rating: 3 },
      headers: { 'idempotency-key': undefined },
    }, through(app))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.error._tag).toBe('PlaceClosed')
    if (result.error._tag !== 'PlaceClosed') return
    expect(result.error).toBeInstanceOf(PlaceClosed)
    expect(result.error.reopensAt).toEqual(created)
  })

  test('reads any other failure as the error envelope, with its field errors', async () => {
    const { app } = createApp()
    const result = await call(endpoints.createPlace, {
      body: { name: '', rating: 3 },
      headers: { 'idempotency-key': 'k2' },
    }, through(app))

    if (result.ok) throw new Error('expected a failure')
    expect(result.status).toBe(422)
    if (result.error._tag !== 'EndpointFailure') throw new Error('expected an undeclared failure')
    expect(result.error.errors?.name).toBeDefined()
  })

  test('fills the path from its parameters and reads an empty success', async () => {
    const { app } = createApp()
    const shown = await call(endpoints.showPlace, { params: { place: 'p1' } }, through(app))
    const deleted = await call(endpoints.deletePlace, { params: { place: 'p1' } }, through(app))

    expect(shown.ok && shown.value.name).toBe('Café Nero')
    expect(deleted).toMatchObject({ ok: true, status: 204, value: undefined })
  })

  test("throws before sending for a parameter that would not be one path segment: '', '.' or '..'", async () => {
    const sent: string[] = []
    const fetch = (request: Request) => {
      sent.push(request.url)

      return Promise.resolve(new Response(null, { status: 204 }))
    }

    for (const place of ['', '.', '..']) {
      // '/api/places/{place}/name' with '..' would be '/api/name', another route.
      await expect(call(endpoints.rename, { params: { place }, body: { name: 'Diner' } }, { fetch })).rejects.toThrow('not be one path segment')
      await expect(call(endpoints.deletePlace, { params: { place } }, { fetch })).rejects.toThrow('not be one path segment')
    }

    expect(sent).toEqual([])
  })

  test('leaves out fields that may be null, and sends through a test browser', async () => {
    const { app } = createApp()
    const browser = testBrowser(app)
    const listed = await call(endpoints.listPlaces, { query: { minRating: 3 } }, browser)

    expect(listed.ok && listed.value.data.map((place) => place.id)).toEqual(['p1'])
  })

  test('builds the request from the contract', () => {
    const request = endpointRequest(endpoints.createPlace, {
      body: { name: 'Diner', rating: 5 },
      headers: { 'idempotency-key': 'k3' },
    }, { baseUrl: 'https://api.example', headers: { Authorization: 'Bearer key' } })

    expect(request.method).toBe('POST')
    expect(request.url).toBe('https://api.example/api/places')
    expect(request.headers.get('Content-Type')).toBe('application/json')
    expect(request.headers.get('Idempotency-Key')).toBe('k3')
    expect(request.headers.get('Authorization')).toBe('Bearer key')
  })
})

describe('openApi', () => {
  const document = openApi(endpoints, { title: 'Places', version: '1', servers: ['https://api.example'] })
  const at = (path: string, method: string) => {
    const paths = document.paths
    if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) throw new Error('no paths')
    const operations = Reflect.get(paths, path)
    return Reflect.get(operations, method)
  }

  test('describes each endpoint by its key, with its path parameters', () => {
    expect(at('/api/places/{place}', 'get')).toMatchObject({
      operationId: 'showPlace',
      parameters: [{ name: 'place', in: 'path', required: true, schema: { type: 'string' } }],
    })
  })

  test('gives a validator decoding from anything the JSON type a client sends', () => {
    const list = at('/api/places', 'get')

    expect(list.summary).toBe('List places.')
    expect(list.parameters).toEqual([
      { name: 'minRating', in: 'query', required: true, schema: { type: 'number' } },
      { name: 'q', in: 'query', required: false, schema: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
    ])
  })

  test('describes the body, the success with its status, and the declared failures', () => {
    const create = at('/api/places', 'post')

    expect(create.requestBody.content['application/json'].schema).toMatchObject({
      type: 'object',
      properties: { name: { type: 'string' }, rating: { type: 'number' } },
      required: ['name', 'rating'],
    })
    expect(Object.keys(create.responses).sort()).toEqual(['201', '409', '422'])
    expect(create.responses['409'].description).toBe('PlaceExists, PlaceClosed')
    expect(create.responses['409'].content['application/json'].schema.allOf[1].properties.body.oneOf).toHaveLength(2)
    expect(at('/api/places/{place}', 'delete').responses).toMatchObject({ 204: { description: 'Success, with no body.' }, 404: {} })
  })

  test('lists the 401 and the security of an endpoint requiring a user, and the 404 of a path with a record', () => {
    const secured = openApi(endpoints, {
      title: 'Places',
      version: '1',
      security: { session: { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token' } },
    })
    const operation = JSON.parse(JSON.stringify(secured)).paths['/api/places/{place}/name'].post

    expect(Object.keys(operation.responses).sort()).toEqual(['200', '401', '404', '422'])
    expect(operation.security).toEqual([{ session: [] }])
    expect(secured.components).toMatchObject({ securitySchemes: { session: { type: 'apiKey' } } })
    expect(at('/api/places', 'get').responses['404']).toBeUndefined()
  })

  test("keeps a validator's limits", () => {
    expect(at('/api/places/{place}/name', 'post').requestBody.content['application/json'].schema.properties.name).toMatchObject({
      type: 'string',
      maxLength: 40,
    })
  })

  test('describes the items of a list whose length maxItems checks before they decode', () => {
    const batch = openApi({
      importPlaces: endpoint.post('/api/places/import', { body: S.Struct({ places: maxItems(S.Struct({ name: S.String }), 50) }) }),
    }, { title: 'Places', version: '1' })

    expect(JSON.parse(JSON.stringify(batch)).paths['/api/places/import'].post.requestBody.content['application/json'].schema.properties.places).toMatchObject({
      type: 'array',
      maxItems: 50,
      items: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    })
  })

  test('collects shared schemas as components', () => {
    expect(document.components).toMatchObject({ schemas: { ErrorResponse: { type: 'object' } } })
    expect(JSON.stringify(document)).not.toContain('#/$defs/')
  })
})
