/**
 * Headers an action or a guard layer adds to whatever response the request
 * ends with, and OPTIONS routes answered with no content.
 */

import { describe, expect, test } from 'bun:test'
import { Effect, Layer } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../../src/setup.js'
import { action } from '../../src/effect/action.js'
import { json, noContent, notFound } from '../../src/effect/responses.js'
import { responseHeader } from '../../src/effect/response-headers.js'
import { testBrowser } from '../../src/testing.js'

// Every answer of v1, success or failure, says it is deprecated.
const DeprecatedVersion = Layer.effectDiscard(responseHeader('Deprecation', 'true'))

function createApp() {
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })
  const v1 = routes.jsonApi().provide(DeprecatedVersion)

  v1
    .get('/api/v1/places', action(json({ places: [] })))
    .get('/api/v1/places/missing', action(notFound('Place')))
  routes.options('/api/v1/places', action(noContent({
    'Access-Control-Allow-Origin': 'https://maps.example',
    'Access-Control-Allow-Methods': 'GET',
  })))

  return app
}

describe('responseHeader', () => {
  test('a guard layer marks every response of its routes, failures included', async () => {
    const app = createApp()
    const listed = await app.request('/api/v1/places')
    const missing = await app.request('/api/v1/places/missing')

    expect(listed.headers.get('Deprecation')).toBe('true')
    expect(missing.status).toBe(404)
    expect(missing.headers.get('Deprecation')).toBe('true')
  })
})

describe('routes.options and noContent', () => {
  test('answer a preflight with headers and no body or content type', async () => {
    const res = await createApp().request('/api/v1/places', { method: 'OPTIONS', headers: { Origin: 'https://maps.example' } })

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://maps.example')
    expect(res.headers.get('Content-Type')).toBeNull()
    expect(await res.text()).toBe('')
  })
})

describe('testBrowser.follow', () => {
  test('refuses a response another browser received', async () => {
    const app = createApp()
    const foreign = await app.request('/api/v1/places')

    expect(() => testBrowser(app).follow(foreign)).toThrow('browser.follow takes a response this browser received')
  })
})
