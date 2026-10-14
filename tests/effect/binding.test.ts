/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
import assert from 'node:assert/strict'
/**
 * Route Model Binding Tests
 */

import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { Effect, Schema as S } from 'effect'
import { effectRoutes } from '../../src/effect/routing.js'
import { web } from '../../src/middleware.js'
import { effectBridge } from '../../src/effect/bridge.js'
import { uuid } from '../../src/effect/schema.js'
import { tableSchema } from '../../src/effect/table-schema.js'
import {
  parseBindings,
  toHonoPath,
  pluralize,
  bound,
  BoundModels,
  compileBindingPlan,
  decodeBoundRow,
  columnTypeToSchema,
  inferParamsSchema,
  routeBinding,
  type ParsedBinding,
  type RouteBindingOptions,
} from '../../src/effect/binding.js'
import { RouteConfigurationError } from '../../src/effect/errors.js'
import { ErrorCodes } from '../../src/effect/error-catalog.js'
import { registerErrorHandlers, setupWeb } from '../../src/setup.js'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { bigint, integer as pgInteger, pgTable, text as pgText, uuid as pgUuid, varchar } from 'drizzle-orm/pg-core'
import { action } from '../../src/effect/action.js'
import { authorize } from '../../src/effect/services.js'
import { json } from '../../src/effect/responses.js'
import { RequireAuthLayer } from '../../src/effect/auth.js'
import { signedIn, testEnv } from '../../src/testing.js'

describe('parseBindings', () => {
  test('reads each {param} and {param:column} placeholder, in order, and nothing else', () => {
    const cases: ReadonlyArray<readonly [string, ParsedBinding[]]> = [
      ['/projects/{project}', [{ param: 'project', column: 'id' }]],
      ['/projects/{project:slug}', [{ param: 'project', column: 'slug' }]],
      ['/api/:version/users/{user}/posts/:postId/comments/{comment:slug}', [
        { param: 'user', column: 'id' },
        { param: 'comment', column: 'slug' },
      ]],
      ['/{org}/{project}', [{ param: 'org', column: 'id' }, { param: 'project', column: 'id' }]],
      ['/users/:id', []],
      ['/files/*', []],
      ['/', []],
      ['', []],
      ['/users/:id{[0-9]+}', []],
      ['/user_profiles/{user_profile}', [{ param: 'user_profile', column: 'id' }]],
      ['/items/{item1}/subitems/{item2}', [{ param: 'item1', column: 'id' }, { param: 'item2', column: 'id' }]],
      ['/users/{user', []],
      ['/users/user}', []],
      ['/users/{{user}}', [{ param: 'user', column: 'id' }]],
      ['/users/{user:uuid}', [{ param: 'user', column: 'uuid' }]],
      ['/users/{user:user_id}', [{ param: 'user', column: 'user_id' }]],
      ['/users/{user:ID}', [{ param: 'user', column: 'ID' }]],
    ]

    for (const [path, bindings] of cases) {
      expect({ path, bindings: parseBindings(path) }).toEqual({ path, bindings })
    }
  })
})

