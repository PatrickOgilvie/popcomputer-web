/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Workers Cache Integration Tests
 *
 * The `cache` route option makes Honertia emit correct Workers Cache headers
 * (Cache-Control / Cache-Tag / Vary) with Inertia-aware guard rails: HTML and
 * JSON page objects vary on X-Inertia, partial reloads are never stored,
 * Set-Cookie and private request state are never publicly cached, and only
 * successful GET responses qualify.
 */

import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { Effect, Layer, Schema as S } from 'effect'
import { effectRoutes } from '../../src/effect/routing.js'
import { honertia } from '../../src/middleware.js'
import { effectBridge } from '../../src/effect/bridge.js'
import {
  createWorkersResponseCacheClient,
  ResponseCachePurgeError,
  ResponseCacheService,
  type ResponseCachePurgeInput,
} from '../../src/effect/response-cache.js'
import { Redirect } from '../../src/effect/errors.js'

const recordingCacheLayer = () => {
  const purges: ResponseCachePurgeInput[] = []

  const layer = Layer.succeed(ResponseCacheService, {
    isAvailable: true,
    purge: (input: ResponseCachePurgeInput) =>
      Effect.sync(() => {
        purges.push(input)
      }),
  })

  return { purges, layer }
}

const createApp = () => {
  const app = new Hono()
  app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
  app.use('*', effectBridge())

  return app
}

