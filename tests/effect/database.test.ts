/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Database Operation Tests
 *
 * The operations run against SQLite through Drizzle's asynchronous proxy
 * driver, which supports interactive transactions and batches, so atomicity
 * and constraint reporting are checked against a real database.
 */

import { describe, expect, test } from 'bun:test'
import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import { integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'
import { Cause, Effect, Exit, Layer, Option, Schema } from 'effect'
import {
  dbBatch,
  dbMutation,
  dbQuery,
  dbTransaction,
  uniqueFieldErrors,
} from '../../src/effect/database.js'
import { DatabaseService } from '../../src/effect/services.js'
import { DatabaseConstraintViolation, DatabaseError } from '../../src/effect/errors.js'
import assert from 'node:assert/strict'
import type { WebDeclaration } from '../../src/effect/register.js'

const workspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
})

const pages = sqliteTable('pages', {
  id: integer('id').primaryKey(),
  workspaceId: integer('workspace_id').notNull().references(() => workspaces.id),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
}, (table) => [unique().on(table.workspaceId, table.slug)])

type Method = 'run' | 'all' | 'values' | 'get'
type TestDatabase = SqliteRemoteDatabase

function openDatabase(): { db: TestDatabase; sqlite: Database; layer: Layer.Layer<DatabaseService> } {
  const sqlite = new Database(':memory:')
  sqlite.run('PRAGMA foreign_keys = ON')
  sqlite.run('CREATE TABLE workspaces (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
  sqlite.run(`CREATE TABLE pages (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
    slug TEXT NOT NULL,
    title TEXT NOT NULL CHECK (length(title) > 0),
    UNIQUE (workspace_id, slug)
  )`)
  sqlite.run(`INSERT INTO workspaces (id, name) VALUES (1, 'Acme')`)

  const execute = (sql: string, params: SQLQueryBindings[], method: Method): { rows: unknown[] } => {
    const statement = sqlite.prepare(sql)

    if (method === 'run') {
      statement.run(...params)

      return { rows: [] }
    }

    const rows = statement.values(...params)

    return { rows: method === 'get' ? rows[0] ?? [] : rows }
  }

  const db = drizzle(
    async (sql, params, method) => execute(sql, params, method),
    // A batch applies atomically, as on D1 and libsql.
    async (queries) =>
      sqlite.transaction(() => queries.map(({ sql, params, method }) => execute(sql, params, method)))()
  )

  return { db, sqlite, layer: Layer.succeed(DatabaseService, db) }
}

declare module '../../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{
      database: TestDatabase
    }>
  }
}

const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()

const countPages = (sqlite: Database) =>
  sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM pages').get()?.count

describe('dbQuery', () => {
  test('reads rows with their Drizzle types', async () => {
    const { layer } = openDatabase()
    const rows = await Effect.runPromise(
      dbQuery((db) => db.select().from(workspaces).where(eq(workspaces.id, 1))).pipe(Effect.provide(layer))
    )

    const names: string[] = rows.map((row) => row.name)
    expect(names).toEqual(['Acme'])
  })

  test('decodes the result with a schema', async () => {
    const { layer, db } = openDatabase()
    await db.insert(pages).values({ workspaceId: 1, slug: 'intro', title: 'Intro' })
    const Page = Schema.Struct({ slug: Schema.Literals(['intro', 'guide']), title: Schema.String })

    const decoded = await Effect.runPromise(
      dbQuery((db) => db.select({ slug: pages.slug, title: pages.title }).from(pages), Schema.Array(Page)).pipe(
        Effect.provide(layer)
      )
    )
    const rejected = await Effect.runPromiseExit(
      dbQuery((db) => db.select({ slug: pages.slug }).from(pages), Schema.Array(Schema.Struct({ slug: Schema.Literal('guide') }))).pipe(
        Effect.provide(layer)
      )
    )

    const slugs: ReadonlyArray<'intro' | 'guide'> = decoded.map((page) => page.slug)
    expect(slugs).toEqual(['intro'])
    expect(failureOf(rejected)).toMatchObject({ value: { _tag: 'DatabaseError', operation: 'query' } })
  })

  test('fails with DatabaseError when the query fails', async () => {
    const { layer, sqlite } = openDatabase()
    sqlite.run('DROP TABLE pages')

    const exit = await Effect.runPromiseExit(
      dbQuery((db) => db.select().from(pages)).pipe(Effect.provide(layer))
    )

    expect(failureOf(exit)).toMatchObject({ value: { _tag: 'DatabaseError', operation: 'query' } })
  })

  test('names the driver\'s reason in the structured message, for development pages and logs', async () => {
    const { layer, sqlite } = openDatabase()
    sqlite.run('DROP TABLE pages')

    const exit = await Effect.runPromiseExit(
      dbQuery((db) => db.select().from(pages)).pipe(Effect.provide(layer))
    )
    const failure = Option.getOrThrow(failureOf(exit))

    assert(failure instanceof DatabaseError)
    expect(failure.toStructured().message).toStartWith('Database query failed. ')
    expect(failure.toStructured().message).toContain('no such table: pages')
  })
})

