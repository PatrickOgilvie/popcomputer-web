/**
 * The route table: each registration's row holds every fact it states, the
 * records its path names with who may load them, who its layers let in, how
 * caches keep it, what it purges and where a failed form goes, as data the
 * application, its tests and its agents can read.
 */

import { describe, expect, test } from 'bun:test'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../../src/setup.js'
import { action } from '../../src/effect/action.js'
import { RequireAuthLayer, RequireGuestLayer } from '../../src/effect/auth.js'
import { routeBinding } from '../../src/effect/binding.js'
import { guard } from '../../src/effect/guard.js'
import { endpoint } from '../../src/endpoint.js'

const user = sqliteTable('user', { id: text('id').primaryKey() })
const projects = sqliteTable('projects', {
  id: integer('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id),
  visibility: text('visibility').notNull(),
})
const notes = sqliteTable('notes', {
  id: integer('id').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id),
})
const orgs = sqliteTable('orgs', { id: integer('id').primaryKey(), slug: text('slug').notNull() })
const tags = sqliteTable('tags', { id: integer('id').primaryKey() })

const ok = Effect.succeed(new Response('ok'))
const status = endpoint.get('/api/status', { success: S.Struct({ up: S.Boolean }) })
const me = endpoint.get('/api/me', { auth: true, success: S.Struct({ id: S.String }) })

function createRoutes() {
  const { routes } = setupWeb(new Hono(), {
    version: '1',
    render: (page) => JSON.stringify(page),
    schema: { user, projects, notes, orgs, tags },
    bindings: {
      project: routeBinding(projects, { ownedBy: 'userId' }),
      note: notes,
      showcase: routeBinding(projects, { publicWhen: { visibility: 'public' } }),
      org: routeBinding(orgs, { guarded: true }),
      tag: routeBinding(tags, { public: true }),
    },
  })

  routes.provide(RequireAuthLayer)
    .get('/projects/{project}', ok, { name: 'projects.show' })
    .put('/projects/{project}', ok, { purges: true })
    .get('/projects/{project}/notes/{note}', ok)
  routes.get('/showcase/{showcase}', ok)
  routes.provide(guard(Effect.void)).get('/orgs/{org:slug}', ok)
  routes
    .get('/tags/{tag}', ok, { cache: { maxAge: 60, tags: ['tags'] } })
    .get('/about', ok)
    .get('/clock', ok, { cache: 'private' })
    .post('/contact', ok, { form: '/about', purges: ['tags'] })
  routes.provide(RequireGuestLayer).get('/login', ok).post('/login', ok)
  // An owner's record without the sign-in layer: its binding asks a signed-out visitor to sign in.
  routes.delete('/projects/{project}/notes/{note}', ok)
  routes.jsonApi().get('/api/ping', ok)
  routes.endpoint(action(status, () => Effect.succeed({ up: true })))
  routes.endpoint(action(me, () => Effect.succeed({ id: 'ada' })))

  return routes
}

/** Each route's row, by its method and path. */
function rowsOf(routes: ReturnType<typeof createRoutes>) {
  return new Map(routes.toJson().map((row) => [`${row.method} ${row.path}`, row]))
}

