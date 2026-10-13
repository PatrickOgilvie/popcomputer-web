/**
 * Effect Schemas derived from Drizzle tables, so a table's columns are
 * declared once.
 */

import { Schema as S } from 'effect'
import type { Table } from 'drizzle-orm'

const DRIZZLE_COLUMNS = Symbol.for('drizzle:Columns')

/** The parts of a Drizzle column a row schema reads. */
interface ColumnShape {
  readonly dataType: string
  readonly notNull: boolean
  readonly enumValues?: readonly string[]
}

/** A field per column of the table, typed as its row's value. */
export type TableFields<T extends Table> = {
  readonly [Key in keyof T['$inferSelect'] & string]: S.Codec<T['$inferSelect'][Key], unknown, never, never>
}

/**
 * An Effect Schema struct of a Drizzle table's row: each column checked
 * against its database type, nullability and enum values. Use it where a
 * schema restates a table, such as a page's props or the signed-in user, and
 * pick the columns a page shows with `mapFields(Struct.pick([...]))`.
 *
 * A narrowing declared only in TypeScript, such as `text('role').$type<Role>()`,
 * is typed but not checked: give the column an enum to check it.
 *
 * @example
 * const PublicCourse = tableSchema(schema.courses).mapFields(Struct.pick(['id', 'title', 'slug']))
 */
export function tableSchema<T extends Table>(table: T): S.Struct<TableFields<T>> {
  const columns: unknown = Reflect.get(table, DRIZZLE_COLUMNS)
  const fields: Record<string, S.Codec<unknown, unknown, never, never>> = {}

  if (columns instanceof Object) {
    for (const [key, column] of Object.entries(columns)) {
      if (!isColumn(column)) continue

      const value = columnValueSchema(column.dataType, column.enumValues)
      fields[key] = column.notNull ? value : S.NullOr(value)
    }
  }

  // SAFETY: each field checks its column's values as Drizzle reads them, which
  // the table's $inferSelect types; a $type<...>() narrowing, documented
  // above, is the one difference the database cannot check.
  return S.Struct(fields) as unknown as S.Struct<TableFields<T>>
}

function isColumn(value: unknown): value is ColumnShape {
  return (
    value instanceof Object &&
    typeof Reflect.get(value, 'dataType') === 'string' &&
    typeof Reflect.get(value, 'notNull') === 'boolean'
  )
}

/** The values a Drizzle column of this data type reads as. */
function columnValueSchema(
  dataType: string,
  enumValues: readonly string[] | undefined
): S.Codec<unknown, unknown, never, never> {
  switch (dataType) {
    case 'string':
      return enumValues && enumValues.length > 0 ? S.Literals(enumValues) : S.String
    case 'number':
      return S.Number
    case 'boolean':
      return S.Boolean
    case 'bigint':
      return S.BigInt
    case 'date':
      return S.Date
    default:
      // JSON, arrays, buffers and custom types: Drizzle's own mapping decides.
      return S.Unknown
  }
}

/** The table's columns that a schema's fields name. */
export type ColumnsOf<T extends Table, Fields> = {
  readonly [Key in keyof Fields & keyof T['_']['columns']]: T['_']['columns'][Key]
}

/**
 * The table's columns a schema's fields name, for a query's `select`: the
 * page schema decides what the query reads, so the two never drift. Add
 * computed values beside them.
 *
 * @example
 * yield* dbQuery((db) =>
 *   db.select({ ...columnsOf(schema.projects, ProjectCard), openTasks: count(schema.tasks.id) })
 *     .from(schema.projects)
 * )
 */
export function columnsOf<T extends Table, Fields extends S.Struct.Fields>(
  table: T,
  schema: S.Struct<Fields>
): ColumnsOf<T, Fields> {
  const columns: unknown = Reflect.get(table, DRIZZLE_COLUMNS)
  const picked: Record<string, unknown> = {}

  if (columns instanceof Object) {
    for (const key of Object.keys(schema.fields)) {
      const column: unknown = Reflect.get(columns, key)

      if (isColumn(column)) picked[key] = column
    }
  }

  // SAFETY: picked holds exactly the table's columns whose keys the schema's
  // fields name, which ColumnsOf maps from the table's own column types.
  return picked as ColumnsOf<T, Fields>
}