describe('dbMutation', () => {
  test('returns typed rows from returning()', async () => {
    const { layer } = openDatabase()
    const [page] = await Effect.runPromise(
      dbMutation((db) =>
        db.insert(pages).values({ workspaceId: 1, slug: 'intro', title: 'Intro' }).returning()
      ).pipe(Effect.provide(layer))
    )

    const slug: string = page.slug
    expect(slug).toBe('intro')
  })

  test.each([
    ['unique', { id: 2, workspaceId: 1, slug: 'intro', title: 'Again' }, ['workspace_id', 'slug']],
    ['unique', { id: 1, workspaceId: 1, slug: 'other', title: 'Same id' }, ['id']],
    ['foreign-key', { id: 3, workspaceId: 99, slug: 'orphan', title: 'Orphan' }, []],
    ['check', { id: 4, workspaceId: 1, slug: 'blank', title: '' }, []],
  ] as const)('reports a %s violation and its columns', async (constraint, values, columns) => {
    const { layer, db } = openDatabase()
    await db.insert(pages).values({ id: 1, workspaceId: 1, slug: 'intro', title: 'Intro' })

    const exit = await Effect.runPromiseExit(
      dbMutation((db) => db.insert(pages).values(values)).pipe(Effect.provide(layer))
    )

    expect(failureOf(exit)).toMatchObject({
      value: { _tag: 'DatabaseConstraintViolation', operation: 'mutation', constraint, columns },
    })
  })

  test('classifies a constraint message without an extended code, as D1 reports it', async () => {
    const d1 = {
      run: () => Promise.reject(new Error('D1_ERROR: UNIQUE constraint failed: pages.workspace_id, pages.slug: SQLITE_CONSTRAINT')),
    }
    // SAFETY: the test client stands in for the database at its service seam;
    // only the method this mutation calls exists.
    const layer = Layer.succeed(DatabaseService, d1 as unknown as TestDatabase)

    const exit = await Effect.runPromiseExit(dbMutation((db) => db.run('INSERT ...')).pipe(Effect.provide(layer)))

    expect(failureOf(exit)).toMatchObject({
      value: { _tag: 'DatabaseConstraintViolation', constraint: 'unique', columns: ['workspace_id', 'slug'] },
    })
  })
})