describe('compiled route binding contract', () => {
  const projects = {
    id: { name: 'id', columnType: 'SQLiteText', dataType: 'string' },
    name: { name: 'name', columnType: 'SQLiteText', dataType: 'string' },
  }

  test('fails closed when a bound parameter has no row parser', async () => {
    await expect(
      compileBindingPlan(
        [{ param: 'project', column: 'id' }],
        { projects },
        {}
      )
    ).rejects.toBeInstanceOf(RouteConfigurationError)
  })

  test('fails closed when nested scope cannot be proven', async () => {
    const tasks = {
      id: { name: 'id', columnType: 'SQLiteText', dataType: 'string' },
    }

    await expect(
      compileBindingPlan(
        [
          { param: 'project', column: 'id' },
          { param: 'task', column: 'id' },
        ],
        { projects, tasks },
        {
          project: S.Struct({ id: S.String, name: S.String }),
          task: S.Struct({ id: S.String }),
        }
      )
    ).rejects.toMatchObject({
      // oxlint-disable-next-line popcomputer/effect-no-manual-tagged-construction -- Assert the literal external error shape independently of its production constructor.
      _tag: 'RouteConfigurationError',
      parent: 'projects',
      child: 'tasks',
    })
  })

  test('bound() returns the row its binding parsed, not the row the database holds', async () => {
    const ownedProjects = sqliteTable('projects', {
      id: text('id').primaryKey(),
      userId: text('user_id').notNull(),
    })
    const sqlite = new Database(':memory:')
    sqlite.run('CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)')
    const db = drizzle(sqlite, { schema: { projects: ownedProjects } })
    db.insert(ownedProjects).values({ id: 'p1', userId: 'user-1' }).run()

    const app = new Hono()
    const { routes } = setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
      database: () => db,
      schema: { projects: ownedProjects },
      bindings: { project: S.Struct({ id: S.String }) },
    })

    routes.get('/projects/{project}', action(Effect.gen(function* () {
      return yield* json(yield* bound('project'))
    })))

    const res = await app.request('/projects/p1')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'p1' })
  })

  test('returns the parser output instead of the raw persisted row', async () => {
    const [binding] = await compileBindingPlan(
      [{ param: 'project', column: 'id' }],
      { projects },
      { project: S.Struct({ id: S.String }) }
    )

    await expect(
      decodeBoundRow(binding, {
        id: 'project-1',
        name: 'Internal name',
      })
    ).resolves.toEqual({ id: 'project-1' })
  })
})

describe('table bindings', () => {
  const members = sqliteTable('members', {
    id: text('id').primaryKey(),
    handle: text('handle').notNull(),
    role: text('role', { enum: ['owner', 'member'] }).notNull(),
    joinedAt: integer('joined_at', { mode: 'timestamp' }).notNull(),
    bio: text('bio'),
  })

  test('check each loaded row against its table\'s columns', async () => {
    const [binding] = await compileBindingPlan(
      [{ param: 'member', column: 'handle' }],
      { members },
      { member: members }
    )
    const row = { id: 'm1', handle: 'ada', role: 'owner', joinedAt: new Date(0), bio: null }

    expect(binding.tableName).toBe('members')
    await expect(decodeBoundRow(binding, row)).resolves.toEqual(row)
    await expect(decodeBoundRow(binding, { ...row, role: 'admin' })).rejects.toMatchObject({
      // oxlint-disable-next-line popcomputer/effect-no-manual-tagged-construction -- Assert the literal external error shape independently of its production constructor.
      _tag: 'RouteConfigurationError',
      binding: 'member',
    })
    await expect(decodeBoundRow(binding, { ...row, joinedAt: 0 })).rejects.toMatchObject({ binding: 'member' })
  })

  test('load a route\'s model under any parameter name', async () => {
    const sqlite = new Database(':memory:')
    sqlite.run('CREATE TABLE members (id TEXT PRIMARY KEY, handle TEXT NOT NULL, role TEXT NOT NULL, joined_at INTEGER NOT NULL, bio TEXT)')
    const db = drizzle(sqlite, { schema: { members } })
    db.insert(members).values({ id: 'm1', handle: 'ada', role: 'owner', joinedAt: new Date(0) }).run()

    const app = new Hono()
    const { routes } = setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      database: () => db as never,
      schema: { members },
      bindings: { author: members },
    })

    routes.get('/authors/{author:handle}', action(Effect.flatMap(bound('author'), (author) => json(author))))

    const res = await app.request('/authors/ada')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 'm1', handle: 'ada', role: 'owner' })
  })
})

