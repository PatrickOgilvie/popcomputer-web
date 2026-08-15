/**
 * Effect Route Builder Tests
 */

import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { Effect, Layer, Context, Schema as S } from 'effect'
import { effectRoutes, EffectRouteBuilder } from '../../src/effect/routing.js'
import { honertia } from '../../src/middleware.js'
import { honertiaServices } from '../../src/request-context.js'
import { effectBridge, type EffectBridgeConfig } from '../../src/effect/bridge.js'
import {
  DatabaseService,
  HonertiaService,
  AuthUserService,
  type AuthUser,
} from '../../src/effect/services.js'
import { Redirect, UnauthorizedError } from '../../src/effect/errors.js'
import {
  EffectErrorObserverService,
  type EffectErrorEvent,
} from '../../src/effect/error-observer.js'
import { uuid } from '../../src/effect/schema.js'

interface TestDatabase {
  readonly name: string
}

declare module '../../src/effect/services.js' {
  interface WebDatabaseType {
    type: TestDatabase
  }
}

type TestEnv = {
  Variables: {
    authUser: AuthUser
  }
}

const ObservedTaggedError = S.Struct({ _tag: S.String })
const isObservedTaggedError = S.is(ObservedTaggedError)

// Helper to create test app
const createApp = <CustomServices = never>(
  bridgeConfig?: EffectBridgeConfig<TestEnv, CustomServices>
) => {
  const app = new Hono<TestEnv>()

  app.use(
    '*',
    honertia({
      version: '1.0.0',
      render: (page) => JSON.stringify(page),
    })
  )

  app.use('*', honertiaServices(() => ({ db: { name: 'test-db' } })))

  app.use('*', effectBridge(bridgeConfig))

  return app
}

const createAppWithoutBridge = () => {
  const app = new Hono<TestEnv>()

  app.use(
    '*',
    honertia({
      version: '1.0.0',
      render: (page) => JSON.stringify(page),
    })
  )

  app.use('*', honertiaServices(() => ({ db: { name: 'test-db' } })))

  return app
}

