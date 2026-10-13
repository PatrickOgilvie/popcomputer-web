/**
 * Cloudflare D1 cannot run dbTransaction.
 *
 * D1 rejects BEGIN and SAVEPOINT, so its Drizzle database's transaction() fails
 * at runtime although it is asynchronous. The transaction client is a type
 * error naming dbBatch, which D1 supports.
 *
 * Checked by tests/typecheck-tests.ts.
 */
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Effect } from 'effect'
import {
  dbBatch,
  dbMutation,
  dbTransaction,
  type DatabaseResult,
  type TransactionClient,
  type UntypedDatabaseResult,
} from '../../src/effect/database.js'
import type { WebDeclaration } from '../../src/effect/register.js'

const pages = sqliteTable('pages', { id: text('id').primaryKey() })

/** The shape of Cloudflare's D1Database binding. */
interface D1Client {
  prepare(query: string): unknown
  exec(query: string): Promise<unknown>
  batch(statements: unknown[]): Promise<unknown[]>
  withSession(constraint?: string): unknown
}

declare module '../../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{
      database: SqliteRemoteDatabase & { $client: D1Client }
    }>
  }
}

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
declare function expectType<T extends true>(): void

expectType<Equals<TransactionClient['__hint'], 'Use dbBatch((db) => [...statements]) to apply several writes atomically.'>>()

export const writes = Effect.gen(function* () {
  // @ts-expect-error D1 has no interactive transactions
  yield* dbTransaction(dbMutation((db) => db.run('DELETE FROM pages')))

  // Batches are D1's atomic writes.
  yield* dbBatch((db) => [db.delete(pages), db.insert(pages).values({ id: 'p1' })])

  // @ts-expect-error Drizzle cannot run db.run(sql) in a D1 batch
  yield* dbBatch((db) => [db.run('DELETE FROM pages')])

  // A list built at run time is a batch, with a list of results.
  const ids: ReadonlyArray<string> = ['p1', 'p2']
  const inserted = yield* dbBatch((db) => ids.map((id) => db.insert(pages).values({ id })))
  expectType<Equals<typeof inserted extends ReadonlyArray<unknown> ? true : false, true>>()

  // @ts-expect-error nor in a list
  yield* dbBatch((db) => ids.map(() => db.run('DELETE FROM pages')))
})

// A result typed `any`, as D1's are without Cloudflare's types, is an error type.
expectType<Equals<DatabaseResult<any>, UntypedDatabaseResult>>()
expectType<Equals<DatabaseResult<{ changes: number }>, { changes: number }>>()
