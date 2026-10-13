/**
 * A synchronous driver cannot run dbTransaction or dbBatch.
 *
 * bun:sqlite's Drizzle driver commits a transaction as soon as its callback
 * returns, before any awaited write runs, and it has no batch. Both
 * operations are type errors for it, naming the reason.
 *
 * Checked by tests/typecheck-tests.ts.
 */
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { Effect } from 'effect'
import { dbBatch, dbMutation, dbTransaction, type TransactionClient } from '../../src/effect/database.js'

declare module '../../src/effect/services.js' {
  interface WebDatabaseType {
    type: BunSQLiteDatabase
  }
}

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
declare function expectType<T extends true>(): void

expectType<Equals<TransactionClient['__error'], 'This database driver runs transactions synchronously, so awaited writes run after it commits.'>>()

export const writes = Effect.gen(function* () {
  // Single writes work on any driver.
  yield* dbMutation((db) => db.run('DELETE FROM pages'))

  // @ts-expect-error the transaction client is SynchronousTransactionsNotSupported
  yield* dbTransaction(async (tx) => tx.run('DELETE FROM pages'))

  // @ts-expect-error bun:sqlite has no batch()
  yield* dbBatch((db) => [db.run('DELETE FROM pages')])
})
