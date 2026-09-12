/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * setupHonertia Tests
 *
 * Tests for the unified setupHonertia configuration including:
 * - Database and auth factory setup
 * - Schema configuration for route model binding
 * - Helpful error messages when configuration is missing
 */

import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
// oxlint-disable-next-line effecttsgo/node-builtin-import -- These teardown tests must yield the actual Hono/SDK Promise event loop; advancing an Effect TestClock cannot flush that native work.
import { scheduler } from 'node:timers/promises'
import { Option, Deferred, Effect, Schema as S } from 'effect'
import { setupWeb, setupHonertia, registerErrorHandlers } from '../src/setup.js'
import { effectRoutes } from '../src/effect/routing.js'
import {
  DatabaseService,
  AuthService,
  AuthUserService,
  PageService,
  HonertiaService,
} from '../src/effect/services.js'
import { bound, routeBinding } from '../src/effect/binding.js'
import { NotFoundError } from '../src/effect/errors.js'

// =============================================================================
// Test Types
// =============================================================================

type TestEnv = {
  Bindings: {
    DATABASE_URL: string
    AUTH_SECRET: string
    ENVIRONMENT: string
  }
}

describe('setupWeb', () => {
  test('composes a flat config and exposes the canonical rendering APIs', async () => {
    const app = new Hono<TestEnv>()

    const application = setupWeb(app, {
      version: '1.0.0',
      render: (page) => JSON.stringify(page),
      database: () => ({ name: 'test-db' }),
    })

    app.get('/plain', (c) => c.var.web.render('Plain', { source: 'hono' }))
    effectRoutes(app).get(
      '/effect',
      Effect.gen(function* () {
        const page = yield* PageService

        return yield* Effect.promise(() => page.render('Effect', { source: 'effect' }))
      })
    )

    expect(application.app).toBe(app)

    const plain = await app.request('/plain', {
      headers: { 'X-Inertia': 'true' },
    })

    expect((await plain.json()).component).toBe('Plain')

    const effect = await app.request('/effect', {
      headers: { 'X-Inertia': 'true' },
    })

    expect((await effect.json()).component).toBe('Effect')
  })
})

// =============================================================================
// Basic setupHonertia Configuration Tests
// =============================================================================