describe('cache route option', () => {
  test('cacheable GET emits Cache-Control and Vary: X-Inertia', async () => {
    const app = createApp()

    effectRoutes(app).get('/pricing', Effect.succeed(new Response('pricing page')), {
      cache: { maxAge: 300 },
    })

    const res = await app.request('/pricing')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    expect(res.headers.get('Vary')).toBe('X-Inertia')
  })

  test('staleWhileRevalidate renders into Cache-Control', async () => {
    const app = createApp()

    effectRoutes(app).get('/docs', Effect.succeed(new Response('docs')), {
      cache: { maxAge: 60, staleWhileRevalidate: 3600 },
    })

    const res = await app.request('/docs')
    expect(res.headers.get('Cache-Control')).toBe(
      'public, max-age=60, stale-while-revalidate=3600'
    )
  })

  test('non-GET responses get no cache headers even with the option set', async () => {
    const app = createApp()

    effectRoutes(app).post('/pricing', Effect.succeed(new Response('created', { status: 201 })), {
      cache: { maxAge: 300 },
    })

    const res = await app.request('/pricing', { method: 'POST' })
    expect(res.status).toBe(201)
    expect(res.headers.get('Cache-Control')).toBeNull()
    expect(res.headers.get('Vary')).toBeNull()
  })

  test('non-2xx responses get no cache headers', async () => {
    const app = createApp()

    effectRoutes(app).get(
      '/missing',
      Effect.succeed(new Response('nope', { status: 404 })),
      { cache: { maxAge: 300 } }
    )

    const res = await app.request('/missing')
    expect(res.status).toBe(404)
    expect(res.headers.get('Cache-Control')).toBeNull()
  })

  test('partial reload requests are never stored', async () => {
    const app = createApp()

    effectRoutes(app).get('/dashboard', Effect.succeed(new Response('partial')), {
      cache: { maxAge: 300 },
    })

    const res = await app.request('/dashboard', {
      headers: {
        'X-Inertia': 'true',
        'X-Inertia-Partial-Component': 'Dashboard',
        'X-Inertia-Partial-Data': 'stats',
      },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Cache-Tag')).toBeNull()
  })

  test('responses that set cookies are never publicly cached', async () => {
    const app = createApp()

    effectRoutes(app).get(
      '/with-cookie',
      Effect.succeed(
        new Response('ok', { headers: { 'Set-Cookie': 'session=abc; Path=/' } })
      ),
      { cache: { maxAge: 300 } }
    )

    const res = await app.request('/with-cookie')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBeNull()
    expect(res.headers.get('Vary')).toBeNull()
  })

  test('authenticated requests are never publicly cached and warn in development', async () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }

    try {
      const { loadUser } = await import('../../src/effect/auth.js')
      const { honertiaServices } = await import('../../src/request-context.js')

      const app = new Hono()
      app.use('*', async (c, next) => {
        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        // oxlint-disable-next-line no-param-reassign -- This middleware supplies the development binding fixture consumed by the cache-policy diagnostics.
        (c.env as { ENVIRONMENT?: string }) = { ENVIRONMENT: 'development' }
        await next()
      })
      app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      app.use(
        '*',
        honertiaServices(() => ({
          auth: {
            api: {
              getSession: async () => ({
                user: {
                  id: 'user-1',
                  email: 'user@example.com',
                  name: 'User',
                  emailVerified: true,
                  image: null,
                  // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture exercises the public Date/Better Auth contract; it does not read the clock.
                  createdAt: new Date('2026-01-01T00:00:00Z'),
                  // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture exercises the public Date/Better Auth contract; it does not read the clock.
                  updatedAt: new Date('2026-01-01T00:00:00Z'),
                },
                session: {
                  id: 'session-1',
                  userId: 'user-1',
                  // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture exercises the public Date/Better Auth contract; it does not read the clock.
                  expiresAt: new Date('2027-01-01T00:00:00Z'),
                  token: 'redacted-test-token',
                  // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture exercises the public Date/Better Auth contract; it does not read the clock.
                  createdAt: new Date('2026-01-01T00:00:00Z'),
                  // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture exercises the public Date/Better Auth contract; it does not read the clock.
                  updatedAt: new Date('2026-01-01T00:00:00Z'),
                },
              }),
            },
          } as never,
        }))
      )
      app.use('*', loadUser())
      app.use('*', effectBridge())

      effectRoutes(app).get('/account', Effect.succeed(new Response('private stuff')), {
        cache: { maxAge: 300 },
      })

      const res = await app.request('/account')
      expect(res.status).toBe(200)
      expect(res.headers.get('Cache-Control')).toBeNull()
      expect(
        warnings.some((w) => w.includes('/account') && w.includes('private/authentication state'))
      ).toBe(true)
    } finally {
      console.warn = originalWarn
    }
  })

  test('requests with Authorization are never publicly cached and warn in development', async () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }

    try {
      const app = new Hono()
      app.use('*', async (c, next) => {
        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        // oxlint-disable-next-line no-param-reassign -- This middleware supplies the development binding fixture consumed by the cache-policy diagnostics.
        (c.env as { ENVIRONMENT?: string }) = { ENVIRONMENT: 'development' }
        await next()
      })
      app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
      app.use('*', effectBridge())

      effectRoutes(app).get('/api/me', Effect.succeed(new Response('private')), {
        cache: { maxAge: 300 },
      })

      const res = await app.request('/api/me', {
        headers: { Authorization: 'Bearer token' },
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('Cache-Control')).toBeNull()
      expect(
        warnings.some(
          (w) => w.includes('/api/me') && w.includes('private/authentication state')
        )
      ).toBe(true)
    } finally {
      console.warn = originalWarn
    }
  })

  test('unrelated cookies (analytics, consent) do not disable caching', async () => {
    const app = createApp()

    effectRoutes(app).get('/landing', Effect.succeed(new Response('public')), {
      cache: { maxAge: 300 },
    })

    // Real browser traffic almost always carries cookies (__cf_bm, analytics,
    // consent). Only session cookies personalize Honertia responses.
    const res = await app.request('/landing', {
      headers: { Cookie: '__cf_bm=abc123; _ga=GA1.2.3; consent=granted' },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
  })

  test('better-auth session cookies disable public caching', async () => {
    const app = createApp()

    effectRoutes(app).get('/dashboard', Effect.succeed(new Response('private')), {
      cache: { maxAge: 300 },
    })

    const plain = await app.request('/dashboard', {
      headers: { Cookie: 'better-auth.session_token=abc' },
    })

    expect(plain.headers.get('Cache-Control')).toBeNull()

    const secure = await app.request('/dashboard', {
      headers: { Cookie: '__Secure-better-auth.session_token=abc' },
    })

    expect(secure.headers.get('Cache-Control')).toBeNull()
  })

  test('a custom session cookie configured via loadUser disables public caching', async () => {
    const { loadUser } = await import('../../src/effect/auth.js')

    const app = new Hono()
    app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
    app.use('*', loadUser({ sessionCookie: 'my_app_session' }))
    app.use('*', effectBridge())

    effectRoutes(app).get('/custom', Effect.succeed(new Response('private')), {
      cache: { maxAge: 300 },
    })

    const withSession = await app.request('/custom', {
      headers: { Cookie: 'my_app_session=abc' },
    })

    expect(withSession.headers.get('Cache-Control')).toBeNull()

    const withoutSession = await app.request('/custom', {
      headers: { Cookie: '_ga=GA1.2.3' },
    })

    expect(withoutSession.headers.get('Cache-Control')).toBe('public, max-age=300')
  })

  test('handler no-cache Cache-Control is preserved', async () => {
    const app = createApp()

    effectRoutes(app).get(
      '/revalidate',
      Effect.succeed(
        new Response('fresh', { headers: { 'Cache-Control': 'no-cache' } })
      ),
      { cache: { maxAge: 300 } }
    )

    const res = await app.request('/revalidate')

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-cache')
  })

  test('handler no-store Cache-Control is preserved', async () => {
    const app = createApp()

    effectRoutes(app).get(
      '/preview',
      Effect.succeed(
        new Response('draft', { headers: { 'Cache-Control': 'no-store' } })
      ),
      { cache: { maxAge: 300 } }
    )

    const res = await app.request('/preview')

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Vary')).toBeNull()
  })

  test('handler private Cache-Control is preserved', async () => {
    const app = createApp()

    effectRoutes(app).get(
      '/account-cache-control',
      Effect.succeed(
        new Response('private', {
          headers: { 'Cache-Control': 'private, max-age=0' },
        })
      ),
      { cache: { maxAge: 300 } }
    )

    const res = await app.request('/account-cache-control')

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=0')
    expect(res.headers.get('Vary')).toBeNull()
  })

  test('bound routes derive Cache-Tag from their bindings', async () => {
    const { Database } = await import('bun:sqlite')
    const { drizzle } = await import('drizzle-orm/bun-sqlite')
    const { sqliteTable, text } = await import('drizzle-orm/sqlite-core')
    const { honertiaServices } = await import('../../src/request-context.js')
    const { bound } = await import('../../src/effect/binding.js')

    const workspaces = sqliteTable('workspaces', {
      id: text('id').primaryKey(),
      slug: text('slug').notNull(),
    })

    const schema = { workspaces }

    const bindings = {
      workspace: S.Struct({ id: S.String, slug: S.String }),
    }

    const sqlite = new Database(':memory:')
    sqlite.run(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, slug TEXT NOT NULL)`)
    const db = drizzle(sqlite, { schema })
    db.insert(workspaces).values({ id: 'ws-1', slug: 'acme' }).run()

    const app = new Hono()
    app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
    // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
    app.use('*', honertiaServices(() => ({ db: db as never })))
    app.use('*', effectBridge({ schema, bindings }))

    effectRoutes(app, { schema, bindings }).get(
      '/workspaces/{workspace}',
      Effect.gen(function* () {
        const workspace = yield* bound('workspace')

        return Response.json(workspace)
      }),
      { cache: { maxAge: 300, tags: ['marketing'] } }
    )

    const res = await app.request('/workspaces/ws-1')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    expect(res.headers.get('Cache-Tag')).toBe('workspace:ws-1,workspaces,marketing')
  })

  test('percent-encodes Cache-Tag characters Cloudflare cannot represent', async () => {
    const app = createApp()

    effectRoutes(app).get('/tagged', Effect.succeed(new Response('tagged')), {
      cache: {
        maxAge: 300,
        tags: ['post:hello world', 'post:日本語', 'post:a,b'],
      },
    })

    const res = await app.request('/tagged')

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Tag')).toBe(
      'post:hello%20world,post:%E6%97%A5%E6%9C%AC%E8%AA%9E,post:a%2Cb'
    )
  })

  test('does not cache when the aggregate Cache-Tag header exceeds 16 KB', async () => {
    const app = createApp()

    const tags = Array.from(
      { length: 17 },
      (_, index) => `${index.toString().padStart(2, '0')}${'x'.repeat(1022)}`
    )

    effectRoutes(app).get('/too-many-tag-bytes', Effect.succeed(new Response('tagged')), {
      cache: { maxAge: 300, tags },
    })

    const res = await app.request('/too-many-tag-bytes')

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBeNull()
    expect(res.headers.get('Cache-Tag')).toBeNull()
  })

  test('routes without the cache option are untouched', async () => {
    const app = createApp()

    effectRoutes(app).get('/plain', Effect.succeed(new Response('plain')))

    const res = await app.request('/plain')
    expect(res.headers.get('Cache-Control')).toBeNull()
    expect(res.headers.get('Vary')).toBeNull()
  })
})

describe('purges route option', () => {
  test('successful mutation purges binding-derived tags', async () => {
    const { Database } = await import('bun:sqlite')
    const { drizzle } = await import('drizzle-orm/bun-sqlite')
    const { sqliteTable, text } = await import('drizzle-orm/sqlite-core')
    const { honertiaServices } = await import('../../src/request-context.js')

    const workspaces = sqliteTable('workspaces', {
      id: text('id').primaryKey(),
      slug: text('slug').notNull(),
    })

    const schema = { workspaces }

    const bindings = {
      workspace: S.Struct({ id: S.String, slug: S.String }),
    }

    const sqlite = new Database(':memory:')
    sqlite.run(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, slug TEXT NOT NULL)`)
    const db = drizzle(sqlite, { schema })
    db.insert(workspaces).values({ id: 'ws-1', slug: 'acme' }).run()

    const { purges, layer } = recordingCacheLayer()

    const app = new Hono()
    app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
    // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
    app.use('*', honertiaServices(() => ({ db: db as never })))
    app.use('*', effectBridge({ schema, bindings }))

    effectRoutes(app, { schema, bindings, services: () => layer }).put(
      '/workspaces/{workspace}',
      Effect.succeed(new Redirect({ url: '/workspaces', status: 303 })),
      { purges: true }
    )

    const res = await app.request('/workspaces/ws-1', { method: 'PUT' })

    expect(res.status).toBe(303)
    expect(purges).toEqual([{ tags: ['workspace:ws-1', 'workspaces'] }])
  })

  test('static purge tags are used verbatim', async () => {
    const { purges, layer } = recordingCacheLayer()

    const app = new Hono()
    app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
    app.use('*', effectBridge())

    effectRoutes(app, { services: () => layer }).post(
      '/refresh',
      Effect.succeed(new Response('ok')),
      { purges: ['marketing', 'pricing'] }
    )

    const res = await app.request('/refresh', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(purges).toEqual([{ tags: ['marketing', 'pricing'] }])
  })

  test('static purge tags use the same encoding as response tags', async () => {
    const { purges, layer } = recordingCacheLayer()

    const app = new Hono()
    app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
    app.use('*', effectBridge())

    effectRoutes(app, { services: () => layer }).post(
      '/refresh',
      Effect.succeed(new Response('ok')),
      { purges: ['post:hello world', 'post:日本語', 'post:a,b'] }
    )

    const res = await app.request('/refresh', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(purges).toEqual([{
      tags: [
        'post:hello%20world',
        'post:%E6%97%A5%E6%9C%AC%E8%AA%9E',
        'post:a%2Cb',
      ],
    }])
  })

  test('failed validation does not purge', async () => {
    const { purges, layer } = recordingCacheLayer()

    const app = new Hono()
    app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
    app.use('*', effectBridge())

    effectRoutes(app, { services: () => layer }).post(
      '/refresh',
      Effect.succeed(new Response('ok')),
      {
        body: S.Struct({ name: S.String }),
        purges: ['marketing'],
      }
    )

    const res = await app.request('/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(422)
    expect(purges).toEqual([])
  })
})

describe('resolveWorkersCachePurgeApi', () => {
  test('prefers the execution context cache when it exposes purge', async () => {
    const { resolveWorkersCachePurgeApi } = await import(
      '../../src/effect/response-cache.js'
    )

    const purge = async () => undefined
    const executionCtx = { cache: { purge } }

    const api = await Effect.runPromise(resolveWorkersCachePurgeApi(executionCtx))
    expect(api).toBe(executionCtx.cache)
  })

  test('resolves null outside a Workers runtime (no ctx.cache, no cloudflare:workers)', async () => {
    const { resolveWorkersCachePurgeApi } = await import(
      '../../src/effect/response-cache.js'
    )

    const api = await Effect.runPromise(resolveWorkersCachePurgeApi(undefined))
    expect(api).toBeNull()
  })
})

describe('ResponseCacheService default client', () => {
  test('is unavailable and no-ops outside a Workers runtime', async () => {
    const app = new Hono()
    app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
    app.use('*', effectBridge())

    effectRoutes(app).get(
      '/cache-status',
      Effect.gen(function* () {
        const cache = yield* ResponseCacheService
        yield* cache.purge({ tags: ['anything'] })

        return Response.json({ available: cache.isAvailable })
      })
    )

    const res = await app.request('/cache-status')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ available: false })
  })
})

describe('Workers ResponseCacheClient', () => {
  test('succeeds only when Workers Cache confirms the purge', async () => {
    const calls: Array<{ tags?: string[]; purgeEverything?: boolean }> = []

    const client = createWorkersResponseCacheClient({
      purge: async (input) => {
        calls.push(input)

        return { success: true, errors: [] }
      },
    })

    await Effect.runPromise(
      client.purge({ tags: ['post:hello world', 'post:日本語', 'post:a,b'] })
    )

    expect(calls).toEqual([{
      tags: [
        'post:hello%20world',
        'post:%E6%97%A5%E6%9C%AC%E8%AA%9E',
        'post:a%2Cb',
      ],
    }])
  })

  test('fails when Workers Cache resolves with success false', async () => {
    const client = createWorkersResponseCacheClient({
      purge: async () => ({
        success: false,
        errors: [{ code: 10000, message: 'rate limited' }],
      }),
    })

    const error = await Effect.runPromise(
      Effect.flip(client.purge({ tags: ['posts'] }))
    )

    expect(error).toBeInstanceOf(ResponseCachePurgeError)
    expect(error.cause).toEqual({
      // oxlint-disable-next-line popcomputer/effect-no-manual-tagged-construction -- Assert the literal external error shape independently of its production constructor.
      _tag: 'WorkersCachePurgeRejected',
      errors: [{ code: 10000, message: 'rate limited' }],
    })
  })

  test('fails when Workers Cache returns a malformed result', async () => {
    const client = createWorkersResponseCacheClient({
      purge: async () => undefined,
    })

    const error = await Effect.runPromise(
      Effect.flip(client.purge({ tags: ['posts'] }))
    )

    expect(error).toBeInstanceOf(ResponseCachePurgeError)
    // oxlint-disable-next-line popcomputer/effect-no-manual-tagged-construction -- Assert the literal external error shape independently of its production constructor.
    expect(error.cause).toEqual({ _tag: 'InvalidWorkersCachePurgeResult' })
  })

  test('rejects overlong tags before calling Workers Cache', async () => {
    let calls = 0

    const client = createWorkersResponseCacheClient({
      purge: async () => {
        calls++

        return { success: true }
      },
    })

    const error = await Effect.runPromise(
      Effect.flip(client.purge({ tags: ['x'.repeat(1025)] }))
    )

    expect(error).toBeInstanceOf(ResponseCachePurgeError)
    // oxlint-disable-next-line popcomputer/effect-no-manual-tagged-construction -- Assert the literal external error shape independently of its production constructor.
    expect(error.cause).toMatchObject({ _tag: 'InvalidCacheTags' })
    expect(calls).toBe(0)
  })

  test('rejects more than 100 purge tags before calling Workers Cache', async () => {
    let calls = 0

    const client = createWorkersResponseCacheClient({
      purge: async () => {
        calls++

        return { success: true }
      },
    })

    const error = await Effect.runPromise(
      Effect.flip(
        client.purge({
          tags: Array.from({ length: 101 }, (_, index) => `tag-${index}`),
        })
      )
    )

    expect(error).toBeInstanceOf(ResponseCachePurgeError)
    // oxlint-disable-next-line popcomputer/effect-no-manual-tagged-construction -- Assert the literal external error shape independently of its production constructor.
    expect(error.cause).toMatchObject({ _tag: 'InvalidCacheTags' })
    expect(calls).toBe(0)
  })
})
