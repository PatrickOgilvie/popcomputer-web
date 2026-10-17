/**
 * Route Model Binding
 *
 * Laravel-style route model binding for Effect routes.
 * Automatically resolves route parameters to database models.
 */

import {
  Context,
  Effect,
  Layer,
  Schema as S,
  SchemaTransformation,
} from 'effect'
import type { Table } from 'drizzle-orm'
import { ConfigurationError, NotFoundError, RouteConfigurationError, UnauthorizedError } from './errors.js'
import { ErrorCodes } from './error-catalog.js'
import type { Registered } from './register.js'
import { tableOfSchema, tableSchema } from './table-schema.js'

/**
 * Drizzle column interface for type inference.
 */
interface DrizzleColumn {
  columnType: string
  dataType: string
  name: string
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
export interface RouteBindingScope<Column extends string = string> {
  /** Child-table property key or keys containing the parent reference. */
  readonly foreignKey: Column | readonly Column[]
  /** Parent-table property key or keys. Defaults to `id`. */
  readonly references?: string | readonly string[]
}

/** Where a parsed route-model binding finds its record. */
interface RouteBindingLookup<Column extends string = string> {
  /** Drizzle schema key when it cannot be derived from the route parameter. */
  readonly table?: string
  /** Parent binding scopes, keyed by the parent binding's name in setupWeb's bindings. */
  readonly scope?: Readonly<Record<string, RouteBindingScope<Column>>>
}

/**
 * Who may load a binding's record, declared once beside its table, so no
 * action decides it. Give one: `ownedBy`, `public`, `publicWhen` or
 * `guarded`. A binding that gives none loads any record its path names, for
 * any visitor, and the framework's lint rule asks for one.
 */
export type RouteBindingAccess<Column extends string = string, Row = NoRow<Column>> =
  | {
      /**
       * Only the signed-in user whose id this column holds. Another user's
       * record answers the same 404 as a missing one, and a signed-out
       * visitor is asked to sign in, before the database is asked. The
       * column references the users table's `id`, which `setupWeb` checks.
       */
      readonly ownedBy: Column
      readonly public?: never
      readonly publicWhen?: never
      readonly guarded?: never
    }
  | {
      /** Anyone, signed in or not, may load any record. */
      readonly public: true
      readonly ownedBy?: never
      readonly publicWhen?: never
      readonly guarded?: never
    }
  | {
      /**
       * Anyone may load a record whose columns hold these values, such as
       * `{ visibility: 'public' }` or `{ isPublic: true }`; any other
       * answers 404, its owner included.
       */
      readonly publicWhen: RouteBindingColumnValues<Column, Row>
      readonly ownedBy?: never
      readonly public?: never
      readonly guarded?: never
    }
  | {
      /**
       * A guard layer decides, such as a membership check for an
       * organization: the record loads for anyone, so every route whose
       * path names it is provided the guard, which answers 404 to a visitor
       * who may not see it.
       */
      readonly guarded: true
      readonly ownedBy?: never
      readonly public?: never
      readonly publicWhen?: never
    }
  | { readonly ownedBy?: never; readonly public?: never; readonly publicWhen?: never; readonly guarded?: never }

/**
 * Options typed by their columns' names alone, as 1.3 typed them, know no
 * column's type, so they give no `publicWhen` values.
 */
type NoRow<Column extends string> = Readonly<Record<Column, never>>

/** Any row, for a definition whose table's types are already checked. */
type AnyRow = Readonly<Record<string, unknown>>

/** Values for some of a row's columns, each of its column's type. */
export type RouteBindingColumnValues<Column extends string = string, Row = NoRow<Column>> = {
  readonly [K in Column]?: K extends keyof Row ? Row[K] : never
}

/** Optional overrides for a parsed route-model binding, and who may load its record. */
export type RouteBindingOptions<Column extends string = string, Row = NoRow<Column>> =
  RouteBindingLookup<Column> & RouteBindingAccess<Column, Row>

/**
 * A Drizzle table whose rows a binding loads. Each row is checked against
 * the table's columns, and the model's type is the table's row type.
 */
export type RouteBindingTable<Row = unknown> = Table & { readonly $inferSelect: Row }

/** A row parser plus the small amount of metadata inference may need. */
export type RouteBindingDefinition<A = unknown> = RouteBindingOptions<string, AnyRow> & {
  readonly schema: S.Codec<A, unknown, never, never> | RouteBindingTable<A>
}

/** The column a binding's access rule reads, and how. */
export type CompiledRouteBindingAccess =
  | { readonly ownedBy: string }
  | { readonly publicWhen: Readonly<Record<string, unknown>> }

/** The access options a binding gives, by name: a valid binding gives at most one. */
function accessOptionsOf(definition: RouteBindingAccess<string, AnyRow>): readonly string[] {
  return (['ownedBy', 'public', 'publicWhen', 'guarded'] as const).filter((key) => definition[key] !== undefined)
}

/**
 * Accepted setup value for one binding: the Drizzle table the model is a row
 * of, an Effect Schema that parses its row, or either with options.
 */
export type RouteBindingConfig =
  | RouteBindingTable
  | S.Codec<unknown, unknown, never, never>
  | RouteBindingDefinition

/** Binding parsers registered once at application composition. */
export type RouteBindingsConfig = Readonly<Record<string, RouteBindingConfig>>

/**
 * A route-model binding: its table, or an Effect Schema, and who may load
 * its record (`ownedBy`, `public`, `publicWhen` or `guarded`), with the table
 * name or parent scope when the route parameter cannot say them.
 *
 * @example
 * bindings: {
 *   project: routeBinding(schema.projects, { ownedBy: 'userId' }),
 *   showcase: routeBinding(schema.projects, { publicWhen: { visibility: 'public' } }),
 * }
 */
export function routeBinding<T extends RouteBindingTable>(
  table: T,
  options?: RouteBindingOptions<Extract<keyof T['$inferSelect'], string>, T['$inferSelect']>
): RouteBindingDefinition<T['$inferSelect']>
export function routeBinding<A>(
  schema: S.Codec<A, unknown, never, never>,
  options?: RouteBindingOptions<string, AnyRow>
): RouteBindingDefinition<A>
export function routeBinding<A>(
  schema: S.Codec<A, unknown, never, never> | RouteBindingTable<A>,
  options: RouteBindingOptions<string, AnyRow> = {}
): RouteBindingDefinition<A> {
  return { schema, ...options }
}

/** Whether a Drizzle table has a column under this property key. */
function hasColumn(table: RouteBindingTable, key: string): boolean {
  const column: unknown = Object.getOwnPropertyDescriptor(table, key)?.value

  return column instanceof Object && 'columnType' in column
}

/** A column's inline foreign keys, from `.references(() => ...)`, as Drizzle keeps them. */
function inlineReferences(table: RouteBindingTable, key: string): ReadonlyArray<{ readonly table: unknown; readonly column: unknown }> {
  const column: unknown = Object.getOwnPropertyDescriptor(table, key)?.value
  const symbol = Object.getOwnPropertySymbols(table).find((candidate) => candidate.description?.endsWith('InlineForeignKeys'))
  const foreignKeys: unknown = symbol === undefined ? undefined : Reflect.get(table, symbol)
  const found: Array<{ table: unknown; column: unknown }> = []

  if (!Array.isArray(foreignKeys)) return found

  for (const foreignKey of foreignKeys) {
    const reference: unknown = foreignKey instanceof Object && Reflect.get(foreignKey, 'reference') instanceof Function
      ? Reflect.apply(Reflect.get(foreignKey, 'reference'), foreignKey, [])
      : undefined

    if (!(reference instanceof Object)) continue

    const columns: unknown = Reflect.get(reference, 'columns')
    const foreignColumns: unknown = Reflect.get(reference, 'foreignColumns')

    if (Array.isArray(columns) && Array.isArray(foreignColumns) && columns.length === 1 && columns[0] === column) {
      found.push({ table: Reflect.get(reference, 'foreignTable'), column: foreignColumns[0] })
    }
  }

  return found
}

/** The table a column references, when it declares one. */
function referencedTable(table: RouteBindingTable, key: string): RouteBindingTable | undefined {
  const referenced = inlineReferences(table, key).map((reference) => reference.table).find(isBindingTable)

  return referenced
}

/** Whether a column references the `id` column of `users`. */
function referencesId(table: RouteBindingTable, key: string, users: RouteBindingTable): boolean {
  const id: unknown = Object.getOwnPropertyDescriptor(users, 'id')?.value

  return id !== undefined && inlineReferences(table, key).some((reference) => reference.table === users && reference.column === id)
}

/** A Drizzle table's SQL name. */
function tableNameOf(table: RouteBindingTable): string {
  const name: unknown = Reflect.get(table, DRIZZLE_TABLE_NAME)

  return typeof name === 'string' ? name : 'table'
}

/**
 * Check setupWeb's bindings when it is called, so a scope that names no
 * binding, or a column a table does not have, fails at startup, naming the
 * fix, instead of failing every request to the routes that use it.
 */
export function assertBindingsConfig(bindings: RouteBindingsConfig, schema?: object, users?: object): void {
  const names = Object.keys(bindings)

  for (const [name, config] of Object.entries(bindings)) {
    if (!isBindingDefinition(config)) continue

    if (config.table !== undefined && schema !== undefined && !Object.hasOwn(schema, config.table)) {
      throw RouteConfigurationError.tableNotFound(config.table, Object.keys(schema)).atStartup()
    }

    const source = bindingTableOf(config) ?? config.schema
    const access = accessOptionsOf(config)

    if (access.length > 1) throw RouteConfigurationError.bindingAccessConflict(name, access).atStartup()
    if (config.publicWhen !== undefined && Object.keys(config.publicWhen).length === 0) {
      throw RouteConfigurationError.bindingPublicWhenEmpty(name).atStartup()
    }

    for (const key of [config.ownedBy, ...Object.keys(config.publicWhen ?? {})]) {
      if (key !== undefined && isBindingTable(source) && !hasColumn(source, key)) {
        throw RouteConfigurationError.bindingColumnNotFound(name, tableNameOf(source), key)
      }
    }

    if (config.ownedBy !== undefined && isBindingTable(source) && isBindingTable(users)) {
      const referenced = referencedTable(source, config.ownedBy)

      if (referenced !== users || !referencesId(source, config.ownedBy, users)) {
        throw RouteConfigurationError.bindingOwnerNotUser(
          name,
          tableNameOf(source),
          config.ownedBy,
          tableNameOf(users),
          referenced === undefined ? undefined : tableNameOf(referenced),
          names.find((other) => referenced !== undefined && bindingTableOf(bindings[other]) === referenced)
        ).atStartup()
      }
    }

    for (const [parent, scope] of Object.entries(config.scope ?? {})) {
      if (parent === name || !Object.hasOwn(bindings, parent)) {
        throw RouteConfigurationError.scopeNotABinding(name, parent, names.filter((other) => other !== name)).atStartup()
      }

      if (isBindingTable(source)) {
        for (const key of normalizeStringList(scope.foreignKey)) {
          if (!hasColumn(source, key)) throw RouteConfigurationError.bindingColumnNotFound(name, tableNameOf(source), key)
        }
      }

      const parentSource = bindingTableOf(bindings[parent])

      if (isBindingTable(parentSource)) {
        for (const key of normalizeStringList(scope.references ?? 'id')) {
          if (!hasColumn(parentSource, key)) {
            throw RouteConfigurationError.bindingColumnNotFound(parent, tableNameOf(parentSource), key)
          }
        }
      }
    }
  }
}

const DRIZZLE_TABLE = Symbol.for('drizzle:IsDrizzleTable')
const DRIZZLE_TABLE_NAME = Symbol.for('drizzle:Name')

/** Whether a binding names a Drizzle table rather than a row schema. */
function isBindingTable(value: unknown): value is RouteBindingTable {
  return value instanceof Object && Reflect.get(value, DRIZZLE_TABLE) === true
}

/** Values decoded from a route parameter by its database column schema. */
export type RouteBindingParam = string | number | bigint | boolean

/** A binding plan compiled once and reused by every request for the route. */
export interface CompiledRouteBinding {
  readonly param: string
  readonly column: string
  readonly tableName: string
  readonly table: Table
  /**
   * The property key of the table's primary key column, or of the lookup
   * column when the table has no single-column primary key. Cache tags name a
   * record by it, whichever column the route looks the record up by.
   */
  readonly primaryKey: string
  readonly paramSchema: S.Codec<RouteBindingParam, string>
  readonly rowSchema: S.Codec<unknown, unknown, never, never>
  readonly parent?: {
    readonly param: string
    readonly relation: RelationInfo
  }
  /** Who may load the record: its owner, or anyone when a column says so. */
  readonly access?: CompiledRouteBindingAccess
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
 * Why a route model could not be loaded. `UnauthorizedError` is a signed-out
 * visitor on a binding only its owner may load.
 */
export type BoundModelError = NotFoundError | UnauthorizedError | RouteConfigurationError | ConfigurationError

/**
 * Loads a route's models. A route loads all of its `{param}` models the first
 * time an action asks for one, after any guard that ran before it, and keeps
 * them for the rest of the request.
 */
export interface BoundModelsClient {
  readonly get: (key: string) => Effect.Effect<unknown, BoundModelError>
}

/** Service tag for the route's model loader, read through {@link bound}. */
export class BoundModels extends Context.Service<
  BoundModels,
  BoundModelsClient
>()('@popcomputer/web/BoundModels') {
  /**
   * Provide fixed models, to run an action outside a route. The layer binds
   * the models it holds, as a route's placeholders do.
   *
   * @example
   * yield* showProject.pipe(Effect.provide(BoundModels.fromModels({ project })))
   */
  static fromModels<const Models extends Readonly<Record<string, unknown>>>(
    models: Models
  ): Layer.Layer<BoundModels | RouteModel<Extract<keyof Models, string>>> {
    const layer = Layer.succeed(
      BoundModels,
      BoundModels.of({
        get: (key) =>
          Object.hasOwn(models, key)
            ? Effect.succeed(models[key])
            : Effect.fail(RouteConfigurationError.bindingNotInRoute(key)),
      })
    )

    // SAFETY: RouteModel is a requirement only the types track; no Effect
    // reads it from the context, so serving the models is what binds them.
    return layer as Layer.Layer<BoundModels | RouteModel<Extract<keyof Models, string>>>
  }
}

/**
 * Error type shown when trying to use bound() without parser types configured.
 */
interface BoundModelNotConfigured<K extends string> {
  readonly __error: `Cannot infer type for bound('${K}'). No route model bindings are registered.`
  readonly __hint: 'Give setupWeb its bindings (bindings: { ... }) and register setupWeb\'s result.'
}

type ConfiguredRouteBindings = Registered<'routeBindings', never>

type RouteBindingOutput<Config> =
  Config extends RouteBindingTable<infer Row>
    ? Row
    : Config extends S.Codec<unknown, unknown, never, never>
      ? S.Schema.Type<Config>
      : Config extends RouteBindingDefinition<infer A>
        ? A
        : unknown

/**
 * What `bound(key)` needs from its route: a `{key}` placeholder in the path.
 * A route provides one for each placeholder of its path and its prefix, so an
 * action, or a layer guarding it, that reads a model its route does not bind
 * fails to type-check where the route is registered.
 */
export interface RouteModel<K extends string> {
  readonly '~popcomputer/web/RouteModel': K
}

/**
 * What an Effect that reads route models with `bound()` requires, for a
 * helper whose type is written out: the loaded models, and a route whose
 * path binds each of them.
 *
 * @example
 * const ownProject: Effect.Effect<Project, BoundModelError | NotFoundError, BoundRequirements<'project'>> = ...
 */
export type BoundRequirements<K extends BoundKey> = BoundModels | RouteModel<K>

/** The keys `bound` accepts: the registered bindings, or any key before the application registers them. */
export type BoundKey = [ConfiguredRouteBindings] extends [never] ? string : keyof ConfiguredRouteBindings & string

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
 * The route loads its models on the first call, so guards and `authorize()`
 * that run earlier decide before any database lookup. Fails with
 * `NotFoundError` when the row does not exist, and `RouteConfigurationError`
 * when the route path has no `{key}` placeholder or the app registered no
 * binding schema.
 *
 * @example
 * const showProject = action(
 *   Effect.gen(function* () {
 *     const project = yield* bound('project')
 *     return yield* render('Projects/Show', { project })
 *   })
 * )
 */
// The annotation keeps `BoundModel<K>` unresolved in the emitted declaration,
// so it resolves against the application's registered bindings.
export const bound: <K extends BoundKey>(
  key: K
) => Effect.Effect<BoundModel<K>, BoundModelError, BoundModels | RouteModel<K>> = Effect.fn('Web.bound')(function* <
  K extends string,
>(key: K) {
  const models = yield* BoundModels
  const model = yield* models.get(key)

  // SAFETY: the route decodes each loaded row with the parser registered for
  // this binding name, and the registered `bindings` are the type-level mirror of
  // that same parser map.
  return model as BoundModel<K>
})

function isBindingDefinition(
  config: RouteBindingConfig
): config is RouteBindingDefinition {
  return !isBindingTable(config) && config instanceof Object && 'schema' in config
}

/** Whether a binding says a guard layer decides who may load its record. */
export function isGuardedBinding(config: RouteBindingConfig | undefined): boolean {
  return config !== undefined && isBindingDefinition(config) && config.guarded === true
}

/** A binding's table or row schema, without its options. */
function bindingSource(config: RouteBindingConfig): RouteBindingTable | S.Codec<unknown, unknown, never, never> {
  return isBindingDefinition(config) ? config.schema : config
}

/**
 * The table a binding loads its rows from: the table it names, or the one a
 * `tableSchema(table, overrides)` it names was built from.
 */
function bindingTableOf(config: RouteBindingConfig): RouteBindingTable | undefined {
  const source = bindingSource(config)

  if (isBindingTable(source)) return source

  const table = tableOfSchema(source)

  return isBindingTable(table) ? table : undefined
}


function normalizeStringList(value: string | readonly string[]): readonly string[] {
  return S.is(S.String)(value) ? [value] : value
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
// oxlint-disable-next-line effecttsgo/async-function -- Route configuration discovers optional Drizzle metadata through native imports; configuration errors reject at the registration boundary.
export async function compileBindingPlan<Schema extends object>(
  bindings: readonly ParsedBinding[],
  schema: Schema,
  configured: RouteBindingsConfig
): Promise<readonly CompiledRouteBinding[]> {
  const plan: CompiledRouteBinding[] = []
  // The bindings on this route that say who may load their record, or load
  // under one that does.
  const restricted = new Set<string>()

  for (const binding of bindings) {
    const config = configured[binding.param]

    if (!config) {
      throw RouteConfigurationError.bindingParserNotConfigured(binding.param)
    }

    const definition: RouteBindingDefinition = isBindingDefinition(config)
      ? config
      : { schema: config }
    const source = bindingSource(config)

    const tableName = bindingTableName(binding, configured, schema)
    const sourceTable = bindingTableOf(config)
    const table: unknown = sourceTable !== undefined
      ? sourceTable
      : Object.getOwnPropertyDescriptor(schema, tableName)?.value

    if (!(table instanceof Object)) {
      throw RouteConfigurationError.tableNotFound(tableName)
    }

    const lookupColumn = lookupColumnOf(table, binding)
    // SAFETY: The route builder established the matching Drizzle and Effect contracts; this adapter only restores generic information their public types erase.
    const column = Object.getOwnPropertyDescriptor(table, lookupColumn)?.value as
      | DrizzleColumn
      | undefined

    if (!(column instanceof Object) || !('columnType' in column)) {
      throw RouteConfigurationError.bindingColumnNotFound(
        binding.param,
        tableName,
        lookupColumn
      )
    }

    // A binding is scoped to the binding before it, or to the earlier
    // binding its `scope` names, such as a project's flag under an
    // environment of that project.
    const scopeKeys = Object.keys(definition.scope ?? {})

    if (scopeKeys.length > 1) {
      throw RouteConfigurationError.scopeNotInRoute(binding.param, scopeKeys.join(', '), plan.map((earlier) => earlier.param))
    }

    const named = scopeKeys[0]
    const parentPlan = named === undefined ? plan[plan.length - 1] : plan.find((earlier) => earlier.param === named)

    if (named !== undefined && parentPlan === undefined) {
      throw RouteConfigurationError.scopeNotInRoute(binding.param, named, plan.map((earlier) => earlier.param))
    }

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

    const accessOptions = accessOptionsOf(definition)

    if (accessOptions.length > 1) throw RouteConfigurationError.bindingAccessConflict(binding.param, accessOptions)

    if (definition.publicWhen !== undefined && Object.keys(definition.publicWhen).length === 0) {
      throw RouteConfigurationError.bindingPublicWhenEmpty(binding.param)
    }

    for (const column of [definition.ownedBy, ...Object.keys(definition.publicWhen ?? {})]) {
      if (column !== undefined && !isColumnProperty(table, column)) {
        throw RouteConfigurationError.bindingColumnNotFound(binding.param, tableName, column)
      }
    }

    const access: CompiledRouteBindingAccess | undefined = definition.ownedBy !== undefined
      ? { ownedBy: definition.ownedBy }
      : definition.publicWhen !== undefined
        ? { publicWhen: { ...definition.publicWhen } }
        : undefined

    // A child that says anyone may load it, under a parent that says who may,
    // is loaded only by the parent's visitors here, and by anyone on a path
    // without the parent: its scope says what it means.
    if (definition.public === true && parent !== undefined && restricted.has(parent.param)) {
      throw RouteConfigurationError.publicUnderRestrictedParent(
        binding.param,
        parent.param,
        parent.relation.columnPairs.map((pair) => pair.foreignKey)
      )
    }

    if (access !== undefined || definition.guarded === true || (parent !== undefined && restricted.has(parent.param))) {
      restricted.add(binding.param)
    }

    // SAFETY: The route builder established the matching Drizzle and Effect contracts; this adapter only restores generic information their public types erase.
    plan.push({
      param: binding.param,
      column: lookupColumn,
      tableName,
      table: table as Table,
      primaryKey: await primaryKeyOf(table as Table, lookupColumn),
      paramSchema: columnTypeToSchema(column.columnType),
      rowSchema: isBindingTable(source) ? tableSchema(source) : source,
      parent,
      access,
    })
  }

  return plan
}

/** The table's single primary key column, else the column the route looks rows up by. */
/**
 * The column a binding looks its record up by: the one its placeholder
 * names, as `{post:slug}`, or for `{post}` the table's `id`, else, for a
 * table without one, its single primary key column, such as a `code` key.
 */
function lookupColumnOf(table: object, binding: ParsedBinding): string {
  if (binding.column !== 'id' || isColumnProperty(table, binding.column)) return binding.column

  const primary = Object.keys(table).filter((key) => {
    const column: unknown = Object.getOwnPropertyDescriptor(table, key)?.value

    return isColumnProperty(table, key) && column instanceof Object && Reflect.get(column, 'primary') === true
  })

  return primary.length === 1 ? primary[0] : binding.column
}

/** Whether a table has a Drizzle column under this property key. */
function isColumnProperty(table: object, key: string): boolean {
  const column: unknown = Object.getOwnPropertyDescriptor(table, key)?.value

  return column instanceof Object && 'columnType' in column
}

async function primaryKeyOf(table: Table, lookupColumn: string): Promise<string> {
  const { getTableColumns } = await loadDrizzle()
  const primary = Object.entries(getTableColumns(table) ?? {}).filter(([, column]) => column.primary)

  return primary.length === 1 ? primary[0][0] : lookupColumn
}

/**
 * Check, when a route is registered, that each `{param:column}` names a
 * column of the table its binding loads from, by the column's property key,
 * so a misspelling fails at startup instead of on every request. A binding
 * whose table cannot be found yet, such as one named only by a schema the
 * database factory supplies, is checked when it first loads.
 */
export function assertBindingColumns(
  bindings: readonly ParsedBinding[],
  configured: RouteBindingsConfig | undefined,
  schema: object | undefined
): void {
  for (const binding of bindings) {
    const config = configured?.[binding.param]

    if (config === undefined || binding.column === 'id') continue

    const table: unknown = bindingTableOf(config) ??
      (schema === undefined ? undefined : Object.getOwnPropertyDescriptor(schema, bindingTableName(binding, configured, schema))?.value)

    if (!(table instanceof Object) || isColumnProperty(table, binding.column)) continue

    const columns = Object.keys(table).filter((key) => isColumnProperty(table, key))

    throw new RouteConfigurationError({
      message: `Column "${binding.column}" for route binding "${binding.param}" is not a column of its table.`,
      hint: `Name one of its columns by its property key: ${columns.map((key) => `"${key}"`).join(', ')}.`,
      binding: binding.param,
      code: ErrorCodes.RTE_601_TABLE_NOT_FOUND,
    }).atStartup()
  }
}

/**
 * Check, when a route is registered, who may load each record its path
 * names: a binding's `scope` must name a binding before it on the path, and
 * a binding that says `public: true` must not load under one that says who
 * may load it, since either would load a record for visitors its parent
 * turns away. Returns the bindings whose record depends on who is visiting:
 * `ownedBy` and `guarded` ones, and those that load under them.
 */
export function assertRouteAccess(
  bindings: readonly ParsedBinding[],
  configured: RouteBindingsConfig | undefined
): ReadonlySet<string> {
  const earlier: string[] = []
  // Bindings that say who may load their record, or load under one that does.
  const restricted = new Set<string>()
  // Of those, the ones whose record depends on who is visiting.
  const personal = new Set<string>()

  for (const binding of bindings) {
    const config = configured?.[binding.param]
    const definition = config !== undefined && isBindingDefinition(config) ? config : undefined
    const named = Object.keys(definition?.scope ?? {})[0]

    if (named !== undefined && !earlier.includes(named)) {
      throw RouteConfigurationError.scopeNotInRoute(binding.param, named, earlier).atStartup()
    }

    const parent = named ?? earlier[earlier.length - 1]

    if (definition?.public === true && parent !== undefined && restricted.has(parent)) {
      const child = bindingTableOf(definition)
      const parentTable = bindingTableOf(configured?.[parent] ?? definition)
      const foreignKeys = child === undefined
        ? []
        : Object.keys(child).filter((key) => inlineReferences(child, key).some((reference) => reference.table === parentTable))

      throw RouteConfigurationError.publicUnderRestrictedParent(
        binding.param,
        parent,
        foreignKeys.length > 0 ? foreignKeys : [`${parent}Id`]
      ).atStartup()
    }

    const says = definition !== undefined &&
      (definition.ownedBy !== undefined || definition.publicWhen !== undefined || definition.guarded === true)

    if (says || (parent !== undefined && restricted.has(parent))) restricted.add(binding.param)

    if (
      (definition !== undefined && (definition.ownedBy !== undefined || definition.guarded === true)) ||
      (parent !== undefined && personal.has(parent))
    ) {
      personal.add(binding.param)
    }

    earlier.push(binding.param)
  }

  return personal
}

/**
 * The schema key of the table a binding loads its model from: its `table`
 * option, the key of the table it names, else its plural name.
 */
export function bindingTableName(
  binding: ParsedBinding,
  configured: RouteBindingsConfig | undefined,
  schema?: object
): string {
  const config = configured?.[binding.param]

  if (config === undefined) return pluralize(binding.param)

  if (isBindingDefinition(config) && config.table !== undefined) return config.table

  const source = bindingTableOf(config)

  if (source === undefined) return pluralize(binding.param)

  const key = schema
    ? Object.keys(schema).find((name) => Object.getOwnPropertyDescriptor(schema, name)?.value === source)
    : undefined
  const sqlName: unknown = Reflect.get(source, DRIZZLE_TABLE_NAME)

  return key ?? (typeof sqlName === 'string' ? sqlName : pluralize(binding.param))
}

/** Decode one route parameter through its compiled column parser. */
export function decodeBindingParam<Input>(
  binding: CompiledRouteBinding,
  input: Input
): Promise<RouteBindingParam | undefined> {
  return Effect.runPromise(S.decodeUnknownEffect(binding.paramSchema)(input).pipe(
    Effect.orElseSucceed(() => undefined),
  ))
}

/** Decode a persisted row through the parser registered for the binding. */
export function decodeBoundRow<Row>(
  binding: CompiledRouteBinding,
  row: Row
): Promise<S.Schema.Type<typeof S.Unknown>> {
  return Effect.runPromise(S.decodeUnknownEffect(binding.rowSchema)(row).pipe(
    Effect.mapError((issue) => RouteConfigurationError.invalidBoundRow(binding.param, binding.tableName, issue.message)),
  ))
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
 * Load drizzle-orm, the optional peer behind route model binding.
 *
 * The import stays inside a try block on purpose: esbuild (which Wrangler
 * uses) and Bun leave an unresolvable import there for runtime instead of
 * failing the build, so apps without drizzle-orm still bundle. Apps that
 * install it get it bundled as usual. Only route binding calls this.
 */
// oxlint-disable-next-line effecttsgo/async-function -- Route binding loads the optional Drizzle peer through a native import; a missing package rejects as a configuration error.
export async function loadDrizzle(): Promise<typeof import('drizzle-orm')> {
  try {
    return await import('drizzle-orm')
  } catch (cause) {
    throw RouteConfigurationError.drizzleNotInstalled(cause)
  }
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
// oxlint-disable-next-line effecttsgo/async-function -- Route configuration discovers optional Drizzle metadata through native imports; configuration errors reject at the registration boundary.
export async function findRelation<Schema extends object>(
  schema: Schema,
  childTableName: string,
  parentTableName: string
): Promise<RelationInfo | null> {
  const childTable = Object.getOwnPropertyDescriptor(schema, childTableName)?.value
  const parentTable = Object.getOwnPropertyDescriptor(schema, parentTableName)?.value

  if (
    !childTable ||
    !(childTable instanceof Object) ||
    !parentTable ||
    !(parentTable instanceof Object)
  ) {
    return null
  }

  // SAFETY: Both schema entries were selected from the configured Drizzle schema and passed the object boundary check above.
  const childDrizzleTable = childTable as Table
  // SAFETY: Both schema entries were selected from the configured Drizzle schema and passed the object boundary check above.
  const parentDrizzleTable = parentTable as Table

  const { getTableColumns, createTableRelationsHelpers } = await loadDrizzle()

  // Map a Drizzle column object back to its JS property key on a table.
  // Column objects carry only the SQL name; table objects and result rows are
  // keyed by the JS property key, so we match by identity.
  // SAFETY: The route builder established the matching Drizzle and Effect contracts; this adapter only restores generic information their public types erase.
  const jsKeyOf = <Column>(table: Table, column: Column): string | null => {
    for (const [key, value] of Object.entries(getTableColumns(table))) {
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
      const foreignKey = jsKeyOf(childDrizzleTable, childColumns[index])
      const references = jsKeyOf(parentDrizzleTable, parentColumns[index])

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
    // SAFETY: The route builder established the matching Drizzle and Effect contracts; this adapter only restores generic information their public types erase.
    const foreignKeys = Object.getOwnPropertyDescriptor(childTable, fkSymbol)?.value

    if (Array.isArray(foreignKeys)) {
      for (const fk of foreignKeys) {
        if (!(fk?.reference instanceof Function)) continue

        // SAFETY: The route builder established the matching Drizzle and Effect contracts; this adapter only restores generic information their public types erase.
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
  // SAFETY: The route builder established the matching Drizzle and Effect contracts; this adapter only restores generic information their public types erase.
  const relations = Object.getOwnPropertyDescriptor(
    schema,
    `${childTableName}Relations`
  )?.value as
    | { table?: object; config?: <Helpers>(helpers: Helpers) => object }
    | undefined

  if (relations?.table && relations.config instanceof Function) {
    try {
      // SAFETY: The route builder established the matching Drizzle and Effect contracts; this adapter only restores generic information their public types erase.
      const helpers = createTableRelationsHelpers(relations.table as Table)
      const relationDefs = relations.config(helpers)

      for (const rel of Object.values(relationDefs)) {
        // SAFETY: The route builder established the matching Drizzle and Effect contracts; this adapter only restores generic information their public types erase.
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
export function columnTypeToSchema(
  columnType: string
): S.Codec<RouteBindingParam, string> {
  switch (columnType) {
    // UUID types
    case 'PgUUID':
      return S.String.check(S.isUUID())

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
      return S.FiniteFromString.check(S.isInt())

    // BigInt types that exceed JS number precision
    case 'PgBigInt64':
    case 'PgBigSerial64':
    case 'MySqlBigInt64':
      return S.BigIntFromString

    // Numeric/Decimal types
    case 'PgNumeric':
    case 'PgDoublePrecision':
    case 'PgReal':
    case 'MySqlFloat':
    case 'MySqlDouble':
    case 'MySqlDecimal':
    case 'SQLiteReal':
      return S.FiniteFromString

    // Boolean - less common in URL params but possible
    // SQLite stores booleans as integers (0/1)
    case 'PgBoolean':
    case 'MySqlBoolean':
    case 'SQLiteBoolean':
      return S.String.pipe(
        S.decodeTo(
          S.Boolean,
          SchemaTransformation.transform({
            decode: (s) => s.toLowerCase() === 'true' || s === '1',
            encode: (b) => b ? 'true' : 'false',
          })
        )
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
export function inferParamsSchema<Schema extends object>(
  bindings: readonly ParsedBinding[],
  schema: Schema,
  configured?: RouteBindingsConfig
): S.Codec<unknown, unknown, never, never> | null {
  if (bindings.length === 0) return null

  const fields: Record<string, S.Codec<unknown, unknown, never, never>> = {}

  for (const binding of bindings) {
    const tableName = bindingTableName(binding, configured, schema)
    // SAFETY: The route builder established the matching Drizzle and Effect contracts; this adapter only restores generic information their public types erase.
    const table = Object.getOwnPropertyDescriptor(schema, tableName)?.value

    if (!table) {
      // Table not found - can't infer, let it fail at query time
      return null
    }

    // SAFETY: The route builder established the matching Drizzle and Effect contracts; this adapter only restores generic information their public types erase.
    const column = Object.getOwnPropertyDescriptor(table, lookupColumnOf(table, binding))?.value as
      | DrizzleColumn
      | undefined

    if (!(column instanceof Object) || !('columnType' in column)) {
      // Column not found or not a Drizzle column - can't infer
      return null
    }

    fields[binding.param] = columnTypeToSchema(column.columnType)
  }

  return S.Struct(fields)
}
