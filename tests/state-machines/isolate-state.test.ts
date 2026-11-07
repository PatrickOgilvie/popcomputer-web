/**
 * Machines 37 and 40: what an isolate
 * keeps between requests, the application's services and the env check.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Context, Effect, Layer, Schema as S } from 'effect'
import { Hono } from 'hono'
import { action } from '../../src/effect/action.js'
import { json, render } from '../../src/effect/responses.js'
import { defineEnv, variable } from '../../src/env.js'
import { PAGE_CACHE_HEADER } from '../../src/page-cache.js'
import { setupWeb } from '../../src/setup.js'
import { testEnv } from '../../src/testing.js'

class Settings extends Context.Service<Settings, { readonly built: number }>()('test/Settings') {}

const api = { headers: { Accept: 'application/json' } }

describe('application services', () => {
  function appFailingOnce(failure: Effect.Effect<never>) {
    const app = new Hono()
    const builds = { count: 0 }
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) }).services({
      app: Layer.effect(Settings, Effect.suspend(() => {
        builds.count += 1

        return builds.count === 1 ? failure : Effect.succeed(Settings.of({ built: builds.count }))
      })),
    })

    routes.get('/', action(Effect.gen(function* () {
      const settings = yield* Settings

      return yield* json({ built: settings.built })
    })))

    return { app, builds }
  }

  test('M37.T10, T16: a defect while building is not kept, so the next request builds again', async () => {
    const { app, builds } = appFailingOnce(Effect.die(new Error('the first build died')))

    const first = await app.request('/', api, testEnv(Layer.empty, {}))
    const second = await app.request('/', api, testEnv(Layer.empty, {}))
    const third = await app.request('/', api, testEnv(Layer.empty, {}))

    expect([first.status, second.status, third.status]).toEqual([500, 200, 200])
    expect(builds.count).toBe(2)
  })

  test('M37.T11: nor is a build that interrupted itself', async () => {
    const { app, builds } = appFailingOnce(Effect.interrupt)

    await app.request('/', api, testEnv(Layer.empty, {}))
    const second = await app.request('/', api, testEnv(Layer.empty, {}))

    expect(second.status).toBe(200)
    expect(builds.count).toBe(2)
  })
})

describe('the env check', () => {
  const page = { headers: { Accept: 'text/html' } }
  let stored: Map<string, Response>

  beforeEach(() => {
    stored = new Map()
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: {
        default: {
          match: (request: Request) => Promise.resolve(stored.get(request.url)?.clone()),
          put: (request: Request, response: Response) => response.arrayBuffer().then((body) => {
            stored.set(request.url, new Response(body, response))
          }),
        },
      },
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'caches')
  })

  function appDeclaring(names: readonly string[], onCheck: () => void = () => {}) {
    const app = new Hono()
    const entries = Object.fromEntries(names.map((name) => [name, variable(S.String.check(S.makeFilter(() => {
      onCheck()

      return true
    })))]))
    const { routes } = setupWeb(app, { version: '1', render: (shown) => `<html>${JSON.stringify(shown)}</html>`, env: defineEnv(entries) })

    routes.get('/', action(render('Home', {})))

    return app
  }

  test('M40.T5: an isolate checks a bindings object once, page cache or not', async () => {
    let checks = 0
    const app = appDeclaring(['NAME'], () => {
      checks += 1
    })
    const bindings = { NAME: 'a' }

    await app.request('/a', page, bindings)
    await app.request('/b', page, bindings)
    await app.request('/c', page, bindings)

    expect(checks).toBe(1)
  })

  test('M40.T7: an application checks the bindings against its own declaration', async () => {
    const bindings = { NAME: 'a' }

    expect((await appDeclaring(['NAME']).request('/', api, bindings)).status).toBe(200)
    expect((await appDeclaring(['NAME', 'MISSING']).request('/', api, bindings)).status).toBe(500)
  })

  test("M40.T8: another application's refusal is not this one's", async () => {
    const bindings = { NAME: 'a' }

    expect((await appDeclaring(['NAME', 'MISSING']).request('/', api, bindings)).status).toBe(500)
    expect((await appDeclaring(['NAME']).request('/', api, bindings)).status).toBe(200)
  })

  test('M40.T11: a cached page does not get past a refused env', async () => {
    const app = appDeclaring(['NAME'])

    const first = await app.request('/', page, { NAME: 'a' })

    expect(first.status).toBe(200)
    await first.text()
    expect(stored.size).toBe(1)
    expect((await app.request('/', page, { NAME: 'a' })).headers.get(PAGE_CACHE_HEADER)).toBe('HIT')
    expect((await app.request('/', page, {})).status).toBe(500)
  })
})