describe('binding scopes', () => {
  const projects = sqliteTable('projects', { id: text('id').primaryKey() })
  const environments = sqliteTable('environments', { id: text('id').primaryKey(), projectId: text('project_id').notNull() })
  const flags = sqliteTable('flags', { id: text('id').primaryKey(), projectId: text('project_id').notNull(), key: text('key').notNull() })
  const schema = { projects, environments, flags }
  const route: ParsedBinding[] = [
    { param: 'project', column: 'id' },
    { param: 'environment', column: 'id' },
    { param: 'flag', column: 'key' },
  ]

  test('scope a binding to any earlier binding of its route', async () => {
    const plan = await compileBindingPlan(route, schema, {
      project: projects,
      environment: routeBinding(environments, { scope: { project: { foreignKey: 'projectId' } } }),
      flag: routeBinding(flags, { scope: { project: { foreignKey: 'projectId' } } }),
    })

    expect(plan[2].parent?.param).toBe('project')
  })

  test('fail, naming the bindings it can scope to, when the scope names none of them', async () => {
    await expect(
      compileBindingPlan(route, schema, {
        project: projects,
        environment: routeBinding(environments, { scope: { project: { foreignKey: 'projectId' } } }),
        flag: routeBinding(flags, { scope: { team: { foreignKey: 'projectId' } } }),
      })
    ).rejects.toMatchObject({
      message: 'Route binding "flag" is scoped to "team", which is not one binding before it on this route.',
      hint: 'Name one of the bindings before "flag" in its scope: "project", "environment".',
    })
  })

  describe('when setupWeb is called, it checks', () => {
    test('a scope that names no other binding', () => {
      expect(() => setupWeb(new Hono(), {
        version: '1',
        render: (page) => JSON.stringify(page),
        bindings: {
          project: projects,
          flag: routeBinding(flags, { scope: { projcet: { foreignKey: 'projectId' } } }),
        },
      })).toThrow('Route binding "flag" is scoped to "projcet", which is not another of setupWeb\'s bindings.')
    })

    test('a foreign key or reference the tables do not have', () => {
      const setup = (scope: RouteBindingOptions<keyof typeof flags.$inferSelect>) => () => setupWeb(new Hono(), {
        version: '1',
        render: (page) => JSON.stringify(page),
        bindings: { project: projects, flag: routeBinding(flags, scope) },
      })

      // @ts-expect-error flags has no column projectUuid
      expect(setup({ scope: { project: { foreignKey: 'projectUuid' } } })).toThrow('Column "projectUuid" for route binding "flag"')
      expect(setup({ scope: { project: { foreignKey: 'projectId', references: 'uuid' } } })).toThrow('Column "uuid" for route binding "project"')
      expect(setup({ scope: { project: { foreignKey: 'projectId' } } })).not.toThrow()
    })
  })
})

describe('ambiguous bindings', () => {
  test('fail instead of picking one of several rows', async () => {
    const events = sqliteTable('events', {
      id: text('id').primaryKey(),
      slug: text('slug').notNull(),
    })
    const sqlite = new Database(':memory:')
    sqlite.run('CREATE TABLE events (id TEXT PRIMARY KEY, slug TEXT NOT NULL)')
    const db = drizzle(sqlite, { schema: { events } })
    db.insert(events).values([{ id: 'e1', slug: 'launch' }, { id: 'e2', slug: 'launch' }, { id: 'e3', slug: 'demo' }]).run()

    const app = new Hono()
    const { routes } = setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
      // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
      database: () => db as never,
      schema: { events },
      bindings: { event: events },
    })

    routes.get('/e/{event:slug}', action(Effect.flatMap(bound('event'), (event) => json(event))))

    const unique = await app.request('/e/demo', {}, { ENVIRONMENT: 'development' })
    const ambiguous = await app.request('/e/launch', { headers: { Accept: 'application/json' } }, { ENVIRONMENT: 'development' })

    expect(unique.status).toBe(200)
    expect(ambiguous.status).toBe(500)
    expect(await ambiguous.json()).toMatchObject({ code: 'WEB_RTE_605_BINDING_AMBIGUOUS' })
  })
})