describe('setupHonertia basic configuration', () => {
  test('configures middleware, errors, and app-owned routes in one call', async () => {
    const app = new Hono<TestEnv>()

    const configured = setupHonertia(app, {
      honertia: {
        version: '1.0.0',
        render: (page) => JSON.stringify(page),
      },
      errors: { component: 'Problem' },
    })

    effectRoutes(app).get('/healthy', Effect.succeed(new Response('OK')), {
      name: 'health.show',
    })
    effectRoutes(app).get(
      '/failed',
      Effect.fail(new NotFoundError({ resource: 'project', id: 'missing' }))
    )

    expect(configured.app).toBe(app)
    expect(configured.routes.findByName('health.show')?.path).toBe('/healthy')

    const missing = await app.request('/missing', undefined, {
      DATABASE_URL: 'unused',
      AUTH_SECRET: 'unused',
      ENVIRONMENT: 'test',
    })

    expect(missing.status).toBe(404)
    expect((await missing.json()).component).toBe('Problem')

    const failed = await app.request('/failed', undefined, {
      DATABASE_URL: 'unused',
      AUTH_SECRET: 'unused',
      ENVIRONMENT: 'test',
    })

    expect(failed.status).toBe(404)
    expect((await failed.json()).component).toBe('Problem')
  })

  test('database factory result is provided as DatabaseService', async () => {
    const app = new Hono<TestEnv>()

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
          database: () => ({ name: 'test-db', url: 'postgres://test' }),
        },
      })
    )

    // Route that uses DatabaseService
    effectRoutes(app).get(
      '/db-test',
      Effect.gen(function* () {
        const db = yield* DatabaseService

        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        return Response.json({ dbName: (db).name })
      })
    )

    const res = await app.request('/db-test')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.dbName).toBe('test-db')
  })

  test('auth factory receives the database and its result is provided as AuthService', async () => {
    const app = new Hono<TestEnv>()

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
          database: () => ({ name: 'auth-db' }),
        },
        auth: {
          client: (_c, { db }) => ({
            // Auth can access db because database runs first
            dbName: db.name,
            secret: 'test-secret',
          }),
        },
      })
    )

    // Route that uses AuthService
    effectRoutes(app).get(
      '/auth-test',
      Effect.gen(function* () {
        const auth = yield* AuthService

        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        return Response.json({
            dbName: (auth as { readonly dbName: string }).dbName,
            secret: (auth as { readonly secret: string }).secret,
          })
      })
    )

    const res = await app.request('/auth-test')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.dbName).toBe('auth-db')
    expect(json.secret).toBe('test-secret')
  })

  test('works without database or auth configured', async () => {
    const app = new Hono<TestEnv>()

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
        },
      })
    )

    // Simple route that doesn't need db/auth
    effectRoutes(app).get(
      '/simple',
      Effect.succeed(new Response('OK'))
    )

    const res = await app.request('/simple')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('OK')
  })

  test('stateless auth receives request context and shared auth services', async () => {
    const app = new Hono<TestEnv>()
    let authFactoryArgumentCount: number | undefined

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
        },
        auth: {
          client: function (context) {
            authFactoryArgumentCount = arguments.length

            return {
              mode: 'stateless',
              secret: context.env.AUTH_SECRET,
            }
          },
        },
      })
    )

    effectRoutes(app).get(
      '/stateless-auth-test',
      Effect.gen(function* () {
        const auth = yield* AuthService

        return Response.json(auth)
      })
    )

    const res = await app.request('/stateless-auth-test', undefined, {
      DATABASE_URL: 'unused',
      AUTH_SECRET: 'stateless-secret',
      ENVIRONMENT: 'test',
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      mode: 'stateless',
      secret: 'stateless-secret',
    })
    expect(authFactoryArgumentCount).toBe(2)
  })

  test('owns Better Auth background promises until inline request teardown', async () => {
    const app = new Hono<TestEnv>()
    let responseSettled = false

    const releaseBackground = Deferred.makeUnsafe<void>()
    const backgroundTask = Effect.runPromise(Deferred.await(releaseBackground))

    const handlerComplete = Deferred.makeUnsafe<void>()

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
        },
        auth: {
          client: (_context, { backgroundTasks }) => {
            backgroundTasks.handler(backgroundTask)

            return { mode: 'stateless' }
          },
        },
      })
    )
    app.get('/background-auth', (c) => {
      Effect.runSync(Deferred.succeed(handlerComplete, undefined))

      return c.text('OK')
    })

    const pendingResponse = app.request('/background-auth').then((response) => {
      responseSettled = true

      return response
    })

    await Effect.runPromise(Deferred.await(handlerComplete))
    // Let Hono's native Promise chain reach teardown before checking that it is blocked.
    await scheduler.yield()

    expect(responseSettled).toBe(false)
    await Effect.runPromise(Deferred.succeed(releaseBackground, undefined))

    const response = await pendingResponse
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('OK')
  })

  test('drains auth background promises when session loading fails before effectBridge', async () => {
    const app = new Hono<TestEnv>()
    let responseSettled = false

    const releaseBackground = Deferred.makeUnsafe<void>()
    const backgroundTask = Effect.runPromise(Deferred.await(releaseBackground))

    const sessionAttempted = Deferred.makeUnsafe<void>()

    setupWeb(app, {
      version: '1.0.0',
      render: (page) => JSON.stringify(page),
      auth: {
        client: (_context, { backgroundTasks }) => {
          backgroundTasks.handler(backgroundTask)

          return {
            api: {
              getSession: async () => {
                Effect.runSync(Deferred.succeed(sessionAttempted, undefined))
                throw new Error('session store unavailable')
              },
            },
          }
        },
      },
    })
    app.get('/pre-bridge-failure', (c) => c.text('must not run'))

    const pendingResponse = app.request('/pre-bridge-failure').then((response) => {
      responseSettled = true

      return response
    })

    await Effect.runPromise(Deferred.await(sessionAttempted))
    // Let Hono's native Promise chain reach teardown before checking that it is blocked.
    await scheduler.yield()

    expect(responseSettled).toBe(false)
    await Effect.runPromise(Deferred.succeed(releaseBackground, undefined))

    const response = await pendingResponse
    expect(response.status).toBe(503)
  })
})

// =============================================================================
// Schema Configuration Tests
// =============================================================================

