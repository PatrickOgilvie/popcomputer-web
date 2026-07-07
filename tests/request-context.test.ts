/**
 * Request Context Seam Tests
 *
 * Framework per-request state (db, auth, authUser, honertia instance, Effect
 * runtime wiring) lives in one typed HonertiaRequestContext, written by
 * framework middleware and readable from plain Hono middleware via
 * honertiaContext(c). honertiaServices() is the public wiring middleware for
 * apps not using setupHonertia.
 */

import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { Effect } from 'effect'
import {
  honertiaServices,
  honertiaContext,
} from '../src/request-context.js'
import { honertia } from '../src/middleware.js'
import { effectBridge } from '../src/effect/bridge.js'
import { effectRoutes } from '../src/effect/routing.js'
import { DatabaseService } from '../src/effect/services.js'

describe('honertiaServices + honertiaContext', () => {
  test('services provided by honertiaServices are readable in later middleware', async () => {
    const app = new Hono()
    const db = { name: 'test-db' }
    const auth = { name: 'test-auth' }

    app.use('*', honertiaServices(() => ({ db, auth })))

    app.get('/inspect', (c) => {
      const ctx = honertiaContext(c)
      return c.json({
        db: (ctx.db as { name: string } | undefined)?.name ?? null,
        auth: (ctx.auth as { name: string } | undefined)?.name ?? null,
      })
    })

    const res = await app.request('/inspect')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ db: 'test-db', auth: 'test-auth' })
  })

  test('fields are absent when nothing configured them', async () => {
    const app = new Hono()

    app.get('/inspect', (c) => {
      const ctx = honertiaContext(c)
      return c.json({
        db: ctx.db === undefined,
        auth: ctx.auth === undefined,
        authUser: ctx.authUser === undefined,
        honertia: ctx.honertia === undefined,
      })
    })

    const res = await app.request('/inspect')
    expect(await res.json()).toEqual({
      db: true,
      auth: true,
      authUser: true,
      honertia: true,
    })
  })

  test('DatabaseService in an effect route resolves to the provided db', async () => {
    const app = new Hono()
    app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
    app.use('*', honertiaServices(() => ({ db: { name: 'holder-db' } as never })))
    app.use('*', effectBridge())

    effectRoutes(app).get(
      '/db-name',
      Effect.gen(function* () {
        const db = yield* DatabaseService
        return new Response((db as unknown as { name: string }).name)
      })
    )

    const res = await app.request('/db-name')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('holder-db')
  })

  test('a route that does not use DatabaseService works without a configured db', async () => {
    const app = new Hono()
    app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
    app.use('*', effectBridge())

    effectRoutes(app).get('/plain', Effect.succeed(new Response('no db needed')))

    const res = await app.request('/plain')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('no db needed')
  })

  test('the honertia renderer instance is exposed on the context', async () => {
    const app = new Hono()
    app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))

    app.get('/shared', (c) => {
      const instance = honertiaContext(c).honertia
      instance?.share('appName', 'context-test')
      return c.json({ shared: instance?.getShared() ?? null })
    })

    const res = await app.request('/shared')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ shared: { appName: 'context-test' } })
  })

  test('loadUser publishes the authenticated user on the context', async () => {
    const { loadUser } = await import('../src/effect/auth.js')
    const app = new Hono()

    const fakeAuth = {
      api: {
        getSession: async () => ({
          user: { id: 'user-1', name: 'Ada' },
          session: { id: 'session-1' },
        }),
      },
    }

    app.use('*', honertiaServices(() => ({ auth: fakeAuth as never })))
    app.use('*', loadUser())

    app.get('/whoami', (c) => {
      const { authUser } = honertiaContext(c)
      return c.json({ userId: (authUser?.user as { id?: string } | undefined)?.id ?? null })
    })

    const res = await app.request('/whoami')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ userId: 'user-1' })
  })

  test('the auth factory can be built from the db computed in the same provide call', async () => {
    const app = new Hono()

    app.use(
      '*',
      honertiaServices(() => {
        const db = { name: 'db-first' }
        return { db, auth: { name: `auth-over-${db.name}` } }
      })
    )

    app.get('/inspect', (c) => {
      const ctx = honertiaContext(c)
      return c.text((ctx.auth as { name: string }).name)
    })

    const res = await app.request('/inspect')
    expect(await res.text()).toBe('auth-over-db-first')
  })
})
