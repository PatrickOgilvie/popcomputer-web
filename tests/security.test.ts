/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Security Middleware Tests
 *
 * Covers the Origin verification setupWeb installs as CSRF defense-in-depth.
 */

import { describe, test, expect } from 'bun:test'
import { Effect } from 'effect'
import { Hono } from 'hono'
import { verifyOrigin } from '../src/security.js'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { json, render } from '../src/effect/responses.js'
import { readError, readErrorPage } from '../src/testing.js'

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

describe('setupWeb verifies origins by default', () => {
  const appWith = (security?: { verifyOrigin: false }) => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page), ...(security ? { security } : {}) })
    routes.post('/projects', action(json({ created: true })))

    return app
  }

  test('refuses a post from another site, and allows its own and one without an origin', async () => {
    const app = appWith()

    expect((await app.request('/projects', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status).toBe(403)
    expect((await app.request('/projects', { method: 'POST', headers: { Origin: 'http://localhost' } })).status).toBe(200)
    expect((await app.request('/projects', { method: 'POST' })).status).toBe(200)
  })

  test('answers a refused request through the error boundary', async () => {
    const app = appWith()
    const visit = await app.request('/projects', { method: 'POST', headers: { Origin: 'https://evil.example', 'X-Inertia': 'true' } })
    const api = await app.request('/projects', { method: 'POST', headers: { Origin: 'https://evil.example', Accept: 'application/json' } })

    expect(visit.status).toBe(403)
    expect(await readErrorPage(visit)).toMatchObject({ component: 'Error', props: { status: 403 } })
    expect(await readError(api)).toMatchObject({ httpStatus: 403, tag: 'ForbiddenError' })
  })

  test('passes a request that carries an Authorization header, which a browser never adds cross-site', async () => {
    const res = await appWith().request('/projects', {
      method: 'POST',
      headers: { Origin: 'https://scanner.example', Authorization: 'Bearer key' },
    })

    expect(res.status).toBe(200)
  })

  test('verifyOrigin: false turns the check off', async () => {
    const res = await appWith({ verifyOrigin: false }).request('/projects', { method: 'POST', headers: { Origin: 'https://evil.example' } })

    expect(res.status).toBe(200)
  })
})

describe('security headers', () => {
  const appWith = (security?: Parameters<typeof setupWeb>[1]['security']) => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page), security })

    routes
      .get('/page', action(render('Home')))
      .get('/embed', action(Effect.succeed(new Response('ok', { headers: { 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "default-src 'none'" } }))))

    return app
  }

  test('refuse framing, sniffing and cross-site referrers on every response by default', async () => {
    const res = await appWith().request('/page')
    const missing = await appWith().request('/nowhere')

    for (const response of [res, missing]) {
      expect(response.headers.get('X-Frame-Options')).toBe('DENY')
      expect(response.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'")
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    }
  })

  test("keep a response's own headers, adding framing to its policy", async () => {
    const res = await appWith().request('/embed')

    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; frame-ancestors 'none'")
  })

  test('let the application frame its own pages, or send none of them', async () => {
    const own = await appWith({ headers: { frames: 'same-origin' } }).request('/page')
    const none = await appWith({ headers: false }).request('/page')

    expect(own.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
    expect(own.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'self'")
    expect(none.headers.get('X-Frame-Options')).toBeNull()
  })
})
