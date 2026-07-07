/**
 * Route Model Binding
 *
 * Laravel-style route model binding for Effect routes.
 * Automatically resolves route parameters to database models.
 */

import { Context, Data, Effect, Schema as S } from 'effect'
import type { Table } from 'drizzle-orm'
import type { SchemaType } from './services.js'
import { RouteConfigurationError } from './errors.js'

/**
 * Drizzle column interface for type inference.
 */
interface DrizzleColumn {
  columnType: string
  dataType: string
  name: string
}

/**
 * Error thrown when a bound model is not found in the BoundModels context.
 * This indicates a programming error - the binding key doesn't match any resolved model.
 */
export class BoundModelNotFound extends Data.TaggedError('BoundModelNotFound')<{
  readonly key: string
}> {
  get message() {
    return `No bound model found for key: '${this.key}'. Ensure the route uses {${this.key}} binding syntax.`
  }
}

/**
 * Parsed binding from route path.
 */
export interface ParsedBinding {
  /** The parameter name (e.g., 'project' from '{project}') */
  param: string
  /** The column to query (e.g., 'id' or 'slug' from '{project:slug}') */
  column: string
}

/**
 * Parse Laravel-style bindings from a route path.
 *
 * @example
 * parseBindings('/users/{user}/posts/{post:slug}')
 * // => [{ param: 'user', column: 'id' }, { param: 'post', column: 'slug' }]
 */
export function parseBindings(path: string): ParsedBinding[] {
  const regex = /\{(\w+)(?::(\w+))?\}/g
  const bindings: ParsedBinding[] = []
  let match

  while ((match = regex.exec(path)) !== null) {
    bindings.push({
      param: match[1],
      column: match[2] ?? 'id',
    })
  }

  return bindings
}

/**
 * Convert Laravel-style route to Hono-style route.
 *
 * @example
 * toHonoPath('/users/{user}/posts/{post:slug}')
 * // => '/users/:user/posts/:post'
 */
export function toHonoPath(path: string): string {
  return path.replace(/\{(\w+)(?::\w+)?\}/g, ':$1')
}

/**
 * Service tag for bound models.
 * Provides access to resolved route models in handlers.
 */
export class BoundModels extends Context.Tag('honertia/BoundModels')<
  BoundModels,
  ReadonlyMap<string, unknown>
>() {}

/**
 * Pluralize a key for schema lookup.
 * Matches the runtime pluralize() function logic.
 */
type Pluralize<S extends string> =
  S extends `${infer _}${'a' | 'e' | 'i' | 'o' | 'u'}y` ? `${S}s` :           // day → days (vowel + y)
  S extends `${infer Base}y` ? `${Base}ies` :                                  // category → categories
  S extends `${infer _}${'s' | 'ss' | 'x' | 'z' | 'zz' | 'ch' | 'sh'}` ? `${S}es` : // class, buzz, box, match → +es
  `${S}s`                                                                       // project → projects

/**
 * Error type shown when trying to use bound() without schema configured.
 */
interface BoundModelNotConfigured<K extends string> {
  readonly __error: `Cannot infer type for bound('${K}'). Schema not configured for route model binding.`
  readonly __hint: 'Add module augmentation: declare module "honertia/effect" { interface HonertiaDatabaseType { schema: typeof schema } }'
}

/**
 * Lookup a table type from schema, trying pluralized key first.
 * Shows helpful error if schema is not configured.
 */
export type BoundModel<K extends string> =
  // Check if schema is configured (has __error means it's the error type)
  SchemaType extends { __error: string }
    ? BoundModelNotConfigured<K>
    : Pluralize<K> extends keyof SchemaType
      ? SchemaType[Pluralize<K>] extends Table
        ? SchemaType[Pluralize<K>]['$inferSelect']
        : unknown
      : K extends keyof SchemaType
        ? SchemaType[K] extends Table
          ? SchemaType[K]['$inferSelect']
          : unknown
        : unknown

/**
 * Type-safe accessor for bound models.
 *
 * @example
 * const showProject = Effect.gen(function* () {
 *   const project = yield* bound('project')
 *   return inertia('Projects/Show', { project })
 * })
 */
export const bound = <K extends string>(
  key: K
): Effect.Effect<
  BoundModel<K>,
  BoundModelNotFound | RouteConfigurationError,
  BoundModels
