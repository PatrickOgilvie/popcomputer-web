/* oxlint-disable effecttsgo/async-function -- Test entrypoints call app.request, a native Promise contract. */
/**
 * A membership is a route model: bound by its user's id, within the
 * organization the path names, as the README's change-role example binds it.
 */

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Effect } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../../src/setup.js'
import { action } from '../../src/effect/action.js'
import { bound } from '../../src/effect/binding.js'
import { json } from '../../src/effect/responses.js'
import { testEnv } from '../../src/testing.js'

const organizations = sqliteTable('organizations', { id: text('id').primaryKey(), slug: text('slug').notNull().unique() })
const memberships = sqliteTable('memberships', {
  organizationId: text('organization_id').notNull().references(() => organizations.id),
  userId: text('user_id').notNull(),
  role: text('role').notNull(),
}, (table) => [primaryKey({ columns: [table.organizationId, table.userId] })])
const schema = { organizations, memberships }

function createApp() {
  const sqlite = new Database(':memory:')
  sqlite.run('CREATE TABLE organizations (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE)')
  sqlite.run('CREATE TABLE memberships (organization_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (organization_id, user_id))')
  sqlite.run("INSERT INTO organizations VALUES ('o1', 'acme'), ('o2', 'globex')")
  sqlite.run("INSERT INTO memberships VALUES ('o1', 'ada', 'admin'), ('o2', 'bo', 'member')")

  const db = drizzle(sqlite, { schema })
  const app = new Hono()
  const { routes } = setupWeb(app, {
    version: '1',
    render: (page) => JSON.stringify(page),
    database: () => db,
    schema,
    bindings: { organization: organizations, member: memberships },
  })

  routes.get('/orgs/{organization:slug}/members/{member:userId}', action(Effect.gen(function* () {
    return yield* json(yield* bound('member'))
  })))

  return app
}

describe('a membership bound by its user', () => {
  test("loads the organization's membership of the user the path names", async () => {
    const res = await createApp().request('/orgs/acme/members/ada', { headers: { Accept: 'application/json' } }, testEnv({}))

    expect(await res.json()).toEqual({ organizationId: 'o1', userId: 'ada', role: 'admin' })
  })

  test("is a 404 for a member of another organization", async () => {
    const res = await createApp().request('/orgs/acme/members/bo', { headers: { Accept: 'application/json' } }, testEnv({}))

    expect(res.status).toBe(404)
  })
})
