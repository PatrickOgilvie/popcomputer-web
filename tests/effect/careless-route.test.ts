/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * A route added later by someone who forgets who may see the record: its
 * action reads the record its path names with bound(), it is registered
 * outside any guard, and it checks nothing itself. The bindings keep it safe.
 */

import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { Effect, Layer, Schema as S } from 'effect'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { and, eq } from 'drizzle-orm'
import { action } from '../../src/effect/action.js'
import { guard } from '../../src/effect/guard.js'
import { bound, routeBinding } from '../../src/effect/binding.js'
import { dbQuery } from '../../src/effect/database.js'
import { json, notFound } from '../../src/effect/responses.js'
import { authorize } from '../../src/effect/services.js'
import { setupWeb } from '../../src/setup.js'
import { signedIn, testEnv } from '../../src/testing.js'

const user = sqliteTable('user', { id: text('id').primaryKey() })
const lists = sqliteTable('lists', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id),
  isPublic: integer('is_public', { mode: 'boolean' }).notNull(),
})
const books = sqliteTable('books', {
  id: text('id').primaryKey(),
  listId: text('list_id').notNull().references(() => lists.id),
})
const organizations = sqliteTable('organizations', { id: text('id').primaryKey() })
const memberships = sqliteTable('memberships', {
  organizationId: text('organization_id').notNull().references(() => organizations.id),
  userId: text('user_id').notNull().references(() => user.id),
})
const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id),
})
const schema = { user, lists, books, organizations, memberships, projects }

const bindings = {
  list: routeBinding(lists, { ownedBy: 'userId' }),
  book: routeBinding(books, { scope: { list: { foreignKey: 'listId' } } }),
  shared: routeBinding(lists, { publicWhen: { isPublic: true } }),
  organization: routeBinding(organizations, { guarded: true }),
  project: routeBinding(projects, { scope: { organization: { foreignKey: 'organizationId' } } }),
}

const createDatabase = () => {
  const sqlite = new Database(':memory:')
  sqlite.run('CREATE TABLE user (id TEXT PRIMARY KEY)')
  sqlite.run('CREATE TABLE lists (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, is_public INTEGER NOT NULL)')
  sqlite.run('CREATE TABLE books (id TEXT PRIMARY KEY, list_id TEXT NOT NULL)')
  sqlite.run('CREATE TABLE organizations (id TEXT PRIMARY KEY)')
  sqlite.run('CREATE TABLE memberships (organization_id TEXT NOT NULL, user_id TEXT NOT NULL)')
  sqlite.run('CREATE TABLE projects (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL)')
  sqlite.run("INSERT INTO user (id) VALUES ('ada'), ('grace')")
  sqlite.run("INSERT INTO lists (id, user_id, is_public) VALUES ('ada-list', 'ada', 0), ('ada-shared', 'ada', 1), ('grace-list', 'grace', 0)")
  sqlite.run("INSERT INTO books (id, list_id) VALUES ('ada-book', 'ada-list'), ('grace-book', 'grace-list')")
  sqlite.run("INSERT INTO organizations (id) VALUES ('acme')")
  sqlite.run("INSERT INTO memberships (organization_id, user_id) VALUES ('acme', 'ada')")
  sqlite.run("INSERT INTO projects (id, organization_id) VALUES ('rocket', 'acme')")

  // Every statement a request sends to the database.
  const queries: string[] = []
  const db = drizzle(sqlite, { schema, logger: { logQuery: (query) => queries.push(query) } })

  return { db, queries }
}