describe('setupHonertia schema configuration', () => {
  // Mock schema for testing
  const mockSchema = {
    projects: {
      id: { name: 'id', columnType: 'SQLiteText' },
      name: { name: 'name' },
    },
    users: {
      id: { name: 'id', columnType: 'SQLiteText' },
      email: { name: 'email' },
    },
  }

  test('schema is available to effectRoutes via context', async () => {
    const app = new Hono<TestEnv>()

    // Mock drizzle-style db (cross-database compatible pattern)
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: '123', name: 'Test Project' }],
          }),
        }),
      }),
    }

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
          database: () => mockDb,
          schema: mockSchema,
          bindings: {
            project: S.Struct({ id: S.String, name: S.String }),
          },
        },
      })
    )

    // Route with model binding - schema comes from setupHonertia
    effectRoutes(app).get(
      '/projects/{project}',
      Effect.gen(function* () {
        const project = yield* bound('project')

        return Response.json(project)
      })
    )

    const res = await app.request('/projects/123')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.id).toBe('123')
    expect(json.name).toBe('Test Project')
  })

  test('nested bindings keep both parent scope and child lookup constraints', async () => {
    const app = new Hono<TestEnv>()

    const usersTable = {
      id: { name: 'id', columnType: 'SQLiteText' },
    }

    const postsTable = {
      id: { name: 'id', columnType: 'SQLiteText' },
      userId: { name: 'userId' },
    }

    const mockSchema = {
      users: usersTable,
      posts: postsTable,
      postsRelations: {
        config: ({ one }: { one: <Table, Options>(table: Table, opts: Options) => object }) => ({
          user: one(
            { _: { name: 'users' } },
            {
              fields: [postsTable.userId],
              references: [usersTable.id],
            }
          ),
        }),
      },
    }

    let postsWhereCalls = 0

    const mockDb = {
      select: () => ({
              from: <Table>(table: Table) => {
          let whereCalls = 0

          const query = {
            where: () => {
              whereCalls += 1

              if (table === postsTable) {
                postsWhereCalls = whereCalls
              }

              return query
            },
            limit: async () => {
              if (table === usersTable) {
                return [{ id: 'u1' }]
              }

              if (table === postsTable) {
                // If resolveBindings calls where twice, this returns the wrong model.
                return whereCalls > 1
                  ? [{ id: 'p1', userId: 'u1' }]
                  : [{ id: 'p2', userId: 'u1' }]
              }

              return []
            },
          }

          return query
        },
      }),
    }

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
          database: () => mockDb,
          schema: mockSchema,
          bindings: {
            user: S.Struct({ id: S.String }),
            post: routeBinding(
              S.Struct({ id: S.String, userId: S.String }),
              { scope: { user: { foreignKey: 'userId' } } }
            ),
          },
        },
      })
    )

    effectRoutes(app).get(
      '/users/{user}/posts/{post}',
      Effect.gen(function* () {
        const post = yield* bound('post')

        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        return new Response((post as { id: string }).id)
      })
    )

    const res = await app.request('/users/u1/posts/p2')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('p2')
    expect(postsWhereCalls).toBe(1)
  })
})

