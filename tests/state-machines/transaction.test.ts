/**
 * Machines 24 and 29: a transaction a
 * statement has failed in cannot commit on Postgres, whatever the Effect did
 * with the failure, and a route's records load through the database the
 * caller is on.
 */
import { describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { Cause, Effect, Exit, Layer } from 'effect'
import { Hono } from 'hono'
import { action } from '../../src/effect/action.js'
import { bound, routeBinding } from '../../src/effect/binding.js'
import { dbMutation, dbQuery, dbTransaction } from '../../src/effect/database.js'
import { json } from '../../src/effect/responses.js'
import type { WebDeclaration } from '../../src/effect/register.js'
import { DatabaseService } from '../../src/effect/services.js'
import { setupWeb } from '../../src/setup.js'
import { testEnv } from '../../src/testing.js'

const projects = pgTable('projects', { id: text('id').primaryKey(), name: text('name').notNull() })
const schema = { projects }
const bindings = { project: routeBinding(projects, { public: true }) }

type TestDatabase = ReturnType<typeof drizzle<typeof schema>>

declare module '../../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{ database: TestDatabase; routeBindings: typeof bindings }>
  }
}

const database = async (rows: ReadonlyArray<readonly [string, string]> = []) => {
  const client = new PGlite()

  await client.exec('create table projects (id text primary key, name text not null)')
  for (const row of rows) await client.query('insert into projects values ($1, $2)', [...row])

  return { client, db: drizzle(client, { schema }) }
}

const names = async (client: PGlite) => (await client.query<{ id: string }>('select id from projects order by id')).rows.map((row) => row.id)

const insert = (id: string) => dbMutation((db) => db.insert(projects).values({ id, name: id }))

describe('a statement that failed inside a transaction', () => {
  test('M29.T18: fails the transaction, though the Effect caught it, since Postgres will not commit', async () => {
    const { client, db } = await database()
    const exit = await Effect.runPromiseExit(dbTransaction(Effect.gen(function* () {
      yield* insert('first')
      yield* insert('first').pipe(Effect.catchTag('DatabaseConstraintViolation', () => Effect.void))

      return 'done'
    })).pipe(Effect.provideService(DatabaseService, db)))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain('Database transaction failed')
    expect(await names(client)).toEqual([])
  })

  test('says how to keep the rest: a nested transaction', async () => {
    const { db } = await database()
    const failure = await Effect.runPromise(dbTransaction(Effect.gen(function* () {
      yield* insert('first')
      yield* insert('first').pipe(Effect.catchTag('DatabaseConstraintViolation', () => Effect.void))
    })).pipe(Effect.provideService(DatabaseService, db), Effect.flip))

    expect(failure._tag).toBe('DatabaseError')
    expect(String((failure as { cause?: unknown }).cause)).toContain('nested dbTransaction')
  })

  test('in a nested transaction, undoes that and leaves the rest to commit', async () => {
    const { client, db } = await database()

    await Effect.runPromise(dbTransaction(Effect.gen(function* () {
      yield* insert('first')
      yield* dbTransaction(insert('first')).pipe(Effect.catchTag('DatabaseConstraintViolation', () => Effect.void))
      yield* insert('second')
    })).pipe(Effect.provideService(DatabaseService, db)))

    expect(await names(client)).toEqual(['first', 'second'])
  })

  test('a transaction with no failed statement commits', async () => {
    const { client, db } = await database()

    await Effect.runPromise(dbTransaction(insert('only')).pipe(Effect.provideService(DatabaseService, db)))

    expect(await names(client)).toEqual(['only'])
  })
})

describe("a route's records", () => {
  const appOn = (db: TestDatabase) => {
    const app = new Hono()
    const { routes } = setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
      database: () => db,
      schema,
      bindings,
    })

    return { app, routes }
  }

  const answer = (response: Promise<Response> | Response) =>
    Promise.race([
      Promise.resolve(response).then((res) => res.status),
      new Promise((resolve) => setTimeout(() => resolve('no answer'), 2000)),
    ])

  test('M24.T9, M29.T22: first read inside a transaction, take part in it', async () => {
    const { db } = await database([['p1', 'one']])
    const { app, routes } = appOn(db)

    routes.get('/inside/{project}', action(Effect.gen(function* () {
      const rows = yield* dbTransaction(Effect.gen(function* () {
        const project = yield* bound('project')

        return yield* dbQuery((tx) => tx.select().from(projects).where(eq(projects.id, project.id)))
      }))

      return yield* json({ name: rows[0]?.name })
    })))

    expect(await answer(app.request('/inside/p1', { headers: { Accept: 'application/json' } }, testEnv(Layer.empty, {})))).toBe(200)
  })

  test("M24.T10: load through the database a route's layer gives, as dbQuery reads it", async () => {
    const [first, second] = [await database([['p1', 'first database']]), await database([['p1', 'second database']])]
    const { app, routes } = appOn(first.db)

    routes.provide(Layer.succeed(DatabaseService, second.db)).get('/both/{project}', action(Effect.gen(function* () {
      const project = yield* bound('project')
      const rows = yield* dbQuery((db) => db.select().from(projects))

      return yield* json({ bound: project.name, queried: rows[0]?.name })
    })))

    const res = await app.request('/both/p1', { headers: { Accept: 'application/json' } }, testEnv(Layer.empty, {}))

    expect(await res.json()).toEqual({ bound: 'second database', queried: 'second database' })
  })
})
