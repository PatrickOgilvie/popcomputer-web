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

/** Schemas that replace the derived field of the columns they name. */
export type ColumnOverrides<T extends Table> = {
  readonly [Key in keyof T['$inferSelect']]?: S.Codec<unknown, unknown, never, never>
}

/** The table's fields, with the overridden columns' schemas in place of theirs. */
export type TableSchemaFields<T extends Table, Overrides> = {
  readonly [Key in keyof TableFields<T>]: Key extends keyof Overrides
    ? Overrides[Key] extends S.Codec<unknown, unknown, never, never> ? Overrides[Key] : TableFields<T>[Key]
    : TableFields<T>[Key]
}

/**
 * An Effect Schema struct of a Drizzle table's row: each column checked
 * against its database type, nullability and enum values. Use it where a
 * schema restates a table, such as a page's props or the signed-in user, and
 * pick the columns a page shows with `mapFields(Struct.pick([...]))`.
 *
 * A JSON column, or a narrowing declared only in TypeScript such as
 * `text('role').$type<Role>()`, is typed but not checked: give the column an
 * enum, or name its schema in `overrides`, which replace the derived field.
 *
 * @example
 * const PublicCourse = tableSchema(schema.courses).mapFields(Struct.pick(['id', 'title', 'slug']))
 * const Contact = tableSchema(schema.contacts, { custom: CustomValues })
 */
/** The table each tableSchema was built from, so a route binding given the schema loads from it. */
const schemaTables = new WeakMap<object, Table>()

/** The table `tableSchema` built this schema from, if it did. */
export function tableOfSchema(schema: object): Table | undefined {
  return schemaTables.get(schema)
}

/**
 * What a Drizzle schema module exports under this key, such as a table or
 * its `relations()`. Vite's dev server gives `import * as schema` as an
 * object of getters, where Bun, Node and workerd give data properties, so
 * the value is read through the getter; an inherited key such as
 * `constructor` is no export.
 */
export function schemaExport(schema: object, key: string): unknown {
  return Object.hasOwn(schema, key) ? Reflect.get(schema, key) : undefined
}

export function tableSchema<T extends Table, const Overrides extends ColumnOverrides<T> = {}>(
  table: T,
  overrides?: Overrides
): S.Struct<TableSchemaFields<T, Overrides>> {
  const columns: unknown = Reflect.get(table, DRIZZLE_COLUMNS)
  const fields: Record<string, S.Codec<unknown, unknown, never, never>> = {}

  if (columns instanceof Object) {
    for (const [key, column] of Object.entries(columns)) {
      if (!isColumn(column)) continue

      const override: unknown = overrides ? Reflect.get(overrides, key) : undefined

      if (override !== undefined && S.isSchema(override)) {
        // SAFETY: ColumnOverrides admits only schemas without services.
        fields[key] = override as S.Codec<unknown, unknown, never, never>
        continue
      }

      const value = columnValueSchema(column.dataType, column.enumValues)
      fields[key] = column.notNull ? value : S.NullOr(value)
    }
  }

  // SAFETY: each field checks its column's values as Drizzle reads them, which
  // the table's $inferSelect types, or is the override the caller named; a
  // $type<...>() narrowing without an override, documented above, is the one
  // difference the database cannot check.
  const schema = S.Struct(fields) as unknown as S.Struct<TableSchemaFields<T, Overrides>>
  schemaTables.set(schema, table)

  return schema
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