describe('setupHonertia auth session loading', () => {
  test('loaded session user reaches AuthUserService and shared auth props', async () => {
    const app = new Hono<TestEnv>()

    const getSessionCalls: string[] = []
    const sessionCookie = 'custom_auth_cookie'

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
        },
        auth: {
          client: () => ({
            api: {
              getSession: async ({ headers }: { headers: Headers }) => {
                getSessionCalls.push(headers.get('cookie') ?? '')

                return {
                  user: {
                    id: 'user-42',
                    email: 'user42@example.com',
                    name: 'User 42',
                    emailVerified: true,
                    image: null,
                    // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture exercises the public Date/Better Auth contract; it does not read the clock.
                    createdAt: new Date('2026-01-01T00:00:00Z'),
                    // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture exercises the public Date/Better Auth contract; it does not read the clock.
                    updatedAt: new Date('2026-01-01T00:00:00Z'),
                  },
                  session: {
                    id: 'session-42',
                    userId: 'user-42',
                    // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture exercises the public Date/Better Auth contract; it does not read the clock.
                    expiresAt: new Date('2027-01-01T00:00:00Z'),
                    token: 'redacted-test-token',
                    // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture exercises the public Date/Better Auth contract; it does not read the clock.
                    createdAt: new Date('2026-01-01T00:00:00Z'),
                    // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture exercises the public Date/Better Auth contract; it does not read the clock.
                    updatedAt: new Date('2026-01-01T00:00:00Z'),
                  },
                }
              },
            },
          }),
          sessionCookie,
        },
      })
    )

    effectRoutes(app).get(
      '/me',
      Effect.gen(function* () {
        const authUser = yield* AuthUserService
        const honertia = yield* HonertiaService

        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        return yield* Effect.tryPromise(() =>
          honertia.render('Auth/Me', {
            userId: authUser.user.id,
          })
        )
      })
    )

    const res = await app.request('/me', {
      headers: {
        'X-Inertia': 'true',
        'Cookie': `${sessionCookie}=abc123`,
      },
    })

    expect(res.status).toBe(200)
    const page = await res.json()
    expect(page.props.userId).toBe('user-42')
    expect(page.props.auth.user.id).toBe('user-42')
    expect(getSessionCalls).toHaveLength(1)
  })

  test('loadUser skips Better Auth session lookup when configured cookie is missing', async () => {
    const app = new Hono<TestEnv>()

    let getSessionCalls = 0

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
        },
        auth: {
          client: () => ({
            api: {
              getSession: async () => {
                getSessionCalls += 1

                return null
              },
            },
          }),
          sessionCookie: 'custom_auth_cookie',
        },
      })
    )

    effectRoutes(app).get(
      '/health',
      Effect.succeed(new Response('ok'))
    )

    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    expect(getSessionCalls).toBe(0)
  })

  test('distinguishes an unavailable session provider from an anonymous session', async () => {
    const app = new Hono<TestEnv>()
    setupHonertia(app, {
      honertia: {
        version: '1.0.0',
        render: (page) => JSON.stringify(page),
      },
      auth: {
        client: () => ({
          api: {
            getSession: async () => {
              throw new Error('provider offline')
            },
          },
        }),
      },
    })
    app.get('/', (c) => c.text('unreachable'))

    const res = await app.request('/', undefined, {
      DATABASE_URL: 'unused',
      AUTH_SECRET: 'unused',
      ENVIRONMENT: 'test',
    })

    expect(res.status).toBe(503)
  })

  test('rejects malformed provider sessions at the boundary', async () => {
    const app = new Hono<TestEnv>()
    setupHonertia(app, {
      honertia: {
        version: '1.0.0',
        render: (page) => JSON.stringify(page),
      },
      auth: {
        client: () => ({
          api: {
            getSession: async () => ({
              user: { id: 'user-1' },
              session: { id: 'session-1' },
            }),
          },
        }),
      },
    })
    app.get('/', (c) => c.text('unreachable'))

    const res = await app.request('/', undefined, {
      DATABASE_URL: 'unused',
      AUTH_SECRET: 'unused',
      ENVIRONMENT: 'test',
    })

    expect(res.status).toBe(500)
  })

  test('treats a null session as anonymous', async () => {
    const app = new Hono<TestEnv>()
    setupHonertia(app, {
      honertia: {
        version: '1.0.0',
        render: (page) => JSON.stringify(page),
      },
      auth: {
        client: () => ({ api: { getSession: async () => null } }),
      },
    })
    effectRoutes(app).get(
      '/',
      Effect.gen(function* () {
        const user = yield* Effect.serviceOption(AuthUserService)

        return Response.json({ anonymous: Option.isNone(user) })
      })
    )

    const res = await app.request('/', undefined, {
      DATABASE_URL: 'unused',
      AUTH_SECRET: 'unused',
      ENVIRONMENT: 'test',
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ anonymous: true })
  })
})

// =============================================================================
// Configuration Error Tests
// =============================================================================

