/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Custom Services Tests
 *
 * Tests for injecting custom services via effectBridge and effectRoutes.
 * This feature allows users to inject Cloudflare Worker bindings and
 * other application-specific services into Effect handlers.
 */

import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { Effect, Layer, Context } from 'effect'
import type { PageProps } from '../../src/types.js'
import { effectRoutes } from '../../src/effect/routing.js'
import { effectBridge, buildContextLayer } from '../../src/effect/bridge.js'
import { honertia } from '../../src/middleware.js'
import { honertiaServices } from '../../src/request-context.js'
import { setupHonertia } from '../../src/setup.js'
import { DatabaseService } from '../../src/effect/services.js'

// =============================================================================
// Custom Service Definitions (simulating Cloudflare Worker bindings)
// =============================================================================

/**
 * Simulates Cloudflare KV namespace bindings
 */
class BindingsService extends Context.Service<
  BindingsService,
  {
    KV: { get: (key: string) => Promise<string | null> }
    ANALYTICS: { writeDataPoint: (data: PageProps) => void }
  }
>()('app/Bindings') {}

/**
 * Simulates a custom logger service
 */
class LoggerService extends Context.Service<
  LoggerService,
  {
    log: (message: string) => void
    logs: string[]
  }
>()('app/Logger') {}

/**
 * Simulates a feature flags service
 */
class FeatureFlagsService extends Context.Service<
  FeatureFlagsService,
  {
    isEnabled: (flag: string) => boolean
  }
>()('app/FeatureFlags') {}

// =============================================================================
// Test Helpers
// =============================================================================

type TestEnv = {
  Bindings: {
    KV_DATA: Record<string, string>
    FEATURES: string[]
  }
  Variables: { testResult: string }
}

const createTestApp = () => {
  const app = new Hono<TestEnv>()

  app.use(
    '*',
    honertia({
      version: '1.0.0',
      render: (page) => JSON.stringify(page),
    })
  )

  // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
  app.use('*', honertiaServices(() => ({ db: { name: 'test-db' } as never })))
  app.use('*', async (c, next) => {
    // Simulate Cloudflare Worker bindings
    // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
    // oxlint-disable-next-line no-param-reassign -- This middleware supplies the Worker binding fixture consumed by the bridge.
    c.env = {
      KV_DATA: { 'user:123': 'John Doe', 'config:theme': 'dark' },
      FEATURES: ['new-dashboard', 'beta-api'],
    }
    await next()
  })

  return app
}

// Mock KV implementation
const createMockKV = (data: Record<string, string>) => ({
  get: async (key: string) => data[key] ?? null,
})

// Mock Analytics implementation
const createMockAnalytics = () => {
  const dataPoints: PageProps[] = []

  return {
    writeDataPoint: (data: PageProps) => dataPoints.push(data),
    getDataPoints: () => dataPoints,
  }
}

