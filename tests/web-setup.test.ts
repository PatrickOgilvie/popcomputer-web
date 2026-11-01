/**
 * The settings each request reads: setupWeb's, the same value for every
 * request, or for a stack composed by hand, the defaults with what its
 * middleware registered.
 */

import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { setupWeb } from '../src/setup.js'
import { web } from '../src/middleware.js'
import { loadUser } from '../src/effect/auth.js'
import { effectBridge } from '../src/effect/bridge.js'
import { setupOf, webSetup, type WebSetup } from '../src/web-setup.js'

const projects = sqliteTable('projects', { id: text('id').primaryKey() })
const schema = { projects }
const bindings = { project: projects }

describe('webSetup', () => {
  test('fills in every default once', () => {
    const setup = webSetup()

    expect(setup.errors).toEqual({})
    expect(setup.signInPath).toBe('/login')
    expect(setup.homePath).toBe('/')
    expect(setup.bodyLimit).toBe(1024 * 1024)
    expect(setup.sessionCookies.isSession('better-auth.session_token')).toBe(true)
    expect(setup.sessionCookies.isSession('sid')).toBe(false)
    expect(webSetup({ sessionCookie: 'sid' }).sessionCookies.isToken('__Host-sid')).toBe(true)
  })
})

describe('setupOf', () => {
  test("hands every request setupWeb's settings, the same value each time", async () => {
    const app = new Hono()
    setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
      auth: { client: () => ({}), signInPath: '/sign-in', homePath: '/dashboard', sessionCookie: 'sid' },
      bodyLimit: 2048,
      schema,
      bindings,
    })
    const seen: WebSetup[] = []
    app.get('/probe', (c) => {
      seen.push(setupOf(c))

      return c.body(null, 204)
    })

    await app.request('/probe')
    await app.request('/probe')

    expect(seen[0]).toBe(seen[1])
    expect(seen[0]).toMatchObject({ signInPath: '/sign-in', homePath: '/dashboard', bodyLimit: 2048, schema, bindings })
    expect(seen[0]?.sessionCookies.isToken('sid')).toBe(true)
  })

  test('on a stack composed by hand, reads what loadUser and effectBridge registered', async () => {
    const app = new Hono()
    app.use('*', web({ version: '1', render: (page) => JSON.stringify(page) }))
    app.use('*', loadUser({ sessionCookie: 'sid' }))
    app.use('*', effectBridge({ schema, bindings }))
    let seen: WebSetup | undefined
    app.get('/probe', (c) => {
      seen = setupOf(c)

      return c.body(null, 204)
    })

    await app.request('/probe')

    expect(seen).toMatchObject({ signInPath: '/login', homePath: '/', schema, bindings })
    expect(seen?.sessionCookies.isToken('sid')).toBe(true)
  })
})