describe('setupHonertia configuration errors', () => {
  test('rejects legacy auth ownership at the setup boundary', () => {
    const app = new Hono<TestEnv>()

    const legacyConfig = {
      honertia: {
        version: '1.0.0',
        render: <Page>(page: Page) => JSON.stringify(page),
        auth: () => ({ mode: 'legacy' }),
      },
    }

    expect(() => setupHonertia(app, legacyConfig)).toThrow(
      'move honertia.auth to top-level auth.client'
    )
  })

  test('rejects Effect schema ownership at the setup boundary', () => {
    const app = new Hono<TestEnv>()

    const legacyConfig = {
      honertia: {
        version: '1.0.0',
        render: <Page>(page: Page) => JSON.stringify(page),
      },
      effect: {
        services: undefined,
        schema: {},
      },
    }

    expect(() => setupHonertia(app, legacyConfig)).toThrow(
      'move effect.schema to honertia.schema'
    )
  })

  test('helpful error when using route model binding without schema', async () => {
    const app = new Hono<TestEnv>()

    // Set environment to development to see full error
    app.use('*', async (c, next) => {
      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      // oxlint-disable-next-line no-param-reassign -- This middleware supplies the complete Worker binding fixture for the request.
      c.env = { DATABASE_URL: 'unused', AUTH_SECRET: 'unused', ENVIRONMENT: 'development' }
      await next()
    })

    // Setup WITHOUT schema
    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
          database: () => ({ name: 'test-db' }),
          // No schema configured!
        },
      })
    )

    // Register error handlers to render errors via Honertia
    registerErrorHandlers(app, {
      component: 'Error',
      showDevErrors: true,
      envKey: 'ENVIRONMENT',
      devValue: 'development',
    })

    // Route with model binding but no schema
    effectRoutes(app).get(
      '/projects/{project}',
      Effect.gen(function* () {
        const project = yield* bound('project')

        return Response.json(project)
      })
    )

    const res = await app.request('/projects/123')

    // Error should be rendered via Honertia
    expect(res.status).toBe(500)

    const body = await res.json()
    expect(body.component).toBe('Error')
    expect(body.props.status).toBe(500)
    expect(body.props.message).toContain('schema configuration')
  })

  test('error hint references setupHonertia configuration', async () => {
    const app = new Hono<TestEnv>()

    app.use('*', async (c, next) => {
      // Set environment to development to see full error
      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      // oxlint-disable-next-line no-param-reassign -- This middleware supplies the complete Worker binding fixture for the request.
      c.env = { DATABASE_URL: 'unused', AUTH_SECRET: 'unused', ENVIRONMENT: 'development' }
      await next()
    })

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
          database: () => ({ name: 'test-db' }),
          // No schema!
        },
      })
    )

    registerErrorHandlers(app, {
      component: 'Error',
      showDevErrors: true,
      envKey: 'ENVIRONMENT',
      devValue: 'development',
    })

    effectRoutes(app).get(
      '/users/{user}',
      Effect.gen(function* () {
        const user = yield* bound('user')

        return Response.json(user)
      })
    )

    const res = await app.request('/users/456')
    const body = await res.json()

    // The hint now comes from fix suggestions and mentions schema
    expect(body.props.hint).toContain('schema')
  })

  test('error includes the specific bound key that failed', async () => {
    const app = new Hono<TestEnv>()

    app.use('*', async (c, next) => {
      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      // oxlint-disable-next-line no-param-reassign -- This middleware supplies the complete Worker binding fixture for the request.
      c.env = { DATABASE_URL: 'unused', AUTH_SECRET: 'unused', ENVIRONMENT: 'development' }
      await next()
    })

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
          database: () => ({ name: 'test-db' }),
        },
      })
    )

    registerErrorHandlers(app, {
      component: 'Error',
      showDevErrors: true,
      envKey: 'ENVIRONMENT',
      devValue: 'development',
    })

    effectRoutes(app).get(
      '/articles/{article}',
      Effect.gen(function* () {
        const article = yield* bound('article')

        return Response.json(article)
      })
    )

    const res = await app.request('/articles/789')
    const body = await res.json()

    // Error message should include the specific key
    expect(body.props.message).toContain("bound('article')")
  })
})

// =============================================================================
// Database Not Configured Tests
// =============================================================================

