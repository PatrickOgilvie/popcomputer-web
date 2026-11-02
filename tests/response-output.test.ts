/**
 * What a response carries beside its body: the cookies and headers the
 * request queued, written once, whether a route finished the response or
 * web() did, and an Inertia visit's redirect that keeps its cookies.
 */

import { describe, expect, test } from 'bun:test'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { cookie } from '../src/effect/cookies.js'
import { responseHeader } from '../src/effect/response-headers.js'
import { json } from '../src/effect/responses.js'

const theme = cookie('theme', S.String)

function createApp() {
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

  routes
    .get('/settings', action(Effect.gen(function* () {
      yield* theme.set('dark')
      yield* responseHeader('X-Served-By', 'settings')

      return yield* json({ saved: true })
    })))
    // A redirect a form gets, as Better Auth's handler or an OAuth start answers one, with a cookie of its own.
    .post('/connect', action(Effect.succeed(new Response(null, {
      status: 302,
      headers: { Location: '/connected', 'Set-Cookie': 'oauth_state=abc; Path=/; HttpOnly' },
    }))))

  return app
}

describe('a response', () => {
  test("carries each cookie and header its route queued once, though web() finishes what the route didn't", async () => {
    const res = await createApp().request('/settings')

    expect(res.headers.getSetCookie().filter((setCookie) => setCookie.startsWith('theme='))).toHaveLength(1)
    expect(res.headers.get('X-Served-By')).toBe('settings')
  })

  test("to an Inertia form's 302 is a 303, which keeps the redirect's own cookies", async () => {
    const res = await createApp().request('/connect', {
      method: 'POST',
      headers: { 'X-Inertia': 'true', 'X-Inertia-Version': '1', Origin: 'http://localhost' },
    })

    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/connected')
    expect(res.headers.getSetCookie()).toContain('oauth_state=abc; Path=/; HttpOnly')
  })
})
