/**
 * A signed-in visitor on a page for guests goes to setupWeb's auth.homePath.
 */

import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { createGuestLayer, RequireGuestLayer } from '../src/effect/auth.js'
import { render } from '../src/effect/responses.js'
import { signedIn, testEnv } from '../src/testing.js'

function createApp(homePath?: string) {
  const app = new Hono()
  const { routes } = setupWeb(app, {
    version: '1',
    render: (page) => JSON.stringify(page),
    auth: homePath === undefined ? {} : { homePath },
  })

  routes.provide(RequireGuestLayer).get('/login', action(render('Auth/Login')))
  routes.provide(createGuestLayer(() => false)).get('/register', action(render('Auth/Register')))
  routes.provide(createGuestLayer(() => false, '/welcome')).get('/invite', action(render('Auth/Invite')))

  return app
}

const signedInVisit = (app: Hono, path: string) =>
  app.request(path, { headers: { 'X-Inertia': 'true' } }, testEnv(signedIn({ id: 'user-1' })))

describe('guest pages', () => {
  test("send a signed-in visitor to setupWeb's auth.homePath", async () => {
    const app = createApp('/dashboard')

    expect((await signedInVisit(app, '/login')).headers.get('Location')).toBe('/dashboard')
    expect((await signedInVisit(app, '/register')).headers.get('Location')).toBe('/dashboard')
    expect((await signedInVisit(app, '/invite')).headers.get('Location')).toBe('/welcome')
  })

  test('send a signed-in visitor home without one', async () => {
    expect((await signedInVisit(createApp(), '/login')).headers.get('Location')).toBe('/')
  })
})
