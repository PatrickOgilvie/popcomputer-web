/* oxlint-disable effecttsgo/async-function -- Test entrypoints and the PGlite client retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Constraint reporting on Postgres, through PGlite and Drizzle's wrapper.
 *
 * Drizzle wraps a driver's error in one whose message repeats the statement's
 * bound values, and Postgres quotes a rejected value in its own message. A
 * value can hold any text, such as a SQLite constraint message, so only the
 * driver's code and fields may say which constraint failed.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { eq } from 'drizzle-orm'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { integer, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { Cause, Effect, Exit, Layer, Option } from 'effect'
import { dbMutation, dbQuery, uniqueFieldErrors } from '../../src/effect/database.js'
import { DatabaseService } from '../../src/effect/services.js'
import type { WebDeclaration } from '../../src/effect/register.js'

const products = pgTable('products', {
  id: text('id').primaryKey(),
  stock: integer('stock').notNull(),
})

const orders = pgTable('orders', {
  id: text('id').primaryKey(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  productId: text('product_id').notNull().references(() => products.id),
  quantity: integer('quantity').notNull(),
  note: text('note'),
  ref: uuid('ref'),
})

type TestDatabase = PgliteDatabase

declare module '../../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{
      database: TestDatabase
    }>
  }
}

/** Text a visitor may send, which names a constraint the statement did not break. */
const NAMES_UNIQUE = 'UNIQUE constraint failed: orders.idempotency_key'
const NAMES_CHECK = 'CHECK constraint failed: products_stock_nonnegative:'

const migrated = new PGlite()
await migrated.exec(`
  CREATE TABLE products (
    id text PRIMARY KEY,
    stock integer NOT NULL,
    CONSTRAINT products_stock_nonnegative CHECK (stock >= 0)
  );
  CREATE TABLE orders (
    id text PRIMARY KEY,
    idempotency_key text NOT NULL UNIQUE,
    product_id text NOT NULL REFERENCES products(id),
    quantity integer NOT NULL CONSTRAINT orders_quantity_limit CHECK (quantity <= 10),
    note text,
    ref uuid
  );
  INSERT INTO products (id, stock) VALUES ('widget', 5);
  INSERT INTO orders (id, idempotency_key, product_id, quantity) VALUES ('o1', 'k1', 'widget', 1);
`)
const snapshot = await migrated.dumpDataDir('none')

let layer: Layer.Layer<DatabaseService>

beforeEach(() => {
  layer = Layer.succeed(DatabaseService, drizzle(new PGlite({ loadDataDir: snapshot })))
})

const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()

const order = (values: Partial<typeof orders.$inferInsert>) =>
  dbMutation((db) => db.insert(orders).values({ id: 'o2', idempotencyKey: 'k2', productId: 'widget', quantity: 1, ...values }))

describe('a constraint violation is the one Postgres reports, whatever the values say', () => {
  test('a missing referenced row stays a foreign-key violation', async () => {
    const exit = await Effect.runPromiseExit(order({ productId: NAMES_UNIQUE }).pipe(Effect.provide(layer)))

    expect(failureOf(exit)).toMatchObject({
      value: {
        _tag: 'DatabaseConstraintViolation',
        constraint: 'foreign-key',
        columns: ['product_id'],
        constraintName: 'orders_product_id_fkey',
      },
    })
  })

  test('a broken CHECK stays a check violation', async () => {
    const exit = await Effect.runPromiseExit(
      order({ idempotencyKey: NAMES_UNIQUE, quantity: 99 }).pipe(Effect.provide(layer))
    )

    expect(failureOf(exit)).toMatchObject({
      value: { _tag: 'DatabaseConstraintViolation', constraint: 'check', constraintName: 'orders_quantity_limit' },
    })
  })

  test('a duplicate key stays a unique violation, under the name Postgres gives it', async () => {
    const exit = await Effect.runPromiseExit(
      order({ idempotencyKey: 'k1', note: NAMES_CHECK }).pipe(Effect.provide(layer))
    )

    expect(failureOf(exit)).toMatchObject({
      value: {
        _tag: 'DatabaseConstraintViolation',
        constraint: 'unique',
        columns: ['idempotency_key'],
        constraintName: 'orders_idempotency_key_key',
      },
    })
  })

  test('a value Postgres rejects and quotes is a DatabaseError, not a violation', async () => {
    const exit = await Effect.runPromiseExit(order({ ref: NAMES_UNIQUE }).pipe(Effect.provide(layer)))

    expect(failureOf(exit)).toMatchObject({ value: { _tag: 'DatabaseError', operation: 'mutation' } })
  })

  test('a read filtering on such a value fails with DatabaseError rather than dying', async () => {
    const exit = await Effect.runPromiseExit(
      dbQuery((db) => db.select().from(orders).where(eq(orders.ref, NAMES_UNIQUE))).pipe(Effect.provide(layer))
    )

    expect(failureOf(exit)).toMatchObject({ value: { _tag: 'DatabaseError', operation: 'query' } })
  })

  test('uniqueFieldErrors passes a broken CHECK through, rather than reporting the field the value names', async () => {
    const exit = await Effect.runPromiseExit(
      order({ idempotencyKey: NAMES_UNIQUE, quantity: 99 }).pipe(
        uniqueFieldErrors({ idempotencyKey: 'This order was already placed.' }),
        Effect.provide(layer)
      )
    )

    expect(failureOf(exit)).toMatchObject({ value: { _tag: 'DatabaseConstraintViolation', constraint: 'check' } })
  })
})
