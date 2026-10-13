/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * JSON Response Tests
 *
 * A JSON response declared by a schema is encoded through its JSON form, as
 * page props are, and a test reads it back through the same schema.
 */

import { describe, expect, test } from 'bun:test'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { httpError, ifChanged, json } from '../src/effect/responses.js'
import { HttpError } from '../src/effect/errors.js'
import { readError, readJson } from '../src/testing.js'
import { errorResponseWith } from '../src/schema.js'

const Evaluation = S.Struct({ flag: S.String, enabled: S.Boolean, evaluatedAt: S.Date })
const ShortOfStock = S.Struct({
  lines: S.Array(S.Struct({ sku: S.String, available: S.Number })),
  checkedAt: S.Date,
})

function createApp() {
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page), errors: { component: 'Error' } })

  routes
    .get('/api/flags', action(json(Evaluation, { flag: 'beta', enabled: true, evaluatedAt: new Date(Date.UTC(2026, 9, 13)) })))
    // SAFETY: deliberately breaks the declared shape at runtime to check the response fails.
    .get('/api/broken', action(json(Evaluation, { flag: 'beta', enabled: 'yes' } as never)))
    .get('/page', action(Effect.fail(new HttpError({ status: 409, message: 'Taken' }))))
    .get('/api/orders', action(json(S.Struct({ version: S.Number }), { version: 7 }, { etag: 'orders-7' })))
    .post('/api/limited', action(httpError(429, 'Slow down.', S.Struct({ retryAfter: S.Number }), { retryAfter: 30 }, {
      headers: { 'Retry-After': '30' },
    })))
    .post('/api/sales', action(httpError(409, 'Some lines are short of stock.', ShortOfStock, {
      lines: [{ sku: 'A-1', available: 2 }],
      checkedAt: new Date(Date.UTC(2026, 9, 13)),
    })))

  return app
}

describe('json(Schema, value)', () => {
  test('encodes the value through the schema, and readJson decodes it back', async () => {
    const res = await createApp().request('/api/flags')

    expect(await res.clone().json()).toEqual({ flag: 'beta', enabled: true, evaluatedAt: '2026-10-13T00:00:00.000Z' })
    expect(await readJson(res, Evaluation)).toEqual({
      flag: 'beta',
      enabled: true,
      evaluatedAt: new Date(Date.UTC(2026, 9, 13)),
    })
  })

  test('a value that does not match its schema is a server error', async () => {
    const res = await createApp().request('/api/broken', { headers: { Accept: 'application/json' } })

    expect(res.status).toBe(500)
  })
})

describe('readError', () => {
  test('says how to get the JSON envelope when the response is HTML', async () => {
    const res = await createApp().request('/page', { headers: { Accept: 'text/html' } })

    await expect(readError(res)).rejects.toThrow('sends Accept: application/json, gets the JSON envelope.')
  })
})

describe('httpError(status, message, Schema, body)', () => {
  test('encodes the body through its schema, which the test and a client decode', async () => {
    const res = await createApp().request('/api/sales', { method: 'POST', headers: { Accept: '*/*' } })
    const expected = { lines: [{ sku: 'A-1', available: 2 }], checkedAt: new Date(Date.UTC(2026, 9, 13)) }

    expect(res.status).toBe(409)
    expect((await readError(res.clone(), ShortOfStock)).body).toEqual(expected)
    expect(S.decodeUnknownSync(errorResponseWith(ShortOfStock))(await res.json()).body).toEqual(expected)
  })

  test('readError rejects a body that does not match the schema', async () => {
    const res = await createApp().request('/api/sales', { method: 'POST', headers: { Accept: '*/*' } })

    await expect(readError(res, S.Struct({ total: S.Number }))).rejects.toThrow('does not match the envelope')
  })
})

describe('httpError headers', () => {
  test('carries headers beside a typed body', async () => {
    const res = await createApp().request('/api/limited', { method: 'POST', headers: { Accept: '*/*' } })

    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('30')
    expect((await readError(res, S.Struct({ retryAfter: S.Number }))).body).toEqual({ retryAfter: 30 })
  })
})

describe('ifChanged', () => {
  test('answers 304 without building the body when the client has the version', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })
    let builds = 0

    routes.get('/api/kitchen', action(ifChanged('orders-7', Effect.gen(function* () {
      builds += 1

      return yield* json({ orders: [] })
    }))))

    const first = await app.request('/api/kitchen')
    const again = await app.request('/api/kitchen', { headers: { 'If-None-Match': '"orders-7"' } })

    expect(first.headers.get('ETag')).toBe('"orders-7"')
    expect(again.status).toBe(304)
    expect(builds).toBe(1)
  })
})

describe('json etag', () => {
  test('answers a request that already has this version with 304 and no body', async () => {
    const app = createApp()
    const first = await app.request('/api/orders')
    const again = await app.request('/api/orders', { headers: { 'If-None-Match': first.headers.get('ETag') ?? '' } })
    const stale = await app.request('/api/orders', { headers: { 'If-None-Match': '"orders-6"' } })

    expect(first.status).toBe(200)
    expect(first.headers.get('ETag')).toBe('"orders-7"')
    expect(again.status).toBe(304)
    expect(await again.text()).toBe('')
    expect(again.headers.get('ETag')).toBe('"orders-7"')
    expect(stale.status).toBe(200)
  })
})
