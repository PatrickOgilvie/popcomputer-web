/**
 * The application the request fuzz tests send generated requests to. Each
 * binding says who may load its record, as an application's would: ada's
 * and grace's private projects, and their tasks, carry canary names no input
 * ever holds, so a response that shows one to anyone else has leaked it. Its
 * routes read, write, nest form fields, cache a public page, return to the
 * page a visitor signed in for, list the tasks no private project holds, and
 * add and edit a project's notes, which only steps create, and none is meant
 * to fail
 * with a defect, which `sendFuzzRequest` hands `brokenPromises` from the
 * error observer. Every statement the database receives is kept.
 */
import { Hono } from 'hono'
import { Context, Effect, Schema as S } from 'effect'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { and, eq, notInArray } from 'drizzle-orm'
import { action, form } from '../../src/effect/action.js'
import { intendedUrl } from '../../src/effect/auth.js'
import { bound, routeBinding } from '../../src/effect/binding.js'
import { dbMutation, dbQuery } from '../../src/effect/database.js'
import { guard } from '../../src/effect/guard.js'
import { json, notFound, redirect } from '../../src/effect/responses.js'
import { coercedNumber, currentPassword, email, nullableString, requiredString } from '../../src/effect/schema.js'
import { authorize } from '../../src/effect/services.js'
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
  title: text('title').notNull(),
})
export const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  body: text('body').notNull(),
})
export const organizations = sqliteTable('organizations', { id: text('id').primaryKey() })
export const memberships = sqliteTable('memberships', {
  organizationId: text('organization_id').notNull().references(() => organizations.id),
  userId: text('user_id').notNull(),
})

const schema = { user, projects, tasks, notes, organizations, memberships }

/** Every route's path, declared once, as an application's src/paths.ts declares them. */
export const paths = {
  home: '/',
  projects: '/projects',
  project: '/projects/{project}',
  task: '/projects/{project}/tasks/{task}',
  tasks: '/tasks',
  notes: '/projects/{project}/notes',
  note: '/projects/{project}/notes/{note}',
  showcase: '/showcase/{showcase}',
  organization: '/orgs/{organization}',
  signIn: '/sign-in',
  search: '/search',
  orders: '/orders',
  afterSignIn: '/after-sign-in',
} as const

/** Names only the owner of each private project may ever see. */
export const CANARIES = { ada: 'canary-ada-7f3a', grace: 'canary-grace-91c2' } as const

export type Person = keyof typeof CANARIES

class CurrentMember extends Context.Service<CurrentMember, typeof memberships.$inferSelect>()('fuzz/CurrentMember') {}

const ProjectForm = S.Struct({ name: requiredString })
const NoteForm = S.Struct({ body: requiredString })
const EditNote = S.Struct({ note: requiredString, body: requiredString })
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

/** A project, task or note, as the database holds it: the record its row belongs to, and its text. */
export interface RecordRow {
  readonly kind: 'project' | 'task' | 'note'
  readonly id: string
  /** A project's user, a task's or a note's project. */
  readonly parent: string
  /** A project's name and visibility, a task's title, a note's body. */
  readonly text: string
}