describe('toHonoPath', () => {
  test('turns each {param} and {param:column} placeholder into :param, and leaves the rest of the path', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['/projects/{project}', '/projects/:project'],
      ['/projects/{project:slug}', '/projects/:project'],
      ['/api/:version/users/{user}/posts/:postId/comments/{comment:slug}', '/api/:version/users/:user/posts/:postId/comments/:comment'],
      ['/{org}/{project}', '/:org/:project'],
      ['/users/:id', '/users/:id'],
      ['/files/*', '/files/*'],
      ['/', '/'],
      ['', ''],
      ['/users/:id{[0-9]+}', '/users/:id{[0-9]+}'],
      ['/user_profiles/{user_profile}', '/user_profiles/:user_profile'],
      ['/items/{item1}/subitems/{item2}', '/items/:item1/subitems/:item2'],
      ['/users/{user', '/users/{user'],
      ['/users/user}', '/users/user}'],
      ['/users/{{user}}', '/users/{:user}'],
      ['/users/{user:user_id}/', '/users/:user/'],
    ]

    for (const [path, honoPath] of cases) {
      expect({ path, honoPath: toHonoPath(path) }).toEqual({ path, honoPath })
    }
  })
})

describe('pluralize', () => {
  test('adds s to regular words', () => {
    expect(pluralize('user')).toBe('users')
    expect(pluralize('project')).toBe('projects')
    expect(pluralize('post')).toBe('posts')
  })

  test('handles words ending in consonant + y', () => {
    expect(pluralize('category')).toBe('categories')
    expect(pluralize('company')).toBe('companies')
    expect(pluralize('city')).toBe('cities')
  })

  test('handles words ending in vowel + y', () => {
    expect(pluralize('day')).toBe('days')
    expect(pluralize('key')).toBe('keys')
    expect(pluralize('toy')).toBe('toys')
  })

  test('handles words ending in s, x, z, ch, sh', () => {
    expect(pluralize('class')).toBe('classes')
    expect(pluralize('box')).toBe('boxes')
    expect(pluralize('buzz')).toBe('buzzes')
    expect(pluralize('match')).toBe('matches')
    expect(pluralize('wish')).toBe('wishes')
    expect(pluralize('bus')).toBe('buses')
  })
})

describe('bound() accessor', () => {
  test('retrieves bound model from context', async () => {
    const effect = Effect.gen(function* () {
      // This file does not augment WebRouteBindingsType, so the model is untyped.
      const project: unknown = yield* bound('project')

      return project
    })

    const result = await Effect.runPromise(
      effect.pipe(Effect.provide(BoundModels.fromModels({ project: { id: '123', name: 'Test Project' } })))
    )

    expect(result).toEqual({ id: '123', name: 'Test Project' })
  })

  test('fails with a route configuration error when the route does not bind the key', async () => {
    const effect = Effect.gen(function* () {
      const project = yield* bound('project')

      return project
    })

    const error = await Effect.runPromise(
      // @ts-expect-error nothing binds the project, which the types report first.
      effect.pipe(Effect.provide(BoundModels.fromModels({})), Effect.flip)
    )

    assert.ok(error instanceof RouteConfigurationError)
    expect(error.binding).toBe('project')
    expect(error.code).toBe(ErrorCodes.RTE_600_BINDING_NOT_FOUND)
    expect(error.hint).toContain('{project}')
  })
})

