/**
 * Testing Utilities Tests
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { Effect } from 'effect'
import {
  RouteRegistry,
  resetGlobalRegistry,
  effectRoutes,
  describeRoute,
  createRouteTester,
  generateTestCases,
} from '../../src/effect/index.js'
import { honertia } from '../../src/middleware.js'
import { effectBridge } from '../../src/effect/bridge.js'

// Helper to create test app with routes
const createTestApp = () => {
  const app = new Hono()
  const registry = new RouteRegistry()

  app.use(
    '*',
    honertia({
      version: '1.0.0',
      render: (page) => JSON.stringify(page),
    })
  )
  app.use('*', effectBridge())

  // Register some test routes
  effectRoutes(app, { registry })
    .get('/projects', Effect.succeed(new Response(JSON.stringify({ projects: [] }), {
      headers: { 'Content-Type': 'application/json' },
    })), { name: 'projects.index' })

  effectRoutes(app, { registry })
    .get('/projects/{project}', Effect.succeed(new Response(JSON.stringify({ project: { id: '123', name: 'Test' } }), {
      headers: { 'Content-Type': 'application/json' },
    })), { name: 'projects.show' })

  effectRoutes(app, { registry })
    .post('/projects', Effect.succeed(
      new Response(JSON.stringify({ project: { id: 'new', name: 'Created' } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    ), { name: 'projects.create' })

  effectRoutes(app, { registry })
    .delete('/projects/{project}', Effect.succeed(new Response(null, { status: 204 })), { name: 'projects.destroy' })

  return { app, registry }
}

describe('describeRoute', () => {
  beforeEach(() => {
    resetGlobalRegistry()
  })

  test('throws error for unknown route', () => {
    const { app, registry } = createTestApp()

    expect(() => {
      describeRoute('unknown.route', app, registry, () => {})
    }).toThrow("Route 'unknown.route' not found in registry")
  })

  test('lists available routes in error message', () => {
    const { app, registry } = createTestApp()

    expect(() => {
      describeRoute('unknown.route', app, registry, () => {})
    }).toThrow('projects.index')
  })
})

describe('describeRoute Integration', () => {
  const { app, registry } = createTestApp()

  describeRoute('projects.index', app, registry, (routeTest) => {
    routeTest('returns 200 status', {
      expect: { status: 200 },
    })

    routeTest('returns JSON response', {
      assert: async (ctx) => {
        expect(ctx.json).toBeDefined()
        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        expect((ctx.json as any).projects).toEqual([])
      },
    })
  })

  describeRoute('projects.show', app, registry, (routeTest) => {
    routeTest('returns project data', {
      params: { project: '123' },
      expect: { status: 200 },
      assert: async (ctx) => {
        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        expect((ctx.json as any).project.id).toBe('123')
      },
    })
  })

  describeRoute('projects.create', app, registry, (routeTest) => {
    routeTest('creates project with POST', {
      body: { name: 'New Project' },
      expect: { status: 201 },
      assert: async (ctx) => {
        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        expect((ctx.json as any).project.name).toBe('Created')
      },
    })
  })

  describeRoute('projects.destroy', app, registry, (routeTest) => {
    routeTest('returns 204 for delete', {
      params: { project: '123' },
      expect: { status: 204 },
    })
  })
})

describe('createRouteTester', () => {
  beforeEach(() => {
    resetGlobalRegistry()
  })

  test('creates tester for named route', () => {
    const { app, registry } = createTestApp()

    const testRoute = createRouteTester('projects.index', app, registry)
    expect(testRoute).toBeInstanceOf(Function)
  })

  test('defaults to the registry owned by the app', () => {
    const app = new Hono()
    effectRoutes(app).get('/owned', Effect.succeed(new Response('ok')), {
      name: 'owned.show',
    })

    expect(createRouteTester('owned.show', app)).toBeInstanceOf(Function)
  })

  test('throws for unknown route', () => {
    const { app, registry } = createTestApp()

    expect(() => {
      createRouteTester('unknown', app, registry)
    }).toThrow("Route 'unknown' not found in registry")
  })
})

describe('createRouteTester Integration', () => {
  const { app, registry } = createTestApp()
  const testProjectsIndex = createRouteTester('projects.index', app, registry)

  testProjectsIndex('can test route directly', {
    expect: { status: 200 },
  })
})

describe('generateTestCases', () => {
  beforeEach(() => {
    resetGlobalRegistry()
  })

  test('generates basic accessibility test', () => {
    const { app, registry } = createTestApp()

    const cases = generateTestCases('projects.index', app, registry)
    expect(cases.some((c) => c.name === 'route is accessible')).toBe(true)
  })

  test('defaults to the registry owned by the app', () => {
    const app = new Hono()
    effectRoutes(app).get('/owned', Effect.succeed(new Response('ok')), {
      name: 'owned.show',
    })

    const cases = generateTestCases('owned.show', app)
    expect(cases.some((testCase) => testCase.name === 'route is accessible')).toBe(true)
  })

  test('generates 404 test for routes with bindings', () => {
    const { app, registry } = createTestApp()

    const cases = generateTestCases('projects.show', app, registry)
    expect(cases.some((c) => c.name === 'returns 404 for non-existent resource')).toBe(true)
  })

  test('generates validation test for non-GET routes', () => {
    const { app, registry } = createTestApp()

    const cases = generateTestCases('projects.create', app, registry)
    expect(cases.some((c) => c.name === 'validates request body')).toBe(true)
  })

  test('returns empty array for unknown route', () => {
    const { app, registry } = createTestApp()

    const cases = generateTestCases('unknown', app, registry)
    expect(cases).toEqual([])
  })
})

describe('Test Request Options', () => {
  const { app, registry } = createTestApp()

  describeRoute('projects.index', app, registry, (routeTest) => {
    routeTest('supports query parameters', {
      query: { page: '2', limit: '10' },
      expect: { status: 200 },
    })

    routeTest('supports custom headers', {
      headers: { 'X-Custom': 'value' },
      expect: { status: 200 },
    })
  })

  describeRoute('projects.create', app, registry, (routeTest) => {
    routeTest('supports JSON body', {
      body: { name: 'Test', description: 'A test project' },
      expect: { status: 201 },
    })
  })
})

describe('Test Expectations - Headers', () => {
  const headersApp = new Hono()
  const headersRegistry = new RouteRegistry()

  headersApp.use('*', effectBridge())
  effectRoutes(headersApp, { registry: headersRegistry }).get(
    '/with-headers',
    Effect.succeed(
      new Response('OK', {
        headers: {
          'X-Custom': 'test-value',
          'Content-Type': 'text/plain',
        },
      })
    ),
    { name: 'headers.test' }
  )

  describeRoute('headers.test', headersApp, headersRegistry, (routeTest) => {
    routeTest('checks exact header value', {
      expect: {
        status: 200,
        headers: { 'X-Custom': 'test-value' },
      },
    })
  })
})

describe('Test Expectations - Regex Headers', () => {
  const dateApp = new Hono()
  const dateRegistry = new RouteRegistry()

  dateApp.use('*', effectBridge())
  effectRoutes(dateApp, { registry: dateRegistry }).get(
    '/with-date',
    Effect.succeed(
      new Response('OK', {
        headers: { 'X-Timestamp': '1234567890' },
      })
    ),
    { name: 'date.test' }
  )

  describeRoute('date.test', dateApp, dateRegistry, (routeTest) => {
    routeTest('checks header with regex', {
      expect: {
        status: 200,
        headers: { 'X-Timestamp': /^\d+$/ },
      },
    })
  })
})

describe('Test User Authentication', () => {
  const { app, registry } = createTestApp()

  describeRoute('projects.index', app, registry, (routeTest) => {
    routeTest('supports guest user', {
      as: 'guest',
      expect: { status: 200 },
    })

    routeTest('supports user type', {
      as: 'user',
      expect: { status: 200 },
    })

    routeTest('supports admin type', {
      as: 'admin',
      expect: { status: 200 },
    })

    routeTest('supports custom user object', {
      as: { id: 'custom-123', email: 'custom@test.com', role: 'superadmin' },
      expect: { status: 200 },
    })
  })
})
