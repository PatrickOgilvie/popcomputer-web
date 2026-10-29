/**
 * The application the request fuzz tests send generated requests to. Each
 * binding says who may load its record, as an application's would: ada's
 * and grace's private projects carry canary names no input ever holds, so a
 * response that shows one to anyone else has leaked it. Its routes read,
 * write, nest form fields, cache a public page and return to the page a
 * visitor signed in for, and none is meant to fail
 * with a defect. Every statement the database receives, and every failure
 * the error observer sees, is kept.
 */
import { Hono } from 'hono'
import { Context, Effect, Layer, Schema as S } from 'effect'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { and, eq } from 'drizzle-orm'
import { action } from '../../src/effect/action.js'
import { intendedUrl } from '../../src/effect/auth.js'
import { bound, routeBinding } from '../../src/effect/binding.js'
import { dbMutation, dbQuery } from '../../src/effect/database.js'
import { EffectErrorObserverService, type EffectErrorEvent } from '../../src/effect/error-observer.js'
import { guard } from '../../src/effect/guard.js'
import { json, notFound, redirect } from '../../src/effect/responses.js'
import { coercedNumber, currentPassword, email, nullableString, requiredString } from '../../src/effect/schema.js'
import { authorize } from '../../src/effect/services.js'
import { validateRequest } from '../../src/effect/validation.js'
import { setupWeb } from '../../src/setup.js'

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

/** Names only the owner of each private project may ever see. */
export const CANARIES = { ada: 'canary-ada-7f3a', grace: 'canary-grace-91c2' } as const

export type Person = keyof typeof CANARIES

class CurrentMember extends Context.Service<CurrentMember, typeof memberships.$inferSelect>()('fuzz/CurrentMember') {}

const ProjectForm = S.Struct({ name: requiredString })
const SignInForm = S.Struct({ email, password: currentPassword })
const Search = S.Struct({ q: nullableString, page: S.optional(coercedNumber), tags: S.optional(S.Array(S.String)) })
const Order = S.Struct({
  address: S.Struct({ city: requiredString }),
  lines: S.Array(S.Struct({ sku: requiredString, quantity: coercedNumber })),
})

/** A project row, as the database holds it. */
export interface ProjectRow {
  readonly id: string
  readonly user_id: string
  readonly name: string
  readonly visibility: string
}

export function createApp() {
  const sqlite = new Database(':memory:')
  sqlite.run('CREATE TABLE user (id TEXT PRIMARY KEY)')
  sqlite.run('CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, visibility TEXT NOT NULL)')
  sqlite.run('CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL)')
  sqlite.run('CREATE TABLE organizations (id TEXT PRIMARY KEY)')
  sqlite.run('CREATE TABLE memberships (organization_id TEXT NOT NULL, user_id TEXT NOT NULL)')
  sqlite.run("INSERT INTO user (id) VALUES ('ada'), ('grace')")
  sqlite.run(`INSERT INTO projects (id, user_id, name, visibility) VALUES
    ('p1', 'ada', '${CANARIES.ada}', 'private'), ('p2', 'ada', 'Launch', 'public'), ('g1', 'grace', '${CANARIES.grace}', 'private')`)
  sqlite.run("INSERT INTO tasks (id, project_id) VALUES ('t1', 'p1'), ('t2', 'g1')")
  sqlite.run("INSERT INTO organizations (id) VALUES ('acme'), ('globex')")
  sqlite.run("INSERT INTO memberships (organization_id, user_id) VALUES ('acme', 'ada'), ('globex', 'grace')")

  const statements: string[] = []
  const observed: EffectErrorEvent[] = []
  const db = drizzle(sqlite, { schema, logger: { logQuery: (query) => statements.push(query) } })
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
  }).services({
    app: Layer.succeed(EffectErrorObserverService, EffectErrorObserverService.of({
      observe: (event) => Effect.sync(() => void observed.push(event)),
    })),
  })

  // SAFETY: These tests register no database type; the client is the Drizzle client above.
  const client = <Given>(given: Given): typeof db => given as never
  const Id = S.Struct({ id: S.String })

  const RequireMember = guard(CurrentMember, Effect.gen(function* () {
    const auth = yield* authorize()
    const organization = S.decodeUnknownSync(Id)(yield* bound('organization'))
    const [membership] = yield* dbQuery((given) =>
      client(given).select().from(memberships).where(and(
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
      const project = S.decodeUnknownSync(Id)(yield* bound('project'))
      const input = yield* validateRequest(ProjectForm)

      yield* dbMutation((given) => client(given).update(projects).set({ name: input.name }).where(eq(projects.id, project.id)))

      return yield* redirect('/projects/{project}', { project: project.id })
    })))
    .patch('/projects/{project}', action(Effect.gen(function* () {
      const project = S.decodeUnknownSync(Id)(yield* bound('project'))
      const input = yield* validateRequest(ProjectForm)

      yield* dbMutation((given) => client(given).update(projects).set({ name: input.name }).where(eq(projects.id, project.id)))

      return yield* json({ ok: true })
    })))
    .delete('/projects/{project}', action(Effect.gen(function* () {
      const project = S.decodeUnknownSync(Id)(yield* bound('project'))

      yield* dbMutation((given) => client(given).delete(tasks).where(eq(tasks.projectId, project.id)))
      yield* dbMutation((given) => client(given).delete(projects).where(eq(projects.id, project.id)))

      return yield* redirect('/projects')
    })))
    .post('/projects', action(Effect.gen(function* () {
      const auth = yield* authorize()
      const input = yield* validateRequest(ProjectForm)
      const id = `p-${crypto.randomUUID()}`

      yield* dbMutation((given) => client(given).insert(projects).values({ ...input, id, userId: auth.user.id, visibility: 'private' }))

      return yield* json({ id })
    })))
    .get('/projects/{project}/tasks/{task}', action(Effect.flatMap(bound('task'), (task) => json(task))))
    .get('/showcase/{showcase}', action(Effect.flatMap(bound('showcase'), (project) => json(project))), { cache: { maxAge: 60 } })
    .post('/sign-in', action(Effect.flatMap(validateRequest(SignInForm), (input) => json({ email: input.email }))))
    .get('/search', action(Effect.flatMap(validateRequest(Search), (input) => json(input))))
    .post('/orders', action(Effect.flatMap(validateRequest(Order), (input) => json(input))))
    .get('/after-sign-in', action(Effect.flatMap(intendedUrl('/home'), (url) => json({ url }))))

  routes.prefix('/orgs/{organization}').provide(RequireMember)
    .get('/orgs/{organization}', action(Effect.flatMap(CurrentMember, (member) => json(member))))

  const rows = () => sqlite.query<ProjectRow, []>('SELECT id, user_id, name, visibility FROM projects ORDER BY id').all()

  return { app, statements, observed, rows }
}
