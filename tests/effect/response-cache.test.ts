/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Workers Cache Integration Tests
 *
 * The `cache` route option emits correct Workers Cache headers
 * (Cache-Control / Cloudflare-CDN-Cache-Control / Cache-Tag / Vary) with Inertia-aware
 * guard rails: HTML and JSON page objects vary on X-Inertia, pages are kept
 * only by purgeable shared caches, partial reloads are never stored,
 * Set-Cookie and private request state are never publicly cached, and only
 * successful GET responses qualify.
 */

import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { Effect, Layer, Schema as S } from 'effect'
import { effectRoutes } from '../../src/effect/routing.js'
import { validateRequest } from '../../src/effect/validation.js'
import { web } from '../../src/middleware.js'
import { effectBridge } from '../../src/effect/bridge.js'
import {
  createWorkersResponseCacheClient,
  PAGE_CACHE_TAG,
  ResponseCachePurgeError,
  ResponseCacheService,
  purgeCache,
  recordCacheTag,
  tagCache,
  type ResponseCachePurgeInput,
} from '../../src/effect/response-cache.js'
import { Redirect, ValidationError } from '../../src/effect/errors.js'
import { render } from '../../src/effect/responses.js'
import { RequestService } from '../../src/effect/services.js'

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
  app.use('*', web({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
  app.use('*', effectBridge())

  return app
}

describe('cache route option', () => {
  test('cacheable GET varies on the Inertia variant and cookies', async () => {
    const app = createApp()

    effectRoutes(app).get('/pricing', Effect.succeed(new Response('pricing page')), {
      cache: { maxAge: 300 },
    })

    const res = await app.request('/pricing')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    expect(res.headers.get('Vary')).toBe('X-Inertia, Cookie')
  })

  test('cached responses add cookies to the headers a response already varies on', async () => {
    const app = createApp()

    effectRoutes(app).get(
      '/feed',
      Effect.sync(() => new Response('feed', { headers: { Vary: 'Accept' } })),
      { cache: { maxAge: 300 } }
    )

    const res = await app.request('/feed')
    expect(res.headers.get('Vary')).toBe('Accept, X-Inertia, Cookie')
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

  test('signed-in requests render their own page, which no cache stores', async () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }

    try {
      const { loadUser } = await import('../../src/effect/auth.js')
      const { webServices } = await import('../../src/request-context.js')

      const app = new Hono()
      app.use('*', async (c, next) => {
        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        // oxlint-disable-next-line no-param-reassign -- This middleware supplies the development binding fixture consumed by the cache-policy diagnostics.
        (c.env as { ENVIRONMENT?: string }) = { ENVIRONMENT: 'development' }
        await next()
      })
      app.use('*', web({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      app.use(
        '*',
        webServices(() => ({
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
      expect(res.headers.get('Cache-Control')).toBe('no-store')
      // Members visiting a cached page is expected, not a misconfiguration.
      expect(warnings).toEqual([])
    } finally {
      console.warn = originalWarn
    }
  })

  test("a response that read a request header is never stored, as one an API key in its own header signs in", async () => {
    const app = createApp()
    // A route's own sign-in, reading a header no shared cache keys on.
    const ApiKeyAuth = Layer.effectDiscard(Effect.flatMap(RequestService, (request) => Effect.sync(() => request.header('X-Api-Key'))))
    const routes = effectRoutes(app)

    routes.provide(ApiKeyAuth).get('/api/me', Effect.succeed(new Response('ada')), { cache: { maxAge: 300 } })
    routes.get('/greeting', Effect.flatMap(RequestService, (request) =>
      Effect.sync(() => new Response(request.header('Accept-Language') === 'fr' ? 'bonjour' : 'hello'))
    ), { cache: { maxAge: 300 } })

    for (const [path, headers] of [['/api/me', { 'X-Api-Key': 'ada-key' }], ['/greeting', { 'Accept-Language': 'fr' }]] as const) {
      const res = await app.request(path, { headers })

      expect({ path, status: res.status, cacheControl: res.headers.get('Cache-Control') }).toEqual({ path, status: 200, cacheControl: 'no-store' })
    }
  })

  test('requests with Authorization are never stored', async () => {
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
      app.use('*', web({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
      app.use('*', effectBridge())

      effectRoutes(app).get('/api/me', Effect.succeed(new Response('private')), {
        cache: { maxAge: 300 },
      })

      const res = await app.request('/api/me', {
        headers: { Authorization: 'Bearer token' },
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('Cache-Control')).toBe('no-store')
      expect(warnings).toEqual([])
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
    // consent). Only session cookies personalize responses.
    const res = await app.request('/landing', {
      headers: { Cookie: '__cf_bm=abc123; _ga=GA1.2.3; consent=granted' },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
  })

  test('better-auth session cookies disable public caching', async () => {
    const app = createApp()

    effectRoutes(app).get('/dashboard', Effect.sync(() => new Response('private')), {
      cache: { maxAge: 300 },
    })

    const plain = await app.request('/dashboard', {
      headers: { Cookie: 'better-auth.session_token=abc' },
    })

    expect(plain.headers.get('Cache-Control')).toBe('no-store')

    const secure = await app.request('/dashboard', {
      headers: { Cookie: '__Secure-better-auth.session_token=abc' },
    })

    expect(secure.headers.get('Cache-Control')).toBe('no-store')
  })

  test('a custom session cookie configured via loadUser disables public caching', async () => {
    const { loadUser } = await import('../../src/effect/auth.js')

    const app = new Hono()
    app.use('*', web({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
    app.use('*', loadUser({ sessionCookie: 'my_app_session' }))
    app.use('*', effectBridge())

    effectRoutes(app).get('/custom', Effect.sync(() => new Response('private')), {
      cache: { maxAge: 300 },
    })

    const withSession = await app.request('/custom', {
      headers: { Cookie: 'my_app_session=abc' },
    })

    expect(withSession.headers.get('Cache-Control')).toBe('no-store')

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

  test('bound routes are tagged with the records they read', async () => {
    const { Database } = await import('bun:sqlite')
    const { drizzle } = await import('drizzle-orm/bun-sqlite')
    const { sqliteTable, text } = await import('drizzle-orm/sqlite-core')
    const { webServices } = await import('../../src/request-context.js')
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
    app.use('*', web({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
    // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
    app.use('*', webServices(() => ({ db: db as never })))
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
    expect(res.headers.get('Cache-Tag')).toBe('workspaces:ws-1,marketing')
  })

  test("'no-store' keeps a response out of every cache", async () => {
    const app = createApp()

    effectRoutes(app).get('/preview/draft', Effect.succeed(new Response('draft')), { cache: 'no-store' })

    const res = await app.request('/preview/draft')

    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Cache-Tag')).toBeNull()
  })

  test('carries the tags an action adds for records it read beyond its bindings', async () => {
    const app = createApp()

    effectRoutes(app).get('/fr/hello', Effect.gen(function* () {
      // The French translation is missing, so the page shows the English one.
      yield* tagCache(recordCacheTag('articles', 'en-hello'), recordCacheTag('articles', 'fr-hello'))

      return new Response('fallback')
    }), { cache: { maxAge: 300 } })

    const res = await app.request('/fr/hello')

    expect(res.headers.get('Cache-Tag')).toBe('articles:en-hello,articles:fr-hello')
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

  test('page documents are kept only at the edge and tagged', async () => {
    const app = createApp()

    effectRoutes(app).get('/pricing', render('Pricing'), {
      cache: { maxAge: 300, staleWhileRevalidate: 3600, tags: ['marketing'] },
    })

    const res = await app.request('/pricing')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    // The document names this deploy's hashed assets; a browser copy could
    // outlive them, so browsers revalidate and only Cloudflare keeps it.
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate')
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe(
      'public, max-age=300, stale-while-revalidate=3600'
    )
    expect(res.headers.get('Cache-Tag')).toBe('marketing,popweb:page')
    expect(res.headers.get('Vary')).toBe('X-Inertia, Cookie')
  })

  test('Inertia page objects follow the same page policy', async () => {
    const app = createApp()

    effectRoutes(app).get('/pricing', render('Pricing'), {
      cache: { maxAge: 300 },
    })

    const res = await app.request('/pricing', {
      headers: { 'X-Inertia': 'true', 'X-Inertia-Version': '1.0.0' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ component: 'Pricing' })
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate')
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=300')
    expect(res.headers.get('Cache-Tag')).toBe(PAGE_CACHE_TAG)
  })

  test('responses that are not pages stay cacheable by browsers', async () => {
    const app = createApp()

    effectRoutes(app).get('/api/plans', Effect.succeed(Response.json({ plans: [] })), {
      cache: { maxAge: 300 },
    })

    const res = await app.request('/api/plans')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBeNull()
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
  test('successful mutation purges its records and the table it writes', async () => {
    const { Database } = await import('bun:sqlite')
    const { drizzle } = await import('drizzle-orm/bun-sqlite')
    const { sqliteTable, text } = await import('drizzle-orm/sqlite-core')
    const { webServices } = await import('../../src/request-context.js')

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
    app.use('*', web({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
    // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
    app.use('*', webServices(() => ({ db: db as never })))
    app.use('*', effectBridge({ schema, bindings }))

    effectRoutes(app, { schema, bindings, services: () => layer }).put(
      '/workspaces/{workspace}',
      Effect.succeed(new Redirect({ url: '/workspaces', status: 303 })),
      { purges: true }
    )

    const res = await app.request('/workspaces/ws-1', { method: 'PUT' })

    expect(res.status).toBe(303)
    expect(purges).toEqual([{ tags: ['workspaces:ws-1', 'workspaces'] }])
  })

  test('a page read by slug is purged by a write by id', async () => {
    const { Database } = await import('bun:sqlite')
    const { drizzle } = await import('drizzle-orm/bun-sqlite')
    const { sqliteTable, text } = await import('drizzle-orm/sqlite-core')
    const { webServices } = await import('../../src/request-context.js')
    const { bound } = await import('../../src/effect/binding.js')

    const posts = sqliteTable('posts', {
      id: text('id').primaryKey(),
      slug: text('slug').notNull(),
    })

    const schema = { posts }
    const bindings = { post: S.Struct({ id: S.String, slug: S.String }) }

    const sqlite = new Database(':memory:')
    sqlite.run(`CREATE TABLE posts (id TEXT PRIMARY KEY, slug TEXT NOT NULL)`)
    const db = drizzle(sqlite, { schema })
    db.insert(posts).values({ id: 'post-1', slug: 'hello-world' }).run()

    const { purges, layer } = recordingCacheLayer()

    const app = new Hono()
    app.use('*', web({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
    // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
    app.use('*', webServices(() => ({ db: db as never })))
    app.use('*', effectBridge({ schema, bindings }))

    effectRoutes(app, { schema, bindings, services: () => layer })
      .get(
        '/blog/{post:slug}',
        Effect.map(bound('post'), (post) => Response.json(post)),
        { cache: { maxAge: 300 } }
      )
      .delete(
        '/posts/{post}',
        Effect.gen(function* () {
          yield* bound('post')
          sqlite.run('DELETE FROM posts')

          return new Redirect({ url: '/blog', status: 303 })
        }),
        { purges: true }
      )

    const read = await app.request('/blog/hello-world')
    const write = await app.request('/posts/post-1', { method: 'DELETE' })

    expect(read.headers.get('Cache-Tag')).toBe('posts:post-1')
    expect(write.status).toBe(303)
    expect(purges).toEqual([{ tags: ['posts:post-1', 'posts'] }])
  })

  test('a plain {param} beside a model binding is read as input, not loaded', async () => {
    const { Database } = await import('bun:sqlite')
    const { drizzle } = await import('drizzle-orm/bun-sqlite')
    const { sqliteTable, text } = await import('drizzle-orm/sqlite-core')
    const { webServices } = await import('../../src/request-context.js')
    const { bound } = await import('../../src/effect/binding.js')

    const teams = sqliteTable('teams', { id: text('id').primaryKey() })
    const schema = { teams }
    const bindings = { team: S.Struct({ id: S.String }) }

    const sqlite = new Database(':memory:')
    sqlite.run(`CREATE TABLE teams (id TEXT PRIMARY KEY)`)
    const db = drizzle(sqlite, { schema })
    db.insert(teams).values({ id: 'team-1' }).run()

    const { purges, layer } = recordingCacheLayer()

    const app = new Hono()
    app.use('*', web({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
    // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
    app.use('*', webServices(() => ({ db: db as never })))
    app.use('*', effectBridge({ schema, bindings }))

    effectRoutes(app, { schema, bindings, services: () => layer }).post(
      '/teams/{team}/invites/{token}',
      Effect.gen(function* () {
        yield* bound('team')
        const { token } = yield* validateRequest(S.Struct({ token: S.String }))

        return Response.json({ token })
      }),
      { purges: true }
    )

    const res = await app.request('/teams/team-1/invites/abc', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ token: 'abc' })
    expect(purges).toEqual([{ tags: ['teams:team-1', 'teams'] }])
  })

  test('purges: true on a route without a {param} fails at registration', () => {
    const register = () =>
      effectRoutes(createApp()).post('/posts', Effect.succeed(new Redirect({ url: '/posts', status: 303 })), {
        purges: true,
      })

    expect(register).toThrow("Route '/posts' has purges: true")
  })

  test('purgeCache adds what the action changed to the route\'s purges', async () => {
    const { purges, layer } = recordingCacheLayer()
    const app = createApp()

    effectRoutes(app, { services: () => layer })
      .post(
        '/offers/accept',
        Effect.andThen(
          purgeCache(recordCacheTag('listings', 'listing-1'), 'listings'),
          Effect.succeed(new Redirect({ url: '/offers', status: 303 }))
        ),
        { purges: ['offers', 'listings'] }
      )
      .post(
        '/offers/decline',
        Effect.andThen(purgeCache('offers'), Effect.fail(new ValidationError({ errors: { reason: 'Give a reason.' } })))
      )

    await app.request('/offers/accept', { method: 'POST' })
    await app.request('/offers/decline', { method: 'POST' })

    // Each tag once, and nothing for the action that failed.
    expect(purges).toEqual([{ tags: ['offers', 'listings', 'listings:listing-1'] }])
  })

  test('static purge tags are used verbatim', async () => {
    const { purges, layer } = recordingCacheLayer()

    const app = new Hono()
    app.use('*', web({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
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
    app.use('*', web({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
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
    app.use('*', web({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
    app.use('*', effectBridge())

    effectRoutes(app, { services: () => layer }).post(
      '/refresh',
      Effect.gen(function* () {
        yield* validateRequest(S.Struct({ name: S.String }))

        return new Response('ok')
      }),
      { purges: ['marketing'] }
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

    const purge = async () => ({ success: true, errors: [] })
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
    app.use('*', web({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
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
  test('encodes tags before calling Workers Cache', async () => {
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
      // @ts-expect-error Workers Cache resolving without a result object is the malformed result under test.
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
