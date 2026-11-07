/**
 * Machines 24, 25, 42, 45 and 46: the records a route's path names, and the
 * declarations that say who may load them. A failed load is kept, a
 * signed-out visitor is asked to sign in before the database is asked, a
 * removed record keeps its parents' tags, an undecided guarded record stops
 * the action, and a declaration that lost its table is refused.
 */
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Effect, Layer, Schema as S, Struct } from 'effect'
import { Hono } from 'hono'
import { action } from '../../src/effect/action.js'
import { betterAuthSession } from '../../src/effect/auth.js'
import { bound, routeBinding } from '../../src/effect/binding.js'
import { effectBridge } from '../../src/effect/bridge.js'
import { dbMutation } from '../../src/effect/database.js'
import { json } from '../../src/effect/responses.js'
import type { WebDeclaration } from '../../src/effect/register.js'
import { effectRoutes } from '../../src/effect/routing.js'
import { DatabaseService } from '../../src/effect/services.js'
import { tableSchema } from '../../src/effect/table-schema.js'
import { web } from '../../src/middleware.js'
import { setupWeb } from '../../src/setup.js'
import { testEnv } from '../../src/testing.js'

const user = sqliteTable('user', { id: text('id').primaryKey() })
const orgs = sqliteTable('orgs', { id: text('id').primaryKey() })
const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => orgs.id),
  name: text('name').notNull(),
})
const lists = sqliteTable('lists', { id: text('id').primaryKey(), isPublic: integer('is_public', { mode: 'boolean' }).notNull() })
const books = sqliteTable('books', {
  id: text('id').primaryKey(),
  listId: text('list_id').notNull().references(() => lists.id),
  userId: text('user_id').notNull().references(() => user.id),
})
const schema = { user, orgs, projects, lists, books }
// Every binding these tests give, for bound()'s types.
const declared = {
  project: routeBinding(projects, { public: true }),
  org: routeBinding(orgs, { public: true }),
  list: routeBinding(lists, { publicWhen: { isPublic: true } }),
  book: routeBinding(books, { ownedBy: 'userId', scope: { list: { foreignKey: 'listId' } } }),
}

declare module '../../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{ database: BunSQLiteDatabase<typeof schema>; routeBindings: typeof declared }>
  }
}
const config = { version: '1', render: (page: unknown) => JSON.stringify(page) }
const api = { headers: { Accept: 'application/json' } }

/** A database of the tables, and every statement a request sends to it. */
function database() {
  const sqlite = new Database(':memory:')

  sqlite.run('CREATE TABLE user (id TEXT PRIMARY KEY)')
  sqlite.run('CREATE TABLE orgs (id TEXT PRIMARY KEY)')
  sqlite.run('CREATE TABLE projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL)')
  sqlite.run('CREATE TABLE lists (id TEXT PRIMARY KEY, is_public INTEGER NOT NULL)')
  sqlite.run('CREATE TABLE books (id TEXT PRIMARY KEY, list_id TEXT NOT NULL, user_id TEXT NOT NULL)')
  sqlite.run("INSERT INTO orgs VALUES ('o1')")
  sqlite.run("INSERT INTO projects VALUES ('p1', 'o1', 'One')")
  sqlite.run("INSERT INTO lists VALUES ('private', 0)")

  const queries: string[] = []
  const db = drizzle(sqlite, { schema, logger: { logQuery: (query) => void queries.push(query) } })

  return { db, queries }
}

describe("a route's records", () => {
  test('M24.T15: a record that failed to load is not looked up again in the request', async () => {
    const { db, queries } = database()
    const app = new Hono()
    const { routes } = setupWeb(app, { ...config, database: () => db, schema, bindings: { project: routeBinding(projects, { public: true }) } })

    routes.get('/projects/{project}', action(Effect.gen(function* () {
      for (let read = 0; read < 3; read += 1) yield* Effect.exit(bound('project'))

      return yield* json({ ok: true })
    })))

    await app.request('/projects/missing', api, testEnv({}))

    expect(queries).toHaveLength(1)
  })

  test("M24.T18: a signed-out visitor is asked to sign in before the database is, when a later record is its owner's", async () => {
    const { db, queries } = database()
    const app = new Hono()
    const { routes } = setupWeb(app, {
      ...config,
      database: () => db,
      schema,
      bindings: {
        list: routeBinding(lists, { publicWhen: { isPublic: true } }),
        book: routeBinding(books, { ownedBy: 'userId', scope: { list: { foreignKey: 'listId' } } }),
      },
    })

    routes.get('/lists/{list}/books/{book}', action(Effect.andThen(bound('book'), json({ ok: true }))))

    const res = await app.request('/lists/private/books/b1', api, testEnv({}))

    expect(res.status).toBe(401)
    expect(queries).toEqual([])
    expect(routes.access()[0]?.signedOut).toBe('sign-in')
  })

  test("M24.T25: a record the action removed without reading it keeps its parent's tag for the purge", async () => {
    const { db } = database()
    const purged: string[] = []
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
      props: {},
      cache: { purge: (input: { readonly tags?: readonly string[] }) => Promise.resolve(void purged.push(...(input.tags ?? []))).then(() => ({ success: true })) },
    }
    const app = new Hono()
    const { routes } = setupWeb(app, {
      ...config,
      database: () => db,
      schema,
      bindings: {
        org: routeBinding(orgs, { public: true }),
        project: routeBinding(projects, { public: true, scope: { org: { foreignKey: 'orgId' } } }),
      },
    })

    routes.delete('/orgs/{org}/projects/{project}', action(Effect.andThen(
      dbMutation((tx) => tx.delete(projects).where(eq(projects.id, 'p1'))),
      json({ ok: true })
    )), { purges: true })

    const res = await app.request('/orgs/o1/projects/p1', { method: 'DELETE', ...api }, testEnv({}), ctx)

    expect(res.status).toBe(200)
    expect(purged).toContain('orgs:o1')
  })
})