describe('setupHonertia database configuration errors', () => {
  test('route model binding without a configured database is a configuration error', async () => {
    const app = new Hono<TestEnv>()

    const mockSchema = {
      projects: { id: { name: 'id', columnType: 'SQLiteText' } },
    }

    app.use('*', async (c, next) => {
      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      // oxlint-disable-next-line no-param-reassign -- This middleware supplies the complete Worker binding fixture for the request.
      c.env = { DATABASE_URL: 'unused', AUTH_SECRET: 'unused', ENVIRONMENT: 'development' }
      await next()
    })

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
          // database NOT configured
          schema: mockSchema,
          bindings: { project: S.Struct({ id: S.String }) },
        },
      })
    )

    registerErrorHandlers(app, {
      component: 'Error',
      showDevErrors: true,
      envKey: 'ENVIRONMENT',
      devValue: 'development',
    })

    effectRoutes(app).get(
      '/projects/{project}',
      Effect.gen(function* () {
        const project = yield* bound('project')

        return Response.json(project)
      })
    )

    // A binding needs a database; its absence is misconfiguration, not a 404
    const res = await app.request('/projects/123')
    const body = await res.json()
    expect(body.component).toBe('Error')
    expect(body.props.message).toContain('DatabaseService is not configured')
  })

  test('helpful error when using DatabaseService without database configured', async () => {
    const app = new Hono<TestEnv>()

    app.use('*', async (c, next) => {
      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      // oxlint-disable-next-line no-param-reassign -- This middleware supplies the complete Worker binding fixture for the request.
      c.env = { DATABASE_URL: 'unused', AUTH_SECRET: 'unused', ENVIRONMENT: 'development' }
      await next()
    })

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
          // database NOT configured!
        },
      })
    )

    registerErrorHandlers(app, {
      component: 'Error',
      showDevErrors: true,
      envKey: 'ENVIRONMENT',
      devValue: 'development',
    })

    effectRoutes(app).get(
      '/test-db',
      Effect.gen(function* () {
        const db = yield* DatabaseService
        // Try to use the db - this should throw
        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        const result = db

        return Response.json(result)
      })
    )

    const res = await app.request('/test-db')
    const body = await res.json()

    expect(body.component).toBe('Error')
    expect(body.props.message).toContain('DatabaseService is not configured')
    expect(body.props.message).toContain('setupWeb')
    // Hint now comes from fix suggestions
    expect(body.props.hint).toContain('database')
  })

  test('helpful error when using AuthService without auth configured', async () => {
    const app = new Hono<TestEnv>()

    app.use('*', async (c, next) => {
      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      // oxlint-disable-next-line no-param-reassign -- This middleware supplies the complete Worker binding fixture for the request.
      c.env = { DATABASE_URL: 'unused', AUTH_SECRET: 'unused', ENVIRONMENT: 'development' }
      await next()
    })

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
          // auth NOT configured!
        },
      })
    )

    registerErrorHandlers(app, {
      component: 'Error',
      showDevErrors: true,
      envKey: 'ENVIRONMENT',
      devValue: 'development',
    })

    effectRoutes(app).get(
      '/test-auth',
      Effect.gen(function* () {
        const auth = yield* AuthService
        // Try to use the auth - this should throw
        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        const session = auth

        return Response.json(session)
      })
    )

    const res = await app.request('/test-auth')
    const body = await res.json()

    expect(body.component).toBe('Error')
    expect(body.props.message).toContain('AuthService is not configured')
    expect(body.props.message).toContain('setupWeb')
    // Hint now comes from fix suggestions
    expect(body.props.hint).toContain('auth')
  })

  test('routes that do not yield DatabaseService work without a configured db', async () => {
    const app = new Hono<TestEnv>()

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
          // database NOT configured, and this route never asks for it
        },
      })
    )

    effectRoutes(app).get('/no-db-use', Effect.succeed(new Response('OK')))

    const res = await app.request('/no-db-use')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('OK')
  })

  test('yielding DatabaseService without a configured db is a configuration error even if unused', async () => {
    const app = new Hono<TestEnv>()

    app.use('*', async (c, next) => {
      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      // oxlint-disable-next-line no-param-reassign -- This middleware supplies the complete Worker binding fixture for the request.
      c.env = { DATABASE_URL: 'unused', AUTH_SECRET: 'unused', ENVIRONMENT: 'development' }
      await next()
    })

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
          // database NOT configured
        },
      })
    )

    registerErrorHandlers(app, {
      component: 'Error',
      showDevErrors: true,
      envKey: 'ENVIRONMENT',
      devValue: 'development',
    })

    effectRoutes(app).get(
      '/declare-db',
      Effect.gen(function* () {
        // Declaring the dependency without configuring it is misconfiguration,
        // regardless of whether the value is subsequently used.
        yield* DatabaseService

        return new Response('OK')
      })
    )

    const res = await app.request('/declare-db')
    const body = await res.json()
    expect(body.component).toBe('Error')
    expect(body.props.message).toContain('DatabaseService is not configured')
  })
})