// Mock Logger implementation
const createMockLogger = () => {
  const logs: string[] = []

  return {
    log: (message: string) => logs.push(message),
    logs,
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('Custom Services via effectBridge', () => {
  test('injects single custom service', async () => {
    const app = createTestApp()

    app.use(
      '*',
      effectBridge<TestEnv, BindingsService>({
        services: (c) =>
          Layer.succeed(BindingsService, {
            KV: createMockKV(c.env.KV_DATA),
            ANALYTICS: createMockAnalytics(),
          }),
      })
    )

    effectRoutes(app).get(
      '/user/:id',
      Effect.gen(function* () {
        const bindings = yield* BindingsService
        const name = yield* Effect.tryPromise(() => bindings.KV.get('user:123'))

        return new Response(`User: ${name}`)
      })
    )

    const res = await app.request('/user/123')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('User: John Doe')
  })

  test('injects multiple custom services using Layer.mergeAll', async () => {
    const app = createTestApp()

    app.use(
      '*',
      effectBridge<TestEnv, BindingsService | LoggerService>({
        services: (c) =>
          Layer.mergeAll(
            Layer.succeed(BindingsService, {
              KV: createMockKV(c.env.KV_DATA),
              ANALYTICS: createMockAnalytics(),
            }),
            Layer.succeed(LoggerService, createMockLogger())
          ),
      })
    )

    effectRoutes(app).get(
      '/test',
      Effect.gen(function* () {
        const bindings = yield* BindingsService
        const logger = yield* LoggerService

        const theme = yield* Effect.tryPromise(() =>
          bindings.KV.get('config:theme')
        )

        logger.log(`Theme loaded: ${theme}`)

        return Response.json({
            theme,
            logCount: logger.logs.length,
          })
      })
    )

    const res = await app.request('/test')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.theme).toBe('dark')
    expect(json.logCount).toBe(1)
  })

  test('custom services work alongside built-in services', async () => {
    const app = new Hono<TestEnv>()

    app.use(
      '*',
      honertia({
        version: '1.0.0',
        render: (page) => JSON.stringify(page),
      })
    )

    // Simulate Cloudflare Worker bindings and set up db
    // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
    app.use('*', honertiaServices(() => ({ db: { name: 'custom-db' } as never })))
    app.use('*', async (c, next) => {
      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      // oxlint-disable-next-line no-param-reassign -- This middleware supplies the Worker binding fixture consumed by the bridge.
      c.env = {
        KV_DATA: { 'user:123': 'John Doe', 'config:theme': 'dark' },
        FEATURES: ['new-dashboard', 'beta-api'],
      }
      await next()
    })

    // Use effectRoutes with custom services config (db is read from c.var.db)
    effectRoutes<TestEnv, BindingsService>(app, {
      services: (c) =>
        Layer.succeed(BindingsService, {
          KV: createMockKV(c.env.KV_DATA),
          ANALYTICS: createMockAnalytics(),
        }),
    }).get(
      '/combined',
      Effect.gen(function* () {
        const db = yield* DatabaseService
        const bindings = yield* BindingsService

        const userName = yield* Effect.tryPromise(() =>
          bindings.KV.get('user:123')
        )

        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        return Response.json({
            dbName: (db).name,
            userName,
          })
      })
    )

    const res = await app.request('/combined')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.dbName).toBe('custom-db')
    expect(json.userName).toBe('John Doe')
  })
})

describe('Custom Services via setupHonertia', () => {
  test('injects custom services via effect config', async () => {
    const app = new Hono<TestEnv>()

    // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
    app.use('*', honertiaServices(() => ({ db: { name: 'test-db' } as never })))
    app.use('*', async (c, next) => {
      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      // oxlint-disable-next-line no-param-reassign -- This middleware supplies the Worker binding fixture consumed by the bridge.
      c.env = {
        KV_DATA: { 'user:123': 'John Doe', 'config:theme': 'dark' },
        FEATURES: ['new-dashboard', 'beta-api'],
      }
      await next()
    })

    app.use(
      '*',
      setupHonertia<TestEnv, unknown, BindingsService>({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
        },
        effect: {
          services: (c) =>
            Layer.succeed(BindingsService, {
              KV: createMockKV(c.env.KV_DATA),
              ANALYTICS: createMockAnalytics(),
            }),
        },
      })
    )

    effectRoutes(app).get(
      '/setup-honertia',
      Effect.gen(function* () {
        const bindings = yield* BindingsService
        const name = yield* Effect.tryPromise(() => bindings.KV.get('user:123'))

        return new Response(name ?? 'missing')
      })
    )

    const res = await app.request('/setup-honertia')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('John Doe')
  })
})