> =>
  Effect.gen(function* () {
    const models = yield* BoundModels

    // Check if schema was not configured (sentinel value set by routing.ts)
    if (models.has('__schema_not_configured__')) {
      return yield* RouteConfigurationError.schemaNotConfigured(key)
    }

    const model = models.get(key)
    if (!model) {
      return yield* new BoundModelNotFound({ key })
    }
    return model as any
  })

/**
 * Pluralize a singular word.
 * Handles common English pluralization rules.
 *
 * @example
 * pluralize('user')     // 'users'
 * pluralize('category') // 'categories'
 * pluralize('box')      // 'boxes'
 * pluralize('class')    // 'classes'
 */
export function pluralize(word: string): string {
  // Words ending in vowel + y: just add 's' (day -> days)
  if (/[aeiou]y$/i.test(word)) return word + 's'
  // Words ending in consonant + y: replace y with ies (category -> categories)
  if (/y$/i.test(word)) return word.slice(0, -1) + 'ies'
  // Words ending in s, x, z, ch, sh: add 'es' (box -> boxes, class -> classes)
  if (/(?:s|x|z|ch|sh)$/i.test(word)) return word + 'es'
  // Default: add 's'
  return word + 's'
}

/**
 * Information about a relation between tables.
 *
 * Both fields are JS property keys (e.g., 'workspaceId'), not SQL column
 * names (e.g., 'workspace_id'), so they can index Drizzle table objects and
 * query result rows directly.
 */
export interface RelationInfo {
  /** Foreign key property key on the child table (e.g., 'workspaceId') */
  foreignKey: string
  /** Referenced property key on the parent table (e.g., 'id') */
  references: string
}

/**
 * Find a relation from child table to parent table.
 *
 * Discovers the foreign key from the child table's inline `.references()`
 * metadata first, then falls back to introspecting a `<child>Relations`
 * definition created with Drizzle's `relations()`.
 *
 * @param schema - The Drizzle schema object
 * @param childTableName - Schema key of the child table (e.g., 'posts')
 * @param parentTableName - Schema key of the parent table (e.g., 'users')
 * @returns Relation info (JS property keys) or null if no relation found
 */
export async function findRelation(
  schema: Record<string, unknown>,
  childTableName: string,
  parentTableName: string
): Promise<RelationInfo | null> {
  const childTable = schema[childTableName]
  const parentTable = schema[parentTableName]
  if (
    !childTable ||
    typeof childTable !== 'object' ||
    !parentTable ||
    typeof parentTable !== 'object'
  ) {
    return null
  }

  // Dynamic import to avoid requiring drizzle-orm for non-binding users
  const { getTableColumns, createTableRelationsHelpers } = await import('drizzle-orm')

  // Map a Drizzle column object back to its JS property key on a table.
  // Column objects carry only the SQL name; table objects and result rows are
  // keyed by the JS property key, so we match by identity.
  const jsKeyOf = (table: object, column: unknown): string | null => {
    for (const [key, value] of Object.entries(getTableColumns(table as Table))) {
      if (value === column) return key
    }
    return null
  }

  const toRelationInfo = (
    childColumn: unknown,
    parentColumn: unknown
  ): RelationInfo | null => {
    const foreignKey = jsKeyOf(childTable, childColumn)
    const references = jsKeyOf(parentTable, parentColumn)
    return foreignKey && references ? { foreignKey, references } : null
  }

  // 1. Inline foreign keys declared with .references() on the child table.
  // Stored under a dialect-specific symbol (e.g., 'drizzle:SQLiteInlineForeignKeys').
  const fkSymbol = Object.getOwnPropertySymbols(childTable).find((sym) =>
    sym.description?.endsWith('InlineForeignKeys')
  )
  if (fkSymbol) {
    const foreignKeys = (childTable as Record<symbol, unknown>)[fkSymbol]
    if (Array.isArray(foreignKeys)) {
      for (const fk of foreignKeys) {
        if (typeof fk?.reference !== 'function') continue
        const reference = fk.reference() as {
          foreignTable: unknown
          columns: unknown[]
          foreignColumns: unknown[]
        }
        if (reference.foreignTable !== parentTable) continue
        const info = toRelationInfo(reference.columns[0], reference.foreignColumns[0])
        if (info) return info
      }
    }
  }

  // 2. relations() definitions (e.g., postsRelations). Evaluate the config
  // with Drizzle's real helpers so the returned One/Many instances are valid.
  const relations = schema[`${childTableName}Relations`] as
    | { table?: unknown; config?: (helpers: unknown) => Record<string, unknown> }
    | undefined
  if (relations?.table && typeof relations.config === 'function') {
    try {
      const helpers = createTableRelationsHelpers(relations.table as Table)
      const relationDefs = relations.config(helpers)

      for (const rel of Object.values(relationDefs)) {
        const relation = rel as {
          referencedTable?: unknown
          config?: { fields?: unknown[]; references?: unknown[] }
        }
        if (relation.referencedTable !== parentTable) continue
        // Only One relations carry fields/references; Many has no config.fields
        const fields = relation.config?.fields
        const references = relation.config?.references
        if (!fields?.length || !references?.length) continue
        const info = toRelationInfo(fields[0], references[0])
        if (info) return info
      }
    } catch {
      // Malformed relations definition - fall through to null; resolveBindings
      // warns in development when a nested binding could not be scoped.
    }
  }

  return null
}