const createApp = (options: { readonly guard?: boolean } = {}) => {
  const { db, queries } = createDatabase()
  const app = new Hono()
  const { routes } = setupWeb(app, {
    version: '1',
    render: (page) => JSON.stringify(page),
    database: () => db,
    schema,
    bindings,
  })

  const RequireMember = guard(Effect.gen(function* () {
    const auth = yield* authorize()
    // This test registers no binding types, so the model is read as its row.
    const organization = S.decodeUnknownSync(S.Struct({ id: S.String }))(yield* bound('organization'))
    const [membership] = yield* dbQuery((client) =>
      // SAFETY: This test registers no database type; the client is the Drizzle client above.
      (client as unknown as typeof db).select().from(memberships).where(and(
        eq(memberships.organizationId, organization.id),
        eq(memberships.userId, auth.user.id)
      ))
    )

    if (membership === undefined) return yield* notFound('Organization')
  }))

  // Each action reads the record its path names, and checks nothing.
  routes
    .get('/lists/{list}', action(Effect.flatMap(bound('list'), (list) => json(list))))
    .get('/lists/{list}/books/{book}', action(Effect.flatMap(bound('book'), (book) => json(book))))
    .get('/shared/{shared}', action(Effect.flatMap(bound('shared'), (list) => json(list))))

  const organizationRoutes = options.guard === true ? routes.provide(RequireMember) : routes

  organizationRoutes
    .get('/orgs/{organization}', action(Effect.flatMap(bound('organization'), (organization) => json(organization))))
    .get('/orgs/{organization}/projects/{project}', action(Effect.flatMap(bound('project'), (project) => json(project))))
    // A write that reads no record, though purging its route's records does.
    .post('/orgs/{organization}/projects/{project}/touch', action(json({ ok: true })), { purges: true })

  return { app, queries }
}

// Only the page's own url differs: nothing says the record exists.
const page = async (res: Response): Promise<unknown> => ({ ...(await res.json()), url: undefined })

