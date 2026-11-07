/**
 * Machines 18 and 20: what a request to a route needs known before the
 * route's own middleware runs, and the body every reader reads. Whether it
 * answers JSON and the page its form is on are set before any middleware can
 * fail, and the body's limit is the route's, whoever reads it first.
 */
import { describe, expect, test } from 'bun:test'
import { Effect, Exit, Schema as S } from 'effect'
import { Hono } from 'hono'
import { action, form } from '../../src/effect/action.js'
import { UnauthorizedError, ValidationError } from '../../src/effect/errors.js'
import { json } from '../../src/effect/responses.js'
import { RequestService } from '../../src/effect/services.js'
import { validateRequest } from '../../src/effect/validation.js'
import { setupWeb } from '../../src/setup.js'
import { testEnv } from '../../src/testing.js'

const config = { version: '1', render: (page: unknown) => JSON.stringify(page) }
const ok = action(json({ ok: true }))
const Note = S.Struct({ note: S.String })
const body = JSON.stringify({ note: 'x'.repeat(48) })

describe("a route's facts", () => {
  test('M18.T10: an origin refused on a jsonApi route answers JSON without an Accept header', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, config)

    routes.jsonApi().post('/api/notes', ok)

    const res = await app.request('/api/notes', { method: 'POST', headers: { Origin: 'https://elsewhere.example', 'Content-Type': 'text/plain' }, body: 'x' }, testEnv({}))

    expect(res.status).toBe(403)
    expect(res.headers.get('Content-Type')).toContain('application/json')
  })

  test("M18.T15: route middleware that refuses a jsonApi route's visitor answers 401, not a redirect to sign in", async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, config)

    routes.jsonApi().middleware(() => {
      throw new UnauthorizedError({ message: 'Sign in.' })
    }).get('/api/me', ok)

    const res = await app.request('/api/me', {}, testEnv({}))

    expect(res.status).toBe(401)
    expect(res.headers.get('Content-Type')).toContain('application/json')
  })

  test("M18.T16: route middleware whose form fails goes back to the form's page, as the action's failure does", async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, config)

    routes.get('/notes/new', ok)
    routes.middleware(() => {
      throw new ValidationError({ errors: { note: 'Too long.' } })
    }).post('/notes', action(form(Note, { page: '/notes/new' }), () => json({ ok: true })))

    const res = await app.request('/notes', { method: 'POST', body: new URLSearchParams({ note: 'x' }) }, testEnv({}))

    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/notes/new')
  })
})

describe('the route a request is for, found by its path', () => {
  const foreignPost = () => ({ method: 'POST', headers: { Origin: 'https://elsewhere.example', 'Content-Type': 'text/plain' }, body: 'x' })

  test('M18.T10: is a route registered for every method', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, config)

    routes.jsonApi().all('/api/any', ok)

    const res = await app.request('/api/any', foreignPost(), testEnv({}))

    expect(res.headers.get('Content-Type')).toContain('application/json')
  })

  test("M18.T10: is not another method's route at the same path", async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, config)

    routes.jsonApi().get('/mixed', ok)
    routes.post('/mixed', ok)

    const res = await app.request('/mixed', foreignPost(), testEnv({}))

    expect(res.status).toBe(403)
    expect(res.headers.get('Content-Type')).not.toContain('application/json')
  })
})

describe('the body every reader reads', () => {
  const twoReads = (first: number, second: number) => action(Effect.gen(function* () {
    const one = yield* Effect.exit(validateRequest(Note, { bodyLimit: first }))
    const two = yield* Effect.exit(validateRequest(Note, { bodyLimit: second }))

    return yield* json({ first: Exit.isSuccess(one), second: Exit.isSuccess(two) })
  }))

  test('M20.T10: a second read with a smaller limit is held to it', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, config)

    routes.post('/notes', twoReads(1000, 10))

    const res = await app.request('/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, testEnv({}))

    expect(await res.json()).toEqual({ first: true, second: false })
  })

  test('M20.T11: a first read with a smaller limit leaves the body for one with a larger', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, config)

    routes.post('/notes', twoReads(10, 1000))

    const res = await app.request('/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, testEnv({}))

    expect(await res.json()).toEqual({ first: false, second: true })
  })

  test("M20.T12: a body application middleware read first is held to the route's limit", async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, {
      ...config,
      middleware: [async (c, next) => {
        await c.req.text()
        await next()
      }],
    })

    routes.post('/notes', action(form(Note, { bodyLimit: 10 }), () => json({ ok: true })))

    const res = await app.request('/notes', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body }, testEnv({}))

    expect(res.status).toBe(413)
  })
})

describe('a body application middleware read first', () => {
  const read = {
    text: (c: { req: { text: () => Promise<unknown> } }) => c.req.text(),
    json: (c: { req: { json: () => Promise<unknown> } }) => c.req.json(),
    arrayBuffer: (c: { req: { arrayBuffer: () => Promise<unknown> } }) => c.req.arrayBuffer(),
    blob: (c: { req: { blob: () => Promise<unknown> } }) => c.req.blob(),
  } as const

  const appReading = (kind: keyof typeof read | 'formData', limit: number) => {
    const app = new Hono()
    const { routes } = setupWeb(app, {
      ...config,
      middleware: [async (c, next) => {
        await (kind === 'formData' ? c.req.formData() : read[kind](c))
        await next()
      }],
    })

    routes.post('/notes', action(form(Note, { bodyLimit: limit }), () => json({ ok: true })))

    return app
  }

  for (const kind of ['text', 'json', 'arrayBuffer', 'blob'] as const) {
    test(`M20.T12: as ${kind} is measured as the bytes sent, held to the limit and passed at it`, async () => {
      const request = { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body }

      expect((await appReading(kind, body.length - 1).request('/notes', request, testEnv({}))).status).toBe(413)
      expect((await appReading(kind, body.length).request('/notes', request, testEnv({}))).status).toBe(200)
    })
  }

  test('M20.T12: as form data is held to the limit', async () => {
    const res = await appReading('formData', 10).request('/notes', { method: 'POST', headers: { Accept: 'application/json' }, body: new URLSearchParams({ note: 'x'.repeat(48) }) }, testEnv({}))

    expect(res.status).toBe(413)
  })
})

test('a form field named with [] and sent more than once reaches the action as every value', async () => {
  const app = new Hono()
  const { routes } = setupWeb(app, config)
  const Tags = S.Struct({ tag: S.Array(S.String) })

  routes.post('/tags', action(form(Tags), (input) => json({ tags: input.tag })))

  const res = await app.request('/tags', { method: 'POST', headers: { Accept: 'application/json' }, body: new URLSearchParams([['tag[]', 'a'], ['tag[]', 'b']]) }, testEnv({}))

  expect(await res.json()).toEqual({ tags: ['a', 'b'] })
})

test("RequestService's parseBody gives every value of a field sent more than once", async () => {
  const app = new Hono()
  const { routes } = setupWeb(app, config)

  routes.post('/raw-tags', action(Effect.gen(function* () {
    const request = yield* RequestService
    const fields = yield* Effect.promise(() => request.parseBody())

    return yield* json({ tag: fields.tag })
  })))

  const res = await app.request('/raw-tags', { method: 'POST', headers: { Accept: 'application/json' }, body: new URLSearchParams([['tag', 'a'], ['tag', 'b']]) }, testEnv({}))

  expect(await res.json()).toEqual({ tag: ['a', 'b'] })
})
