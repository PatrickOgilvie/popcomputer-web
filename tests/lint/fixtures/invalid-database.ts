import { eq, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { action, bound, dbBatch, dbMutation, dbQuery, dbTransaction, background, json } from '@popcomputer/web/effect'
import { cacheSet } from '@popcomputer/web/cache'
import { projects, tasks } from './schema'

export const archiveAll = action(Effect.gen(function* () {
  yield* dbMutation((db) => db.update(projects).set({ archived: true })) // expect: no-unscoped-write
  yield* dbMutation((db) => db.delete(tasks).returning()) // expect: no-unscoped-write
  yield* dbBatch((db) => [db.delete(tasks)]) // expect: no-unscoped-write
  yield* dbQuery((db) => db.insert(tasks).values({ id: 't1' })) // expect: no-write-in-db-query

  yield* dbTransaction(Effect.gen(function* () {
    const project = yield* bound('project')
    yield* dbMutation((db) => db.update(projects).set({ name: 'x' }).where(eq(projects.id, project.id)))
    yield* Effect.promise(() => fetch('https://hooks.example/archived')) // expect: no-external-work-in-transaction no-external-work-in-transaction
    yield* background('notify', Effect.void) // expect: no-external-work-in-transaction
    yield* cacheSet('projects', 1, { ttl: '1 minute' }) // expect: no-external-work-in-transaction
    yield* Effect.sleep('1 second') // expect: no-external-work-in-transaction
  }))

  const name = 'x'
  yield* dbQuery((db) => db.run(sql.raw(`SELECT * FROM projects WHERE name = '${name}'`))) // expect: no-sql-interpolation
  yield* dbQuery((db) => db.run(`DELETE FROM projects WHERE id = ${name}`)) // expect: no-sql-interpolation

  return yield* json({ ok: true })
}))
