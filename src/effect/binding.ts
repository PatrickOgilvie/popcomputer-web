/**
 * Route Model Binding
 *
 * Laravel-style route model binding for Effect routes.
 * Automatically resolves route parameters to database models.
 */

import { Context, Data, Effect, Exit, Schema as S } from 'effect'
import type { Table } from 'drizzle-orm'
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

/** Explicit parent scope for a binding when Drizzle cannot infer it. */
export interface RouteBindingScope {
  /** Child-table property key or keys containing the parent reference. */
  readonly foreignKey: string | readonly string[]
  /** Parent-table property key or keys. Defaults to `id`. */
  readonly references?: string | readonly string[]
}

/** Optional overrides for a parsed route-model binding. */
export interface RouteBindingOptions {
  /** Drizzle schema key when it cannot be derived from the route parameter. */
  readonly table?: string
  /** Parent binding scopes, keyed by the parent route parameter. */
  readonly scope?: Readonly<Record<string, RouteBindingScope>>
}

/** A row parser plus the small amount of metadata inference may need. */
export interface RouteBindingDefinition<A = unknown> extends RouteBindingOptions {
  readonly schema: S.Schema<A, unknown, never>
}

/** Accepted setup value for one binding. */
export type RouteBindingConfig =
  | S.Schema.AnyNoContext
  | RouteBindingDefinition

/** Binding parsers registered once at application composition. */
export type RouteBindingsConfig = Readonly<Record<string, RouteBindingConfig>>

/**
 * Augmentable route-binding parser map used by {@link bound}.
 *
 * Applications should set `type` to the same object passed as
 * `bindings` in setupWeb so decoded parser outputs flow into handler types.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WebRouteBindingsType {}

/** @deprecated Augment {@link WebRouteBindingsType} instead. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HonertiaRouteBindingsType {}

/**
 * Add explicit metadata to a route-model parser.
 *
 * Most bindings should register their Effect Schema directly. Use this only
 * when a table name or nested parent scope is ambiguous.
 */
export function routeBinding<A>(
  schema: S.Schema<A, unknown, never>,
  options: RouteBindingOptions = {}
): RouteBindingDefinition<A> {
  return { schema, ...options }
}

/** A binding plan compiled once and reused by every request for the route. */
export interface CompiledRouteBinding {
  readonly param: string
  readonly column: string
  readonly tableName: string
  readonly table: Record<string, unknown>
  readonly paramSchema: S.Schema.AnyNoContext
  readonly rowSchema: S.Schema.AnyNoContext
  readonly parent?: {
    readonly param: string
    readonly relation: RelationInfo
  }
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
export class BoundModels extends Context.Tag('@popcomputer/web/BoundModels')<
  BoundModels,
  ReadonlyMap<string, unknown>
>() {}

/**
 * Error type shown when trying to use bound() without parser types configured.
 */
interface BoundModelNotConfigured<K extends string> {
  readonly __error: `Cannot infer type for bound('${K}'). Route binding parser type not configured.`
  readonly __hint: 'Augment WebRouteBindingsType with the object passed to setupWeb as bindings.'
}

type ConfiguredRouteBindings = WebRouteBindingsType extends {
  type: infer Bindings
} ? Bindings
  : HonertiaRouteBindingsType extends { type: infer Bindings }
    ? Bindings
    : never

type RouteBindingOutput<Config> =
  Config extends S.Schema<infer A, infer _I, infer _R>
    ? A
    : Config extends RouteBindingDefinition<infer A>
      ? A
      : unknown

/** Decoded output type registered for one route-model binding key. */
export type BoundModel<K extends string> =
  [ConfiguredRouteBindings] extends [never]
    ? BoundModelNotConfigured<K>
    : K extends keyof ConfiguredRouteBindings
      ? RouteBindingOutput<ConfiguredRouteBindings[K]>
      : BoundModelNotConfigured<K>

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
    // SAFETY: route execution stores the decoded output of the parser keyed by
    // this binding name. WebRouteBindingsType is the public type-level
    // mirror of that same parser map.
    return model as BoundModel<K>
  })

function isBindingDefinition(
  config: RouteBindingConfig
): config is RouteBindingDefinition {
  return typeof config === 'object' && config !== null && 'schema' in config
}

function normalizeStringList(value: string | readonly string[]): readonly string[] {
  return typeof value === 'string' ? [value] : value
}

