/**
 * Machines 18 and 32: a stack composed by hand, and layers composed with
 * Layer.merge. What a middleware after effectBridge gives the request reaches
 * the action, a flash with no web() fails where it is set, and every
 * shareProps a route is given runs, however its layers were composed.
 */
import { describe, expect, test } from 'bun:test'
import { Effect, Layer, Schema as S } from 'effect'
import { Hono } from 'hono'
import { action } from '../../src/effect/action.js'
import { currentUser, loadUser } from '../../src/effect/auth.js'
import { effectBridge } from '../../src/effect/bridge.js'
import { EffectErrorObserverService } from '../../src/effect/error-observer.js'
import { flash, json, render, shareProps } from '../../src/effect/responses.js'
import { effectRoutes } from '../../src/effect/routing.js'
import { web } from '../../src/middleware.js'
import type { WebDeclaration } from '../../src/effect/register.js'
import { webServices } from '../../src/request-context.js'
import { setupWeb } from '../../src/setup.js'
import { testEnv } from '../../src/testing.js'

declare module '../../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{ auth: typeof signedInAuth }>
  }
}

const config = { version: '1', render: (page: unknown) => JSON.stringify(page) }
const api = { headers: { Accept: 'application/json' } }

/** A Better Auth whose session lookup finds Ada. */
const signedInAuth = {
  api: {
    getSession: async () => ({
      user: { id: 'user-1', email: 'ada@example.com', name: 'Ada', emailVerified: true, image: null, createdAt: new Date(0), updatedAt: new Date(0) },
      session: { id: 'session-1', userId: 'user-1', expiresAt: new Date(4102444800000), token: 'test-token', createdAt: new Date(0), updatedAt: new Date(0) },
    }),
  },
}

describe('a stack composed by hand', () => {
  test('M18.T23: a user loadUser finds after effectBridge reaches the action', async () => {
    const app = new Hono()

    app.use('*', web(config))
    app.use('*', webServices(() => ({ auth: signedInAuth })))
    app.use('*', effectBridge())
    app.use('*', loadUser())
    effectRoutes(app).get('/me', action(Effect.flatMap(currentUser, (viewer) => json({ signedIn: viewer !== null && viewer !== undefined }))))

    expect(await (await app.request('/me', api)).json()).toEqual({ signedIn: true })
  })

  test('M18.T25: a flash value set where web() runs after effectBridge reaches the response', async () => {
    const app = new Hono()

    app.use('*', effectBridge())
    app.use('*', web(config))
    effectRoutes(app).post('/save', action(Effect.andThen(flash('success', 'Saved.'), json({ ok: true }))))

    const res = await app.request('/save', { method: 'POST', ...api })

    expect(res.headers.getSetCookie().join()).toContain('popweb-flash')
  })

  test('M18.T25: a flash value with no web() fails where it is set, saying why, rather than vanishing', async () => {
    const observed: string[] = []
    const app = new Hono()

    app.use('*', effectBridge({ services: () => Layer.succeed(EffectErrorObserverService, { observe: (event) => Effect.sync(() => void observed.push(String(event.error))) }) }))
    effectRoutes(app).post('/save', action(Effect.andThen(flash('success', 'Saved.'), json({ ok: true }))))

    expect((await app.request('/save', { method: 'POST', ...api })).status).toBe(500)
    expect(observed.join()).toContain('has no flash cookie to go in')
  })
})

describe('shareProps', () => {
  test('M32.T8: two given in one Layer.merge both run', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, { ...config, shared: S.Struct({ unread: S.Number, since: S.Date }) })

    routes
      .provide(Layer.merge(shareProps(Effect.succeed({ unread: 3 })), shareProps(Effect.succeed({ since: new Date(Date.UTC(2026, 9, 13)) }))))
      .get('/inbox', action(render('Inbox')))

    const res = await app.request('/inbox', { headers: { 'X-Inertia': 'true', 'X-Inertia-Version': '1' } }, testEnv({}))

    expect((await res.json()).props).toMatchObject({ unread: 3, since: '2026-10-13T00:00:00.000Z' })
  })
})

