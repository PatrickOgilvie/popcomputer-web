/**
 * guard(): the layers that decide who may go on. A guarded binding loads only
 * once a guard has read it; memberships, roles and permissions are guards
 * provided one after another.
 */

import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { Context, Effect, Layer, Schema as S } from 'effect'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { and, eq } from 'drizzle-orm'
import { action } from '../../src/effect/action.js'
import { guard } from '../../src/effect/guard.js'
import { bound, routeBinding } from '../../src/effect/binding.js'
import { dbQuery } from '../../src/effect/database.js'
import { forbidden, json, notFound, redirectNow } from '../../src/effect/responses.js'
import { authorize } from '../../src/effect/services.js'
import { setupWeb } from '../../src/setup.js'
import { signedIn, testEnv } from '../../src/testing.js'

const organizations = sqliteTable('organizations', { id: text('id').primaryKey() })
const memberships = sqliteTable('memberships', {
  organizationId: text('organization_id').notNull().references(() => organizations.id),
  userId: text('user_id').notNull(),
  role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull(),
})
const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id),
})

type Membership = typeof memberships.$inferSelect
type Permission = 'projects.read' | 'projects.delete'

const permissions: Readonly<Record<Membership['role'], ReadonlyArray<Permission>>> = {
  owner: ['projects.read', 'projects.delete'],
  admin: ['projects.read', 'projects.delete'],
  member: ['projects.read'],
}

class CurrentMember extends Context.Service<CurrentMember, Membership>()('test/CurrentMember') {}

const createApp = () => {
  const sqlite = new Database(':memory:')
  sqlite.run('CREATE TABLE organizations (id TEXT PRIMARY KEY)')
  sqlite.run('CREATE TABLE memberships (organization_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL)')
  sqlite.run('CREATE TABLE projects (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL)')
  sqlite.run("INSERT INTO organizations (id) VALUES ('acme')")
  sqlite.run("INSERT INTO memberships (organization_id, user_id, role) VALUES ('acme', 'ada', 'admin'), ('acme', 'bob', 'member')")
  sqlite.run("INSERT INTO projects (id, organization_id) VALUES ('rocket', 'acme')")

  // Every statement a request sends to the database.
  const queries: string[] = []
  const db = drizzle(sqlite, { schema: { organizations, memberships, projects }, logger: { logQuery: (query) => queries.push(query) } })
  const app = new Hono()
  const { routes } = setupWeb(app, {
    version: '1',
    render: (page) => JSON.stringify(page),
    database: () => db,
    schema: { organizations, memberships, projects },
    bindings: {
      organization: routeBinding(organizations, { guarded: true }),
      project: routeBinding(projects, { scope: { organization: { foreignKey: 'organizationId' } } }),
    },
  })

  // This test registers no binding types, so the model is read as its row.
  const organizationOf = Effect.map(bound('organization'), S.decodeUnknownSync(S.Struct({ id: S.String })))

  // Finds the visitor's membership, and turns a stranger away with `refuse`.
  const memberOr = <E>(refuse: Effect.Effect<never, E>) => Effect.gen(function* () {
    const auth = yield* authorize()
    const organization = yield* organizationOf
    const [membership] = yield* dbQuery((client) =>
      // SAFETY: This test registers no database type; the client is the Drizzle client above.
      (client as unknown as typeof db).select().from(memberships).where(and(
        eq(memberships.organizationId, organization.id),
        eq(memberships.userId, auth.user.id)
      ))
    )

    if (membership === undefined) return yield* refuse

    return CurrentMember.of(membership)
  })

  const findMember = memberOr(notFound('Organization'))
  const RequireMember = guard(CurrentMember, findMember)

  const can = (permission: Permission) => Effect.gen(function* () {
    const member = yield* CurrentMember

    if (!permissions[member.role].includes(permission)) return yield* forbidden('Your role does not allow that.')

    return member
  })

  // Reads the organization for a page's breadcrumbs, and decides nothing.
  const Breadcrumbs = Layer.effectDiscard(Effect.asVoid(bound('organization')))

  const showProject = action(Effect.flatMap(bound('project'), (project) => json(project)))
  const whoAmI = action(Effect.flatMap(CurrentMember, (member) => json({ role: member.role })))

  routes.prefix('/breadcrumbs/{organization}').provide(Breadcrumbs).get('/breadcrumbs/{organization}/projects/{project}', showProject)
  routes.prefix('/late/{organization}').provide(Breadcrumbs).provide(RequireMember).get('/late/{organization}/projects/{project}', showProject)

  const members = routes.prefix('/orgs/{organization}').provide(RequireMember)

  members
    .get('/orgs/{organization}/projects/{project}', showProject)
    .get('/orgs/{organization}/me', whoAmI)
  members.provide(Breadcrumbs).get('/orgs/{organization}/crumbs/{project}', showProject)
  members.provide(guard(can('projects.delete'))).delete('/orgs/{organization}/projects/{project}', action(json({ deleted: true })))
  // The same permission, stated by the action.
  members.post('/orgs/{organization}/projects/{project}/archive', action(Effect.andThen(can('projects.delete'), json({ archived: true }))))

  // Guards that turn a stranger away with a 403, or by sending them elsewhere.
  routes.prefix('/closed/{organization}').provide(guard(CurrentMember, memberOr(forbidden('Members only.'))))
    .get('/closed/{organization}/projects/{project}', showProject)
  routes.prefix('/invite/{organization}').provide(guard(CurrentMember, memberOr(redirectNow('/request-access'))))
    .get('/invite/{organization}/projects/{project}', showProject)

  // The same guard, given as a layer.
  routes.prefix('/layered/{organization}').provide(guard(Layer.effect(CurrentMember, findMember))).get('/layered/{organization}/me', whoAmI)

  // A guard that decides from the project, provided before the organization's
  // guard, or on a route whose organization no guard decides.
  const ProjectGuard = guard(Effect.asVoid(bound('project')))

  routes.prefix('/early/{organization}').provide(ProjectGuard).provide(RequireMember)
    .get('/early/{organization}/projects/{project}', showProject)
  routes.prefix('/unguarded/{organization}').provide(ProjectGuard)
    .get('/unguarded/{organization}/projects/{project}', showProject)

  // One guard that decides from the organization, then from its project.
  routes.prefix('/both/{organization}').provide(guard(Effect.gen(function* () {
    yield* findMember
    yield* bound('project')
  }))).get('/both/{organization}/projects/{project}', showProject)

  // The breadcrumbs built beside a guard, which Layer.merge builds at once,
  // whose decision outlasts its read of the organization, as one waiting on
  // a distant database does.
  const SlowMember = guard(CurrentMember, Effect.gen(function* () {
    yield* organizationOf
    yield* Effect.sleep('20 millis')

    return yield* memberOr(forbidden('Members only.'))
  }))

  routes.prefix('/merged/{organization}').provide(Layer.merge(SlowMember, Breadcrumbs))
    .get('/merged/{organization}/projects/{project}', showProject)
  routes.prefix('/merged-first/{organization}').provide(Layer.merge(Breadcrumbs, SlowMember))
    .get('/merged-first/{organization}/projects/{project}', showProject)

  return { app, queries }
}