describe('Custom Services via effectRoutes config', () => {
  test('injects custom service via effectRoutes config', async () => {
    const app = createTestApp()
    app.use('*', effectBridge())

    effectRoutes<TestEnv, FeatureFlagsService>(app, {
      services: (c) =>
        Layer.succeed(FeatureFlagsService, {
          isEnabled: (flag: string) => c.env.FEATURES.includes(flag),
        }),
    }).get(
      '/feature-check',
      Effect.gen(function* () {
        const flags = yield* FeatureFlagsService

        return Response.json({
            newDashboard: flags.isEnabled('new-dashboard'),
            oldFeature: flags.isEnabled('old-feature'),
          })
      })
    )

    const res = await app.request('/feature-check')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.newDashboard).toBe(true)
    expect(json.oldFeature).toBe(false)
  })

  test('effectRoutes config services work with prefix and group', async () => {
    const app = createTestApp()
    app.use('*', effectBridge())

    effectRoutes<TestEnv, BindingsService>(app, {
      services: (c) =>
        Layer.succeed(BindingsService, {
          KV: createMockKV(c.env.KV_DATA),
          ANALYTICS: createMockAnalytics(),
        }),
    })
      .prefix('/api')
      .group((route) => {
        route.get(
          '/kv/:key',
          Effect.gen(function* () {
            const bindings = yield* BindingsService

            const value = yield* Effect.tryPromise(() =>
              bindings.KV.get('user:123')
            )

            return new Response(value ?? 'not found')
          })
        )
      })

    const res = await app.request('/api/kv/user:123')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('John Doe')
  })

  test('effectRoutes config services work with provide()', async () => {
    const app = createTestApp()
    app.use('*', effectBridge())

    // Additional layer provided via provide()
    class RequestIdService extends Context.Service<
      RequestIdService,
      { id: string }
    >()('RequestId') {}

    effectRoutes<TestEnv, BindingsService>(app, {
      services: (c) =>
        Layer.succeed(BindingsService, {
          KV: createMockKV(c.env.KV_DATA),
          ANALYTICS: createMockAnalytics(),
        }),
    })
      .provide(Layer.succeed(RequestIdService, { id: 'req-456' }))
      .get(
        '/with-request-id',
        Effect.gen(function* () {
          const bindings = yield* BindingsService
          const requestId = yield* RequestIdService

          const userName = yield* Effect.tryPromise(() =>
            bindings.KV.get('user:123')
          )

          return Response.json({
              requestId: requestId.id,
              userName,
            })
        })
      )

    const res = await app.request('/with-request-id')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.requestId).toBe('req-456')
    expect(json.userName).toBe('John Doe')
  })

  test('works without effectBridge middleware', async () => {
    const app = createTestApp()

    effectRoutes<TestEnv, BindingsService>(app, {
      services: (c) =>
        Layer.succeed(BindingsService, {
          KV: createMockKV(c.env.KV_DATA),
          ANALYTICS: createMockAnalytics(),
        }),
    }).get(
      '/no-bridge',
      Effect.gen(function* () {
        const bindings = yield* BindingsService

        const theme = yield* Effect.tryPromise(() =>
          bindings.KV.get('config:theme')
        )

        return new Response(theme ?? 'missing')
      })
    )

    const res = await app.request('/no-bridge')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('dark')
  })
})

describe('buildContextLayer with custom services', () => {
  test('buildContextLayer includes custom services in return type', async () => {
    const app = createTestApp()

    app.use('*', async (c, next) => {
      const layer = buildContextLayer<TestEnv, BindingsService>(c, {
        services: (ctx) =>
          Layer.succeed(BindingsService, {
            KV: createMockKV(ctx.env.KV_DATA),
            ANALYTICS: createMockAnalytics(),
          }),
      })

      // Verify the layer can be used to run an effect requiring BindingsService
      const program = Effect.gen(function* () {
        const bindings = yield* BindingsService

        return yield* Effect.tryPromise(() => bindings.KV.get('user:123'))
      }).pipe(Effect.provide(layer))

      const result = await Effect.runPromise(program)
      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      c.set('testResult', result)
      await next()
    })

    app.get('/test', (c) => {
      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      return c.text(c.get('testResult'))
    })

    const res = await app.request('/test')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('John Doe')
  })
})

