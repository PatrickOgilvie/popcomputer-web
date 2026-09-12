/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Test Utilities Self-Tests
 * 
 * Tests for the test utilities themselves to ensure they work correctly.
 */

import { describe, test, expect } from 'bun:test'
import { Clock, Effect } from 'effect'
import { TestClock } from 'effect/testing'
import {
  createTestApp,
  makeRequest,
  makeInertiaRequest,
  parseInertiaResponse,
  parseHtmlResponse,
  assertInertiaResponse,
  assertHtmlResponse,
  assertVersionMismatch,
  assertPageObject,
  mockUsers,
  mockProjects,
  mockErrors,
  edgeCaseStrings,
  delay,
  lazyProp,
  createRequestTracker,
} from '../src/test-utils.js'
import { HEADERS } from '../src/types.js'

describe('Test Utilities', () => {
  describe('createTestApp', () => {
    test('creates app with default version', async () => {
      const app = createTestApp()
      app.get('/', (c) => c.var.honertia.render('Home'))

      const res = await makeInertiaRequest(app, '/')
      const page = await parseInertiaResponse(res)

      expect(page.version).toBe('1.0.0')
    })

    test('creates app with custom version', async () => {
      const app = createTestApp({ version: '2.5.0' })
      app.get('/', (c) => c.var.honertia.render('Home'))

      const res = await makeInertiaRequest(app, '/')
      const page = await parseInertiaResponse(res)

      expect(page.version).toBe('2.5.0')
    })

    test('creates app with version function', async () => {
      let counter = 0
      const app = createTestApp({ version: () => `v${++counter}` })
      app.get('/', (c) => c.var.honertia.render('Home'))

      const res1 = await makeInertiaRequest(app, '/')
      const page1 = await parseInertiaResponse(res1)
      expect(page1.version).toBe('v1')

      const res2 = await makeInertiaRequest(app, '/')
      const page2 = await parseInertiaResponse(res2)
      expect(page2.version).toBe('v2')
    })

    test('creates app with custom render function', async () => {
      const app = createTestApp({
        render: (page) => `CUSTOM:${page.component}`,
      })

      app.get('/', (c) => c.var.honertia.render('MyComponent'))

      const res = await makeRequest(app, '/')
      const html = await res.text()

      expect(html).toBe('CUSTOM:MyComponent')
    })
  })

  describe('makeRequest', () => {
    test('makes GET request by default', async () => {
      const app = createTestApp()
      app.get('/test', (c) => c.text('OK'))

      const res = await makeRequest(app, '/test')

      expect(res.status).toBe(200)
      expect(await res.text()).toBe('OK')
    })

    test('makes request with custom method', async () => {
      const app = createTestApp()
      app.post('/submit', (c) => c.text('POSTED'))

      const res = await makeRequest(app, '/submit', { method: 'POST' })

      expect(await res.text()).toBe('POSTED')
    })

    test('makes request with custom headers', async () => {
      const app = createTestApp()
      app.get('/headers', (c) => c.text(c.req.header('X-Custom') ?? 'missing'))

      const res = await makeRequest(app, '/headers', {
        headers: { 'X-Custom': 'test-value' },
      })

      expect(await res.text()).toBe('test-value')
    })
  })

  describe('makeInertiaRequest', () => {
    test('includes X-Inertia header automatically', async () => {
      const app = createTestApp()
      app.get('/', (c) => c.var.honertia.render('Home'))

      const res = await makeInertiaRequest(app, '/')

      expect(res.headers.get('Content-Type')).toContain('application/json')
      expect(res.headers.get(HEADERS.HONERTIA)).toBe('true')
    })

    test('includes version header when specified', async () => {
      const app = createTestApp({ version: '2.0.0' })
      app.get('/', (c) => c.var.honertia.render('Home'))

      const res = await makeInertiaRequest(app, '/', { version: '1.0.0' })

      // Should trigger version mismatch
      expect(res.status).toBe(409)
    })

    test('includes partial headers when specified', async () => {
      const app = createTestApp()
      app.get('/', (c) =>
        c.var.honertia.render('Dashboard', {
          users: mockUsers,
          projects: mockProjects,
        })
      )

      const res = await makeInertiaRequest(app, '/', {
        partialComponent: 'Dashboard',
        partialData: 'users',
      })

      const page = await parseInertiaResponse(res)
      expect(page.props.users).toEqual(mockUsers)
      expect(page.props.projects).toBeUndefined()
    })

    test('includes partial except header when specified', async () => {
      const app = createTestApp()
      app.get('/', (c) =>
        c.var.honertia.render('Dashboard', {
          users: mockUsers,
          projects: mockProjects,
        })
      )

      const res = await makeInertiaRequest(app, '/', {
        partialComponent: 'Dashboard',
        partialExcept: 'users',
      })

      const page = await parseInertiaResponse(res)
      expect(page.props.users).toBeUndefined()
      expect(page.props.projects).toEqual(mockProjects)
    })
  })

  describe('parseInertiaResponse', () => {
    test('parses JSON response to PageObject', async () => {
      const app = createTestApp()
      app.get('/', (c) =>
        c.var.honertia.render('Home', { message: 'Hello' })
      )

      const res = await makeInertiaRequest(app, '/')
      const page = await parseInertiaResponse(res)

      expect(page.component).toBe('Home')
      expect(page.props.message).toBe('Hello')
      expect(page.url).toBe('/')
      expect(page.version).toBe('1.0.0')
    })
  })

  describe('parseHtmlResponse', () => {
    test('extracts page object from HTML', async () => {
      const app = createTestApp()
      app.get('/', (c) =>
        c.var.honertia.render('Home', { title: 'Test' })
      )

      const res = await makeRequest(app, '/')
      const page = await parseHtmlResponse(res)

      expect(page).not.toBeNull()
      expect(page?.component).toBe('Home')
      expect(page?.props.title).toBe('Test')
    })

    test('returns null for non-Inertia HTML', async () => {
      const app = createTestApp()
      app.get('/plain', (c) => c.html('<html><body>Plain</body></html>'))

      const res = await makeRequest(app, '/plain')
      const page = await parseHtmlResponse(res)

      expect(page).toBeNull()
    })
  })

  describe('Assertions', () => {
    test('assertInertiaResponse passes for valid response', async () => {
      const app = createTestApp()
      app.get('/', (c) => c.var.honertia.render('Home'))

      const res = await makeInertiaRequest(app, '/')

      expect(() => assertInertiaResponse(res)).not.toThrow()
    })

    test('assertHtmlResponse passes for valid response', async () => {
      const app = createTestApp()
      app.get('/', (c) => c.var.honertia.render('Home'))

      const res = await makeRequest(app, '/')

      expect(() => assertHtmlResponse(res)).not.toThrow()
    })

    test('assertVersionMismatch passes for 409 response', async () => {
      const app = createTestApp({ version: '2.0.0' })
      app.get('/', (c) => c.var.honertia.render('Home'))

      const res = await makeInertiaRequest(app, '/', { version: '1.0.0' })

      expect(() => assertVersionMismatch(res)).not.toThrow()
    })

    test('assertPageObject validates page properties', () => {
      const page = {
        component: 'Dashboard',
        props: {},
        url: '/dashboard',
        version: '1.0.0',
      }

      expect(() =>
        assertPageObject(page, { component: 'Dashboard', url: '/dashboard' })
      ).not.toThrow()

      expect(() =>
        assertPageObject(page, { component: 'Other' })
      ).toThrow()
    })
  })

  describe('Mock Data', () => {
    test('mockUsers has expected structure', () => {
      expect(mockUsers).toHaveLength(3)
      expect(mockUsers[0]).toHaveProperty('id')
      expect(mockUsers[0]).toHaveProperty('name')
      expect(mockUsers[0]).toHaveProperty('email')
    })

    test('mockProjects has expected structure', () => {
      expect(mockProjects).toHaveLength(2)
      expect(mockProjects[0]).toHaveProperty('id')
      expect(mockProjects[0]).toHaveProperty('name')
      expect(mockProjects[0]).toHaveProperty('status')
    })

    test('mockErrors has expected structure', () => {
      expect(mockErrors).toHaveProperty('email')
      expect(mockErrors).toHaveProperty('password')
    })
  })

  describe('Edge Case Strings', () => {
    test('contains all expected test cases', () => {
      expect(edgeCaseStrings).toHaveProperty('emoji')
      expect(edgeCaseStrings).toHaveProperty('unicode')
      expect(edgeCaseStrings).toHaveProperty('multiByteEmoji')
      expect(edgeCaseStrings).toHaveProperty('htmlEntities')
      expect(edgeCaseStrings).toHaveProperty('quotes')
      expect(edgeCaseStrings).toHaveProperty('newlines')
      expect(edgeCaseStrings).toHaveProperty('specialChars')
      expect(edgeCaseStrings).toHaveProperty('longString')
      expect(edgeCaseStrings).toHaveProperty('emptyString')
      expect(edgeCaseStrings).toHaveProperty('whitespace')
    })

    test('longString is actually long', () => {
      expect(edgeCaseStrings.longString.length).toBe(10000)
    })
  })

  describe('Timing Utilities', () => {
    test('delay waits for specified time', async () => {
      const start = performance.now()
      await delay(50)
      const elapsed = performance.now() - start

      expect(elapsed).toBeGreaterThanOrEqual(45) // Allow for timing variance
    })

    test('lazyProp creates a function that returns value', async () => {
      const getValue = lazyProp({ data: 'test' })
      const result = await getValue()

      expect(result).toEqual({ data: 'test' })
    })

    test('lazyProp with delay waits before returning', async () => {
      const getValue = lazyProp('delayed', 50)

      const start = performance.now()
      const result = await getValue()
      const elapsed = performance.now() - start

      expect(result).toBe('delayed')
      expect(elapsed).toBeGreaterThanOrEqual(45)
    })
  })

  describe('Request Tracker', () => {
    test('tracks requests', () => {
      const tracker = createRequestTracker()

      tracker.track('/users', 'GET')
      tracker.track('/users/1', 'PUT')

      expect(tracker.count()).toBe(2)
      expect(tracker.requests).toHaveLength(2)
    })

    test('records path and method', () => {
      const tracker = createRequestTracker()

      tracker.track('/api/data', 'POST')

      expect(tracker.requests[0].path).toBe('/api/data')
      expect(tracker.requests[0].method).toBe('POST')
    })

    test('records timestamps from the supplied clock', async () => {
      await Effect.runPromise(Effect.gen(function* () {
        const clock = yield* Clock.Clock
        const tracker = createRequestTracker(clock)
        yield* TestClock.adjust('5 seconds')
        tracker.track('/test', 'GET')

        expect(tracker.requests[0].timestamp).toBe(5_000)
      }).pipe(Effect.provide(TestClock.layer())))
    })

    test('reset clears all requests', () => {
      const tracker = createRequestTracker()

      tracker.track('/a', 'GET')
      tracker.track('/b', 'POST')
      tracker.track('/c', 'DELETE')

      expect(tracker.count()).toBe(3)

      tracker.reset()

      expect(tracker.count()).toBe(0)
      expect(tracker.requests).toHaveLength(0)
    })
  })
})
