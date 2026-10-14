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
import { effectBridge } from '../../src/effect/bridge.js'
import { web } from '../../src/middleware.js'
import { webServices } from '../../src/request-context.js'
import { setupWeb } from '../../src/setup.js'
import { DatabaseService } from '../../src/effect/services.js'
import type { WebDeclaration } from '../../src/effect/register.js'

/** The database stub these tests provide and read back. */
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
}

const createTestApp = () => {
  const app = new Hono<TestEnv>()

  app.use(
    '*',
    web({
      version: '1.0.0',
      render: (page) => JSON.stringify(page),
    })
  )

  app.use('*', webServices(() => ({ db: { name: 'test-db' } })))
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

// =============================================================================
// Tests
// =============================================================================

describe('Custom Services via effectBridge', () => {
  test('custom services work alongside built-in services', async () => {
    const app = new Hono<TestEnv>()

    app.use(
      '*',
      web({
        version: '1.0.0',
        render: (page) => JSON.stringify(page),
      })
    )

    // Simulate Cloudflare Worker bindings and set up db
    app.use('*', webServices(() => ({ db: { name: 'custom-db' } })))
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

        const userName = yield* Effect.promise(() =>
          bindings.KV.get('user:123')
        )

        return Response.json({
            dbName: db.name,
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

describe('Custom Services via setupWeb', () => {
  test("request services receive the request's context and bindings", async () => {
    const app = new Hono<TestEnv>()

    class RequestInfoService extends Context.Service<
      RequestInfoService,
      { method: string; path: string }
    >()('RequestInfo') {}

    app.use('*', webServices(() => ({ db: { name: 'test-db' } })))
    app.use('*', async (c, next) => {
      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      // oxlint-disable-next-line no-param-reassign -- This middleware supplies the Worker binding fixture consumed by the bridge.
      c.env = {
        KV_DATA: { 'user:123': 'John Doe', 'config:theme': 'dark' },
        FEATURES: ['new-dashboard', 'beta-api'],
      }
      await next()
    })

    const { routes } = setupWeb(app, {
      version: '1.0.0',
      render: (page) => JSON.stringify(page),
    }).services({
      request: (c) =>
        Layer.mergeAll(
          Layer.succeed(BindingsService, {
            KV: createMockKV(c.env.KV_DATA),
            ANALYTICS: createMockAnalytics(),
          }),
          Layer.succeed(RequestInfoService, { method: c.req.method, path: c.req.path })
        ),
    })

    routes.get(
      '/setup-web',
      Effect.gen(function* () {
        const bindings = yield* BindingsService
        const info = yield* RequestInfoService
        const name = yield* Effect.promise(() => bindings.KV.get('user:123'))

        return Response.json({ name, method: info.method, path: info.path })
      })
    )

    const res = await app.request('/setup-web')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: 'John Doe', method: 'GET', path: '/setup-web' })
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

            const value = yield* Effect.promise(() =>
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

          const userName = yield* Effect.promise(() =>
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
})