function explicitRelation(scope: RouteBindingScope): RelationInfo | null {
  const foreignKeys = normalizeStringList(scope.foreignKey)
  const references = normalizeStringList(scope.references ?? 'id')
  if (foreignKeys.length === 0 || foreignKeys.length !== references.length) {
    return null
  }

  return {
    columnPairs: foreignKeys.map((foreignKey, index) => ({
      foreignKey,
      references: references[index],
    })),
  }
}

/**
 * Compile lookup, parsing, and parent-scope policy for a route.
 *
 * Nested bindings fail closed when their relationship cannot be proven.
 */
export async function compileBindingPlan(
  bindings: readonly ParsedBinding[],
  schema: Record<string, unknown>,
  configured: RouteBindingsConfig
): Promise<readonly CompiledRouteBinding[]> {
  const plan: CompiledRouteBinding[] = []

  for (const binding of bindings) {
    const config = configured[binding.param]
    if (!config) {
      throw RouteConfigurationError.bindingParserNotConfigured(binding.param)
    }

    const definition: RouteBindingDefinition = isBindingDefinition(config)
      ? config
      : { schema: config }
    const tableName = definition.table ?? pluralize(binding.param)
    const table = schema[tableName]
    if (!table || typeof table !== 'object') {
      throw RouteConfigurationError.tableNotFound(tableName)
    }

    const column = (table as Record<string, unknown>)[binding.column] as
      | DrizzleColumn
      | undefined
    if (!column || typeof column !== 'object' || !('columnType' in column)) {
      throw RouteConfigurationError.bindingColumnNotFound(
        binding.param,
        tableName,
        binding.column
      )
    }

    const parentPlan = plan[plan.length - 1]
    let parent: CompiledRouteBinding['parent']
    if (parentPlan) {
      const explicit = definition.scope?.[parentPlan.param]
      const relation = explicit
        ? explicitRelation(explicit)
        : await findRelation(schema, tableName, parentPlan.tableName)

      if (!relation) {
        throw RouteConfigurationError.relationNotFound(
          parentPlan.tableName,
          tableName,
          binding.param
        )
      }

      for (const pair of relation.columnPairs) {
        if (!(pair.foreignKey in table) || !(pair.references in parentPlan.table)) {
          throw RouteConfigurationError.relationNotFound(
            parentPlan.tableName,
            tableName,
            binding.param
          )
        }
      }

      parent = { param: parentPlan.param, relation }
    }

    plan.push({
      param: binding.param,
      column: binding.column,
      tableName,
      table: table as Record<string, unknown>,
      // SAFETY: columnTypeToSchema only constructs schemas from Effect's
      // context-free primitive schemas and transforms.
      paramSchema: columnTypeToSchema(column.columnType) as S.Schema.AnyNoContext,
      rowSchema: definition.schema,
      ...(parent ? { parent } : {}),
    })
  }

  return plan
}

/** Decode one route parameter through its compiled column parser. */
export async function decodeBindingParam(
  binding: CompiledRouteBinding,
  input: unknown
): Promise<unknown | undefined> {
  const exit = await Effect.runPromiseExit(S.decodeUnknown(binding.paramSchema)(input))
  return Exit.isSuccess(exit) ? exit.value : undefined
}

/** Decode a persisted row through the parser registered for the binding. */
export async function decodeBoundRow(
  binding: CompiledRouteBinding,
  row: unknown
): Promise<unknown> {
  const exit = await Effect.runPromiseExit(S.decodeUnknown(binding.rowSchema)(row))
  if (Exit.isSuccess(exit)) {
    return exit.value
  }

  throw RouteConfigurationError.invalidBoundRow(binding.param, binding.tableName)
}

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
export interface RelationColumnPair {
  /** Foreign key property key on the child table (e.g., 'workspaceId') */
  foreignKey: string
  /** Referenced property key on the parent table (e.g., 'id') */
  references: string
}

export interface RelationInfo {
  /** Every child/parent column pair that defines the relation. */
  columnPairs: readonly RelationColumnPair[]
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
    childColumns: readonly unknown[],
    parentColumns: readonly unknown[]
  ): RelationInfo | null => {
    if (
      childColumns.length === 0 ||
      childColumns.length !== parentColumns.length
    ) {
      return null
    }

    const columnPairs: RelationColumnPair[] = []
    for (let index = 0; index < childColumns.length; index++) {
      const foreignKey = jsKeyOf(childTable, childColumns[index])
      const references = jsKeyOf(parentTable, parentColumns[index])
      if (!foreignKey || !references) return null
      columnPairs.push({ foreignKey, references })
    }

    return { columnPairs }
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
        const info = toRelationInfo(reference.columns, reference.foreignColumns)
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
        const info = toRelationInfo(fields, references)
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