describe('a guarded record', () => {
  test('M25.T6: that no guard decided stops the action before it runs, though it reads nothing', async () => {
    const { db } = database()
    let ran = 0
    const app = new Hono()
    const { routes } = setupWeb(app, { ...config, database: () => db, schema, bindings: { org: routeBinding(orgs, { guarded: true }) } })

    routes.put('/orgs/{org}', action(Effect.andThen(Effect.sync(() => void (ran += 1)), json({ ok: true }))))

    const res = await app.request('/orgs/o1', { method: 'PUT', ...api }, testEnv({}))

    expect(res.status).toBe(500)
    expect(ran).toBe(0)
  })
})

describe("a route's models", () => {
  test('M42.T2: a request outside a path-scoped bridge leaves the bridge its bindings', async () => {
    const { db } = database()
    const app = new Hono()

    app.use('*', web(config))
    app.use('/scoped/*', effectBridge({ schema, bindings: { project: routeBinding(projects, { public: true }) } }))

    // A hand stack's bound() is untyped: the route answers once it loaded the record.
    effectRoutes(app).provide(Layer.succeed(DatabaseService, db)).get('/:area/{project}', action(Effect.andThen(bound('project'), json({ loaded: true }))))

    await app.request('/other/p1', api)

    const res = await app.request('/scoped/p1', api)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ loaded: true })
  })
})

describe("a route's models, kept by the settings they came from", () => {
  test('M42.T2: two path-scoped bridges that share bindings but not a schema load from their own tables', async () => {
    const sqlite = new Database(':memory:')

    sqlite.run('CREATE TABLE projects_a (id TEXT PRIMARY KEY, name TEXT NOT NULL)')
    sqlite.run('CREATE TABLE projects_b (id TEXT PRIMARY KEY, name TEXT NOT NULL)')
    sqlite.run("INSERT INTO projects_a VALUES ('p1', 'from a')")
    sqlite.run("INSERT INTO projects_b VALUES ('p1', 'from b')")

    const projectsA = sqliteTable('projects_a', { id: text('id').primaryKey(), name: text('name').notNull() })
    const projectsB = sqliteTable('projects_b', { id: text('id').primaryKey(), name: text('name').notNull() })
    // A row schema, not a table: the binding loads from the schema's projects.
    const shared = { project: S.Struct({ id: S.String, name: S.String }) }
    const app = new Hono()

    app.use('*', web(config))
    app.use('/a/*', effectBridge({ schema: { projects: projectsA }, bindings: shared }))
    app.use('/b/*', effectBridge({ schema: { projects: projectsB }, bindings: shared }))

    effectRoutes(app).provide(Layer.succeed(DatabaseService, drizzle(sqlite))).get('/:area/{project}', action(Effect.flatMap(bound('project'), (project) => json({ name: project.name }))))

    expect(await (await app.request('/a/p1', api)).json()).toEqual({ name: 'from a' })
    expect(await (await app.request('/b/p1', api)).json()).toEqual({ name: 'from b' })
  })
})

describe('a declaration that lost its table', () => {
  test("M45.T12: a routeBinding given a schema that names no table is refused, rather than loading from the binding's plural", () => {
    const archived = sqliteTable('archived', { id: text('id').primaryKey(), name: text('name').notNull() })

    expect(() => setupWeb(new Hono(), {
      ...config,
      schema: { projects, archived },
      bindings: { project: routeBinding(tableSchema(archived).mapFields(Struct.pick(['id', 'name']))) },
    })).toThrow('names no table')
  })

  test('M46.T5: an ownedBy binding is refused when the session schema no longer names its users table', () => {
    const teams = sqliteTable('teams', { id: text('id').primaryKey() })
    const accounts = sqliteTable('accounts', { id: text('id').primaryKey() })
    const notes = sqliteTable('notes', { id: text('id').primaryKey(), teamId: text('team_id').notNull().references(() => teams.id) })

    expect(() => setupWeb(new Hono(), {
      ...config,
      schema: { teams, accounts, notes },
      auth: { client: () => ({}), session: betterAuthSession(tableSchema(accounts)).annotate({ title: 'Session' }) },
      bindings: { note: routeBinding(notes, { ownedBy: 'teamId' }) },
    })).toThrow('cannot find the users table')
  })
})
