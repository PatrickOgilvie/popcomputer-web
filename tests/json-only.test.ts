/**
 * An application whose setupWeb has no render template answers only JSON,
 * as an API does.
 */

import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { json, render } from '../src/effect/responses.js'

function createApp() {
  const app = new Hono()
  const { routes } = setupWeb(app, {})

  routes
    .get('/api/status', action(json({ ok: true })))
    .get('/page', action(render('Home')))

  return app
}

const browser = { Accept: 'text/html' }

describe('an application without render', () => {
  test('answers its routes', async () => {
    expect(await (await createApp().request('/api/status')).json()).toEqual({ ok: true })
  })

  test('answers an unknown path with the JSON error envelope, whatever the client asks for', async () => {
    const res = await createApp().request('/nowhere', { headers: browser })

    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toContain('application/json')
    expect(await res.json()).toMatchObject({ tag: 'NotFoundError', httpStatus: 404 })
  })

  test('refuses to render a page, naming what to give setupWeb', async () => {
    const res = await createApp().request('/page', { headers: browser }, { ENVIRONMENT: 'development' })
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(JSON.stringify(body)).toContain("setupWeb has no render")
  })
})