// =============================================================================
// Integration with effectRoutes Tests
// =============================================================================

describe('setupHonertia integration with effectRoutes', () => {
  test('effectRoutes can override schema if needed', async () => {
    const app = new Hono<TestEnv>()

    const setupSchema = {
      projects: { id: { name: 'id', columnType: 'SQLiteText' } },
    }

    const routeSchema = {
      tasks: {
        id: { name: 'id', columnType: 'SQLiteText' },
        title: { name: 'title' },
      },
    }

    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: '1', title: 'Test Task' }],
          }),
        }),
      }),
    }

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
          database: () => mockDb,
          schema: setupSchema,
        },
      })
    )

    // effectRoutes can pass its own schema to override
    effectRoutes(app, {
      schema: routeSchema,
      bindings: { task: S.Struct({ id: S.String, title: S.String }) },
    }).get(
      '/tasks/{task}',
      Effect.gen(function* () {
        const task = yield* bound('task')

        return Response.json(task)
      })
    )

    const res = await app.request('/tasks/1')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.title).toBe('Test Task')
  })

  test('multiple effectRoutes groups share the same schema from setupHonertia', async () => {
    const app = new Hono<TestEnv>()

    const mockSchema = {
      projects: { id: { name: 'id', columnType: 'SQLiteText' }, name: { name: 'name' } },
      users: { id: { name: 'id', columnType: 'SQLiteText' }, email: { name: 'email' } },
    }

    let queryCount = 0

    const mockDb = {
      select: () => ({
        from: (table: typeof mockSchema.projects | typeof mockSchema.users) => ({
          where: () => ({
            limit: async () => {
              queryCount++

              if (table === mockSchema.projects) {
                return [{ id: '1', name: 'Project A' }]
              }

              if (table === mockSchema.users) {
                return [{ id: '2', email: 'test@example.com' }]
              }

              return []
            },
          }),
        }),
      }),
    }

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
          database: () => mockDb,
          schema: mockSchema,
          bindings: {
            project: S.Struct({ id: S.String, name: S.String }),
            user: S.Struct({ id: S.String, email: S.String }),
          },
        },
      })
    )

    // First route group
    effectRoutes(app).get(
      '/projects/{project}',
      Effect.gen(function* () {
        const project = yield* bound('project')

        return Response.json(project)
      })
    )

    // Second route group - both use schema from setupHonertia
    effectRoutes(app).get(
      '/users/{user}',
      Effect.gen(function* () {
        const user = yield* bound('user')

        return Response.json(user)
      })
    )

    const projectRes = await app.request('/projects/1')
    expect(projectRes.status).toBe(200)
    expect((await projectRes.json()).name).toBe('Project A')

    const userRes = await app.request('/users/2')
    expect(userRes.status).toBe(200)
    expect((await userRes.json()).email).toBe('test@example.com')

    expect(queryCount).toBe(2)
  })
})

// =============================================================================
// Full Stack Configuration Test
// =============================================================================

describe('setupHonertia full configuration', () => {
  test('complete setup with database, auth, schema, and custom middleware', async () => {
    const app = new Hono<TestEnv>()

    const mockSchema = {
      projects: { id: { name: 'id', columnType: 'SQLiteText' }, ownerId: { name: 'ownerId' } },
    }

    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: '1', ownerId: 'user-1' }],
          }),
        }),
      }),
    }

    let customMiddlewareRan = false

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
          database: () => mockDb,
          schema: mockSchema,
          bindings: {
            project: S.Struct({ id: S.String, ownerId: S.String }),
          },
        },
        auth: {
          client: (_c, { db }) => ({
            getUser: () => ({ id: 'user-1', name: 'Test User' }),
            dbRef: db, // Can access db
          }),
        },
        middleware: [
          async (c, next) => {
            customMiddlewareRan = true
            await next()
          },
        ],
      })
    )

    effectRoutes(app).get(
      '/projects/{project}',
      Effect.gen(function* () {
        const project = yield* bound('project')
        const db = yield* DatabaseService
        const auth = yield* AuthService

        // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
        return Response.json({
            project,
            hasDb: !!db,
            hasAuth: 'getUser' in auth,
            authHasDbRef: 'dbRef' in auth,
          })
      })
    )

    const res = await app.request('/projects/1')
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.project.id).toBe('1')
    expect(json.hasDb).toBe(true)
    expect(json.hasAuth).toBe(true)
    expect(json.authHasDbRef).toBe(true)
    expect(customMiddlewareRan).toBe(true)
  })
})