/**
 * Map a Drizzle column type to an Effect Schema for URL param validation.
 * URL params are always strings, so numeric types use string-to-number transforms.
 *
 * @param columnType - The Drizzle columnType (e.g., 'PgUUID', 'PgInteger')
 * @returns An Effect Schema that validates the URL param string
 */
export function columnTypeToSchema(columnType: string): S.Schema.Any {
  switch (columnType) {
    // UUID types
    case 'PgUUID':
      return S.UUID

    // Integer types - URL params are strings, so we parse to number
    case 'PgInteger':
    case 'PgSmallInt':
    case 'PgBigInt53':
    case 'PgSerial':
    case 'PgSmallSerial':
    case 'PgBigSerial53':
    case 'SQLiteInteger':
    case 'MySqlInt':
    case 'MySqlTinyInt':
    case 'MySqlSmallInt':
    case 'MySqlMediumInt':
    case 'MySqlBigInt53':
    case 'MySqlSerial':
      return S.NumberFromString.pipe(S.int())

    // BigInt types that exceed JS number precision
    case 'PgBigInt64':
    case 'PgBigSerial64':
    case 'MySqlBigInt64':
      return S.BigInt

    // Numeric/Decimal types
    case 'PgNumeric':
    case 'PgDoublePrecision':
    case 'PgReal':
    case 'MySqlFloat':
    case 'MySqlDouble':
    case 'MySqlDecimal':
    case 'SQLiteReal':
      return S.NumberFromString

    // Boolean - less common in URL params but possible
    // SQLite stores booleans as integers (0/1)
    case 'PgBoolean':
    case 'MySqlBoolean':
    case 'SQLiteBoolean':
      return S.transform(
        S.String,
        S.Boolean,
        {
          decode: (s) => s.toLowerCase() === 'true' || s === '1',
          encode: (b) => b ? 'true' : 'false'
        }
      )

    // String types (default for text, varchar, etc.)
    case 'PgText':
    case 'PgVarchar':
    case 'PgChar':
    case 'MySqlVarChar':
    case 'MySqlText':
    case 'MySqlChar':
    case 'SQLiteText':
    default:
      return S.String
  }
}

/**
 * Infer an Effect Schema for route params based on database column types.
 * Looks up each binding's column in the schema and builds a struct schema.
 *
 * @param bindings - Parsed route bindings
 * @param schema - The Drizzle schema object
 * @returns An Effect Schema for validating route params, or null if inference fails
 */
export function inferParamsSchema(
  bindings: ParsedBinding[],
  schema: Record<string, unknown>
): S.Schema.Any | null {
  if (bindings.length === 0) return null

  const fields: Record<string, S.Schema.Any> = {}

  for (const binding of bindings) {
    const tableName = pluralize(binding.param)
    const table = schema[tableName] as Record<string, unknown> | undefined

    if (!table) {
      // Table not found - can't infer, let it fail at query time
      return null
    }

    const column = table[binding.column] as DrizzleColumn | undefined
    if (!column || typeof column !== 'object' || !('columnType' in column)) {
      // Column not found or not a Drizzle column - can't infer
      return null
    }

    fields[binding.param] = columnTypeToSchema(column.columnType)
  }

  return S.Struct(fields)
}