// Mock user
const createMockUser = (): AuthUser => ({
  user: {
    id: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  session: {
    id: 'session-456',
    userId: 'user-123',
    expiresAt: new Date(),
    token: 'token',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
})

describe('effectRoutes', () => {
  test('creates EffectRouteBuilder instance', () => {
    const app = new Hono()
    const builder = effectRoutes(app)

    expect(builder).toBeInstanceOf(EffectRouteBuilder)
  })
})

describe('route-level body validation parseOptions', () => {
  const postJson = <Body>(app: Hono<TestEnv>, body: Body) =>
    app.request('/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    })

  test('excess body properties are ignored by default', async () => {
    const app = createApp()

    effectRoutes(app).post('/users', Effect.succeed(new Response('Created')), {
      body: S.Struct({ name: S.String }),
    })

    const res = await postJson(app, { name: 'Test', role: 'admin' })
    expect(res.status).toBe(200)
  })

  test('excess body properties are rejected with onExcessProperty error', async () => {
    const app = createApp()

    effectRoutes(app).post('/users', Effect.succeed(new Response('Created')), {
      body: S.Struct({ name: S.String }),
      parseOptions: { onExcessProperty: 'error' },
    })

    const res = await postJson(app, { name: 'Test', role: 'admin' })
    expect(res.status).toBe(422)
  })
})

describe('Effect Route Error Observation', () => {
  test('observes validation failures exactly once', async () => {
    const events: EffectErrorEvent[] = []
    const app = createApp({
      services: () =>
        Layer.succeed(EffectErrorObserverService, {
          observe: (event) =>
            Effect.sync(() => {
              events.push(event)
            }),
        }),
    })

    effectRoutes(app).post(
      '/users',
      Effect.succeed(new Response('Created')),
      {
        body: S.Struct({ name: S.String }),
      }
    )

    const res = await app.request('/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(422)
    expect(events).toHaveLength(1)
    expect(events[0]?.source).toBe('framework')
    expect(events[0]?.handling).toBe('unhandled')
    expect(events[0]?.kind).toBe('failure')
    const observedError = events[0]?.error
    expect(isObservedTaggedError(observedError)).toBe(true)
    if (!isObservedTaggedError(observedError)) {
      throw new Error('Expected an observed tagged error')
    }
    expect(observedError._tag).toBe('ValidationError')
  })

  test('observes failures in the temp runtime path when no runtime is pre-installed', async () => {
    const events: EffectErrorEvent[] = []
    const app = createAppWithoutBridge()

    effectRoutes(app, {
      services: () =>
        Layer.succeed(EffectErrorObserverService, {
          observe: (event) =>
            Effect.sync(() => {
              events.push(event)
            }),
        }),
    }).get(
      '/temp-runtime',
      Effect.fail(new UnauthorizedError({ message: 'Login required' }))
    )

    const res = await app.request('/temp-runtime', {
      headers: { Accept: 'application/json' },
    })

    expect(res.status).toBe(401)
    expect(events).toHaveLength(1)
    expect(events[0]?.source).toBe('framework')
    expect(events[0]?.handling).toBe('unhandled')
    expect(events[0]?.kind).toBe('failure')
    const structured = events[0]?.structured
    expect(structured).toBeDefined()
    if (structured === undefined) {
      throw new Error('Expected structured error details')
    }
    expect(structured.httpStatus).toBe(401)
  })
})

describe('EffectRouteBuilder', () => {
  describe('Basic Routes', () => {
    test('registers GET route', async () => {
      const app = createApp()

      effectRoutes(app).get(
        '/hello',
        Effect.succeed(new Response('Hello World'))
      )

      const res = await app.request('/hello')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('Hello World')
    })

    test('registers POST route', async () => {
      const app = createApp()

      effectRoutes(app).post(
        '/submit',
        Effect.succeed(new Response('Submitted'))
      )

      const res = await app.request('/submit', { method: 'POST' })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('Submitted')
    })

    test('registers PUT route', async () => {
      const app = createApp()

      effectRoutes(app).put(
        '/update',
        Effect.succeed(new Response('Updated'))
      )

      const res = await app.request('/update', { method: 'PUT' })
      expect(res.status).toBe(200)
    })

    test('registers PATCH route', async () => {
      const app = createApp()

      effectRoutes(app).patch(
        '/patch',
        Effect.succeed(new Response('Patched'))
      )

      const res = await app.request('/patch', { method: 'PATCH' })
      expect(res.status).toBe(200)
    })

    test('registers DELETE route', async () => {
      const app = createApp()

      effectRoutes(app).delete(
        '/remove',
        Effect.succeed(new Response('Deleted'))
      )

      const res = await app.request('/remove', { method: 'DELETE' })
      expect(res.status).toBe(200)
    })

    test('registers ALL route', async () => {
      const app = createApp()

      effectRoutes(app).all('/any', Effect.succeed(new Response('Any method')))

      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        const res = await app.request('/any', { method })
        expect(res.status).toBe(200)
      }
    })
  })

  describe('Route Parameters', () => {
    test('handles route params', async () => {
      const app = createApp()

      effectRoutes(app).get(
        '/users/:id',
        Effect.gen(function* () {
          const honertia = yield* HonertiaService
          return yield* Effect.promise(() =>
            honertia.render('Users/Show', { userId: 'from-route' })
          )
        })
      )

      const res = await app.request('/users/123')
      expect(res.status).toBe(200)
    })

    test('handles multiple params', async () => {
      const app = createApp()

      effectRoutes(app).get(
        '/projects/:projectId/tasks/:taskId',
        Effect.succeed(new Response('OK'))
      )

      const res = await app.request('/projects/1/tasks/2')
      expect(res.status).toBe(200)
    })

    test('validates params schema and 404s invalid values', async () => {
      const app = createApp()

      effectRoutes(app).get(
        '/users/:id',
        Effect.succeed(new Response('Validated')),
        { params: S.Struct({ id: uuid }) }
      )

      const invalid = await app.request('/users/not-a-uuid')
      expect(invalid.status).toBe(404)

      const valid = await app.request(
        '/users/123e4567-e89b-12d3-a456-426614174000'
      )
      expect(valid.status).toBe(200)
      expect(await valid.text()).toBe('Validated')
    })
  })

  describe('prefix()', () => {
    test('applies path prefix to routes', async () => {
      const app = createApp()

      effectRoutes(app)
        .prefix('/api')
        .get('/users', Effect.succeed(new Response('Users list')))

      const res = await app.request('/api/users')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('Users list')
    })

    test('handles nested prefixes', async () => {
      const app = createApp()

      effectRoutes(app)
        .prefix('/api')
        .prefix('/v1')
        .get('/users', Effect.succeed(new Response('V1 Users')))

      const res = await app.request('/api/v1/users')
      expect(res.status).toBe(200)
    })

    test('handles root path with prefix', async () => {
      const app = createApp()

      effectRoutes(app)
        .prefix('/dashboard')
        .get('/', Effect.succeed(new Response('Dashboard home')))

      const res = await app.request('/dashboard')
      expect(res.status).toBe(200)
    })
  })

  describe('group()', () => {
    test('groups routes together', async () => {
      const app = createApp()

      effectRoutes(app).group((route) => {
        route.get('/a', Effect.succeed(new Response('A')))
        route.get('/b', Effect.succeed(new Response('B')))
        route.get('/c', Effect.succeed(new Response('C')))
      })

      expect((await app.request('/a')).status).toBe(200)
      expect((await app.request('/b')).status).toBe(200)
      expect((await app.request('/c')).status).toBe(200)
    })

    test('groups routes with prefix', async () => {
      const app = createApp()

      effectRoutes(app)
        .prefix('/admin')
        .group((route) => {
          route.get('/users', Effect.succeed(new Response('Admin users')))
          route.get('/settings', Effect.succeed(new Response('Admin settings')))
        })

      expect((await app.request('/admin/users')).status).toBe(200)
      expect((await app.request('/admin/settings')).status).toBe(200)
    })

    test('supports nested groups', async () => {
      const app = createApp()

      effectRoutes(app)
        .prefix('/api')
        .group((api) => {
          api.prefix('/users').group((users) => {
            users.get('/', Effect.succeed(new Response('List users')))
            users.get('/:id', Effect.succeed(new Response('Show user')))
          })
        })

      expect((await app.request('/api/users')).status).toBe(200)
      expect((await app.request('/api/users/123')).status).toBe(200)
    })
  })

  describe('provide()', () => {
    test('provides layer to all routes', async () => {
      const app = createApp()

      // Custom service
      class ConfigService extends Context.Service<
        ConfigService,
        { apiKey: string }
      >()('Config') {}

      const configLayer = Layer.succeed(ConfigService, { apiKey: 'secret' })

      effectRoutes(app)
        .provide(configLayer)
        .get(
          '/config',
          Effect.gen(function* () {
            const config = yield* ConfigService
            return new Response(`Key: ${config.apiKey}`)
          })
        )

      const res = await app.request('/config')
      expect(await res.text()).toBe('Key: secret')
    })

    test('supports context-aware layers that consume base services', async () => {
      const app = createApp()

      class SharedPropsReady extends Context.Service<
        SharedPropsReady,
        { orgCount: number }
      >()('SharedPropsReady') {}

      const sharedPropsLayer = Layer.effect(
        SharedPropsReady,
        Effect.gen(function* () {
          const db = yield* DatabaseService
          const honertia = yield* HonertiaService
          honertia.share('organizations', [{ id: 'org-1' }])
          return { orgCount: S.is(S.String)(db.name) ? 1 : 0 }
        })
      )

      effectRoutes(app)
        .provide(sharedPropsLayer)
        .get(
          '/context-aware-provide',
          Effect.gen(function* () {
            const shared = yield* SharedPropsReady
            const honertia = yield* HonertiaService
            return yield* Effect.promise(() =>
              honertia.render('Dashboard', { orgCount: shared.orgCount })
            )
          })
        )

      const res = await app.request('/context-aware-provide')
      const page = await res.json()

      expect(page.component).toBe('Dashboard')
      expect(page.props.orgCount).toBe(1)
      expect(page.props.organizations).toEqual([{ id: 'org-1' }])
    })

    test('supports cross-layer dependencies (.provide(A).provide(B needing A))', async () => {
      const app = createApp()

      class ServiceA extends Context.Service<ServiceA, { a: string }>()('CrossA') {}
      class ServiceB extends Context.Service<ServiceB, { derived: string }>()('CrossB') {}

      const layerA = Layer.succeed(ServiceA, { a: 'hello' })
      const layerB = Layer.effect(
        ServiceB,
        Effect.gen(function* () {
          const a = yield* ServiceA
          return { derived: a.a + '-world' }
        })
      )

      effectRoutes(app)
        .provide(layerA)
        .provide(layerB)
        .get(
          '/cross-layer',
          Effect.gen(function* () {
            const b = yield* ServiceB
            return new Response(b.derived)
          })
        )

      const res = await app.request('/cross-layer')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('hello-world')
    })

    test('provides multiple layers', async () => {
      const app = createApp()

      class ServiceA extends Context.Service<ServiceA, { a: string }>()('A') {}
      class ServiceB extends Context.Service<ServiceB, { b: string }>()('B') {}

      effectRoutes(app)
        .provide(Layer.succeed(ServiceA, { a: 'valueA' }))
        .provide(Layer.succeed(ServiceB, { b: 'valueB' }))
        .get(
          '/both',
          Effect.gen(function* () {
            const a = yield* ServiceA
            const b = yield* ServiceB
            return new Response(`${a.a}-${b.b}`)
          })
        )

      const res = await app.request('/both')
      expect(await res.text()).toBe('valueA-valueB')
    })

    test('layer errors are handled', async () => {
      const app = createApp()

      // Layer that fails with UnauthorizedError
      const failingLayer = Layer.effect(
        AuthUserService,
        Effect.fail(new UnauthorizedError({ message: 'Not logged in', redirectTo: '/login' }))
      )

      effectRoutes(app)
        .provide(failingLayer)
        .get('/protected', Effect.succeed(new Response('Protected')))

      const res = await app.request('/protected')
      // Should redirect to login
      expect(res.status).toBe(302)
      expect(res.headers.get('Location')).toBe('/login')
    })
  })

  describe('Service Access', () => {
    test('routes can access DatabaseService', async () => {
      const app = createApp()

      effectRoutes(app).get(
        '/db-test',
        Effect.gen(function* () {
          const db = yield* DatabaseService
          return new Response(JSON.stringify(db))
        })
      )

      const res = await app.request('/db-test')
      const json = await res.json()
      expect(json).toEqual({ name: 'test-db' })
    })

    test('routes can access HonertiaService', async () => {
      const app = createApp()

      effectRoutes(app).get(
        '/render-test',
        Effect.gen(function* () {
          const honertia = yield* HonertiaService
          return yield* Effect.promise(() =>
            honertia.render('Test', { data: 123 })
          )
        })
      )

      const res = await app.request('/render-test')
      const json = await res.json()
      expect(json.component).toBe('Test')
      expect(json.props.data).toBe(123)
    })
  })

  describe('Redirects', () => {
    test('handles Redirect return value', async () => {
      const app = createApp()

      effectRoutes(app).post(
        '/create',
        Effect.succeed(new Redirect({ url: '/created', status: 303 }))
      )

      const res = await app.request('/create', { method: 'POST' })
      expect(res.status).toBe(303)
      expect(res.headers.get('Location')).toBe('/created')
    })
  })

  describe('Error Handling', () => {
    test('handles Effect failures', async () => {
      const app = createApp()

      effectRoutes(app).get(
        '/error',
        Effect.fail(new UnauthorizedError({ message: 'No access' }))
      )

      const res = await app.request('/error')
      expect(res.status).toBe(302)
    })

    test('handles Effect failures gracefully', async () => {
      const app = createApp()

      effectRoutes(app).get(
        '/error',
        Effect.fail(new UnauthorizedError({ message: 'Access denied' }))
      )

      const res = await app.request('/error')
      // Redirects to /login
      expect(res.status).toBe(302)
    })
  })
})

describe('Real-world Patterns', () => {
  test('CRUD routes pattern', async () => {
    const app = createApp()

    effectRoutes(app)
      .prefix('/projects')
      .group((route) => {
        route.get('/', Effect.succeed(new Response('List')))
        route.post('/', Effect.succeed(new Redirect({ url: '/projects', status: 303 })))
        route.get('/create', Effect.succeed(new Response('Create form')))
        route.get('/:id', Effect.succeed(new Response('Show')))
        route.get('/:id/edit', Effect.succeed(new Response('Edit form')))
        route.put('/:id', Effect.succeed(new Redirect({ url: '/projects', status: 303 })))
        route.delete('/:id', Effect.succeed(new Redirect({ url: '/projects', status: 303 })))
      })

    expect((await app.request('/projects')).status).toBe(200)
    expect((await app.request('/projects', { method: 'POST' })).status).toBe(303)
    expect((await app.request('/projects/create')).status).toBe(200)
    expect((await app.request('/projects/1')).status).toBe(200)
    expect((await app.request('/projects/1/edit')).status).toBe(200)
    expect((await app.request('/projects/1', { method: 'PUT' })).status).toBe(303)
    expect((await app.request('/projects/1', { method: 'DELETE' })).status).toBe(303)
  })

  test('API with versioning', async () => {
    const app = createApp()

    // V1 API
    effectRoutes(app)
      .prefix('/api/v1')
      .group((route) => {
        route.get('/users', Effect.succeed(new Response('V1 users')))
      })

    // V2 API
    effectRoutes(app)
      .prefix('/api/v2')
      .group((route) => {
        route.get('/users', Effect.succeed(new Response('V2 users')))
      })

    const v1 = await app.request('/api/v1/users')
    expect(await v1.text()).toBe('V1 users')

    const v2 = await app.request('/api/v2/users')
    expect(await v2.text()).toBe('V2 users')
  })

  test('mixed authenticated and public routes', async () => {
    const app = createApp()

    // Add mock auth user for protected routes
    app.use('/dashboard/*', async (c, next) => {
      c.set('authUser', createMockUser())
      await next()
    })

    // Public routes
    effectRoutes(app).group((route) => {
      route.get('/', Effect.succeed(new Response('Home')))
      route.get('/about', Effect.succeed(new Response('About')))
    })

    // Protected routes
    effectRoutes(app)
      .prefix('/dashboard')
      .group((route) => {
        route.get('/', Effect.succeed(new Response('Dashboard')))
        route.get('/settings', Effect.succeed(new Response('Settings')))
      })

    expect((await app.request('/')).status).toBe(200)
    expect((await app.request('/about')).status).toBe(200)
    expect((await app.request('/dashboard')).status).toBe(200)
    expect((await app.request('/dashboard/settings')).status).toBe(200)
  })
})
