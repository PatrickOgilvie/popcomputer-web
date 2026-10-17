/**
 * The application the security regression tests attack: each binding says
 * who may load its record, a guard decides an organization's, a form creates
 * a member's project, one page is cached, and two routes redirect where a
 * request asks. Every statement the database receives is logged.
 */

import { Hono } from 'hono'
import { Context, Duration, Effect, Schema as S } from 'effect'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { and, eq } from 'drizzle-orm'
import { action } from '../../src/effect/action.js'
import { intendedUrl } from '../../src/effect/auth.js'
import { bound, routeBinding } from '../../src/effect/binding.js'
import { dbMutation, dbQuery } from '../../src/effect/database.js'
import { guard } from '../../src/effect/guard.js'
import { back, json, notFound, redirect } from '../../src/effect/responses.js'
import { requiredString } from '../../src/effect/schema.js'
import { authorize } from '../../src/effect/services.js'
import { validateRequest } from '../../src/effect/validation.js'
import { setupWeb } from '../../src/setup.js'
import { signedIn, testEnv } from '../../src/testing.js'

export const user = sqliteTable('user', { id: text('id').primaryKey() })
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id),
  name: text('name').notNull(),
  visibility: text('visibility', { enum: ['private', 'public'] }).notNull(),
})
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
})
export const organizations = sqliteTable('organizations', { id: text('id').primaryKey() })
export const memberships = sqliteTable('memberships', {
  organizationId: text('organization_id').notNull().references(() => organizations.id),
  userId: text('user_id').notNull(),
})

const schema = { user, projects, tasks, organizations, memberships }

class CurrentMember extends Context.Service<CurrentMember, typeof memberships.$inferSelect>()('security/CurrentMember') {}

const ProjectForm = S.Struct({ name: requiredString })

export function createApp() {
  const sqlite = new Database(':memory:')
  sqlite.run('CREATE TABLE user (id TEXT PRIMARY KEY)')
  sqlite.run('CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, visibility TEXT NOT NULL)')
  sqlite.run('CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL)')
  sqlite.run('CREATE TABLE organizations (id TEXT PRIMARY KEY)')
  sqlite.run('CREATE TABLE memberships (organization_id TEXT NOT NULL, user_id TEXT NOT NULL)')
  sqlite.run("INSERT INTO user (id) VALUES ('ada'), ('grace')")
  sqlite.run("INSERT INTO projects (id, user_id, name, visibility) VALUES ('p1', 'ada', 'Private plans', 'private'), ('p2', 'ada', 'Launch', 'public')")
  sqlite.run("INSERT INTO tasks (id, project_id) VALUES ('t1', 'p1')")
  sqlite.run("INSERT INTO organizations (id) VALUES ('acme')")
  sqlite.run("INSERT INTO memberships (organization_id, user_id) VALUES ('acme', 'ada')")

  const queries: string[] = []
  const db = drizzle(sqlite, { schema, logger: { logQuery: (query) => queries.push(query) } })
  const app = new Hono()
  const { routes } = setupWeb(app, {
    version: '1',
    render: (page) => JSON.stringify(page),
    database: () => db,
    schema,
    bindings: {
      project: routeBinding(projects, { ownedBy: 'userId' }),
      showcase: routeBinding(projects, { publicWhen: { visibility: 'public' } }),
      task: routeBinding(tasks, { scope: { project: { foreignKey: 'projectId' } } }),
      organization: routeBinding(organizations, { guarded: true }),
    },
  })

  const RequireMember = guard(CurrentMember, Effect.gen(function* () {
    const auth = yield* authorize()
    // These tests register no binding types, so the model is read as its row.
    const organization = S.decodeUnknownSync(S.Struct({ id: S.String }))(yield* bound('organization'))
    const [membership] = yield* dbQuery((client) =>
      // SAFETY: These tests register no database type; the client is the Drizzle client above.
      (client as unknown as typeof db).select().from(memberships).where(and(
        eq(memberships.organizationId, organization.id),
        eq(memberships.userId, auth.user.id)
      ))
    )

    if (membership === undefined) return yield* notFound('Organization')

    return CurrentMember.of(membership)
  }))

  routes
    .get('/projects/{project}', action(Effect.flatMap(bound('project'), (project) => json(project))))
    .put('/projects/{project}', action(Effect.gen(function* () {
      const project = S.decodeUnknownSync(S.Struct({ id: S.String }))(yield* bound('project'))
      const input = yield* validateRequest(ProjectForm)

      yield* dbMutation((client) =>
        // SAFETY: These tests register no database type; the client is the Drizzle client above.
        (client as unknown as typeof db).update(projects).set({ name: input.name }).where(eq(projects.id, project.id))
      )

      return yield* json({ ok: true })
    })))
    .get('/projects/{project}/tasks/{task}', action(Effect.flatMap(bound('task'), (task) => json(task))))
    .get('/showcase/{showcase}', action(Effect.flatMap(bound('showcase'), (project) => json(project))), { cache: { maxAge: 60 } })
    .post('/projects', action(Effect.gen(function* () {
      const auth = yield* authorize()
      const input = yield* validateRequest(ProjectForm)
      const id = `p-${crypto.randomUUID()}`

      yield* dbMutation((client) =>
        // SAFETY: These tests register no database type; the client is the Drizzle client above.
        (client as unknown as typeof db).insert(projects).values({ ...input, id, userId: auth.user.id, visibility: 'private' })
      )

      return yield* json({ id })
    })))
    // Reads the user, waits, then loads the record, so concurrent requests interleave.
    .get('/slow/{project}', action(Effect.gen(function* () {
      const auth = yield* authorize()

      yield* Effect.sleep(Duration.millis(Math.floor(Math.random() * 8)))

      const project = S.decodeUnknownSync(S.Struct({ userId: S.String }))(yield* bound('project'))

      yield* Effect.sleep(Duration.millis(Math.floor(Math.random() * 8)))

      return yield* json({ viewer: auth.user.id, owner: project.userId })
    })))
    .get('/after-sign-in', action(Effect.flatMap(intendedUrl('/home'), (url) => json({ url }))))
    .post('/go-back', action(back('/home')))
    .get('/home', action(redirect('/home')))

  routes.prefix('/orgs/{organization}').provide(RequireMember)
    .get('/orgs/{organization}', action(Effect.flatMap(CurrentMember, (member) => json(member))))

  const row = (id: string) => sqlite.query('SELECT * FROM projects WHERE id = ?').get(id)

  return { app, queries, row, sqlite }
}

/** A request's bindings as the signed-in user with this id, or a visitor. */
export const as = (id?: string) =>
  id === undefined ? testEnv({ ENVIRONMENT: 'production' }) : testEnv(signedIn({ id }), { ENVIRONMENT: 'production' })

/** A request as a JSON client sends one. */
export const asJson = (init: RequestInit = {}): RequestInit => ({ ...init, headers: { Accept: 'application/json', ...init.headers } })
