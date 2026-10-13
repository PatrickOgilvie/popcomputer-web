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
import { Effect } from 'effect'
import { dbBatch, dbTransaction, type TransactionClient } from '../../src/effect/database.js'

/** The shape of Cloudflare's D1Database binding. */
interface D1Client {
  prepare(query: string): unknown
  exec(query: string): Promise<unknown>
  batch(statements: unknown[]): Promise<unknown[]>
  withSession(constraint?: string): unknown
}

declare module '../../src/effect/services.js' {
  interface WebDatabaseType {
    // drizzle(env.DB) from drizzle-orm/d1: an async SQLite database with batch().
    type: SqliteRemoteDatabase & { $client: D1Client }
  }
}

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
declare function expectType<T extends true>(): void

expectType<Equals<TransactionClient['__hint'], 'Use dbBatch((db) => [...statements]) to apply several writes atomically.'>>()

export const writes = Effect.gen(function* () {
  // @ts-expect-error the transaction client is D1TransactionsNotSupported
  yield* dbTransaction(async (tx) => tx.run('DELETE FROM pages'))

  // Batches are D1's atomic writes.
  yield* dbBatch((db) => [db.run('DELETE FROM pages')])
})