describe('the route table', () => {
  test('records each record a path names, with its table and who may load it', () => {
    const rows = rowsOf(createRoutes())

    expect(rows.get('get /projects/{project}/notes/{note}')?.models).toEqual([
      { param: 'project', column: 'id', table: 'projects', primaryKey: 'id', access: { ownedBy: 'userId' }, personal: true },
      // A binding that says nothing, under someone's own record.
      { param: 'note', column: 'id', table: 'notes', primaryKey: 'id', access: 'unsaid', personal: true },
    ])
    expect(rows.get('get /showcase/{showcase}')?.models).toEqual([
      { param: 'showcase', column: 'id', table: 'projects', primaryKey: 'id', access: { publicWhen: { visibility: 'public' } }, personal: false },
    ])
    expect(rows.get('get /orgs/{org:slug}')?.models).toEqual([
      // Looked up by its slug, named by its primary key.
      { param: 'org', column: 'slug', table: 'orgs', primaryKey: 'id', access: 'guarded', personal: true },
    ])
    expect(rows.get('get /tags/{tag}')?.models).toEqual([
      { param: 'tag', column: 'id', table: 'tags', primaryKey: 'id', access: 'public', personal: false },
    ])
  })

  test('records who its layers let in, and how many guards and middleware decide first', () => {
    const rows = rowsOf(createRoutes())

    expect(rows.get('get /projects/{project}')).toMatchObject({ visitors: 'signed-in', guards: 0, middleware: 0, name: 'projects.show' })
    expect(rows.get('get /login')).toMatchObject({ visitors: 'guests' })
    expect(rows.get('get /orgs/{org:slug}')).toMatchObject({ visitors: 'anyone', guards: 1 })
    expect(rows.get('get /about')).toMatchObject({ visitors: 'anyone', guards: 0 })
  })

  test('records how caches keep it and what it purges', () => {
    const rows = rowsOf(createRoutes())

    expect(rows.get('get /about')).toMatchObject({ cache: 'default', pageCache: true, purges: [] })
    expect(rows.get('get /clock')).toMatchObject({ cache: 'private', pageCache: false })
    expect(rows.get('get /tags/{tag}')).toMatchObject({ cache: { maxAge: 60, tags: ['tags'] }, pageCache: false })
    // A path that names a record, or a guard that decides, keeps the default page cache away.
    expect(rows.get('get /showcase/{showcase}')).toMatchObject({ cache: 'default', pageCache: false })
    expect(rows.get('get /orgs/{org:slug}')).toMatchObject({ pageCache: false })
    expect(rows.get('put /projects/{project}')?.purges).toBe('records')
    expect(rows.get('post /contact')?.purges).toEqual(['tags'])
  })

  test('records where a failed form goes: its form option, else the page at its own path', () => {
    const rows = rowsOf(createRoutes())

    expect(rows.get('post /contact')?.form).toBe('/about')
    expect(rows.get('post /login')?.form).toBe('/login')
    expect(rows.get('put /projects/{project}')?.form).toBe('/projects/{project}')
    expect(rows.get('get /about')?.form).toBeUndefined()
  })

  test('records whether it answers pages or JSON, and the contract an endpoint implements', () => {
    const routes = createRoutes()
    const rows = rowsOf(routes)

    expect(rows.get('get /about')?.answers).toBe('page')
    expect(rows.get('get /api/ping')?.answers).toBe('json')
    expect(rows.get('get /api/status')).toMatchObject({ answers: 'json', endpoint: true })
    expect(routes.getRegistry().findByName('projects.show')?.endpoint).toBeUndefined()
    expect(routes.getRegistry().all().find((row) => row.path === '/api/status')?.endpoint).toBe(status)
  })

  test('says who reaches each route: a signed-out visitor, the owner of its records, and another member', () => {
    const access = new Map(createRoutes().access().map((row) => [`${row.method} ${row.path}`, [row.signedOut, row.owner, row.stranger]]))

    expect(Object.fromEntries(access)).toEqual({
      'get /projects/{project}': ['sign-in', 'reaches', 'not-found'],
      'put /projects/{project}': ['sign-in', 'reaches', 'not-found'],
      'get /projects/{project}/notes/{note}': ['sign-in', 'reaches', 'not-found'],
      'delete /projects/{project}/notes/{note}': ['sign-in', 'reaches', 'not-found'],
      'get /showcase/{showcase}': ['when-public', 'when-public', 'when-public'],
      'get /orgs/{org:slug}': ['guard', 'guard', 'guard'],
      'get /tags/{tag}': ['reaches', 'reaches', 'reaches'],
      'get /about': ['reaches', 'reaches', 'reaches'],
      'get /clock': ['reaches', 'reaches', 'reaches'],
      'post /contact': ['reaches', 'reaches', 'reaches'],
      'get /login': ['reaches', 'home', 'home'],
      'post /login': ['reaches', 'home', 'home'],
      'get /api/ping': ['reaches', 'reaches', 'reaches'],
      'get /api/status': ['reaches', 'reaches', 'reaches'],
      // An endpoint whose contract says auth: true.
      'get /api/me': ['sign-in', 'reaches', 'reaches'],
    })
  })

  test('is JSON as it stands, and its rows do not change once registered', () => {
    const routes = createRoutes()

    expect(JSON.parse(JSON.stringify(routes.toJson()))).toEqual(routes.toJson())
    expect(routes.getRegistry().all().every((row) => Object.isFrozen(row))).toBe(true)
  })
})