// =============================================================================
// Middleware Dispatcher Tests (regression for "Context is not finalized")
// =============================================================================

describe('setupHonertia middleware dispatcher (regression)', () => {
  test('dispatcher properly propagates response through middleware chain', async () => {
    const app = new Hono<TestEnv>()
    const executed: string[] = []

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
        },
        middleware: [
          async (c, next) => {
            executed.push('custom-before')
            await next()
            executed.push('custom-after')
          },
        ],
      })
    )

    effectRoutes(app).post(
      '/form',
      Effect.sync(() => {
        executed.push('handler')

        return Response.redirect('/success', 302)
      })
    )

    const res = await app.request('/form', {
      method: 'POST',
      headers: { 'X-Inertia': 'true' },
    })

    // Response should be valid (303 due to 302->303 conversion)
    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/success')

    // All middleware should have executed
    expect(executed).toContain('custom-before')
    expect(executed).toContain('handler')
    expect(executed).toContain('custom-after')
  })

  test('wrapper middleware can transform the downstream response via c.res', async () => {
    const app = new Hono<TestEnv>()

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
        },
        middleware: [
          async (c, next) => {
            await next()
            // Hono's contract: next() resolves to void; wrappers observe and
            // transform the downstream response through c.res.
            c.res.headers.set('X-Transformed', 'yes')
          },
        ],
      })
    )

    effectRoutes(app).get('/page', Effect.succeed(new Response('content')))

    const res = await app.request('/page')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('content')
    expect(res.headers.get('X-Transformed')).toBe('yes')
  })

  test('dispatcher handles early return from custom middleware', async () => {
    const app = new Hono<TestEnv>()

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
        },
        middleware: [
          async (c, next) => {
            // Early return - don't call next()
            if (c.req.header('X-Block') === 'true') {
              return c.text('Blocked', 403)
            }

            await next()
          },
        ],
      })
    )

    effectRoutes(app).get(
      '/protected',
      Effect.succeed(new Response('OK'))
    )

    // Without block header - should reach handler
    const res1 = await app.request('/protected')
    expect(res1.status).toBe(200)
    expect(await res1.text()).toBe('OK')

    // With block header - should return early
    const res2 = await app.request('/protected', {
      headers: { 'X-Block': 'true' },
    })

    expect(res2.status).toBe(403)
    expect(await res2.text()).toBe('Blocked')
  })

  test('dispatcher handles response modification after next()', async () => {
    const app = new Hono<TestEnv>()

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
        },
        middleware: [
          async (c, next) => {
            await next()
            // Modify response after handler
            c.res.headers.set('X-Custom-Header', 'added')
          },
        ],
      })
    )

    effectRoutes(app).get(
      '/test',
      Effect.succeed(new Response('OK'))
    )

    const res = await app.request('/test')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Custom-Header')).toBe('added')
  })

  test('version mismatch returns 409 through dispatcher without error', async () => {
    const app = new Hono<TestEnv>()

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '2.0.0',
          render: (page) => JSON.stringify(page),
        },
      })
    )

    effectRoutes(app).get(
      '/page',
      Effect.succeed(new Response('OK'))
    )

    const res = await app.request('/page', {
      headers: {
        'X-Inertia': 'true',
        'X-Inertia-Version': '1.0.0', // Old version
      },
    })

    expect(res.status).toBe(409)
    expect(res.headers.get('X-Inertia-Location')).toBeTruthy()
  })

  test('catch-all route that does not call next() still finalizes context', async () => {
    const app = new Hono<TestEnv>()

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
        },
      })
    )

    // Register error handlers
    registerErrorHandlers(app, {
      component: 'Error',
      showDevErrors: true,
    })

    // Catch-all route that returns a response
    effectRoutes(app).get(
      '/*',
      Effect.succeed(new Response('Catch all', { status: 200 }))
    )

    const res = await app.request('/anything')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('Catch all')
  })
})
