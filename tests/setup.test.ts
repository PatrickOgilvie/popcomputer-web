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
import { Effect } from 'effect'
import { setupHonertia, registerErrorHandlers } from '../src/setup.js'
import { effectRoutes } from '../src/effect/routing.js'
import {
  DatabaseService,
  AuthService,
  AuthUserService,
  HonertiaService,
} from '../src/effect/services.js'
import { bound } from '../src/effect/binding.js'

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

// =============================================================================
// Basic setupHonertia Configuration Tests
// =============================================================================

describe('setupHonertia basic configuration', () => {
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
        return new Response(JSON.stringify({ dbName: (db as any).name }))
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
          auth: (_c, { db }) => ({
            // Auth can access db because database runs first
            dbName: (db as { name?: string } | undefined)?.name,
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
        return new Response(
          JSON.stringify({
            dbName: (auth as any).dbName,
            secret: (auth as any).secret,
          })
        )
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
      Effect.gen(function* () {
        return new Response('OK')
      })
    )

    const res = await app.request('/simple')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('OK')
  })
})

// =============================================================================
// Schema Configuration Tests
// =============================================================================

describe('setupHonertia schema configuration', () => {
  // Mock schema for testing
  const mockSchema = {
    projects: {
      id: { name: 'id' },
      name: { name: 'name' },
    },
    users: {
      id: { name: 'id' },
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
        },
      })
    )

    // Route with model binding - schema comes from setupHonertia
    effectRoutes(app).get(
      '/projects/{project}',
      Effect.gen(function* () {
        const project = yield* bound('project')
        return new Response(JSON.stringify(project))
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
      id: { name: 'id' },
    }

    const postsTable = {
      id: { name: 'id' },
      userId: { name: 'userId' },
    }

    const mockSchema = {
      users: usersTable,
      posts: postsTable,
      postsRelations: {
        config: ({ one }: { one: (table: unknown, opts: any) => unknown }) => ({
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
        from: (table: unknown) => {
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
        },
      })
    )

    effectRoutes(app).get(
      '/users/{user}/posts/{post}',
      Effect.gen(function* () {
        const post = yield* bound('post')
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
          auth: () => ({
            api: {
              getSession: async ({ headers }: { headers: Headers }) => {
                getSessionCalls.push(headers.get('cookie') ?? '')
                return {
                  user: {
                    id: 'user-42',
                    email: 'user42@example.com',
                  },
                  session: {
                    id: 'session-42',
                    userId: 'user-42',
                  },
                }
              },
            },
          }),
        },
        auth: {
          sessionCookie,
        },
      })
    )

    effectRoutes(app).get(
      '/me',
      Effect.gen(function* () {
        const authUser = yield* AuthUserService
        const honertia = yield* HonertiaService
        return yield* Effect.tryPromise(() =>
          honertia.render('Auth/Me', {
            userId: (authUser as any).user.id,
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
          auth: () => ({
            api: {
              getSession: async () => {
                getSessionCalls += 1
                return null
              },
            },
          }),
        },
        auth: {
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
})

// =============================================================================
// Configuration Error Tests
// =============================================================================

describe('setupHonertia configuration errors', () => {
  test('helpful error when using route model binding without schema', async () => {
    const app = new Hono<TestEnv>()

    // Set environment to development to see full error
    app.use('*', async (c, next) => {
      ;(c.env as any) = { ENVIRONMENT: 'development' }
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
        return new Response(JSON.stringify(project))
      })
    )

    const res = await app.request('/projects/123')

    // Error should be rendered via Honertia
    expect(res.status).toBe(200) // Inertia renders with 200

    const body = await res.json()
    expect(body.component).toBe('Error')
    expect(body.props.status).toBe(500)
    expect(body.props.message).toContain('schema configuration')
  })

  test('error hint references setupHonertia configuration', async () => {
    const app = new Hono<TestEnv>()

    app.use('*', async (c, next) => {
      // Set environment to development to see full error
      ;(c.env as any) = { ENVIRONMENT: 'development' }
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
        return new Response(JSON.stringify(user))
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
      ;(c.env as any) = { ENVIRONMENT: 'development' }
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
        return new Response(JSON.stringify(article))
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
      projects: { id: { name: 'id' } },
    }

    app.use('*', async (c, next) => {
      ;(c.env as any) = { ENVIRONMENT: 'development' }
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
        return new Response(JSON.stringify(project))
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
      ;(c.env as any) = { ENVIRONMENT: 'development' }
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
        const result = (db as any).select()
        return new Response(JSON.stringify(result))
      })
    )

    const res = await app.request('/test-db')
    const body = await res.json()

    expect(body.component).toBe('Error')
    expect(body.props.message).toContain('DatabaseService is not configured')
    expect(body.props.message).toContain('setupHonertia')
    // Hint now comes from fix suggestions
    expect(body.props.hint).toContain('database')
  })

  test('helpful error when using AuthService without auth configured', async () => {
    const app = new Hono<TestEnv>()

    app.use('*', async (c, next) => {
      ;(c.env as any) = { ENVIRONMENT: 'development' }
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
        const session = (auth as any).getSession()
        return new Response(JSON.stringify(session))
      })
    )

    const res = await app.request('/test-auth')
    const body = await res.json()

    expect(body.component).toBe('Error')
    expect(body.props.message).toContain('AuthService is not configured')
    expect(body.props.message).toContain('setupHonertia')
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
      ;(c.env as any) = { ENVIRONMENT: 'development' }
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
      projects: { id: { name: 'id' } },
    }

    const routeSchema = {
      tasks: {
        id: { name: 'id' },
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
    effectRoutes(app, { schema: routeSchema }).get(
      '/tasks/{task}',
      Effect.gen(function* () {
        const task = yield* bound('task')
        return new Response(JSON.stringify(task))
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
      projects: { id: { name: 'id' }, name: { name: 'name' } },
      users: { id: { name: 'id' }, email: { name: 'email' } },
    }

    let queryCount = 0
    const mockDb = {
      select: () => ({
        from: (table: any) => ({
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
        },
      })
    )

    // First route group
    effectRoutes(app).get(
      '/projects/{project}',
      Effect.gen(function* () {
        const project = yield* bound('project')
        return new Response(JSON.stringify(project))
      })
    )

    // Second route group - both use schema from setupHonertia
    effectRoutes(app).get(
      '/users/{user}',
      Effect.gen(function* () {
        const user = yield* bound('user')
        return new Response(JSON.stringify(user))
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
      projects: { id: { name: 'id' }, ownerId: { name: 'ownerId' } },
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
          auth: (_c, { db }) => ({
            getUser: () => ({ id: 'user-1', name: 'Test User' }),
            dbRef: db, // Can access db
          }),
          schema: mockSchema,
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

        return new Response(
          JSON.stringify({
            project,
            hasDb: !!db,
            hasAuth: !!(auth as any).getUser,
            authHasDbRef: !!(auth as any).dbRef,
          })
        )
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
      Effect.gen(function* () {
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
      Effect.gen(function* () {
        return new Response('OK')
      })
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
      Effect.gen(function* () {
        return new Response('OK')
      })
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
      Effect.gen(function* () {
        return new Response('OK')
      })
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
      Effect.gen(function* () {
        return new Response('Catch all', { status: 200 })
      })
    )

    const res = await app.request('/anything')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('Catch all')
  })
})
