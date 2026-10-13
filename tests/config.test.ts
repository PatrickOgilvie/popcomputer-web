/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Configuration Tests
 *
 * Effect `Config` reads the Worker's bindings: in application services,
 * built once, in request services, and in actions. A missing binding fails
 * the request with a configuration error naming it.
 */

import { describe, expect, test } from 'bun:test'
import { Config, Context, Effect, Layer, Redacted } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { json } from '../src/effect/responses.js'
import { config } from '../src/effect/config.js'
import { testEnv } from '../src/testing.js'

class Settings extends Context.Service<Settings, { readonly baseUrl: string }>()('test/Settings') {}
class Region extends Context.Service<Region, { readonly name: string }>()('test/Region') {}

type Env = {
  Bindings: { readonly BASE_URL?: string; readonly REGION?: string; readonly API_KEY?: string; readonly ENVIRONMENT?: string }
}

function createApp() {
  const builds = { app: 0 }
  const app = new Hono<Env>()

  const { routes } = setupWeb(app, {
    version: '1',
    render: (page) => JSON.stringify(page),
  }).services({
    app: Layer.effect(Settings, Effect.gen(function* () {
      builds.app += 1

      return Settings.of({ baseUrl: yield* Config.String('BASE_URL') })
    })),
    request: () => Layer.effect(Region, Effect.map(Config.String('REGION'), (name) => Region.of({ name }))),
  })

  routes
    .get('/settings', action(Effect.gen(function* () {
      const settings = yield* Settings
      const region = yield* Region

      return yield* json({ baseUrl: settings.baseUrl, region: region.name })
    })))
    .get('/key', action(Effect.gen(function* () {
      const key = yield* Config.Redacted('API_KEY')

      return yield* json({ length: Redacted.value(key).length })
    })))

  return { app, builds }
}

const bindings = { BASE_URL: 'https://example.com', REGION: 'weur', API_KEY: 'secret' }
const api = { headers: { Accept: 'application/json' } }

describe('Config from bindings', () => {
  test('application and request services read bindings', async () => {
    const { app } = createApp()
    const res = await app.request('/settings', api, testEnv(Layer.empty, bindings))

    expect(await res.json()).toEqual({ baseUrl: 'https://example.com', region: 'weur' })
  })

  test('actions read bindings', async () => {
    const { app } = createApp()
    const res = await app.request('/key', api, testEnv(Layer.empty, bindings))

    expect(await res.json()).toEqual({ length: 6 })
  })

  test('application services are built once per isolate', async () => {
    const { app, builds } = createApp()

    await app.request('/settings', api, testEnv(Layer.empty, bindings))
    await app.request('/settings', api, testEnv(Layer.empty, bindings))

    expect(builds.app).toBe(1)
  })

  test('a failed application service build is retried by the next request', async () => {
    const { app, builds } = createApp()

    const missing = await app.request('/settings', api, testEnv(Layer.empty, { REGION: 'weur' }))
    const configured = await app.request('/settings', api, testEnv(Layer.empty, bindings))

    expect(missing.status).toBe(500)
    expect(await configured.json()).toEqual({ baseUrl: 'https://example.com', region: 'weur' })
    expect(builds.app).toBe(2)
  })

  test('a missing binding is a configuration error, named outside production', async () => {
    const { app } = createApp()
    const missingRegion = { BASE_URL: 'https://example.com' }

    const development = await app.request('/settings', api, testEnv(Layer.empty, { ...missingRegion, ENVIRONMENT: 'development' }))
    const test = await app.request('/settings', api, testEnv(Layer.empty, missingRegion))
    const production = await app.request('/settings', api, testEnv(Layer.empty, { ...missingRegion, ENVIRONMENT: 'production' }))

    expect(development.status).toBe(500)
    expect(await development.json()).toMatchObject({ code: 'WEB_CFG_305_INVALID_CONFIG', message: expect.stringContaining('REGION') })
    expect(await test.json()).toMatchObject({ message: expect.stringContaining('REGION') })
    expect(await production.json()).toMatchObject({ code: 'WEB_CFG_305_INVALID_CONFIG', message: expect.not.stringContaining('REGION') })
  })
})

describe('config', () => {
  test('reads the vars and secrets the request\'s bindings hold', async () => {
    const app = new Hono<Env>()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

    routes.get('/settings', action(Effect.gen(function* () {
      const region = yield* config.string('REGION')
      const key = yield* config.redacted('API_KEY')

      return yield* json({ region, keyLength: Redacted.value(key).length })
    })))

    const res = await app.request('/settings', {}, testEnv(Layer.empty, { REGION: 'weur', API_KEY: 'secret' }))

    expect(await res.json()).toEqual({ region: 'weur', keyLength: 6 })
  })
})