describe('a careless route on a binding that says who may load it', () => {
  test('ownedBy serves the record to its owner, and another member the 404 a missing record gets', async () => {
    const { app } = createApp()
    const ada = testEnv(signedIn({ id: 'ada' }))
    const grace = testEnv(signedIn({ id: 'grace' }))

    const own = await app.request('/lists/ada-list', {}, ada)
    const othersExisting = await app.request('/lists/ada-list', {}, grace)
    const othersMissing = await app.request('/lists/no-such-list', {}, grace)

    expect(own.status).toBe(200)
    expect(await own.json()).toMatchObject({ id: 'ada-list', userId: 'ada' })
    expect([othersExisting.status, othersMissing.status]).toEqual([404, 404])
    expect(await page(othersExisting)).toEqual(await page(othersMissing))
  })

  test('ownedBy asks a signed-out visitor to sign in, and no query reads the table', async () => {
    const { app, queries } = createApp()

    const browser = await app.request('/lists/ada-list')
    const client = await app.request('/lists/ada-list', { headers: { Accept: 'application/json' } })

    expect(browser.status).toBe(302)
    expect(browser.headers.get('Location')).toBe('/login?redirect=%2Flists%2Fada-list')
    expect(client.status).toBe(401)
    expect(await client.json()).toMatchObject({ code: 'WEB_AUTH_100_UNAUTHENTICATED' })
    expect(queries.filter((query) => query.includes('"lists"'))).toEqual([])
  })

  test("a child scoped under an ownedBy parent is a 404 to another member, under the owner's parent or under her own", async () => {
    const { app } = createApp()
    const ada = testEnv(signedIn({ id: 'ada' }))
    const grace = testEnv(signedIn({ id: 'grace' }))

    expect((await app.request('/lists/ada-list/books/ada-book', {}, ada)).status).toBe(200)
    expect((await app.request('/lists/grace-list/books/grace-book', {}, grace)).status).toBe(200)
    expect((await app.request('/lists/ada-list/books/ada-book', {}, grace)).status).toBe(404)
    expect((await app.request('/lists/grace-list/books/ada-book', {}, grace)).status).toBe(404)
  })

  test('publicWhen serves a shared record to a signed-out visitor, and an unshared one is a 404 to everyone, its owner included', async () => {
    const { app } = createApp()

    const shared = await app.request('/shared/ada-shared')
    const unshared = [
      await app.request('/shared/ada-list'),
      await app.request('/shared/ada-list', {}, testEnv(signedIn({ id: 'grace' }))),
      await app.request('/shared/ada-list', {}, testEnv(signedIn({ id: 'ada' }))),
    ]

    expect(shared.status).toBe(200)
    expect(await shared.json()).toMatchObject({ id: 'ada-shared', isPublic: true })
    expect(unshared.map((res) => res.status)).toEqual([404, 404, 404])
  })

  test('guarded fails a route no guard reads, whether it reads the record or only a child under it, and loads no record', async () => {
    const { app, queries } = createApp()

    for (const id of ['ada', 'grace']) {
      for (const path of ['/orgs/acme', '/orgs/acme/projects/rocket']) {
        const res = await app.request(
          path,
          { headers: { Accept: 'application/json' } },
          testEnv(signedIn({ id }), { ENVIRONMENT: 'development' })
        )
        const body: unknown = await res.json()

        expect({ id, path, status: res.status }).toEqual({ id, path, status: 500 })
        expect(body).toMatchObject({
          code: 'WEB_RTE_606_BINDING_ACCESS_INVALID',
          message: expect.stringContaining('records were asked for before a guard(...) read it'),
        })
        expect(body).not.toHaveProperty('id')
      }
    }

    expect(queries).toEqual([])
  })

  test("guarded fails a write no guard reads before purging its records, so a stranger purges nothing of another organization's", async () => {
    const { app, queries } = createApp()
    const res = await app.request(
      '/orgs/acme/projects/rocket/touch',
      { method: 'POST', headers: { Accept: 'application/json' } },
      testEnv(signedIn({ id: 'grace' }), { ENVIRONMENT: 'development' })
    )

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ code: 'WEB_RTE_606_BINDING_ACCESS_INVALID' })
    expect(queries).toEqual([])
  })

  test('guarded: the same routes, provided a guard that reads the record, let a member in and answer a stranger 404', async () => {
    const { app } = createApp({ guard: true })
    const ada = testEnv(signedIn({ id: 'ada' }))
    const grace = testEnv(signedIn({ id: 'grace' }))

    const member = await app.request('/orgs/acme/projects/rocket', {}, ada)

    expect(member.status).toBe(200)
    expect(await member.json()).toMatchObject({ id: 'rocket', organizationId: 'acme' })
    expect((await app.request('/orgs/acme', {}, ada)).status).toBe(200)
    expect((await app.request('/orgs/acme', {}, grace)).status).toBe(404)
    expect((await app.request('/orgs/acme/projects/rocket', {}, grace)).status).toBe(404)
  })

  test('caching the response is refused when the route is registered, on an ownedBy binding or a child under one', () => {
    const { routes } = setupWeb(new Hono(), { version: '1', render: (page) => JSON.stringify(page), schema, bindings })

    expect(() => routes.get('/lists/{list}', action(Effect.flatMap(bound('list'), (list) => json(list))), { cache: { maxAge: 60 } }))
      .toThrow("Route '/lists/{list}' caches its response, but who may load \"list\" depends on the visitor")
    expect(() => routes.get('/lists/{list}/books/{book}', action(Effect.flatMap(bound('book'), (book) => json(book))), { cache: { maxAge: 60 } }))
      .toThrow('who may load "list" and "book" depends on the visitor')
  })
})

// Why every binding says who may load it.
describe('the 1.3 behaviour require-binding-access reports', () => {
  test("the same careless route on a bare table binding serves one member's record to another, and to a signed-out visitor", async () => {
    const { db } = createDatabase()
    const app = new Hono()
    const { routes } = setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
      database: () => db,
      schema,
      bindings: { list: lists },
    })

    routes.get('/lists/{list}', action(Effect.flatMap(bound('list'), (list) => json(list))))

    const toGrace = await app.request('/lists/ada-list', {}, testEnv(signedIn({ id: 'grace' })))
    const signedOut = await app.request('/lists/ada-list')

    expect([toGrace.status, signedOut.status]).toEqual([200, 200])
    expect(await toGrace.json()).toMatchObject({ id: 'ada-list', userId: 'ada' })
    expect(await signedOut.json()).toMatchObject({ id: 'ada-list', userId: 'ada' })
  })
})
