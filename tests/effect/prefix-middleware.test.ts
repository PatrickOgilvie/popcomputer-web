/**
 * Prefix-Wide Middleware Tests
 *
 * Builder .middleware() attaches per matched route, so unmatched paths under
 * the same prefix (404s) bypass it. prefixMiddleware() attaches to the whole
 * prefix — matched or not — so cross-cutting response policy (error redaction,
 * envelope shaping, security headers) applies uniformly.
 */

import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { Effect } from 'effect'
import type { MiddlewareHandler } from 'hono'
import { effectRoutes } from '../../src/effect/routing.js'
import { honertia } from '../../src/middleware.js'
import { effectBridge } from '../../src/effect/bridge.js'
import { registerErrorHandlers } from '../../src/setup.js'

const stampResponses: MiddlewareHandler = async (c, next) => {
  await next()
  c.res.headers.set('X-Policy', 'applied')
}

const createApp = () => {
  const app = new Hono()
  app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
  app.use('*', effectBridge())
  registerErrorHandlers(app)
  return app
}

describe('prefixMiddleware', () => {
  test('runs for matched routes under the prefix', async () => {
    const app = createApp()

    effectRoutes(app)
      .prefix('/api')
      .prefixMiddleware(stampResponses)
      .group((route) => {
        route.get('/status', Effect.succeed(new Response('ok')))
      })

    const res = await app.request('/api/status')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Policy')).toBe('applied')
  })

  test('runs for unmatched paths under the prefix (404s)', async () => {
    const app = createApp()

    effectRoutes(app)
      .prefix('/api')
      .prefixMiddleware(stampResponses)
      .group((route) => {
        route.get('/status', Effect.succeed(new Response('ok')))
      })

    const res = await app.request('/api/does-not-exist', {
      headers: { Accept: 'application/json' },
    })
    expect(res.status).toBe(404)
    expect(res.headers.get('X-Policy')).toBe('applied')
  })

  test('does not run for paths outside the prefix', async () => {
    const app = createApp()

    effectRoutes(app)
      .prefix('/api')
      .prefixMiddleware(stampResponses)
      .group((route) => {
        route.get('/status', Effect.succeed(new Response('ok')))
      })

    effectRoutes(app).get('/home', Effect.succeed(new Response('home')))

    const res = await app.request('/home')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Policy')).toBeNull()
  })

  test('documents the gap: route middleware() does not run on unmatched paths', async () => {
    const app = createApp()

    effectRoutes(app)
      .middleware(stampResponses)
      .prefix('/api')
      .group((route) => {
        route.get('/status', Effect.succeed(new Response('ok')))
      })

    const matched = await app.request('/api/status')
    expect(matched.headers.get('X-Policy')).toBe('applied')

    const unmatched = await app.request('/api/does-not-exist', {
      headers: { Accept: 'application/json' },
    })
    expect(unmatched.status).toBe(404)
    expect(unmatched.headers.get('X-Policy')).toBeNull()
  })
})