const as = (id: string) => testEnv(signedIn({ id }), { ENVIRONMENT: 'development' })
const asJson = { headers: { Accept: 'application/json' } }

describe('guard()', () => {
  test('a layer that reads a guarded record but is no guard loads nothing, for a member or a stranger', async () => {
    const { app, queries } = createApp()

    for (const id of ['ada', 'grace']) {
      const res = await app.request('/breadcrumbs/acme/projects/rocket', asJson, as(id))

      expect({ id, status: res.status }).toEqual({ id, status: 500 })
      expect(await res.json()).toMatchObject({ code: 'WEB_RTE_606_BINDING_ACCESS_INVALID' })
    }

    expect(queries).toEqual([])
  })

  test('a layer that reads a record before the guard fails; after it, the guard has decided', async () => {
    const { app } = createApp()

    expect((await app.request('/late/acme/projects/rocket', asJson, as('ada'))).status).toBe(500)
    expect((await app.request('/orgs/acme/crumbs/rocket', asJson, as('ada'))).status).toBe(200)
    expect((await app.request('/orgs/acme/crumbs/rocket', asJson, as('grace'))).status).toBe(404)
  })

  test("a guard that finds a service lets a member in with it, and answers a stranger the guard's 404", async () => {
    const { app } = createApp()

    expect(await (await app.request('/layered/acme/me', asJson, as('bob'))).json()).toEqual({ role: 'member' })
    expect((await app.request('/layered/acme/me', asJson, as('grace'))).status).toBe(404)

    expect((await app.request('/orgs/acme/projects/rocket', asJson, as('ada'))).status).toBe(200)
    expect(await (await app.request('/orgs/acme/me', asJson, as('bob'))).json()).toEqual({ role: 'member' })
    expect((await app.request('/orgs/acme/projects/rocket', asJson, as('grace'))).status).toBe(404)
  })

  test("a guard that turns a stranger away answers the same for a record under the guarded one that exists and one that does not", async () => {
    const { app, queries } = createApp()

    for (const project of ['rocket', 'nope']) {
      queries.length = 0
      const closed = await app.request(`/closed/acme/projects/${project}`, asJson, as('grace'))

      expect({ project, status: closed.status }).toEqual({ project, status: 403 })
      // The guard decided from the organization and the membership alone.
      expect(queries.filter((query) => query.includes('from "projects"'))).toEqual([])

      const invite = await app.request(`/invite/acme/projects/${project}`, asJson, as('grace'))

      expect({ project, status: invite.status, location: invite.headers.get('Location') }).toEqual({ project, status: 303, location: '/request-access' })
    }

    // The guard that answers 404 looks up the same records either way.
    const lookups = async (project: string) => {
      queries.length = 0
      await app.request(`/orgs/acme/projects/${project}`, asJson, as('grace'))

      return [...queries]
    }

    expect(await lookups('rocket')).toEqual(await lookups('nope'))

    // A member the guard lets in gets the record, or its 404.
    expect((await app.request('/closed/acme/projects/rocket', asJson, as('bob'))).status).toBe(200)
    expect((await app.request('/closed/acme/projects/nope', asJson, as('bob'))).status).toBe(404)
  })

  test('a guard that reads a record under the guarded one fails before any lookup until that one\'s guard has decided', async () => {
    const { app, queries } = createApp()

    for (const route of ['early', 'unguarded']) {
      for (const id of ['ada', 'grace']) {
        for (const project of ['rocket', 'nope']) {
          const res = await app.request(`/${route}/acme/projects/${project}`, asJson, as(id))

          expect({ route, id, project, status: res.status }).toEqual({ route, id, project, status: 500 })
          expect(await res.json()).toMatchObject({ code: 'WEB_RTE_606_BINDING_ACCESS_INVALID' })
        }
      }
    }

    expect(queries).toEqual([])
  })

  test('one guard that reads the guarded record and then one under it decides from both', async () => {
    const { app, queries } = createApp()

    expect((await app.request('/both/acme/projects/rocket', asJson, as('ada'))).status).toBe(200)
    expect((await app.request('/both/acme/projects/nope', asJson, as('ada'))).status).toBe(404)

    queries.length = 0

    for (const project of ['rocket', 'nope']) {
      expect((await app.request(`/both/acme/projects/${project}`, asJson, as('grace'))).status).toBe(404)
    }

    expect(queries.filter((query) => query.includes('from "projects"'))).toEqual([])
  })

  test('a layer built beside the guard reads no record until the guard has decided, for a member or a stranger', async () => {
    const { app, queries } = createApp()

    for (const route of ['merged', 'merged-first']) {
      for (const id of ['ada', 'grace']) {
        for (const project of ['rocket', 'nope']) {
          queries.length = 0
          const res = await app.request(`/${route}/acme/projects/${project}`, asJson, as(id))

          expect({ route, id, project, status: res.status }).toEqual({ route, id, project, status: 500 })
          expect(await res.json()).toMatchObject({ code: 'WEB_RTE_606_BINDING_ACCESS_INVALID' })
          // The project is never looked up before the guard has let the visitor in.
          expect(queries.filter((query) => query.includes('from "projects"'))).toEqual([])
        }
      }
    }
  })

  test('a permission guard after the membership guard answers a member without it the same for a record that exists and one that does not', async () => {
    const { app } = createApp()
    const remove = { method: 'DELETE', ...asJson }

    expect((await app.request('/orgs/acme/projects/rocket', remove, as('bob'))).status).toBe(403)
    expect((await app.request('/orgs/acme/projects/nope', remove, as('bob'))).status).toBe(403)
    expect((await app.request('/orgs/acme/projects/nope', asJson, as('bob'))).status).toBe(404)
  })

  test('a permission is a guard after the membership guard: a member without it gets a 403, one with it goes on', async () => {
    const { app } = createApp()
    const remove = { method: 'DELETE', ...asJson }

    expect((await app.request('/orgs/acme/projects/rocket', remove, as('ada'))).status).toBe(200)
    expect((await app.request('/orgs/acme/projects/rocket', remove, as('bob'))).status).toBe(403)
    expect((await app.request('/orgs/acme/projects/rocket', remove, as('grace'))).status).toBe(404)

    const archive = { method: 'POST', ...asJson }

    expect((await app.request('/orgs/acme/projects/rocket/archive', archive, as('ada'))).status).toBe(200)
    expect((await app.request('/orgs/acme/projects/rocket/archive', archive, as('bob'))).status).toBe(403)
  })
})
