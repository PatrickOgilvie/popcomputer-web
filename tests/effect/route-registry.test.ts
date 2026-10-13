import { Layer } from 'effect'
import assert from 'node:assert/strict'
/**
 * Route Registry Tests
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { Effect } from 'effect'
import {
  RouteRegistry,
  getAppRouteRegistry,
  effectRoutes,
} from '../../src/effect/index.js'
import { web } from '../../src/middleware.js'
import { effectBridge } from '../../src/effect/bridge.js'

// Helper to create test app
const createApp = () => {
  const app = new Hono()
  app.use(
    '*',
    web({
      version: '1.0.0',
      render: (page) => JSON.stringify(page),
    })
  )
  app.use('*', effectBridge())

  return app
}

describe('RouteRegistry', () => {
  describe('Basic Operations', () => {
    test('starts empty', () => {
      const registry = new RouteRegistry()
      expect(registry.count()).toBe(0)
      expect(registry.all()).toEqual([])
    })

    test('registers routes', () => {
      const registry = new RouteRegistry()
      registry.register({
        method: 'get',
        path: '/projects/{project}',
        honoPath: '/projects/:project',
        fullPath: '/projects/:project',
        bindings: [{ param: 'project', column: 'id' }],
        prefix: '',
      })

      expect(registry.count()).toBe(1)
      expect(registry.all()[0].method).toBe('get')
      expect(registry.all()[0].path).toBe('/projects/{project}')
    })

  })

  describe('Finding Routes', () => {
    let registry: RouteRegistry

    beforeEach(() => {
      registry = new RouteRegistry()
      registry.register({
        method: 'get',
        path: '/projects',
        honoPath: '/projects',
        fullPath: '/projects',
        bindings: [],
        prefix: '',
        name: 'projects.index',
      })
      registry.register({
        method: 'post',
        path: '/projects',
        honoPath: '/projects',
        fullPath: '/projects',
        bindings: [],
        prefix: '',
        name: 'projects.store',
      })
      registry.register({
        method: 'get',
        path: '/projects/{project}',
        honoPath: '/projects/:project',
        fullPath: '/projects/:project',
        bindings: [{ param: 'project', column: 'id' }],
        prefix: '',
        name: 'projects.show',
      })
      registry.register({
        method: 'get',
        path: '/users',
        honoPath: '/users',
        fullPath: '/api/users',
        bindings: [],
        prefix: '/api',
        name: 'users.index',
      })
    })

    test('findByName returns correct route', () => {
      const route = registry.findByName('projects.show')
      expect(route).toBeDefined()
      assert.ok(route)
      expect(route.path).toBe('/projects/{project}')
    })

    test('findByName returns undefined for unknown name', () => {
      const route = registry.findByName('unknown')
      expect(route).toBeUndefined()
    })

    test('find filters by method', () => {
      const routes = registry.find({ method: 'get' })
      expect(routes.length).toBe(3)
      expect(routes.every((r) => r.method === 'get')).toBe(true)
    })

    test('find filters by prefix', () => {
      const routes = registry.find({ prefix: '/api' })
      expect(routes.length).toBe(1)
      expect(routes[0].name).toBe('users.index')
    })

    test('find filters by name', () => {
      const routes = registry.find({ name: 'projects.store' })
      expect(routes.length).toBe(1)
      expect(routes[0].method).toBe('post')
    })

    test('find filters by pathPattern', () => {
      const routes = registry.find({ pathPattern: '/projects/*' })
      expect(routes.length).toBe(1)
      expect(routes[0].name).toBe('projects.show')
    })

    test('has checks existence by path', () => {
      expect(registry.has('/projects')).toBe(true)
      expect(registry.has('/unknown')).toBe(false)
    })

    test('has checks existence by path and method', () => {
      expect(registry.has('/projects', 'get')).toBe(true)
      expect(registry.has('/projects', 'delete')).toBe(false)
    })
  })

  describe('JSON Serialization', () => {
    test('toJson converts routes to serializable format', () => {
      const registry = new RouteRegistry()
      registry.register({
        method: 'get',
        path: '/projects/{project}',
        honoPath: '/projects/:project',
        fullPath: '/projects/:project',
        bindings: [{ param: 'project', column: 'id' }],
        prefix: '',
        name: 'projects.show',
      })

      const json = registry.toJson()
      expect(json).toEqual([
        {
          method: 'get',
          path: '/projects/{project}',
          fullPath: '/projects/:project',
          bindings: [{ param: 'project', column: 'id' }],
          name: 'projects.show',
        },
      ])
    })

    test('toJson is JSON.stringify compatible', () => {
      const registry = new RouteRegistry()
      registry.register({
        method: 'post',
        path: '/submit',
        honoPath: '/submit',
        fullPath: '/submit',
        bindings: [],
        prefix: '',
      })

      const json = registry.toJson()
      const stringified = JSON.stringify(json)
      const parsed = JSON.parse(stringified)
      expect(parsed).toEqual(json)
    })
  })

})

describe('effectRoutes Integration', () => {
  test('routes are registered with the app-owned registry by default', () => {
    const app = createApp()

    effectRoutes(app).get('/hello', Effect.succeed(new Response('Hello')))
    effectRoutes(app).post('/submit', Effect.succeed(new Response('OK')))

    const registry = getAppRouteRegistry(app)
    expect(registry.count()).toBe(2)
    expect(registry.has('/hello', 'get')).toBe(true)
    expect(registry.has('/submit', 'post')).toBe(true)
  })

  test('routes can use custom registry', () => {
    const app = createApp()
    const customRegistry = new RouteRegistry()

    effectRoutes(app, { registry: customRegistry }).get(
      '/custom',
      Effect.succeed(new Response('Custom'))
    )

    expect(customRegistry.count()).toBe(1)
    expect(getAppRouteRegistry(app).count()).toBe(0)
  })

  test('getRegistry returns the registry', () => {
    const app = createApp()
    const customRegistry = new RouteRegistry()

    const builder = effectRoutes(app, { registry: customRegistry })
    expect(builder.getRegistry()).toBe(customRegistry)
  })

  test('prefix is included in registry metadata', () => {
    const app = createApp()

    effectRoutes(app)
      .prefix('/api')
      .get('/projects', Effect.succeed(new Response('Projects')))

    const registry = getAppRouteRegistry(app)
    const route = registry.all()[0]
    expect(route.prefix).toBe('/api')
    expect(route.fullPath).toBe('/api/projects')
  })

  test('bindings are captured in registry', () => {
    const app = createApp()

    effectRoutes(app).get(
      '/projects/{project}/tasks/{task:slug}',
      Effect.succeed(new Response('OK'))
    )

    const registry = getAppRouteRegistry(app)
    const route = registry.all()[0]
    expect(route.bindings).toEqual([
      { param: 'project', column: 'id' },
      { param: 'task', column: 'slug' },
    ])
  })

  test('named routes are captured', () => {
    const app = createApp()

    effectRoutes(app).get('/projects', Effect.succeed(new Response('OK')), {
      name: 'projects.index',
    })

    const registry = getAppRouteRegistry(app)
    const route = registry.findByName('projects.index')
    expect(route).toBeDefined()
    assert.ok(route)
    expect(route.path).toBe('/projects')
  })

  test('provide passes registry to new builder', () => {
    const app = createApp()
    const customRegistry = new RouteRegistry()

    const builder = effectRoutes(app, { registry: customRegistry })

    // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
    const providedBuilder = builder.provide(
      // Dummy layer
      Layer.empty
    )

    expect(providedBuilder.getRegistry()).toBe(customRegistry)
  })

  test('prefix passes registry to new builder', () => {
    const app = createApp()
    const customRegistry = new RouteRegistry()

    const builder = effectRoutes(app, { registry: customRegistry })
    const prefixedBuilder = builder.prefix('/api')

    expect(prefixedBuilder.getRegistry()).toBe(customRegistry)
  })
})
