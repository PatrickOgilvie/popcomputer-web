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
import type { WebDeclaration } from '../../src/effect/register.js'

declare module '../../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{
      database: BunSQLiteDatabase
    }>
  }
}

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
declare function expectType<T extends true>(): void

expectType<Equals<TransactionClient['__error'], 'This database driver runs transactions synchronously, so awaited writes run after it commits.'>>()

export const writes = Effect.gen(function* () {
  // Single writes work on any driver.
  yield* dbMutation((db) => db.run('DELETE FROM pages'))

  // @ts-expect-error a synchronous driver commits before awaited writes run
  yield* dbTransaction(dbMutation((db) => db.run('DELETE FROM pages')))

  // @ts-expect-error bun:sqlite has no batch()
  yield* dbBatch((db) => [db.run('DELETE FROM pages')])
})
