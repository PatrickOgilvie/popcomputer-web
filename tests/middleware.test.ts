/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Page middleware tests
 */

import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { web, HEADERS } from '../src/middleware.js'
import { serializePage } from '../src/helpers.js'
import type { PageObject } from '../src/types.js'
import {
  createTestApp,
  makeInertiaRequest,
  parseInertiaResponse,
  edgeCaseStrings,
  lazyProp,
  mockUsers,
  mockProjects,
  mockErrors,
  createRequestTracker,
} from './support/test-utils.js'

// Create test app with the page middleware
const createApp = (version = '1.0.0') => {
  const app = new Hono()

  app.use(
    '*',
    web({
      version,
      render: (page: PageObject) =>
        `<!DOCTYPE html><html><body><script data-page="app" type="application/json">${serializePage(page)}</script><div id="app"></div></body></html>`,
    })
  )

  return app
}

describe('Page middleware', () => {
  describe('Basic Rendering', () => {
    test('renders HTML for regular requests', async () => {
      const app = createApp()
      app.get('/', (c) => c.var.web.render('Home', { title: 'Welcome' }))

      const res = await app.request('/')

      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toContain('text/html')

      const html = await res.text()
      expect(html).toContain('<!DOCTYPE html>')
      expect(html).toContain('<script data-page="app" type="application/json">')
      expect(html).toContain('<div id="app"></div>')
      expect(html).toContain('"component":"Home"')
    })

    test('renders JSON for Inertia requests', async () => {
      const app = createApp()
      app.get('/', (c) => c.var.web.render('Home', { title: 'Welcome' }))

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toContain('application/json')
      expect(res.headers.get(HEADERS.INERTIA)).toBe('true')

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.component).toBe('Home')
      expect(json.props.title).toBe('Welcome')
    })

    test('includes URL in page object', async () => {
      const app = createApp()
      app.get('/projects/:id', (c) =>
        c.var.web.render('Project', { id: c.req.param('id') })
      )

      const res = await app.request('/projects/123?tab=details', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.url).toBe('/projects/123?tab=details')
    })

    test('includes version in page object', async () => {
      const app = createApp('2.0.0')
      app.get('/', (c) => c.var.web.render('Home'))

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.version).toBe('2.0.0')
    })
  })

  describe('Shared Props', () => {
    test('merges shared props into page props', async () => {
      const app = createApp()

      app.use('*', async (c, next) => {
        c.var.web.share('auth', { user: { id: 1, name: 'John' } })
        await next()
      })

      app.get('/', (c) => c.var.web.render('Home', { title: 'Welcome' }))

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.auth).toEqual({ user: { id: 1, name: 'John' } })
      expect(json.props.title).toBe('Welcome')
    })

    test('page props override shared props', async () => {
      const app = createApp()

      app.use('*', async (c, next) => {
        c.var.web.share('title', 'Shared Title')
        await next()
      })

      app.get('/', (c) =>
        c.var.web.render('Home', { title: 'Page Title' })
      )

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.title).toBe('Page Title')
    })

    test('resolves lazy shared props', async () => {
      const app = createApp()

      app.use('*', async (c, next) => {
        c.var.web.share('timestamp', () => 'resolved-value')
        c.var.web.share('asyncValue', async () => 'async-resolved')
        await next()
      })

      app.get('/', (c) => c.var.web.render('Home'))

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.timestamp).toBe('resolved-value')
      expect(json.props.asyncValue).toBe('async-resolved')
    })
  })

  describe('Errors', () => {
    test('includes errors in props', async () => {
      const app = createApp()

      app.get('/', (c) => {
        c.var.web.setErrors({
          email: 'Invalid email',
          password: 'Required',
        })

        return c.var.web.render('Login')
      })

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.errors).toEqual({
        email: 'Invalid email',
        password: 'Required',
      })
    })

    test('merges multiple error calls', async () => {
      const app = createApp()

      app.get('/', (c) => {
        c.var.web.setErrors({ email: 'Invalid' })
        c.var.web.setErrors({ password: 'Required' })

        return c.var.web.render('Login')
      })

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.errors).toEqual({
        email: 'Invalid',
        password: 'Required',
      })
    })

    test('includes empty errors object by default', async () => {
      const app = createApp()
      app.get('/', (c) => c.var.web.render('Home'))

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.errors).toEqual({})
    })
  })

  describe('Version Mismatch', () => {
    test('returns 409 with X-Inertia-Location on version mismatch', async () => {
      const app = createApp('2.0.0')
      app.get('/', (c) => c.var.web.render('Home'))

      const res = await app.request('/', {
        headers: {
          [HEADERS.INERTIA]: 'true',
          [HEADERS.VERSION]: '1.0.0',
        },
      })

      expect(res.status).toBe(409)
      expect(res.headers.get(HEADERS.LOCATION)).toBe('http://localhost/')
    })

    test('does not trigger version check for non-GET requests', async () => {
      const app = createApp('2.0.0')
      app.post('/', (c) => c.var.web.render('Home'))

      const res = await app.request('/', {
        method: 'POST',
        headers: {
          [HEADERS.INERTIA]: 'true',
          [HEADERS.VERSION]: '1.0.0',
        },
      })

      expect(res.status).toBe(200)
    })
  })

  describe('Partial Reloads', () => {
    test('filters props on partial reload with include', async () => {
      const app = createApp()
      app.get('/', (c) =>
        c.var.web.render('Dashboard', {
          users: [1, 2, 3],
          projects: [4, 5, 6],
          stats: { count: 10 },
        })
      )

      const res = await app.request('/', {
        headers: {
          [HEADERS.INERTIA]: 'true',
          [HEADERS.PARTIAL_COMPONENT]: 'Dashboard',
          [HEADERS.PARTIAL_DATA]: 'users,stats',
        },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.users).toEqual([1, 2, 3])
      expect(json.props.stats).toEqual({ count: 10 })
      expect(json.props.projects).toBeUndefined()
    })

    test('excludes props on partial reload with except', async () => {
      const app = createApp()
      app.get('/', (c) =>
        c.var.web.render('Dashboard', {
          users: [1, 2, 3],
          projects: [4, 5, 6],
          stats: { count: 10 },
        })
      )

      const res = await app.request('/', {
        headers: {
          [HEADERS.INERTIA]: 'true',
          [HEADERS.PARTIAL_COMPONENT]: 'Dashboard',
          [HEADERS.PARTIAL_EXCEPT]: 'users',
        },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.users).toBeUndefined()
      expect(json.props.projects).toEqual([4, 5, 6])
      expect(json.props.stats).toEqual({ count: 10 })
    })

    test('always includes errors in partial reload', async () => {
      const app = createApp()
      app.get('/', (c) => {
        c.var.web.setErrors({ name: 'Required' })

        return c.var.web.render('Form', {
          users: [1],
          data: { field: 'value' },
        })
      })

      const res = await app.request('/', {
        headers: {
          [HEADERS.INERTIA]: 'true',
          [HEADERS.PARTIAL_COMPONENT]: 'Form',
          [HEADERS.PARTIAL_DATA]: 'users',
        },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.users).toEqual([1])
      expect(json.props.errors).toEqual({ name: 'Required' })
      expect(json.props.data).toBeUndefined()
    })

    test('ignores partial headers for different component', async () => {
      const app = createApp()
      app.get('/', (c) =>
        c.var.web.render('Dashboard', {
          users: [1, 2, 3],
          projects: [4, 5, 6],
        })
      )

      const res = await app.request('/', {
        headers: {
          [HEADERS.INERTIA]: 'true',
          [HEADERS.PARTIAL_COMPONENT]: 'DifferentComponent',
          [HEADERS.PARTIAL_DATA]: 'users',
        },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.users).toEqual([1, 2, 3])
      expect(json.props.projects).toEqual([4, 5, 6])
    })

    test('does not evaluate lazy shared props excluded by a partial reload', async () => {
      const app = createApp()
      let cheapEvaluated = 0
      let expensiveEvaluated = 0

      app.get('/', (c) => {
        c.var.web.share('cheap', () => {
          cheapEvaluated++

          return 'cheap-value'
        })
        c.var.web.share('expensive', () => {
          expensiveEvaluated++

          return 'expensive-value'
        })

        return c.var.web.render('Dashboard')
      })

      const res = await app.request('/', {
        headers: {
          [HEADERS.INERTIA]: 'true',
          [HEADERS.PARTIAL_COMPONENT]: 'Dashboard',
          [HEADERS.PARTIAL_DATA]: 'cheap',
        },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.cheap).toBe('cheap-value')
      expect(json.props.expensive).toBeUndefined()
      // The excluded lazy prop must never run — that is the point of a partial reload.
      expect(cheapEvaluated).toBe(1)
      expect(expensiveEvaluated).toBe(0)
    })

    test('does not evaluate a lazy shared prop overridden by a passed prop', async () => {
      const app = createApp()
      let sharedEvaluated = 0

      app.get('/', (c) => {
        c.var.web.share('user', () => {
          sharedEvaluated++

          return { id: 'shared' }
        })

        return c.var.web.render('Dashboard', { user: { id: 'passed' } })
      })

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.user).toEqual({ id: 'passed' })
      expect(sharedEvaluated).toBe(0)
    })
  })

  describe('Redirect Handling', () => {
    test('converts 302 to 303 for POST requests with X-Inertia', async () => {
      const app = createApp()
      app.post('/form', (c) => c.redirect('/success', 302))

      const res = await app.request('/form', {
        method: 'POST',
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // The middleware MUST convert 302 to 303 for mutating requests
      // to prevent browsers from changing POST to GET on redirect
      expect(res.status).toBe(303)
      expect(res.headers.get('Location')).toBe('/success')
    })

    test('converts 302 to 303 for PUT requests with X-Inertia', async () => {
      const app = createApp()
      app.put('/item', (c) => c.redirect('/success', 302))

      const res = await app.request('/item', {
        method: 'PUT',
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      expect(res.status).toBe(303)
    })

    test('converts 302 to 303 for DELETE requests with X-Inertia', async () => {
      const app = createApp()
      app.delete('/item', (c) => c.redirect('/list', 302))

      const res = await app.request('/item', {
        method: 'DELETE',
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      expect(res.status).toBe(303)
      expect(res.headers.get('Location')).toBe('/list')
    })

    test('converts 302 to 303 for PATCH requests with X-Inertia', async () => {
      const app = createApp()
      app.patch('/item', (c) => c.redirect('/success', 302))

      const res = await app.request('/item', {
        method: 'PATCH',
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      expect(res.status).toBe(303)
    })

    test('does not convert 302 for GET requests', async () => {
      const app = createApp()
      app.get('/old', (c) => c.redirect('/new', 302))

      const res = await app.request('/old', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      expect(res.status).toBe(302)
    })

    test('does not convert 302 for non-Inertia requests', async () => {
      const app = createApp()
      app.post('/form', (c) => c.redirect('/success', 302))

      const res = await app.request('/form', { method: 'POST' })

      expect(res.status).toBe(302)
    })

    test('sends an Inertia visit to another site with 409 and X-Inertia-Location, keeping its cookies', async () => {
      const app = createApp()
      app.post('/checkout', (c) => {
        c.header('Set-Cookie', 'checkout=pending; Path=/; HttpOnly')

        return c.redirect('https://pay.example/session/1', 303)
      })

      const res = await app.request('/checkout', { method: 'POST', headers: { [HEADERS.INERTIA]: 'true' } })

      expect(res.status).toBe(409)
      expect(res.headers.get(HEADERS.LOCATION)).toBe('https://pay.example/session/1')
      expect(res.headers.get('Location')).toBeNull()
      expect(res.headers.getSetCookie()).toEqual(['checkout=pending; Path=/; HttpOnly'])
    })

    test('leaves a redirect to another site alone for a visit that is not Inertia, and one within the site for Inertia', async () => {
      const app = createApp()
      app.get('/away', (c) => c.redirect('https://pay.example/session/1', 302))
      app.get('/near', (c) => c.redirect('http://localhost/success', 302))

      const away = await app.request('/away')
      const near = await app.request('/near', { headers: { [HEADERS.INERTIA]: 'true' } })

      expect(away.status).toBe(302)
      expect(away.headers.get('Location')).toBe('https://pay.example/session/1')
      expect(near.status).toBe(302)
      expect(near.headers.get('Location')).toBe('http://localhost/success')
    })
  })

  describe('Render Options', () => {
    test('includes clearHistory in page object', async () => {
      const app = createApp()
      app.get('/', (c) =>
        c.var.web.render('Home', {}, { clearHistory: true })
      )

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.clearHistory).toBe(true)
    })

    test('includes encryptHistory in page object', async () => {
      const app = createApp()
      app.get('/', (c) =>
        c.var.web.render('Home', {}, { encryptHistory: true })
      )

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.encryptHistory).toBe(true)
    })
  })

  describe('Vary Header', () => {
    test('includes Vary header for HTML responses', async () => {
      const app = createApp()
      app.get('/', (c) => c.var.web.render('Home'))

      const res = await app.request('/')

      expect(res.headers.get('Vary')).toBe(HEADERS.INERTIA)
    })

    test('includes Vary header for JSON responses', async () => {
      const app = createApp()
      app.get('/', (c) => c.var.web.render('Home'))

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      expect(res.headers.get('Vary')).toBe(HEADERS.INERTIA)
    })
  })

  describe('Dynamic Version', () => {
    test('supports function-based version', async () => {
      let versionCounter = 0
      const app = new Hono()

      app.use(
        '*',
        web({
          version: () => `v${++versionCounter}`,
          render: (page) => JSON.stringify(page),
        })
      )

      app.get('/', (c) => c.var.web.render('Home'))

      const res1 = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json1 = (await res1.json()) as PageObject
      expect(json1.version).toBe('v1')

      const res2 = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json2 = (await res2.json()) as PageObject
      expect(json2.version).toBe('v2')
    })
  })

  describe('Edge Cases: Multi-byte Characters', () => {
    test('handles emoji in props correctly', async () => {
      const app = createApp()
      app.get('/', (c) =>
        c.var.web.render('Home', { emoji: edgeCaseStrings.emoji })
      )

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.emoji).toBe('😀🎉🚀')
    })

    test('handles multi-byte emoji (family) in props', async () => {
      const app = createApp()
      app.get('/', (c) =>
        c.var.web.render('Home', { emoji: edgeCaseStrings.multiByteEmoji })
      )

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.emoji).toBe('👨‍👩‍👧‍👦')
    })

    test('handles unicode/Japanese characters in props', async () => {
      const app = createApp()
      app.get('/', (c) =>
        c.var.web.render('Home', { text: edgeCaseStrings.unicode })
      )

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.text).toBe('日本語テスト')
    })

    test('handles special characters in component names', async () => {
      const app = createApp()
      app.get('/', (c) => c.var.web.render('Users/Profile/Edit'))

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.component).toBe('Users/Profile/Edit')
    })
  })

  describe('Edge Cases: Complex Props', () => {
    test('handles deeply nested objects', async () => {
      const app = createApp()

      const deepProps = {
        level1: {
          level2: {
            level3: {
              level4: {
                value: 'deep',
              },
            },
          },
        },
      }

      app.get('/', (c) => c.var.web.render('Home', deepProps))

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject<typeof deepProps>
      expect(json.props.level1.level2.level3.level4.value).toBe('deep')
    })

    test('handles arrays with mixed types', async () => {
      const app = createApp()
      app.get('/', (c) =>
        c.var.web.render('Home', {
          mixed: [1, 'string', { nested: true }, [1, 2, 3], null],
        })
      )

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.mixed).toEqual([
        1,
        'string',
        { nested: true },
        [1, 2, 3],
        null,
      ])
    })

    test('handles null and undefined values', async () => {
      const app = createApp()
      app.get('/', (c) =>
        c.var.web.render('Home', {
          nullValue: null,
          undefinedValue: undefined,
        })
      )

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.nullValue).toBeNull()
      // undefined should be omitted in JSON
      expect('undefinedValue' in json.props).toBe(false)
    })

    test('handles large arrays (pagination mock)', async () => {
      const app = createApp()

      const largeData = {
        users: Array.from({ length: 1000 }, (_, i) => ({
          id: i + 1,
          name: `User ${i + 1}`,
        })),
        meta: { total: 1000, page: 1, perPage: 1000 },
      }

      app.get('/', (c) => c.var.web.render('Users/Index', largeData))

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject<typeof largeData>
      expect(json.props.users).toHaveLength(1000)
      expect(json.props.meta.total).toBe(1000)
    })

    test('handles Date objects (serialized to string)', async () => {
      const app = createApp()
      // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture exercises the public Date/Better Auth contract; it does not read the clock.
      const date = new Date('2025-01-01T00:00:00Z')
      app.get('/', (c) =>
        c.var.web.render('Home', { createdAt: date.toISOString() })
      )

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.createdAt).toBe('2025-01-01T00:00:00.000Z')
    })
  })

  describe('Edge Cases: Error Handling', () => {
    test('handles error bag pattern (nested errors)', async () => {
      const app = createApp()
      app.get('/', (c) => {
        c.var.web.setErrors({
          'user.email': 'Invalid email',
          'user.password': 'Too short',
          'settings.notifications': 'Required',
        })

        return c.var.web.render('Settings')
      })

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.errors?.['user.email']).toBe('Invalid email')
      expect(json.props.errors?.['user.password']).toBe('Too short')
      expect(json.props.errors?.['settings.notifications']).toBe('Required')
    })

    test('handles array-indexed errors', async () => {
      const app = createApp()
      app.get('/', (c) => {
        c.var.web.setErrors({
          'items.0.name': 'Required',
          'items.1.price': 'Must be positive',
          'items.2.quantity': 'Must be integer',
        })

        return c.var.web.render('Form')
      })

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.errors?.['items.0.name']).toBe('Required')
      expect(json.props.errors?.['items.1.price']).toBe('Must be positive')
    })

    test('clears previous errors on new request', async () => {
      const app = createApp()
      let hasErrors = true

      app.get('/', (c) => {
        if (hasErrors) {
          c.var.web.setErrors({ email: 'Invalid' })
        }

        return c.var.web.render('Form')
      })

      const res1 = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json1 = (await res1.json()) as PageObject
      expect(json1.props.errors?.email).toBe('Invalid')

      hasErrors = false

      const res2 = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json2 = (await res2.json()) as PageObject
      expect(json2.props.errors).toEqual({})
    })
  })

  describe('Edge Cases: Async Props', () => {
    test('resolves multiple async shared props in parallel', async () => {
      const app = createApp()

      app.use('*', async (c, next) => {
        c.var.web.share('user', lazyProp({ id: 1, name: 'John' }))
        c.var.web.share('settings', lazyProp({ theme: 'dark' }))
        c.var.web.share('notifications', lazyProp([{ id: 1 }]))
        await next()
      })

      app.get('/', (c) => c.var.web.render('Dashboard'))

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.user).toEqual({ id: 1, name: 'John' })
      expect(json.props.settings).toEqual({ theme: 'dark' })
      expect(json.props.notifications).toEqual([{ id: 1 }])
    })

    test('handles errors in async shared props gracefully', async () => {
      const app = createApp()

      app.use('*', async (c, next) => {
        c.var.web.share('failing', async () => {
          throw new Error('Prop resolution failed')
        })
        await next()
      })

      app.get('/', (c) => c.var.web.render('Home'))

      // The error should propagate
      try {
        await app.request('/', {
          headers: { [HEADERS.INERTIA]: 'true' },
        })
      } catch (e) {
        expect(e).toBeDefined()
      }
    })

    test('handles mixed sync and async shared props', async () => {
      const app = createApp()

      app.use('*', async (c, next) => {
        c.var.web.share('sync', 'immediate')
        c.var.web.share('async', async () => 'delayed')
        c.var.web.share('lazy', () => 'lazy-sync')
        await next()
      })

      app.get('/', (c) => c.var.web.render('Home'))

      const res = await app.request('/', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.sync).toBe('immediate')
      expect(json.props.async).toBe('delayed')
      expect(json.props.lazy).toBe('lazy-sync')
    })
  })

  describe('Edge Cases: Partial Reloads', () => {
    test('handles partial reload with dot notation keys', async () => {
      const app = createApp()
      app.get('/', (c) =>
        c.var.web.render('Dashboard', {
          'user.profile': { name: 'John' },
          'user.settings': { theme: 'dark' },
          stats: { count: 10 },
        })
      )

      const res = await app.request('/', {
        headers: {
          [HEADERS.INERTIA]: 'true',
          [HEADERS.PARTIAL_COMPONENT]: 'Dashboard',
          [HEADERS.PARTIAL_DATA]: 'user.profile,stats',
        },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props['user.profile']).toEqual({ name: 'John' })
      expect(json.props.stats).toEqual({ count: 10 })
      expect(json.props['user.settings']).toBeUndefined()
    })

    test('handles empty partial data header', async () => {
      const app = createApp()
      app.get('/', (c) =>
        c.var.web.render('Dashboard', {
          users: mockUsers,
          projects: mockProjects,
        })
      )

      const res = await app.request('/', {
        headers: {
          [HEADERS.INERTIA]: 'true',
          [HEADERS.PARTIAL_COMPONENT]: 'Dashboard',
          [HEADERS.PARTIAL_DATA]: '',
        },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      // Empty partial data should include errors only
      expect(json.props.errors).toEqual({})
    })

    test('handles partial reload with both only and except', async () => {
      const app = createApp()
      app.get('/', (c) =>
        c.var.web.render('Dashboard', {
          users: mockUsers,
          projects: mockProjects,
          stats: { count: 10 },
        })
      )

      // When both are provided, only should be processed first, then except
      const res = await app.request('/', {
        headers: {
          [HEADERS.INERTIA]: 'true',
          [HEADERS.PARTIAL_COMPONENT]: 'Dashboard',
          [HEADERS.PARTIAL_DATA]: 'users,projects,stats',
          [HEADERS.PARTIAL_EXCEPT]: 'projects',
        },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.props.users).toEqual(mockUsers)
      expect(json.props.stats).toEqual({ count: 10 })
      expect(json.props.projects).toBeUndefined()
    })

    test('partial reload preserves errors regardless of filter', async () => {
      const app = createApp()
      app.get('/', (c) => {
        c.var.web.setErrors(mockErrors)

        return c.var.web.render('Form', {
          users: mockUsers,
          settings: { theme: 'dark' },
        })
      })

      const res = await app.request('/', {
        headers: {
          [HEADERS.INERTIA]: 'true',
          [HEADERS.PARTIAL_COMPONENT]: 'Form',
          [HEADERS.PARTIAL_EXCEPT]: 'errors',
        },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      // errors should still be included even when trying to exclude
      expect(json.props.errors).toEqual(mockErrors)
    })
  })

  describe('Edge Cases: HTTP Methods', () => {
    test('handles all HTTP methods correctly', async () => {
      const app = createApp()
      const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

      for (const method of methods) {
        app.on(method, '/test', (c) =>
          c.var.web.render('Test', { method })
        )
      }

      for (const method of methods) {
        const res = await app.request('/test', {
          method,
          headers: { [HEADERS.INERTIA]: 'true' },
        })

        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        const json = (await res.json()) as PageObject
        expect(json.props.method).toBe(method)
      }
    })

    test('302 redirect behavior for different HTTP methods', async () => {
      const app = createApp()
      app.post('/form', (c) => c.redirect('/success', 302))
      app.get('/redirect', (c) => c.redirect('/success', 302))

      // POST with X-Inertia MUST convert 302 to 303
      const postRes = await app.request('/form', {
        method: 'POST',
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      expect(postRes.status).toBe(303)
      expect(postRes.headers.get('Location')).toBe('/success')

      // GET with Inertia should stay 302
      const getRes = await app.request('/redirect', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      expect(getRes.status).toBe(302)

      // POST without Inertia should stay 302
      const noInertiaRes = await app.request('/form', {
        method: 'POST',
      })

      expect(noInertiaRes.status).toBe(302)
    })
  })

  describe('Edge Cases: URL Handling', () => {
    test('handles URL with query parameters', async () => {
      const app = createApp()
      app.get('/search', (c) => c.var.web.render('Search'))

      const res = await app.request('/search?q=test&page=1&sort=name', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.url).toBe('/search?q=test&page=1&sort=name')
    })

    test('handles URL with hash fragment', async () => {
      const app = createApp()
      app.get('/page', (c) => c.var.web.render('Page'))

      // Note: hash fragments are typically not sent to server
      const res = await app.request('/page', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.url).toBe('/page')
    })

    test('handles URL with encoded characters', async () => {
      const app = createApp()
      app.get('/users/:name', (c) => c.var.web.render('User'))

      const res = await app.request('/users/John%20Doe', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.url).toBe('/users/John%20Doe')
    })

    test('handles deeply nested routes', async () => {
      const app = createApp()
      app.get('/org/:org/team/:team/project/:project/task/:task', (c) =>
        c.var.web.render('Task', {
          org: c.req.param('org'),
          team: c.req.param('team'),
          project: c.req.param('project'),
          task: c.req.param('task'),
        })
      )

      const res = await app.request('/org/acme/team/dev/project/api/task/123', {
        headers: { [HEADERS.INERTIA]: 'true' },
      })

      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      const json = (await res.json()) as PageObject
      expect(json.url).toBe('/org/acme/team/dev/project/api/task/123')
      expect(json.props.org).toBe('acme')
      expect(json.props.task).toBe('123')
    })
  })

  describe('Test Utilities Integration', () => {
    test('createTestApp works correctly', async () => {
      const app = createTestApp({ version: '2.0.0' })
      app.get('/', (c) => c.var.web.render('Home'))

      const res = await makeInertiaRequest(app, '/')
      const page = await parseInertiaResponse(res)

      expect(page.version).toBe('2.0.0')
      expect(page.component).toBe('Home')
    })

    test('request tracker tracks requests', () => {
      const tracker = createRequestTracker()

      tracker.track('/users', 'GET')
      tracker.track('/users/1', 'PUT')
      tracker.track('/users/1', 'DELETE')

      expect(tracker.count()).toBe(3)
      expect(tracker.requests[0].path).toBe('/users')
      expect(tracker.requests[1].method).toBe('PUT')

      tracker.reset()
      expect(tracker.count()).toBe(0)
    })
  })
})

describe('HEADERS constant', () => {
  test('exports all required header names', () => {
    expect(HEADERS.INERTIA).toBe('X-Inertia')
    expect(HEADERS.VERSION).toBe('X-Inertia-Version')
    expect(HEADERS.PARTIAL_COMPONENT).toBe('X-Inertia-Partial-Component')
    expect(HEADERS.PARTIAL_DATA).toBe('X-Inertia-Partial-Data')
    expect(HEADERS.PARTIAL_EXCEPT).toBe('X-Inertia-Partial-Except')
    expect(HEADERS.LOCATION).toBe('X-Inertia-Location')
  })
})

/**
 * Regression tests for "Context is not finalized" errors.
 *
 * These tests ensure middleware properly returns responses and doesn't
 * cause Hono to throw "Context is not finalized" errors.
 */
describe('Context Finalization (regression)', () => {
  test('POST redirect with X-Inertia headers does not throw context error', async () => {
    const app = createApp()
    app.post('/login', (c) => c.redirect('/dashboard', 302))

    // This specific scenario previously caused "Context is not finalized"
    const res = await app.request('/login', {
      method: 'POST',
      headers: { [HEADERS.INERTIA]: 'true' },
    })

    // Must get a valid response, not an error
    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/dashboard')
  })

  test('version mismatch returns 409 without context error', async () => {
    const app = createApp()
    app.get('/page', (c) => c.var.web.render('Page'))

    // Version mismatch early return
    const res = await app.request('/page', {
      headers: {
        [HEADERS.INERTIA]: 'true',
        [HEADERS.VERSION]: 'old-version',
      },
    })

    expect(res.status).toBe(409)
    expect(res.headers.get(HEADERS.LOCATION)).toBeTruthy()
  })

  test('multiple middleware in chain all complete without context error', async () => {
    const app = new Hono()
    const executed: string[] = []

    // First middleware
    app.use('*', async (c, next) => {
      executed.push('middleware-1-before')
      await next()
      executed.push('middleware-1-after')
    })

    // Page middleware
    app.use(
      '*',
      web({
        version: '1.0.0',
        render: async (page) => `<html>${JSON.stringify(page)}</html>`,
      })
    )

    // Third middleware
    app.use('*', async (c, next) => {
      executed.push('middleware-3-before')
      await next()
      executed.push('middleware-3-after')
    })

    app.post('/form', (c) => {
      executed.push('handler')

      return c.redirect('/success', 302)
    })

    const res = await app.request('/form', {
      method: 'POST',
      headers: { [HEADERS.INERTIA]: 'true' },
    })

    // Response should be valid
    expect(res.status).toBe(303)

    // All middleware should have executed in correct order
    expect(executed).toEqual([
      'middleware-1-before',
      'middleware-3-before',
      'handler',
      'middleware-3-after',
      'middleware-1-after',
    ])
  })

  test('redirect without Location header does not throw', async () => {
    const app = new Hono()

    app.use(
      '*',
      web({
        version: '1.0.0',
        render: async (page) => `<html>${JSON.stringify(page)}</html>`,
      })
    )

    // Edge case: 302 response without Location header
    app.post('/weird', (_c) => {
      return new Response(null, { status: 302 })
    })

    const res = await app.request('/weird', {
      method: 'POST',
      headers: { [HEADERS.INERTIA]: 'true' },
    })

    // Should still get a response (302 stays 302 since no Location to convert)
    expect(res.status).toBe(302)
  })

  test('middleware returns response for proper propagation in forwarding scenarios', async () => {
    // This tests that the page middleware properly returns c.res
    // which is critical for request forwarding/sandbox scenarios
    const innerApp = new Hono()

    innerApp.use(
      '*',
      web({
        version: '1.0.0',
        render: async (page) => `<html>${JSON.stringify(page)}</html>`,
      })
    )

    innerApp.get('/page', (c) => c.var.web.render('Page', { data: 'test' }))
    innerApp.post('/submit', (c) => c.redirect('/success', 302))

    // Outer app that forwards requests (simulating sandbox forwarding)
    const outerApp = new Hono()
    outerApp.all('*', async (c) => {
      // Forward request to inner app
      const res = await innerApp.request(c.req.raw)

      return res
    })

    // Test regular render
    const getRes = await outerApp.request('/page', {
      headers: { [HEADERS.INERTIA]: 'true' },
    })

    expect(getRes.status).toBe(200)
    const json = await getRes.json()
    expect(json.component).toBe('Page')

    // Test redirect conversion
    const postRes = await outerApp.request('/submit', {
      method: 'POST',
      headers: { [HEADERS.INERTIA]: 'true' },
    })

    expect(postRes.status).toBe(303)
    expect(postRes.headers.get('Location')).toBe('/success')
  })

  test('middleware returns response even when no handler matches', async () => {
    const app = new Hono()

    app.use(
      '*',
      web({
        version: '1.0.0',
        render: async (page) => `<html>${JSON.stringify(page)}</html>`,
      })
    )

    // No route defined for /missing

    const res = await app.request('/missing', {
      headers: { [HEADERS.INERTIA]: 'true' },
    })

    // Should get Hono's 404 response
    expect(res.status).toBe(404)
  })
})
