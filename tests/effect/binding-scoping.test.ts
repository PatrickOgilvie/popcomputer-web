/**
 * Nested Route Model Binding Scoping Tests
 *
 * A nested binding like /workspaces/{workspace}/api-keys/{apiKey} must scope
 * the child lookup to the resolved parent (WHERE id = ? AND workspace_id = ?).
 * These tests use real Drizzle tables against an in-memory SQLite database,
 * with foreign keys whose JS property key (workspaceId) differs from the SQL
 * column name (workspace_id) — the idiomatic Drizzle shape.
 */

import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { relations } from 'drizzle-orm'
import { Hono } from 'hono'
import { Effect } from 'effect'
import { effectRoutes } from '../../src/effect/routing.js'
import { honertia } from '../../src/middleware.js'
import { effectBridge } from '../../src/effect/bridge.js'
import { honertiaServices } from '../../src/request-context.js'
import { bound, findRelation } from '../../src/effect/binding.js'

const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull(),
})

// FK declared with .references() — discoverable from table metadata alone.
const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  label: text('label').notNull(),
})

// FK declared only via relations() — no .references() constraint.
const memberships = sqliteTable('memberships', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  role: text('role').notNull(),
})

const membershipsRelations = relations(memberships, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [memberships.workspaceId],
    references: [workspaces.id],
  }),
}))

const schema = { workspaces, apiKeys, memberships, membershipsRelations }

function createTestDb() {
  const sqlite = new Database(':memory:')
  sqlite.run(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, slug TEXT NOT NULL)`)
  sqlite.run(
    `CREATE TABLE api_keys (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, label TEXT NOT NULL)`
  )
  sqlite.run(
    `CREATE TABLE memberships (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, role TEXT NOT NULL)`
  )

  const db = drizzle(sqlite, { schema })

  db.insert(workspaces).values([
    { id: 'ws-1', slug: 'acme' },
    { id: 'ws-2', slug: 'globex' },
  ]).run()
  db.insert(apiKeys).values([
    { id: 'key-1', workspaceId: 'ws-1', label: 'acme key' },
    { id: 'key-2', workspaceId: 'ws-2', label: 'globex key' },
  ]).run()
  db.insert(memberships).values([
    { id: 'mem-1', workspaceId: 'ws-1', role: 'admin' },
    { id: 'mem-2', workspaceId: 'ws-2', role: 'member' },
  ]).run()

  return db
}

function createApp() {
  const db = createTestDb()
  const app = new Hono()

  app.use('*', honertia({ version: '1.0.0', render: (page) => JSON.stringify(page) }))
  app.use('*', honertiaServices(() => ({ db: db as never })))
  app.use('*', effectBridge({ schema }))

  const routes = effectRoutes(app, { schema })

  routes.get(
    '/workspaces/{workspace}/api-keys/{apiKey}',
    Effect.gen(function* () {
      const apiKey = yield* bound('apiKey')
      return Response.json(apiKey)
    })
  )

  routes.get(
    '/workspaces/{workspace}/memberships/{membership}',
    Effect.gen(function* () {
      const membership = yield* bound('membership')
      return Response.json(membership)
    })
  )

  return app
}

describe('nested binding scoping', () => {
  describe('FK discovered from .references() table metadata', () => {
    test("child belonging to a different parent returns 404 (cross-tenant)", async () => {
      const app = createApp()

      // key-2 belongs to ws-2; requesting it under ws-1 must not resolve
      const res = await app.request('/workspaces/ws-1/api-keys/key-2')
      expect(res.status).toBe(404)
    })

    test('child belonging to the requested parent resolves', async () => {
      const app = createApp()

      const res = await app.request('/workspaces/ws-1/api-keys/key-1')
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        id: 'key-1',
        workspaceId: 'ws-1',
        label: 'acme key',
      })
    })
  })

  describe('FK discovered from relations() definitions', () => {
    test("child belonging to a different parent returns 404 (cross-tenant)", async () => {
      const app = createApp()

      const res = await app.request('/workspaces/ws-1/memberships/mem-2')
      expect(res.status).toBe(404)
    })

    test('child belonging to the requested parent resolves', async () => {
      const app = createApp()

      const res = await app.request('/workspaces/ws-1/memberships/mem-1')
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        id: 'mem-1',
        workspaceId: 'ws-1',
        role: 'admin',
      })
    })
  })
})

describe('findRelation', () => {
  test('discovers FK from .references() metadata using JS property keys', async () => {
    const relation = await findRelation(schema, 'apiKeys', 'workspaces')

    expect(relation).toEqual({ foreignKey: 'workspaceId', references: 'id' })
  })

  test('discovers FK from relations() definitions using JS property keys', async () => {
    const relation = await findRelation(schema, 'memberships', 'workspaces')

    expect(relation).toEqual({ foreignKey: 'workspaceId', references: 'id' })
  })

  test('returns null when no relation links the tables', async () => {
    const relation = await findRelation(schema, 'workspaces', 'apiKeys')

    expect(relation).toBeNull()
  })
})