describe('constraint details from other drivers', () => {
  // Drizzle wraps a driver's error and keeps it in `cause`.
  const wrapped = (driverError: Error) =>
    Object.assign(new Error("Failed to run the query 'insert into pages ...'"), { cause: driverError })

  const violationFrom = async (driverError: Error) => {
    const client = { run: () => Promise.reject(wrapped(driverError)) }
    // SAFETY: the test client stands in for the database at its service seam;
    // only the method this mutation calls exists.
    const layer = Layer.succeed(DatabaseService, client as unknown as TestDatabase)

    return failureOf(await Effect.runPromiseExit(dbMutation((db) => db.run('insert ...')).pipe(Effect.provide(layer))))
  }

  test('reads Postgres columns from detail and the constraint name', async () => {
    const postgres = Object.assign(new Error('duplicate key value violates unique constraint "pages_workspace_slug_unique"'), {
      code: '23505',
      detail: 'Key (workspace_id, slug)=(1, intro) already exists.',
      constraint: 'pages_workspace_slug_unique',
    })

    expect(await violationFrom(postgres)).toMatchObject({
      value: {
        _tag: 'DatabaseConstraintViolation',
        constraint: 'unique',
        columns: ['workspace_id', 'slug'],
        constraintName: 'pages_workspace_slug_unique',
      },
    })
  })

  test('reads a postgres.js not-null column', async () => {
    const postgres = Object.assign(new Error('null value in column "title" violates not-null constraint'), {
      code: '23502',
      column_name: 'title',
    })

    expect(await violationFrom(postgres)).toMatchObject({
      value: { constraint: 'not-null', columns: ['title'] },
    })
  })

  test('reads the MySQL key name', async () => {
    const mysql = Object.assign(new Error("Duplicate entry '1-intro' for key 'pages.pages_workspace_slug_unique'"), {
      code: 'ER_DUP_ENTRY',
      errno: 1062,
    })

    expect(await violationFrom(mysql)).toMatchObject({
      value: { constraint: 'unique', columns: [], constraintName: 'pages_workspace_slug_unique' },
    })
  })
})

describe('uniqueFieldErrors', () => {
  test('reports a unique violation on a listed column as a field error', async () => {
    const { layer, db } = openDatabase()
    await db.insert(pages).values({ workspaceId: 1, slug: 'intro', title: 'Intro' })

    const exit = await Effect.runPromiseExit(
      dbMutation((db) => db.insert(pages).values({ workspaceId: 1, slug: 'intro', title: 'Again' })).pipe(
        uniqueFieldErrors({ slug: 'A page with this slug already exists.' }),
        Effect.provide(layer)
      )
    )

    expect(failureOf(exit)).toMatchObject({
      value: { _tag: 'ValidationError', errors: { slug: 'A page with this slug already exists.' } },
    })
  })

  test('matches camelCase keys to snake_case columns, and passes other violations through', async () => {
    const { layer, db } = openDatabase()
    await db.insert(pages).values({ id: 1, workspaceId: 1, slug: 'intro', title: 'Intro' })

    const duplicateSlug = await Effect.runPromiseExit(
      dbMutation((db) => db.insert(pages).values({ workspaceId: 1, slug: 'intro', title: 'Again' })).pipe(
        uniqueFieldErrors({ workspaceId: 'Taken in this workspace.' }),
        Effect.provide(layer)
      )
    )
    const duplicateId = await Effect.runPromiseExit(
      dbMutation((db) => db.insert(pages).values({ id: 1, workspaceId: 1, slug: 'new', title: 'New' })).pipe(
        uniqueFieldErrors({ slug: 'Taken.' }),
        Effect.provide(layer)
      )
    )

    expect(failureOf(duplicateSlug)).toMatchObject({ value: { errors: { workspaceId: 'Taken in this workspace.' } } })
    expect(failureOf(duplicateId)).toMatchObject({ value: { _tag: 'DatabaseConstraintViolation', columns: ['id'] } })
  })
  test('reports a constraint named by its field, such as an index on lower(email)', async () => {
    // Postgres names the constraint but no columns for an expression index.
    const violation = new DatabaseConstraintViolation({
      operation: 'mutation',
      constraint: 'unique',
      columns: [],
      constraintName: 'contacts_email_lower_unique',
      cause: null,
    })

    const exit = await Effect.runPromiseExit(
      Effect.fail(violation).pipe(
        uniqueFieldErrors({ email: 'A contact has this email.' }, { constraints: { contacts_email_lower_unique: 'email' } })
      )
    )

    expect(failureOf(exit)).toMatchObject({ value: { _tag: 'ValidationError', errors: { email: 'A contact has this email.' } } })
    expect(violation.toStructured().message).toContain('"contacts_email_lower_unique"')
  })
})

class SlugTaken extends Schema.TaggedError<SlugTaken>()('SlugTaken', { slug: Schema.String }) {}

