import { describe, expect, test } from 'bun:test'
import { Effect, Layer, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../../src/setup.js'
import { action } from '../../src/effect/action.js'
import { authorize } from '../../src/effect/services.js'
import { json } from '../../src/effect/responses.js'
import { validateRequest } from '../../src/effect/validation.js'
import { wantsJson } from '../../src/effect/negotiation.js'
import { readError, testEnv } from '../../src/testing.js'

const headers = (values: Record<string, string>) => (name: string) =>
  Object.entries(values).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]

describe('wantsJson', () => {
  test.each([
    ['an Inertia visit', { 'X-Inertia': 'true', Accept: 'text/html, application/xhtml+xml' }, false],
    ['a browser visit', { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }, false],
    ['a request asking for JSON', { Accept: 'application/json' }, true],
    ['a request sending JSON', { 'Content-Type': 'application/json' }, true],
    ['fetch with its default Accept', { Accept: '*/*' }, true],
    ['an API client authenticating with a bearer token', { Authorization: 'Bearer key' }, true],
    ['a bearer request asking for HTML', { Authorization: 'Bearer key', Accept: 'text/html' }, false],
    ['a request with neither', {}, false],
  ])('%s', (_name, values, expected) => {
    expect(wantsJson(headers(values))).toBe(expected)
  })
})

describe('an API route answers clients that do not ask for JSON with JSON', () => {
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

  routes
    .get('/api/flags', action(Effect.gen(function* () {
      const { environment } = yield* validateRequest(S.Struct({ environment: S.NonEmptyString }))

      return yield* json({ environment })
    })))
    .get('/api/me', action(Effect.gen(function* () {
      const auth = yield* authorize()

      return yield* json({ id: auth.user.id })
    })))

  const env = testEnv(Layer.empty)

  test('invalid input from fetch is a 422 with the field errors', async () => {
    const res = await app.request('/api/flags', { headers: { Accept: '*/*' } }, env)

    expect(res.status).toBe(422)
    expect(res.headers.get('Content-Type')).toContain('application/json')
    expect(JSON.stringify(await res.json())).toContain('environment')
  })

  test('a bearer request that is not signed in is a 401, not a redirect to sign in', async () => {
    const res = await app.request('/api/me', { headers: { Authorization: 'Bearer revoked' } }, env)

    expect(res.status).toBe(401)
    expect(res.headers.get('Content-Type')).toContain('application/json')
  })

  test('a browser visit still goes to sign in', async () => {
    const res = await app.request('/api/me', { headers: { Accept: 'text/html' } }, env)

    expect(res.status).toBe(302)
  })
})

describe('routes.jsonApi()', () => {
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })
  const api = routes.prefix('/api/v1').jsonApi()

  api
    .get('/me', action(Effect.gen(function* () {
      const auth = yield* authorize()

      return yield* json({ id: auth.user.id })
    })))
    .post('/counts', action(Effect.gen(function* () {
      const input = yield* validateRequest(S.Struct({ sku: S.NonEmptyString }))

      return yield* json(input)
    })))
  routes.get('/account', action(Effect.gen(function* () {
    const auth = yield* authorize()

    return yield* json({ id: auth.user.id })
  })))

  const env = testEnv(Layer.empty)

  test('answers a request with no Accept or Authorization header as a JSON client', async () => {
    const signedOut = await app.request('/api/v1/me', {}, env)
    const invalid = await app.request('/api/v1/counts', { method: 'POST', body: new URLSearchParams('sku=') }, env)

    expect(signedOut.status).toBe(401)
    expect(signedOut.headers.get('Content-Type')).toContain('application/json')
    expect(signedOut.headers.get('WWW-Authenticate')).toBe('Bearer')
    expect(invalid.status).toBe(422)
    expect((await readError(invalid)).errors).toHaveProperty('sku')
  })

  test('leaves the other routes as they were', async () => {
    const res = await app.request('/account', {}, env)

    expect(res.status).toBe(302)
  })
})
