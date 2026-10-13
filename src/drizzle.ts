/**
 * `@popcomputer/web/drizzle`: helpers that build Drizzle queries from the
 * application's tables. Only an application that uses Drizzle imports it.
 */

import { getTableColumns, is, sql, SQL, type Column, type Table } from 'drizzle-orm'

/** The values `rowOf` writes: the table's insert values, each of which may be SQL the database computes. */
export type RowValues<T extends Table> = { readonly [Key in keyof T['$inferInsert']]: T['$inferInsert'][Key] | SQL }

/** The select fields `rowOf` builds: one aliased value per column of the table. */
export type RowFields<T extends Table> = {
  readonly [Key in keyof T['_']['columns']]: SQL.Aliased<T['_']['columns'][Key]['_']['data']>
}

/**
 * The select fields that write `values` as one row of `table` through an
 * insert-select: every column of the table, in its order, with the values
 * given bound through their columns' encoding, the columns left out taking
 * their defaults (`$defaultFn`, `.default(...)`), and the rest `NULL`.
 *
 * On Cloudflare D1, where a batch cannot branch, the condition a write
 * depends on goes in the select's `WHERE`: the row is written only when it
 * holds, and the insert's `.returning()` says whether it was. A column the
 * values misname is a type error, and none can be left out of order.
 *
 * @example
 * yield* dbBatch((db) => [
 *   db.insert(candidates).select(
 *     db.select(rowOf(candidates, { id, jobId: job.id, email, name }))
 *       .from(jobs)
 *       .where(and(eq(jobs.id, job.id), eq(jobs.status, 'open')))
 *   ).returning({ id: candidates.id }),
 * ])
 */
export function rowOf<T extends Table>(table: T, values: RowValues<T>): RowFields<T> {
  const given: Readonly<Record<string, unknown>> = values
  const columns: Readonly<Record<string, Column>> = getTableColumns(table)
  const fields: Record<string, SQL.Aliased> = {}

  for (const [key, column] of Object.entries(columns)) {
    const value = Object.hasOwn(given, key) ? given[key] : defaultOf(column)

    fields[key] = (is(value, SQL) ? sql`${value}` : sql`${sql.param(value ?? null, column)}`).as(column.name)
  }

  // SAFETY: each field is the table's own column under its key, aliased to
  // the column's SQL name, with the column's data type.
  return fields as RowFields<T>
}

/** The value a column takes when an insert leaves it out, or undefined for NULL. */
function defaultOf(column: Column): unknown {
  if (column.defaultFn !== undefined) return column.defaultFn()

  return column.default
}