export function createApp() {
  const sqlite = new Database(':memory:')
  sqlite.run('CREATE TABLE user (id TEXT PRIMARY KEY)')
  sqlite.run('CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, visibility TEXT NOT NULL)')
  sqlite.run('CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL)')
  sqlite.run('CREATE TABLE notes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL)')
  sqlite.run('CREATE TABLE organizations (id TEXT PRIMARY KEY)')
  sqlite.run('CREATE TABLE memberships (organization_id TEXT NOT NULL, user_id TEXT NOT NULL)')
  sqlite.run("INSERT INTO user (id) VALUES ('ada'), ('grace')")
  sqlite.run(`INSERT INTO projects (id, user_id, name, visibility) VALUES
    ('p1', 'ada', '${CANARIES.ada}', 'private'), ('p2', 'ada', 'Launch', 'public'), ('g1', 'grace', '${CANARIES.grace}', 'private')`)
  sqlite.run(`INSERT INTO tasks (id, project_id, title) VALUES
    ('t1', 'p1', '${CANARIES.ada} plan'), ('t2', 'g1', '${CANARIES.grace} plan'), ('t3', 'p2', 'Launch checklist')`)
  sqlite.run("INSERT INTO organizations (id) VALUES ('acme'), ('globex')")
  sqlite.run("INSERT INTO memberships (organization_id, user_id) VALUES ('acme', 'ada'), ('globex', 'grace')")

  const statements: string[] = []
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
      note: routeBinding(notes, { scope: { project: { foreignKey: 'projectId' } } }),
      organization: routeBinding(organizations, { guarded: true }),
    },
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
    .get(paths.project, action(Effect.flatMap(bound('project'), (project) => json(project))))
    .put(paths.project, action(form(ProjectForm), (input) => Effect.gen(function* () {
      const project = S.decodeUnknownSync(Id)(yield* bound('project'))

      yield* dbMutation((given) => client(given).update(projects).set({ name: input.name }).where(eq(projects.id, project.id)))

      return yield* redirect(paths.project, { project: project.id })
    })))
    .patch(paths.project, action(form(ProjectForm), (input) => Effect.gen(function* () {
      const project = S.decodeUnknownSync(Id)(yield* bound('project'))

      yield* dbMutation((given) => client(given).update(projects).set({ name: input.name }).where(eq(projects.id, project.id)))

      return yield* json({ ok: true })
    })))
    .delete(paths.project, action(Effect.gen(function* () {
      const project = S.decodeUnknownSync(Id)(yield* bound('project'))

      yield* dbMutation((given) => client(given).delete(notes).where(eq(notes.projectId, project.id)))
      yield* dbMutation((given) => client(given).delete(tasks).where(eq(tasks.projectId, project.id)))
      yield* dbMutation((given) => client(given).delete(projects).where(eq(projects.id, project.id)))

      return yield* redirect(paths.projects)
    })))
    .post(paths.projects, action(form(ProjectForm), (input) => Effect.gen(function* () {
      const auth = yield* authorize()
      const id = `p-${crypto.randomUUID()}`

      yield* dbMutation((given) => client(given).insert(projects).values({ ...input, id, userId: auth.user.id, visibility: 'private' }))

      return yield* json({ id })
    })))
    .get(paths.task, action(Effect.flatMap(bound('task'), (task) => json(task))))
    // The tasks no private project holds. It relies on every task having its
    // project, which the delete keeps by taking a project's tasks with it.
    .get(paths.tasks, action(Effect.flatMap(
      dbQuery((given) => client(given).select().from(tasks).where(notInArray(
        tasks.projectId,
        client(given).select({ id: projects.id }).from(projects).where(eq(projects.visibility, 'private'))
      ))),
      (shown) => json(shown)
    )))
    .post(paths.notes, action(form(NoteForm), (input) => Effect.gen(function* () {
      const project = S.decodeUnknownSync(Id)(yield* bound('project'))
      const id = `n-${crypto.randomUUID()}`

      yield* dbMutation((given) => client(given).insert(notes).values({ id, projectId: project.id, body: input.body }))

      return yield* json({ id })
    })))
    // A form that names the note it edits in its body, as a list of notes
    // edited in place does: the note is looked up among the project's own.
    .put(paths.notes, action(form(EditNote), (input) => Effect.gen(function* () {
      const project = S.decodeUnknownSync(Id)(yield* bound('project'))
      const [note] = yield* dbQuery((given) =>
        client(given).select().from(notes).where(and(eq(notes.id, input.note), eq(notes.projectId, project.id)))
      )

      if (note === undefined) return yield* notFound('Note')

      yield* dbMutation((given) => client(given).update(notes).set({ body: input.body }).where(eq(notes.id, note.id)))

      return yield* json({ ok: true })
    })))
    .get(paths.note, action(Effect.flatMap(bound('note'), (note) => json(note))))
    .get(paths.showcase, action(Effect.flatMap(bound('showcase'), (project) => json(project))), { cache: { maxAge: 60 } })
    .post(paths.signIn, action(form(SignInForm), (input) => json({ email: input.email })))
    .get(paths.search, action(form(Search), (input) => json(input)))
    .post(paths.orders, action(form(Order), (input) => json(input)))
    .get(paths.afterSignIn, action(Effect.flatMap(intendedUrl('/home'), (url) => json({ url }))))

  routes.prefix(paths.organization).provide(RequireMember)
    .get(paths.organization, action(Effect.flatMap(CurrentMember, (member) => json(member))))

  const rows = () => sqlite.query<ProjectRow, []>('SELECT id, user_id, name, visibility FROM projects ORDER BY id').all()
  const records = () => sqlite.query<RecordRow, []>(`
    SELECT 'project' AS kind, id, user_id AS parent, name || ' (' || visibility || ')' AS text FROM projects
    UNION ALL SELECT 'task', id, project_id, title FROM tasks
    UNION ALL SELECT 'note', id, project_id, body FROM notes
    ORDER BY id`).all()

  return { app, statements, rows, routes, records }
}
