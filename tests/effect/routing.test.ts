/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Effect Route Builder Tests
 */

import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import type { Env } from 'hono'
import { Effect, Layer, Context, Schema as S } from 'effect'
import { effectRoutes } from '../../src/effect/routing.js'
import { web } from '../../src/middleware.js'
import { webServices } from '../../src/request-context.js'
import { effectBridge, type EffectBridgeConfig } from '../../src/effect/bridge.js'
import {
  DatabaseService,
  PageService,
  AuthUserService,
} from '../../src/effect/services.js'
import { Redirect, UnauthorizedError } from '../../src/effect/errors.js'
import {
  EffectErrorObserverService,
  type EffectErrorEvent,
} from '../../src/effect/error-observer.js'
import { uuid } from '../../src/effect/schema.js'
import { validateRequest } from '../../src/effect/validation.js'
import type { WebDeclaration } from '../../src/effect/register.js'

interface TestDatabase {
  readonly name: string
}

declare module '../../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{
      database: TestDatabase
    }>
  }
}

const ObservedTaggedError = S.Struct({ _tag: S.String })

const isObservedTaggedError = S.is(ObservedTaggedError)

// Helper to create test app
const createApp = <CustomServices = never>(
  bridgeConfig?: EffectBridgeConfig<Env, CustomServices>
) => {
  const app = new Hono<Env>()

  app.use(
    '*',
    web({
      version: '1.0.0',
      render: (page) => JSON.stringify(page),
    })
  )

  app.use('*', webServices(() => ({ db: { name: 'test-db' } })))

  app.use('*', effectBridge(bridgeConfig))

  return app
}

const createAppWithoutBridge = () => {
  const app = new Hono<Env>()

  app.use(
    '*',
    web({
      version: '1.0.0',
      render: (page) => JSON.stringify(page),
    })
  )

  app.use('*', webServices(() => ({ db: { name: 'test-db' } })))

  return app
}

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
      Effect.gen(function* () {
        yield* validateRequest(S.Struct({ name: S.String }))

        return new Response('Created')
      })
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
    test('route registrations chain on the same builder', async () => {
      const app = createApp()

      effectRoutes(app)
        .prefix('/chained')
        .get('/first', Effect.succeed(new Response('first')))
        .post('/second', Effect.succeed(new Response('second')))
        .group((route) => {
          route.put('/third', Effect.succeed(new Response('third')))
        })
        .delete('/fourth', Effect.succeed(new Response('fourth')))

      const first = await app.request('/chained/first')
      const second = await app.request('/chained/second', { method: 'POST' })
      const third = await app.request('/chained/third', { method: 'PUT' })
      const fourth = await app.request('/chained/fourth', { method: 'DELETE' })

      expect(await first.text()).toBe('first')
      expect(await second.text()).toBe('second')
      expect(await third.text()).toBe('third')
      expect(await fourth.text()).toBe('fourth')
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
          const { id } = yield* validateRequest(S.Struct({ id: S.String }))

          return new Response(`User ${id}`)
        })
      )

      const res = await app.request('/users/123')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('User 123')
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

    test('registers a whole declared path that starts with the prefix as it is', async () => {
      const app = createApp()

      effectRoutes(app)
        .prefix('/orgs/{org}')
        .get('/orgs/{org}/settings', Effect.succeed(new Response('Settings')))
        .get('/orgs/{org}', Effect.succeed(new Response('Org home')))

      expect(await (await app.request('/orgs/acme/settings')).text()).toBe('Settings')
      expect(await (await app.request('/orgs/acme')).text()).toBe('Org home')
      expect((await app.request('/orgs/acme/orgs/acme/settings')).status).toBe(404)
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
          const page = yield* PageService
          page.share('organizations', [{ id: 'org-1' }])

          return { orgCount: S.is(S.String)(db.name) ? 1 : 0 }
        })
      )

      effectRoutes(app)
        .provide(sharedPropsLayer)
        .get(
          '/context-aware-provide',
          Effect.gen(function* () {
            const shared = yield* SharedPropsReady
            const page = yield* PageService

            return yield* Effect.promise(() =>
              page.render('Dashboard', { orgCount: shared.orgCount })
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
    test('routes can access PageService', async () => {
      const app = createApp()

      effectRoutes(app).get(
        '/render-test',
        Effect.gen(function* () {
          const page = yield* PageService

          return yield* Effect.promise(() =>
            page.render('Test', { data: 123 })
          )
        })
      )

      const res = await app.request('/render-test')
      const json = await res.json()
      expect(json.component).toBe('Test')
      expect(json.props.data).toBe(123)
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
        route.post('/', Effect.succeed(new Redirect({ url: '/projects/stored', status: 303 })))
        route.get('/create', Effect.succeed(new Response('Create form')))
        route.get('/:id', Effect.succeed(new Response('Show')))
        route.get('/:id/edit', Effect.succeed(new Response('Edit form')))
        route.put('/:id', Effect.succeed(new Redirect({ url: '/projects/updated', status: 303 })))
        route.delete('/:id', Effect.succeed(new Redirect({ url: '/projects/destroyed', status: 303 })))
      })

    const location = async (path: string, method: string) => {
      const res = await app.request(path, { method })
      expect(res.status).toBe(303)
      return res.headers.get('Location')
    }

    expect(await (await app.request('/projects')).text()).toBe('List')
    expect(await location('/projects', 'POST')).toBe('/projects/stored')
    expect(await (await app.request('/projects/create')).text()).toBe('Create form')
    expect(await (await app.request('/projects/1')).text()).toBe('Show')
    expect(await (await app.request('/projects/1/edit')).text()).toBe('Edit form')
    expect(await location('/projects/1', 'PUT')).toBe('/projects/updated')
    expect(await location('/projects/1', 'DELETE')).toBe('/projects/destroyed')
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

})

describe('a route an earlier route answers first', () => {
  const ok = Effect.succeed(new Response('ok'))

  test('is refused at registration, naming the order that works', () => {
    const routes = effectRoutes(new Hono()).get('/products/{product}', ok)

    expect(() => routes.get('/products/new', ok)).toThrow(
      'GET /products/new is registered after GET /products/{product}, whose path matches it, so it is never reached'
    )
  })

  test('is allowed before the placeholder path, for another method, or one segment longer', () => {
    const routes = effectRoutes(new Hono())
      .get('/products/new', ok)
      .get('/products/{product}', ok)
      .post('/products/import', ok)
      .get('/products/{product}/edit', ok)

    expect(routes.getRegistry().all().map((route) => route.path)).toEqual([
      '/products/new',
      '/products/{product}',
      '/products/import',
      '/products/{product}/edit',
    ])
  })

  test('registered twice is refused as such', () => {
    const routes = effectRoutes(new Hono()).get('/products/new', ok)

    expect(() => routes.get('/products/new', ok)).toThrow('GET /products/new is registered twice')
  })

  test('is refused under a catch-all registered for every method', () => {
    const routes = effectRoutes(new Hono()).all('/api/auth/*', ok)

    expect(() => routes.get('/api/auth/session', ok)).toThrow('Register /api/auth/session before /api/auth/*')
  })
})
