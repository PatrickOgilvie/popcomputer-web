/// <reference types="@cloudflare/workers-types" />
/**
 * A D1 database annotated as Drizzle's DrizzleD1Database, which has no
 * `$client`, is still D1: dbTransaction is a type error naming dbBatch.
 *
 * Checked by tests/typecheck-tests.ts.
 */
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Effect } from 'effect'
import { dbBatch, dbMutation, dbTransaction, type TransactionClient } from '../../src/effect/database.js'
import type { WebDeclaration } from '../../src/effect/register.js'

const pages = sqliteTable('pages', { id: text('id').primaryKey() })
const schema = { pages }

declare module '../../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{ database: DrizzleD1Database<typeof schema> }>
  }
}

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
declare function expectType<T extends true>(): void

expectType<Equals<TransactionClient['__hint'], 'Use dbBatch((db) => [...statements]) to apply several writes atomically.'>>()

export const writes = Effect.gen(function* () {
  // @ts-expect-error D1 has no interactive transactions
  yield* dbTransaction(dbMutation((db) => db.delete(pages)))

  const [deleted] = yield* dbBatch((db) => [db.delete(pages)])
  // Cloudflare's types are in scope, so the result is typed.
  return deleted.meta.changes
})