describe('Route Model Binding Integration', () => {
  describe('route registration with different path styles', () => {
    test('Laravel-style routes work without schema (no binding resolution)', async () => {
      const app = new Hono()

      app.use(
        '*',
        web({
          version: '1.0.0',
          render: (page) => JSON.stringify(page),
        })
      )

      app.use('*', effectBridge())

      effectRoutes(app).get(
        '/projects/{project}',
        Effect.succeed(new Response('Project page'))
      )

      const res = await app.request('/projects/123')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('Project page')
    })


  })

  describe('params schema validation with Laravel-style routes', () => {
    test('validates multiple params with Laravel syntax', async () => {
      const app = new Hono()
      app.use('*', web({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
      app.use('*', effectBridge())

      effectRoutes(app).get(
        '/users/{user}/posts/{post}',
        Effect.succeed(new Response('Both valid')),
        {
          params: S.Struct({
            user: uuid,
            post: uuid,
          }),
        }
      )

      // Both invalid
      const bothInvalid = await app.request('/users/bad/posts/also-bad')
      expect(bothInvalid.status).toBe(404)

      // First valid, second invalid
      const secondInvalid = await app.request(
        '/users/123e4567-e89b-12d3-a456-426614174000/posts/not-uuid'
      )

      expect(secondInvalid.status).toBe(404)

      // Both valid
      const bothValid = await app.request(
        '/users/123e4567-e89b-12d3-a456-426614174000/posts/987fcdeb-51a2-3bc4-a567-890123456789'
      )

      expect(bothValid.status).toBe(200)
      expect(await bothValid.text()).toBe('Both valid')
    })

    test('validates mixed Hono and Laravel params', async () => {
      const app = new Hono()
      app.use('*', web({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
      app.use('*', effectBridge())

      effectRoutes(app).get(
        '/api/:version/projects/{project}',
        Effect.succeed(new Response('Mixed validated')),
        {
          params: S.Struct({
            version: S.Literals(['v1', 'v2']),
            project: uuid,
          }),
        }
      )

      // Invalid version
      const badVersion = await app.request('/api/v3/projects/123e4567-e89b-12d3-a456-426614174000')
      expect(badVersion.status).toBe(404)

      // Invalid project
      const badProject = await app.request('/api/v1/projects/not-uuid')
      expect(badProject.status).toBe(404)

      // Both valid
      const valid = await app.request('/api/v1/projects/123e4567-e89b-12d3-a456-426614174000')
      expect(valid.status).toBe(200)
      expect(await valid.text()).toBe('Mixed validated')
    })

    test('bound() gives helpful RouteConfigurationError when schema not provided', async () => {
      const app = new Hono()
      app.use('*', web({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
      app.use('*', effectBridge())

      // Set up error handler to render error pages
      registerErrorHandlers(app, { component: 'Error' })

      // Route with bindings but no schema - using bound() should error helpfully
      effectRoutes(app).get(
        '/projects/{project}',
        Effect.gen(function* () {
          const project = yield* bound('project')

          return Response.json(project)
        })
      )

      const res = await app.request('/projects/123')
      expect(res.status).toBe(500)

      const body = await res.json()
      // Error is rendered via the configured error component (not raw JSON)
      expect(body.component).toBe('Error')
      expect(body.props.status).toBe(500)
      expect(body.props.code).toBe('WEB_CFG_302_SCHEMA_NOT_CONFIGURED')
    })
  })
})

describe('columnTypeToSchema', () => {
  // Helper to decode with the dynamically returned schema
  // oxlint-disable-next-line effecttsgo/schema-sync -- These tests deliberately exercise the synchronous throwing decoder with toThrow; their schemas require no runtime services.
  const decodeWith = (schema: S.ConstraintDecoder<unknown>) => S.decodeUnknownSync(schema)

  describe('UUID types', () => {
    test('PgUUID returns UUID schema', () => {
      const decode = decodeWith(columnTypeToSchema('PgUUID'))

      // Valid UUID should pass
      expect(decode('123e4567-e89b-12d3-a456-426614174000')).toBe('123e4567-e89b-12d3-a456-426614174000')

      // Invalid UUID should throw
      expect(() => decode('not-a-uuid')).toThrow()
    })
  })

  describe('Integer types', () => {
    test('PgInteger returns NumberFromString with int filter', () => {
      const decode = decodeWith(columnTypeToSchema('PgInteger'))

      expect(decode('42')).toBe(42)
      expect(decode('0')).toBe(0)
      expect(decode('-10')).toBe(-10)

      // Non-integer should throw
      expect(() => decode('3.14')).toThrow()
      expect(() => decode('abc')).toThrow()
    })

    test('SQLiteInteger returns NumberFromString with int filter', () => {
      const decode = decodeWith(columnTypeToSchema('SQLiteInteger'))
      expect(decode('100')).toBe(100)
    })

    test('MySqlInt returns NumberFromString with int filter', () => {
      const decode = decodeWith(columnTypeToSchema('MySqlInt'))
      expect(decode('999')).toBe(999)
    })
  })

  describe('BigInt types', () => {
    test('PgBigInt64 returns BigInt schema', () => {
      const decode = decodeWith(columnTypeToSchema('PgBigInt64'))
      expect(decode('9007199254740993')).toBe(9007199254740993n)
    })
  })

  describe('Numeric/Decimal types', () => {
    test('PgNumeric returns NumberFromString', () => {
      const decode = decodeWith(columnTypeToSchema('PgNumeric'))

      expect(decode('3.14159')).toBe(3.14159)
      expect(decode('42')).toBe(42)
    })

    test('PgDoublePrecision returns NumberFromString', () => {
      const decode = decodeWith(columnTypeToSchema('PgDoublePrecision'))
      expect(decode('1.23456789')).toBe(1.23456789)
    })

    test('rejects non-finite numeric route parameters', () => {
      for (const type of ['PgNumeric', 'PgDoublePrecision', 'MySqlDecimal', 'SQLiteReal']) {
        const decode = decodeWith(columnTypeToSchema(type))

        for (const value of ['NaN', 'Infinity', '-Infinity', '1e999']) {
          expect(() => decode(value)).toThrow()
        }
      }
    })
  })

  describe('Boolean types', () => {
    test('PgBoolean transforms string to boolean (case-insensitive)', () => {
      const decode = decodeWith(columnTypeToSchema('PgBoolean'))

      expect(decode('true')).toBe(true)
      expect(decode('TRUE')).toBe(true)
      expect(decode('True')).toBe(true)
      expect(decode('1')).toBe(true)
      expect(decode('false')).toBe(false)
      expect(decode('FALSE')).toBe(false)
      expect(decode('0')).toBe(false)
      expect(decode('anything-else')).toBe(false)
    })

    test('SQLiteBoolean transforms string to boolean', () => {
      const decode = decodeWith(columnTypeToSchema('SQLiteBoolean'))

      expect(decode('true')).toBe(true)
      expect(decode('1')).toBe(true)
      expect(decode('false')).toBe(false)
      expect(decode('0')).toBe(false)
    })
  })

  describe('Unknown types', () => {
    test('unknown column type returns String schema as fallback', () => {
      const decode = decodeWith(columnTypeToSchema('SomeUnknownType'))
      expect(decode('anything')).toBe('anything')
    })
  })
})

describe('inferParamsSchema', () => {
  // Helper to decode with the dynamically returned schema
  // oxlint-disable-next-line effecttsgo/schema-sync -- These tests deliberately exercise the synchronous throwing decoder with toThrow; their schemas require no runtime services.
  const decodeWith = (schema: S.ConstraintDecoder<unknown>) => S.decodeUnknownSync(schema)

  const projects = pgTable('projects', {
    id: pgUuid('id').primaryKey(),
    slug: varchar('slug').notNull(),
    position: pgInteger('position'),
  })
  const users = pgTable('users', {
    id: pgInteger('id').primaryKey(),
    email: pgText('email'),
  })
  const posts = pgTable('posts', {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
  })
  const comments = pgTable('comments', { id: pgInteger('id').primaryKey() })
  const schema = { projects, users, posts }
  // As setupWeb's bindings: each route parameter names its table. A member
  // is a row of users, which only the configured binding says.
  const configured = { project: projects, member: users, post: posts, comment: comments }

  const infer = (path: string) => inferParamsSchema(parseBindings(path), schema, configured)

  test('infers UUID schema for UUID column', () => {
    const params = infer('/projects/{project}')

    assert.ok(params)
    const decode = decodeWith(params)

    // Valid UUID
    expect(decode({ project: '123e4567-e89b-12d3-a456-426614174000' })).toEqual({
      project: '123e4567-e89b-12d3-a456-426614174000',
    })

    // Invalid UUID should throw
    expect(() => decode({ project: 'not-a-uuid' })).toThrow()
  })

  test('infers String schema for text/varchar column with custom column syntax', () => {
    const params = infer('/projects/{project:slug}')

    assert.ok(params)
    const decode = decodeWith(params)

    // Any string should work for slug
    expect(decode({ project: 'my-awesome-project' })).toEqual({
      project: 'my-awesome-project',
    })
  })

  test('infers Integer schema for integer column of the table the binding names', () => {
    const params = infer('/members/{member}')

    assert.ok(params)
    const decode = decodeWith(params)

    // String number should be decoded to number
    expect(decode({ member: '42' })).toEqual({ member: 42 })

    // Non-numeric should throw
    expect(() => decode({ member: 'abc' })).toThrow()
  })

  test('infers BigInt schema for bigint column', () => {
    const params = infer('/posts/{post}')

    assert.ok(params)
    const decode = decodeWith(params)

    expect(decode({ post: '9007199254740993' })).toEqual({ post: 9007199254740993n })
  })

  test('infers schema for multiple bindings', () => {
    const params = infer('/members/{member}/projects/{project}')

    assert.ok(params)
    const decode = decodeWith(params)

    expect(
      decode({
        member: '1',
        project: '123e4567-e89b-12d3-a456-426614174000',
      })
    ).toEqual({
      member: 1,
      project: '123e4567-e89b-12d3-a456-426614174000',
    })
  })

  test('returns null for empty bindings', () => {
    expect(infer('/static/path')).toBeNull()
  })

  test('returns null when table not found in schema', () => {
    expect(infer('/comments/{comment}')).toBeNull()
  })

  test('returns null when column not found in table', () => {
    expect(infer('/projects/{project:nonexistent}')).toBeNull()
  })
})

describe('route model binding loads when the action asks', () => {
  const createApp = (options: { readonly guard?: boolean } = {}) => {
    const projects = sqliteTable('projects', {
      id: text('id').primaryKey(),
      userId: text('user_id').notNull(),
    })
    const sqlite = new Database(':memory:')
    sqlite.run('CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)')
    sqlite.run("INSERT INTO projects (id, user_id) VALUES ('secret-project', 'user-1')")

    // Every statement a request sends to the database.
    const queries: string[] = []
    const db = drizzle(sqlite, { schema: { projects }, logger: { logQuery: (query) => queries.push(query) } })
    const app = new Hono()

    setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
      database: () => db,
      schema: { projects },
      bindings: { project: S.Struct({ id: S.String, userId: S.String }) },
    })

    const routes = options.guard ? effectRoutes(app).provide(RequireAuthLayer) : effectRoutes(app)

    routes
      .get('/projects/{project}', action(Effect.gen(function* () {
        yield* authorize()

        return yield* json(yield* bound('project'))
      })))
      .get('/projects/{project}/ping', action(json({ pong: true })))
      .get('/projects/{project}/audit', action(Effect.gen(function* () {
        return yield* json(yield* bound('project'))
      })), { params: S.Struct({ project: uuid }) })

    routes.prefix('/teams/{project}').get('/settings', action(Effect.gen(function* () {
      return yield* json(yield* bound('project'))
    }))).post('/archive', action(json({ archived: true })), { purges: true })

    return { app, queries }
  }

  test('a binding given as tableSchema(table, overrides) loads from that table', async () => {
    const rules = sqliteTable('alert_rules', {
      id: text('id').primaryKey(),
      spec: text('spec', { mode: 'json' }).notNull(),
    })
    const sqlite = new Database(':memory:')
    sqlite.run('CREATE TABLE alert_rules (id TEXT PRIMARY KEY, spec TEXT NOT NULL)')
    const db = drizzle(sqlite, { schema: { alertRules: rules } })
    db.insert(rules).values({ id: 'r1', spec: { metric: 'temp', above: 30 } }).run()

    const app = new Hono()
    const { routes } = setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
      database: () => db,
      schema: { alertRules: rules },
      bindings: { rule: tableSchema(rules, { spec: S.Struct({ metric: S.String, above: S.Number }) }) },
    })
    routes.get('/rules/{rule}', action(Effect.gen(function* () {
      return yield* json(yield* bound('rule'))
    })))

    const res = await app.request('/rules/r1')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'r1', spec: { metric: 'temp', above: 30 } })
  })

  test('a bare {param} looks up a table without an id column by its primary key', async () => {
    const locales = sqliteTable('locales', { code: text('code').primaryKey(), name: text('name').notNull() })
    const sqlite = new Database(':memory:')
    sqlite.run('CREATE TABLE locales (code TEXT PRIMARY KEY, name TEXT NOT NULL)')
    const db = drizzle(sqlite, { schema: { locales } })
    db.insert(locales).values({ code: 'fr', name: 'Français' }).run()

    const app = new Hono()
    const { routes } = setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
      database: () => db,
      schema: { locales },
      bindings: { locale: locales },
    })
    routes.get('/{locale}', action(Effect.gen(function* () {
      return yield* json(yield* bound('locale'))
    })))

    const found = await app.request('/fr')
    const missing = await app.request('/xx')

    expect(await found.json()).toEqual({ code: 'fr', name: 'Français' })
    expect(missing.status).toBe(404)
  })

  test('a {param:column} naming no column of its table fails when the route is registered', () => {
    const envelopes = sqliteTable('envelopes', { id: text('id').primaryKey(), certificateToken: text('certificate_token').notNull() })
    const { routes } = setupWeb(new Hono(), {
      version: '1',
      render: (page) => JSON.stringify(page),
      bindings: { certificate: envelopes },
    })
    const show = action(Effect.gen(function* () {
      return yield* json(yield* bound('certificate'))
    }))

    expect(() => routes.get('/c/{certificate:certificate_token}', show))
      .toThrow('Name one of its columns by its property key: "id", "certificateToken".')
    expect(() => routes.get('/c/{certificate:certificateToken}', show)).not.toThrow()
  })

  test('a binding naming a table the schema lacks fails when setupWeb is called', () => {
    const rules = sqliteTable('alert_rules', { id: text('id').primaryKey() })

    expect(() => setupWeb(new Hono(), {
      version: '1',
      render: (page) => JSON.stringify(page),
      schema: { alertRules: rules },
      bindings: { rule: routeBinding(S.Struct({ id: S.String }), { table: 'alertRule' }) },
    })).toThrow('alertRule')
  })

  test('a prefix\'s placeholders bind models for the routes under it', async () => {
    const { app } = createApp()
    const found = await app.request('/teams/secret-project/settings')
    const missing = await app.request('/teams/no-such-project/settings')
    const archived = await app.request('/teams/secret-project/archive', { method: 'POST' })

    expect(found.status).toBe(200)
    expect(await found.json()).toEqual({ id: 'secret-project', userId: 'user-1' })
    expect(missing.status).toBe(404)
    expect(archived.status).toBe(200)
  })

  test('signed-out requests cannot tell whether a project exists', async () => {
    for (const guard of [false, true]) {
      const { app } = createApp({ guard })
      const existing = await app.request('/projects/secret-project')
      const missing = await app.request('/projects/no-such-project')

      expect([existing.status, missing.status]).toEqual([302, 302])
    }
  })

  test('signed-in requests load the model and 404 when it is missing', async () => {
    const { app } = createApp()
    const env = testEnv(signedIn({ id: 'user-1' }))

    const existing = await app.request('/projects/secret-project', {}, env)
    const missing = await app.request('/projects/no-such-project', {}, env)

    expect(existing.status).toBe(200)
    expect(await existing.json()).toEqual({ id: 'secret-project', userId: 'user-1' })
    expect(missing.status).toBe(404)
  })

  test('params validation runs before model binding', async () => {
    const { app, queries } = createApp()

    const invalid = await app.request('/projects/not-a-uuid/audit')

    expect(invalid.status).toBe(404)
    expect(queries).toEqual([])

    // A parameter the schema accepts loads the model, which is missing.
    const absent = await app.request('/projects/123e4567-e89b-12d3-a456-426614174000/audit')

    expect(absent.status).toBe(404)
    expect(queries).toHaveLength(1)
  })

  test('an action that never calls bound() does not load the model', async () => {
    const { app } = createApp()
    const res = await app.request('/projects/no-such-project/ping')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pong: true })
  })
})
