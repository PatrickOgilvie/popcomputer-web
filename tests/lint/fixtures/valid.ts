import { and, eq, sql } from 'drizzle-orm'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '@popcomputer/web'
import {
  action,
  authorize,
  background,
  bound,
  config,
  dbMutation,
  dbQuery,
  dbTransaction,
  file,
  json,
  RequestService,
  routeBinding,
  validateRequest,
} from '@popcomputer/web/effect'
import { endpoint } from '@popcomputer/web/endpoint'
import { projects, tasks } from './schema'

export const archive = action(Effect.gen(function* () {
  const auth = yield* authorize()
  const project = yield* bound('project')
  const input = yield* validateRequest(S.Struct({ name: S.String }))
  const request = yield* RequestService
  const signature = request.header('Stripe-Signature')
  const raw = yield* Effect.promise(() => request.raw().text())

  const rows = yield* dbQuery((db) => db.select().from(tasks).where(eq(tasks.projectId, project.id)))
  yield* dbTransaction(Effect.gen(function* () {
    yield* dbMutation((db) => db.update(projects).set({ name: input.name }).where(and(eq(projects.id, project.id), eq(projects.userId, auth.user.id))))
    yield* dbMutation((db) => db.delete(tasks).where(eq(tasks.projectId, project.id)))
    yield* dbMutation((db) => db.insert(tasks).values({ id: 't1', projectId: project.id }))
  }))
  yield* dbQuery((db) => db.run(sql`SELECT * FROM projects WHERE name = ${input.name}`))
  yield* background('notify', Effect.promise(() => fetch('https://hooks.example/archived')))
  yield* Effect.void.pipe(Effect.catchTag('NoSuchElementError', () => Effect.void))

  void [rows, signature, raw]

  return yield* json({ ok: true })
}))

export const download = action(file('a,b', { contentType: 'text/csv', filename: 'export.csv' }))

const ping = endpoint.post('/ping', { body: S.Struct({ name: S.String }), success: S.Struct({ ok: S.Boolean }) })

export const pinged = action(ping, ({ body }) => Effect.succeed({ ok: body.name !== '' }))

// Outside an action module's database operations, a delete with no where is a test's reset.
export const reset = (db: { delete(table: unknown): Promise<void> }) => db.delete(tasks)

export const readsConfig = config.redacted('STRIPE_KEY')

// Each binding says who may load its record, or that its parent decides.
const shared = { team: routeBinding(projects, { guarded: true }) }
const owned = routeBinding(tasks, { ownedBy: 'userId' })

export const web = setupWeb(new Hono(), {
  version: '1',
  render: (page) => JSON.stringify(page),
  bindings: {
    project: routeBinding(projects, { ownedBy: 'userId' }),
    showcase: routeBinding(projects, { publicWhen: { isPublic: true } }),
    listing: routeBinding(projects, { public: true }),
    task: routeBinding(tasks, { scope: { project: { foreignKey: 'projectId' } } }),
    note: { schema: tasks, ownedBy: 'userId' },
    owned,
    ...shared,
  },
})