describe('Real-world Cloudflare Workers patterns', () => {
  test('simulates D1 database binding', async () => {
    const app = createTestApp()

    // Simulate D1 binding
    class D1Service extends Context.Service<
      D1Service,
      {
        prepare: (sql: string) => {
          bind: (...params: unknown[]) => {
            first: <T>() => Promise<T | null>
            all: <T>() => Promise<{ results: T[] }>
          }
        }
      }
    >()('cf/D1') {}

    // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
    const mockD1 = {
      prepare: (sql: string) => ({
        bind: (...params: unknown[]) => ({
          first: async <T>() =>
            ({ id: 1, name: 'Test Project', sql, params }) as T,
          all: async <T>() => ({ results: [{ id: 1 }, { id: 2 }] as T[] }),
        }),
      }),
    }

    app.use(
      '*',
      effectBridge<TestEnv, D1Service>({
        services: () => Layer.succeed(D1Service, mockD1),
      })
    )

    effectRoutes(app).get(
      '/projects/:id',
      Effect.gen(function* () {
        const d1 = yield* D1Service

        const project = yield* Effect.tryPromise(() =>
          d1.prepare('SELECT * FROM projects WHERE id = ?').bind(1).first<{
            id: number
            name: string
          }>()
        )

        return Response.json(project)
      })
    )

    const res = await app.request('/projects/1')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.id).toBe(1)
    expect(json.name).toBe('Test Project')
  })

  test('simulates Analytics Engine binding', async () => {
    const app = createTestApp()
    const writtenDataPoints: PageProps[] = []

    class AnalyticsService extends Context.Service<
      AnalyticsService,
      {
        writeDataPoint: (data: {
          blobs?: string[]
          doubles?: number[]
          indexes?: string[]
        }) => void
      }
    >()('cf/Analytics') {}

    app.use(
      '*',
      effectBridge<TestEnv, AnalyticsService>({
        services: () =>
          Layer.succeed(AnalyticsService, {
            writeDataPoint: (data) => writtenDataPoints.push(data),
          }),
      })
    )

    effectRoutes(app).post(
      '/track',
      Effect.gen(function* () {
        const analytics = yield* AnalyticsService

        analytics.writeDataPoint({
          blobs: ['page_view', '/home'],
          doubles: [1],
          indexes: ['user-123'],
        })

        return new Response('tracked')
      })
    )

    const res = await app.request('/track', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(writtenDataPoints).toHaveLength(1)
    expect(writtenDataPoints[0]).toEqual({
      blobs: ['page_view', '/home'],
      doubles: [1],
      indexes: ['user-123'],
    })
  })

  test('simulates Queue binding', async () => {
    const app = createTestApp()
    const queuedMessages: { body: unknown; options?: object }[] = []

    class QueueService extends Context.Service<
      QueueService,
      {
        send: <Body>(body: Body, options?: { contentType?: string }) => Promise<void>
        sendBatch: (messages: { body: unknown }[]) => Promise<void>
      }
    >()('cf/Queue') {}

    app.use(
      '*',
      effectBridge<TestEnv, QueueService>({
        services: () =>
          Layer.succeed(QueueService, {
            send: async (body, options) => {
              queuedMessages.push({ body, options })
            },
            sendBatch: async (messages) => {
              messages.forEach((m) => queuedMessages.push({ body: m.body }))
            },
          }),
      })
    )

    effectRoutes(app).post(
      '/enqueue',
      Effect.gen(function* () {
        const queue = yield* QueueService

        yield* Effect.tryPromise(() =>
          queue.send(
            { type: 'email', to: 'user@example.com' },
            { contentType: 'json' }
          )
        )

        return new Response('queued')
      })
    )

    const res = await app.request('/enqueue', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(queuedMessages).toHaveLength(1)
    expect(queuedMessages[0].body).toEqual({
      type: 'email',
      to: 'user@example.com',
    })
  })
})

describe('Edge cases', () => {
  test('works without custom services (backward compatibility)', async () => {
    const app = createTestApp()

    app.use('*', effectBridge())

    effectRoutes(app).get(
      '/simple',
      Effect.gen(function* () {
        const db = yield* DatabaseService

        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        return new Response(`DB: ${(db).name}`)
      })
    )

    const res = await app.request('/simple')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('DB: test-db')
  })

  test('custom services are isolated per request', async () => {
    const app = createTestApp()
    let requestCount = 0

    class RequestCounterService extends Context.Service<
      RequestCounterService,
      { count: number }
    >()('RequestCounter') {}

    app.use(
      '*',
      effectBridge<TestEnv, RequestCounterService>({
        services: () => {
          requestCount++

          return Layer.succeed(RequestCounterService, { count: requestCount })
        },
      })
    )

    effectRoutes(app).get(
      '/count',
      Effect.gen(function* () {
        const counter = yield* RequestCounterService

        return new Response(`Count: ${counter.count}`)
      })
    )

    const res1 = await app.request('/count')
    expect(await res1.text()).toBe('Count: 1')

    const res2 = await app.request('/count')
    expect(await res2.text()).toBe('Count: 2')

    const res3 = await app.request('/count')
    expect(await res3.text()).toBe('Count: 3')
  })

  test('services function receives full Hono context', async () => {
    const app = createTestApp()

    class ContextInfoService extends Context.Service<
      ContextInfoService,
      { method: string; path: string; hasEnv: boolean }
    >()('ContextInfo') {}

    app.use(
      '*',
      effectBridge<TestEnv, ContextInfoService>({
        services: (c) =>
          Layer.succeed(ContextInfoService, {
            method: c.req.method,
            path: c.req.path,
            hasEnv: c.env !== undefined,
          }),
      })
    )

    effectRoutes(app).get(
      '/context-info',
      Effect.gen(function* () {
        const info = yield* ContextInfoService

        return Response.json(info)
      })
    )

    const res = await app.request('/context-info')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.method).toBe('GET')
    expect(json.path).toBe('/context-info')
    expect(json.hasEnv).toBe(true)
  })
})