describe('dbTransaction', () => {
  test('commits every write the Effect makes when it succeeds', async () => {
    const { layer, sqlite } = openDatabase()

    await Effect.runPromise(
      dbTransaction(Effect.gen(function* () {
        yield* dbMutation((db) => db.insert(pages).values({ workspaceId: 1, slug: 'a', title: 'A' }))
        yield* dbMutation((db) => db.insert(pages).values({ workspaceId: 1, slug: 'b', title: 'B' }))
      })).pipe(Effect.provide(layer))
    )

    expect(countPages(sqlite)).toBe(2)
  })

  test('reads inside the transaction see its own writes', async () => {
    const { layer } = openDatabase()

    const titles = await Effect.runPromise(
      dbTransaction(Effect.gen(function* () {
        yield* dbMutation((db) => db.insert(pages).values({ workspaceId: 1, slug: 'a', title: 'A' }))

        return yield* dbQuery((db) => db.select({ title: pages.title }).from(pages))
      })).pipe(Effect.provide(layer))
    )

    expect(titles).toEqual([{ title: 'A' }])
  })

  test('rolls back earlier writes when a later one fails', async () => {
    const { layer, sqlite } = openDatabase()

    const exit = await Effect.runPromiseExit(
      dbTransaction(Effect.gen(function* () {
        yield* dbMutation((db) => db.insert(pages).values({ workspaceId: 1, slug: 'a', title: 'A' }))
        yield* dbMutation((db) => db.insert(pages).values({ workspaceId: 1, slug: 'a', title: 'Duplicate' }))
      })).pipe(Effect.provide(layer))
    )

    expect(failureOf(exit)).toMatchObject({ value: { _tag: 'DatabaseConstraintViolation', constraint: 'unique' } })
    expect(countPages(sqlite)).toBe(0)
  })

  test("rolls back on the Effect's own typed failure, and fails with it", async () => {
    const { layer, sqlite } = openDatabase()

    const exit = await Effect.runPromiseExit(
      dbTransaction(Effect.gen(function* () {
        yield* dbMutation((db) => db.insert(pages).values({ workspaceId: 1, slug: 'a', title: 'A' }))

        return yield* new SlugTaken({ slug: 'a' })
      })).pipe(Effect.provide(layer))
    )

    const failure = failureOf(exit)

    expect(Option.isSome(failure) && failure.value).toBeInstanceOf(SlugTaken)
    expect(countPages(sqlite)).toBe(0)
  })

  test('is a defect naming dbBatch when the database rejects BEGIN, as D1 does', async () => {
    const d1 = {
      transaction: () => Promise.reject(new Error(
        'D1_ERROR: To execute a transaction, please use the state.storage.transaction() or state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements.'
      )),
    }
    // SAFETY: the test client stands in for the database at its service seam;
    // only the method this transaction calls exists.
    const layer = Layer.succeed(DatabaseService, d1 as unknown as TestDatabase)

    const exit = await Effect.runPromiseExit(dbTransaction(Effect.succeed(1)).pipe(Effect.provide(layer)))

    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : '').toContain('dbBatch')
  })
})

describe('dbBatch', () => {
  test('applies every statement and returns each result in order', async () => {
    const { layer, sqlite } = openDatabase()

    const [inserted, all] = await Effect.runPromise(
      dbBatch((db) => [
        db.insert(pages).values({ workspaceId: 1, slug: 'a', title: 'A' }).returning(),
        db.select().from(pages),
      ]).pipe(Effect.provide(layer))
    )

    const titles: string[] = all.map((page) => page.title)
    expect(inserted.map((page) => page.slug)).toEqual(['a'])
    expect(titles).toEqual(['A'])
    expect(countPages(sqlite)).toBe(1)
  })

  test('applies none of the statements when one fails', async () => {
    const { layer, sqlite } = openDatabase()

    const exit = await Effect.runPromiseExit(
      dbBatch((db) => [
        db.insert(pages).values({ workspaceId: 1, slug: 'a', title: 'A' }),
        db.insert(pages).values({ workspaceId: 1, slug: 'a', title: 'Duplicate' }),
      ]).pipe(Effect.provide(layer))
    )

    expect(failureOf(exit)).toMatchObject({
      value: { _tag: 'DatabaseConstraintViolation', operation: 'batch', constraint: 'unique' },
    })
    expect(countPages(sqlite)).toBe(0)
  })
})
