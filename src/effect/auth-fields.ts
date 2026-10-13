/**
 * Better Auth's `user.additionalFields`, taken from the application's user
 * table, so each field is declared once: in the table.
 */

import type { Table } from 'drizzle-orm'

const DRIZZLE_COLUMNS = Symbol.for('drizzle:Columns')

type ColumnConfig<T extends Table, Key> = Key extends keyof T['_']['columns']
  ? T['_']['columns'][Key]['_']
  : never

/** Better Auth's field type for a column: its enum's values, or its data type. */
type FieldType<Column> = Column extends { readonly enumValues: [infer First extends string, ...infer Rest extends string[]] }
  ? string extends First
    ? DataFieldType<Column>
    : Array<First | Rest[number]>
  : DataFieldType<Column>

type DataFieldType<Column> = Column extends { readonly dataType: 'string' }
  ? 'string'
  : Column extends { readonly dataType: 'number' | 'bigint' }
    ? 'number'
    : Column extends { readonly dataType: 'boolean' }
      ? 'boolean'
      : Column extends { readonly dataType: 'date' }
        ? 'date'
        : 'json'

/** A field is required at sign-up when its column is not null and has no default. */
type FieldRequired<Column> = Column extends { readonly notNull: true; readonly hasDefault: false } ? true : false

/** What `betterAuthFields` takes for each field: whether a visitor may set it at sign-up. */
export interface BetterAuthFieldOptions {
  readonly input: boolean
}

/** Better Auth's `additionalFields` for the named columns of a user table. */
export type BetterAuthFields<T extends Table, Fields> = {
  -readonly [Key in keyof Fields & string]: {
    type: FieldType<ColumnConfig<T, Key>>
    required: FieldRequired<ColumnConfig<T, Key>>
    input: Fields[Key] extends { readonly input: infer Input extends boolean } ? Input : false
  }
}

/**
 * Better Auth's `user.additionalFields` for the columns an application adds to
 * its `user` table: each field's type, enum values and whether it is required
 * follow the column. Name each with whether a visitor may set it at sign-up;
 * a field such as `role` that only the application sets is `input: false`.
 *
 * @example
 * betterAuth({
 *   user: { additionalFields: betterAuthFields(schema.user, { role: { input: false }, timeZone: { input: true } }) },
 * })
 */
export function betterAuthFields<
  T extends Table,
  const Fields extends { readonly [Key in keyof T['$inferSelect']]?: BetterAuthFieldOptions },
>(table: T, fields: Fields): BetterAuthFields<T, Fields> {
  const columns: unknown = Reflect.get(table, DRIZZLE_COLUMNS)
  const result: Record<string, { type: unknown; required: boolean; input: boolean }> = {}

  for (const [key, options] of Object.entries(fields)) {
    const column: unknown = columns instanceof Object ? Reflect.get(columns, key) : undefined

    if (!(column instanceof Object) || options === undefined) continue

    const enumValues: unknown = Reflect.get(column, 'enumValues')
    const dataType: unknown = Reflect.get(column, 'dataType')

    result[key] = {
      type: Array.isArray(enumValues) && enumValues.length > 0 ? [...enumValues] : dataFieldType(dataType),
      required: Reflect.get(column, 'notNull') === true && Reflect.get(column, 'hasDefault') !== true,
      input: options.input,
    }
  }

  // SAFETY: each field is built from the column BetterAuthFields reads its
  // type from: its enum values, or its data type, and its nullability.
  return result as unknown as BetterAuthFields<T, Fields>
}

function dataFieldType(dataType: unknown): 'string' | 'number' | 'boolean' | 'date' | 'json' {
  switch (dataType) {
    case 'string':
      return 'string'
    case 'number':
    case 'bigint':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'date':
      return 'date'
    default:
      return 'json'
  }
}
