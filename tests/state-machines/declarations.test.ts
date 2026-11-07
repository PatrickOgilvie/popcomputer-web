/**
 * Machines 38, 39, 43 and 44: what an application declares once, before it
 * serves. A builder whose result was dropped, a registration after the first
 * request, a path registered twice through another registry and a second
 * setupWeb are refused, and the route table never lists a route Hono lacks.
 */
import { describe, expect, test } from 'bun:test'
import { Effect, Layer, Schema as S } from 'effect'
import { Hono } from 'hono'
import { action, form } from '../../src/effect/action.js'
import { effectBridge } from '../../src/effect/bridge.js'
import { ForbiddenError } from '../../src/effect/errors.js'
import { guard } from '../../src/effect/guard.js'
import { RequireAuthLayer } from '../../src/effect/auth.js'
import { json } from '../../src/effect/responses.js'
import { RouteRegistry } from '../../src/effect/route-registry.js'
import { effectRoutes } from '../../src/effect/routing.js'
import { web } from '../../src/middleware.js'
import { setupWeb } from '../../src/setup.js'
import { testEnv } from '../../src/testing.js'

const api = { headers: { Accept: 'application/json' } }
const config = { version: '1', render: (page: unknown) => JSON.stringify(page) }
const ok = action(json({ ok: true }))
const setUp = () => {
  const app = new Hono()

  return { app, routes: setupWeb(app, config).routes }
}

type Routes = ReturnType<typeof setUp>['routes']

const Deny = guard(Effect.fail(new ForbiddenError({ message: 'No.' })))

describe('a builder whose result was dropped', () => {
  for (const [row, drop] of [
    ['M38.T2', (routes: Routes) => void routes.provide(Deny)],
    ['M38.T4', (routes: Routes) => void routes.middleware(async (_c, next) => next())],
    ['M38.T6', (routes: Routes) => void routes.prefix('/api')],
    ['M38.T8', (routes: Routes) => void routes.jsonApi()],
  ] as const) {
    test(`${row}: makes every request answer a configuration error naming it`, async () => {
      const { app, routes } = setUp()

      drop(routes)
      routes.get('/open', ok)

      const res = await app.request('/open', api, testEnv({}))

      expect(res.status).toBe(500)
      expect(JSON.stringify(await res.json())).toContain('nothing registered a route on')
    })
  }

  test('M38.T2: a dropped RequireAuthLayer too', async () => {
    const { app, routes } = setUp()

    void routes.provide(RequireAuthLayer)
    routes.get('/open', ok)

    expect((await app.request('/open', api, testEnv({}))).status).toBe(500)
  })

  test('M38.T2: inside group too', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, config)

    routes.group((route) => {
      void route.provide(Deny)
      route.get('/open', ok)
    })

    expect((await app.request('/open', api, testEnv({}))).status).toBe(500)
  })

  test('a builder kept and registered on, or used for a job, is no mistake', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, config)
    const denied = routes.provide(Deny)

    denied.get('/denied', ok)
    routes.prefix('/api').jsonApi().get('/api/open', ok)
    void routes.provide(Layer.empty).queue(S.Struct({ id: S.String }), () => Effect.void)
    // Kept for a job's services, which runs only later.
    void routes.provide(Layer.empty)

    expect((await app.request('/api/open', api, testEnv({}))).status).toBe(200)
    expect((await app.request('/denied', api, testEnv({}))).status).toBe(403)
  })
})

describe('the route table', () => {
  test('M38.T13: prefixMiddleware after a route under its prefix is refused', () => {
    const app = new Hono()
    const { routes } = setupWeb(app, config)
    const apiRoutes = routes.prefix('/api')

    apiRoutes.get('/api/early', ok)

    expect(() => apiRoutes.prefixMiddleware(async (_c, next) => next())).toThrow('/api/early')
  })

  test('M38.T13: and at the root, or at the prefix itself', () => {
    const { routes } = setUp()

    routes.get('/anywhere', ok)

    expect(() => routes.prefixMiddleware(async (_c, next) => next())).toThrow('/anywhere')

    const apiRoutes = setUp().routes.prefix('/api')

    apiRoutes.get('/api', ok)

    expect(() => apiRoutes.prefixMiddleware(async (_c, next) => next())).toThrow("prefixMiddleware on '/api'")
  })

  test('a name registered twice is refused before Hono takes the route', async () => {
    const { app, routes } = setUp()

    routes.get('/first', ok, { name: 'home' })

    expect(() => routes.get('/second', ok, { name: 'home' })).toThrow("Duplicate route name 'home'")
    expect((await app.request('/second', api, testEnv({}))).status).toBe(404)
  })

  test('M39.T6: a path registered through another registry is refused, as through the same one', () => {
    const app = new Hono()

    app.use('*', web(config))
    app.use('*', effectBridge())
    effectRoutes(app).get('/dup', ok)

    expect(() => effectRoutes(app, { registry: new RouteRegistry() }).get('/dup', ok)).toThrow('registered twice')
  })

  test('M39.T9, T11: a route registered after the first request is refused before it changes anything', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, config)

    routes.get('/one', ok, { name: 'one' })
    await app.request('/one', api, testEnv({}))

    expect(() => routes.get('/two', ok, { name: 'two' })).toThrow('after the application served its first request')
    expect(routes.getRegistry().has('/two')).toBe(false)
    expect(routes.getRegistry().count()).toBe(1)
  })

  test('M43.T4: the page a form goes back to is looked up once, when there is none', async () => {
    let lookups = 0
    const registry = new (class extends RouteRegistry {
      override formPageOf(route: Parameters<RouteRegistry['formPageOf']>[0]) {
        lookups += 1

        return super.formPageOf(route)
      }
    })()
    const app = new Hono()

    app.use('*', web(config))
    app.use('*', effectBridge())
    effectRoutes(app, { registry }).post('/none', ok)

    for (let index = 0; index < 3; index += 1) await app.request('/none', { method: 'POST', ...api })

    expect(lookups).toBe(1)
  })

  test('M43.T5: a failed form goes to no page a refused registration left behind', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, config)

    routes.post('/a', action(form(S.Struct({ name: S.NonEmptyString })), () => json({ ok: true })))
    await app.request('/a', { method: 'POST', body: new URLSearchParams({ name: '' }) }, testEnv({}))

    expect(() => routes.get('/a', ok)).toThrow()

    const res = await app.request('/a', { method: 'POST', body: new URLSearchParams({ name: '' }) }, testEnv({}))

    expect(res.headers.get('Location')).toBe('/')
  })
})

describe('setupWeb', () => {
  test('M44.T9: refuses an app whose routes were registered before it, unchecked against its bindings', () => {
    const app = new Hono()

    effectRoutes(app).get('/early', ok)

    expect(() => setupWeb(app, config)).toThrow('before setupWeb, unchecked against the bindings')
  })

  test('M44.T10: refuses a second setupWeb on one app', () => {
    const app = new Hono()

    setupWeb(app, config)

    expect(() => setupWeb(app, config)).toThrow('setupWeb was called on this app already')
  })
})
