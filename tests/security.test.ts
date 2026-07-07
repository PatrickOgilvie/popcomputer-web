/**
 * Security Middleware Tests
 *
 * Covers the opt-in Origin verification used as CSRF defense-in-depth.
 */

import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { verifyOrigin } from '../src/security.js'

const createApp = (config = {}) => {
  const app = new Hono()
  app.use('*', verifyOrigin(config))
  app.get('/', (c) => c.text('ok'))
  app.post('/', (c) => c.text('created'))
  return app
}

describe('verifyOrigin', () => {
  test('allows safe methods regardless of origin', async () => {
    const app = createApp()
    const res = await app.request('https://app.test/', {
      method: 'GET',
      headers: { Origin: 'https://evil.test' },
    })
    expect(res.status).toBe(200)
  })

  test('allows same-origin state-changing requests', async () => {
    const app = createApp()
    const res = await app.request('https://app.test/', {
      method: 'POST',
      headers: { Origin: 'https://app.test' },
    })
    expect(res.status).toBe(200)
  })

  test('blocks cross-origin state-changing requests', async () => {
    const app = createApp()
    const res = await app.request('https://app.test/', {
      method: 'POST',
      headers: { Origin: 'https://evil.test' },
    })
    expect(res.status).toBe(403)
  })

  test('allows configured extra origins', async () => {
    const app = createApp({ allowedOrigins: ['journeymannative://'] })
    const res = await app.request('https://app.test/', {
      method: 'POST',
      headers: { Origin: 'journeymannative://' },
    })
    expect(res.status).toBe(200)
  })

  test('supports a predicate allowlist', async () => {
    const app = createApp({
      allowedOrigins: (origin: string) => origin.endsWith('.trusted.test'),
    })
    const ok = await app.request('https://app.test/', {
      method: 'POST',
      headers: { Origin: 'https://a.trusted.test' },
    })
    const blocked = await app.request('https://app.test/', {
      method: 'POST',
      headers: { Origin: 'https://a.evil.test' },
    })
    expect(ok.status).toBe(200)
    expect(blocked.status).toBe(403)
  })

  test('falls back to Referer when Origin is absent', async () => {
    const app = createApp()
    const blocked = await app.request('https://app.test/', {
      method: 'POST',
      headers: { Referer: 'https://evil.test/some/path' },
    })
    expect(blocked.status).toBe(403)

    const allowed = await app.request('https://app.test/', {
      method: 'POST',
      headers: { Referer: 'https://app.test/some/path' },
    })
    expect(allowed.status).toBe(200)
  })

  test('allows header-less requests by default (non-browser clients)', async () => {
    const app = createApp()
    const res = await app.request('https://app.test/', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  test('rejects header-less requests when requireOrigin is set', async () => {
    const app = createApp({ requireOrigin: true })
    const res = await app.request('https://app.test/', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  test('honors a custom rejection status', async () => {
    const app = createApp({ status: 419 })
    const res = await app.request('https://app.test/', {
      method: 'POST',
      headers: { Origin: 'https://evil.test' },
    })
    expect(res.status).toBe(419)
  })
})
