/**
 * The records a route's path names, loaded for the request: `bound()` reads
 * them, a purge or a cached page tags itself with them, and a guard decides
 * from them before anything under them loads.
 *
 * Each record loads by its placeholder, scoped to its parent's row and
 * narrowed by who may load it (`ownedBy`, `publicWhen`), in the same query,
 * so a record the visitor may not see is missing like any other. Records
 * load parents first, once each, and a guarded one only once a guard that
 * read it has let the visitor in.
 */

import { Context, Effect, Option, Schema as S, Semaphore } from 'effect'
import type { SQL, SQLWrapper, Table } from 'drizzle-orm'
import type { Context as HonoContext, Env } from 'hono'
import {
  BoundModels,
  compileBindingPlan,
  decodeBoundRow,
  inferParamsSchema,
  isGuardedBinding,
  loadDrizzle,
  type BoundModelError,
  type CompiledRouteBinding,
  type ParsedBinding,
  type RouteBindingParam,
  type RouteBindingsConfig,
} from './binding.js'
import { dbQuery } from './database.js'
import { ConfigurationError, NotFoundError, RouteConfigurationError, UnauthorizedError } from './errors.js'
import { currentDecision, GuardVerdicts } from './guard.js'
import { formatRecordTag } from './response-cache.js'
import { AuthUserService, DatabaseService } from './services.js'
import { setupOf } from '../web-setup.js'

/** The Cache-Tag of each record a route's bindings name. */
export class RouteRecords extends Context.Service<
  RouteRecords,
  { readonly tags: Effect.Effect<readonly string[], BoundModelError> }
>()('@popcomputer/web/RouteRecords') {}

/** What a route's path names, as the application's settings read it: the same for every request. */
export interface RouteModels {
  readonly schema: object | undefined
  readonly configuredBindings: RouteBindingsConfig | undefined
  /** The placeholders a binding loads a record for, in path order. */
  readonly modelBindings: ParsedBinding[]
  readonly paramsSchema: S.Codec<unknown, unknown, never, never> | undefined
  /** The bindings a guard decides who may load. */
  readonly guarded: readonly string[]
  /** How each binding loads its record, compiled once, by the first load. */
  readonly plan: Effect.Effect<readonly CompiledRouteBinding[], RouteConfigurationError>
}

/**
 * What a route's path names, worked out by its first request for every later
 * one: it depends only on the application's settings. Registration can't
 * work it out, since a stack composed by hand gives its schema and bindings
 * to effectBridge, which hands them to each request.
 */
export function routeModelsOnce<E extends Env>(
  bindings: ParsedBinding[],
  params: S.Codec<unknown, unknown, never, never> | undefined,
  bridgeConfig: { readonly schema?: object; readonly bindings?: RouteBindingsConfig } | undefined
): (c: HonoContext<E>) => RouteModels {
  let routeModels: RouteModels | undefined

  return (c) => {
    if (routeModels !== undefined) return routeModels

    const schema = bridgeConfig?.schema ?? setupOf(c).schema
    const configuredBindings = bridgeConfig?.bindings ?? setupOf(c).bindings
    // A {param} with a binding parser names a model; any other is a plain
    // parameter the action reads with validateRequest.
    const modelBindings = configuredBindings
      ? bindings.filter((binding) => Object.hasOwn(configuredBindings, binding.param))
      : []
    let compiled: Promise<readonly CompiledRouteBinding[]> | undefined

    routeModels = {
      schema,
      configuredBindings,
      modelBindings,
      // The params schema given, or one inferred from the tables' columns.
      paramsSchema: params ?? (
        modelBindings.length > 0 && schema
          ? inferParamsSchema(modelBindings, schema, configuredBindings) ?? undefined
          : undefined
      ),
      // A guarded binding loads once a guard(...) the route is provided has
      // read it and let the visitor in.
      guarded: modelBindings.map((binding) => binding.param).filter((name) => isGuardedBinding(configuredBindings?.[name])),
      plan: Effect.tryPromise({
        try: () => compiled ??= compileBindingPlan(modelBindings, schema ?? {}, configuredBindings ?? {}),
        catch: (cause) => cause,
      }).pipe(
        // A misconfigured binding is a typed failure; anything else, a defect.
        Effect.catch((cause) => cause instanceof RouteConfigurationError ? Effect.fail(cause) : Effect.die(cause))
      ),
    }

    return routeModels
  }
}

/** What one request asks of its route's models. */
export interface RouteModelsRequest {
  /** Every placeholder the route's path names, models or not. */
  readonly bindings: readonly ParsedBinding[]
  readonly models: RouteModels
  /** The request's value for a placeholder. */
  readonly param: (name: string) => string | undefined
  /** A guard starts deciding: the page it guards is no shared cache's to keep. */
  readonly onGuard: Effect.Effect<void>
}

/**
 * The route's models for one request, as the services a route gives its
 * action and layers: BoundModels, which `bound()` reads, RouteRecords, and
 * GuardVerdicts, through which every guard, however it was composed, starts
 * its decision and confirms the records it read.
 */
export function routeModelsLayer(request: RouteModelsRequest) {
  const { bindings, models: route, param, onGuard } = request
  const { modelBindings, guarded } = route

  return Effect.gen(function* () {
    const database = yield* Effect.serviceOption(DatabaseService)
    // The guarded records a guard has let the visitor in to.
    const decided = new Set<string>()
    const undecided = (): string | undefined => guarded.find((name) => !decided.has(name))
    const positionOf = (key: string): number => modelBindings.findIndex((binding) => binding.param === key)
    // The models this request has loaded, which each later load goes on from,
    // one load at a time.
    const loading: LoadingModels = { models: new Map(), rows: new Map(), recordTags: [] }
    const lock = Semaphore.makeUnsafe(1)

    // The first `count` of the route's models, after any loaded already. They
    // load through the request's DatabaseService, so a database a test gives
    // with testEnv serves bound() as it serves dbQuery. The signed-in user,
    // whose id a binding only its owner may load is looked up by, is read
    // when they load, so a layer the route provides, such as an API key's,
    // has given it.
    const loadThrough = (count: number): Effect.Effect<LoadedModels, BoundModelError> =>
      lock.withPermits(1)(Effect.gen(function* () {
        if (route.configuredBindings === undefined || modelBindings.length === 0) return { models: new Map(), recordTags: [] }
        if (loading.rows.size >= count) return { models: loading.models, recordTags: [...loading.recordTags] }
        if (Option.isNone(database)) return yield* ConfigurationError.databaseNotConfigured()

        const signedIn = yield* Effect.serviceOption(AuthUserService)
        const plan = yield* route.plan

        yield* loadRecords(plan.slice(0, count), param, userIdOf(signedIn), loading).pipe(
          Effect.provideService(DatabaseService, database.value)
        )

        return { models: loading.models, recordTags: [...loading.recordTags] }
      }))
    const load = loadThrough(modelBindings.length)

    const bound = BoundModels.of({
      get: (key) => {
        if (!bindings.some((binding) => binding.param === key)) return Effect.fail(RouteConfigurationError.bindingNotInRoute(key))
        if (!route.schema) return Effect.fail(RouteConfigurationError.schemaNotConfigured(key))
        if (!modelBindings.some((binding) => binding.param === key)) return Effect.fail(RouteConfigurationError.bindingParserNotConfigured(key))

        return Effect.flatMap(currentDecision, (decision) => {
          if (Option.isSome(decision)) {
            const position = positionOf(key)
            // A guarded record before this one is decided by its own guard
            // first: a guard that read a record under it would load both, and
            // answer from them, for a visitor that guard turns away.
            const earlier = guarded.find((name) =>
              positionOf(name) < position && !decided.has(name) && !decision.value.reads.has(name)
            )

            if (earlier !== undefined) return Effect.fail(RouteConfigurationError.guardedWithoutGuard(earlier))

            // Decided once this guard lets the visitor in, not now.
            decision.value.reads.add(key)

            // A guard decides from the record it reads and those before it,
            // so the records under it, such as an organization's project, are
            // looked up only once the guards have let the visitor in: a
            // visitor one turns away learns only that.
            return Effect.map(loadThrough(position + 1), (loaded) => loaded.models.get(key))
          }

          const unguarded = undecided()

          return unguarded === undefined
            ? Effect.map(load, (loaded) => loaded.models.get(key))
            : Effect.fail(RouteConfigurationError.guardedWithoutGuard(unguarded))
        })
      },
    })

    // A record the action removed, or never loaded and no longer exists,
    // names no cached page. Purging the records a route names reads them
    // too, so a guarded one no guard read purges nothing for a visitor the
    // guard would have turned away.
    const records = RouteRecords.of({
      tags: Effect.suspend(() => {
        const unguarded = undecided()

        return unguarded === undefined ? Effect.void : Effect.fail(RouteConfigurationError.guardedWithoutGuard(unguarded))
      }).pipe(
        Effect.andThen(load),
        Effect.map((loaded) => loaded.recordTags),
        Effect.catchTag('NotFoundError', () => Effect.succeed([])),
        Effect.catchTag('UnauthorizedError', () => Effect.succeed([]))
      ),
    })

    const verdicts = GuardVerdicts.of({
      start: onGuard,
      confirm: (reads) => Effect.sync(() => {
        for (const key of reads) decided.add(key)
      }),
    })

    return Context.make(BoundModels, bound).pipe(Context.add(RouteRecords, records), Context.add(GuardVerdicts, verdicts))
  })
}

/** A route's models, and the Cache-Tag of each one's record. */
interface LoadedModels {
  readonly models: ReadonlyMap<string, unknown>
  readonly recordTags: readonly string[]
}

/**
 * The models a request has loaded so far, parents first, which a later load
 * goes on from: a guard's read loads the record it names and those before
 * it, and the first read after the guards loads the rest.
 */
interface LoadingModels {
  readonly models: Map<string, unknown>
  /** Each loaded binding's row, which scopes the bindings under it. */
  readonly rows: Map<string, object>
  readonly recordTags: string[]
}

/** A signed-in user's id: Better Auth's are strings, or numbers when it generates serial ids. */
type UserId = string | number | bigint

/** The signed-in user's id, if the action's AuthUserService has one: it holds the user and the session. */
function userIdOf(signedIn: Option.Option<object>): UserId | undefined {
  const user: unknown = Option.isSome(signedIn) ? Reflect.get(signedIn.value, 'user') : undefined
  const id: unknown = user instanceof Object ? Reflect.get(user, 'id') : undefined

  return typeof id === 'string' || typeof id === 'number' || typeof id === 'bigint' ? id : undefined
}

/** A column of a binding's table, as Drizzle's conditions take it. */
type BindingColumn = Parameters<typeof import('drizzle-orm').eq>[0]

/**
 * A Drizzle database as far as a binding's lookups use it: every dialect's
 * has `select`, and D1's, libsql's and Neon's over HTTP have `batch`, which
 * sends many statements in one round trip.
 */
interface BindingDatabase {
  select: (fields?: Readonly<Record<string, BindingColumn>>) => { from: (table: Table) => BindingQueryBuilder }
  batch?: (statements: ReadonlyArray<PromiseLike<object[]>>) => PromiseLike<ReadonlyArray<object[]>>
}

interface BindingQueryBuilder extends SQLWrapper {
  where: (condition: SQL | undefined) => BindingQueryBuilder
  limit: (n: number) => PromiseLike<object[]>
}

/** At most two rows of `table` that meet `condition`. */
function lookUp(db: BindingDatabase, table: Table, condition: SQL | undefined): PromiseLike<object[]> {
  return db.select().from(table).where(condition).limit(2)
}

/** The values of `table`'s `column` in the rows that meet `condition`, as a subquery. */
function valuesOf(db: BindingDatabase, table: Table, column: BindingColumn, condition: SQL | undefined): SQLWrapper {
  return db.select({ value: column }).from(table).where(condition)
}

/**
 * Every lookup at once: in one round trip where the driver batches
 * statements, and otherwise sent together, since none waits for another's
 * rows.
 */
function lookUpAll(db: BindingDatabase, lookUps: ReadonlyArray<PromiseLike<object[]>>): PromiseLike<ReadonlyArray<object[]>> {
  return lookUps.length > 1 && db.batch !== undefined ? db.batch(lookUps) : Promise.all(lookUps)
}

/** Whether a parent's row holds no value for a column its child's foreign key references. */
function lacksReference(binding: CompiledRouteBinding, parentRow: object | undefined): boolean {
  return binding.parent !== undefined && (
    parentRow === undefined ||
    binding.parent.relation.columnPairs.some((pair) => {
      const reference: unknown = Object.getOwnPropertyDescriptor(parentRow, pair.references)?.value

      return reference === undefined || reference === null
    })
  )
}

/** A record this load looks up, by the value its placeholder holds. */
interface RecordLookUp {
  readonly binding: CompiledRouteBinding
  readonly value: RouteBindingParam
}

/**
 * Load these bindings' records, parents first, each scoped to its parent and
 * narrowed by who may load it, going on from those `loading` holds. The
 * first binding without a record fails with its 404, and a record only its
 * owner may load fails a signed-out visitor with a 401, before any query.
 * Every record goes to the database at once: each statement carries its
 * parents' conditions, so none waits for another's rows.
 */
function loadRecords(
  plan: readonly CompiledRouteBinding[],
  param: (name: string) => string | undefined,
  userId: UserId | undefined,
  loading: LoadingModels
): Effect.Effect<void, RouteConfigurationError | NotFoundError | UnauthorizedError, DatabaseService> {
  return Effect.gen(function* () {
    const pending = plan.filter((binding) => !loading.rows.has(binding.param))

    if (pending.length === 0) return

    // The records to look up, up to the first refused before any query: a
    // placeholder its column can't hold, a record only its owner may load
    // for a signed-out visitor, or a loaded parent without the value its
    // child references. Those before it are looked up, and answer first.
    const lookUps: RecordLookUp[] = []
    let refused: RouteConfigurationError | NotFoundError | UnauthorizedError | undefined

    for (const binding of pending) {
      const raw = param(binding.param)
      const value = raw ? S.decodeUnknownOption(binding.paramSchema)(raw) : Option.none()

      if (Option.isNone(value)) {
        refused = new NotFoundError({ resource: binding.param })
        break
      }

      // A record only its owner may load is never looked up for anyone else.
      if (binding.access !== undefined && 'ownedBy' in binding.access && userId === undefined) {
        refused = new UnauthorizedError({ message: 'Authentication required' })
        break
      }

      const parent = binding.parent?.param
      const loadsWithParent = parent !== undefined && lookUps.some((lookUp) => lookUp.binding.param === parent)

      if (parent !== undefined && !loadsWithParent && lacksReference(binding, loading.rows.get(parent))) {
        refused = RouteConfigurationError.relationNotFound(parent, binding.tableName, binding.param)
        break
      }

      lookUps.push({ binding, value: value.value })
    }

    const { eq, and, inArray, isNull } = yield* Effect.promise(loadDrizzle)
    // SAFETY: a binding's columns are its compiled table's, which compileBindingPlan checked.
    const columnOf = (binding: CompiledRouteBinding, key: string) => Object.getOwnPropertyDescriptor(binding.table, key)?.value as Parameters<typeof eq>[0]

    // Two rows at most for each: a lookup column that is not unique within
    // the route's scope names no single record, so it fails instead of
    // picking one. (.limit works on every dialect; only SQLite has .get().)
    // A query that fails is a defect for the error boundary.
    const results = lookUps.length === 0 ? [] : yield* dbQuery((database: object) => {
      // SAFETY: every Drizzle dialect's database has this select builder, and a batch where its driver sends one.
      const db = database as BindingDatabase
      // Each record's condition, which its children's statements carry.
      const conditions = new Map<string, SQL | undefined>()

      return lookUpAll(db, lookUps.map(({ binding, value }) => {
        const where = [eq(columnOf(binding, binding.column), value)]

        if (binding.parent) {
          const parentRow = loading.rows.get(binding.parent.param)
          const parent = lookUps.find((lookUp) => lookUp.binding.param === binding.parent?.param)?.binding

          // A parent loaded before scopes the record by its row's values;
          // one loading with it, by a subquery over the parent's own
          // condition, so a record under another parent is missing.
          for (const pair of binding.parent.relation.columnPairs) {
            const foreignKey = columnOf(binding, pair.foreignKey)

            where.push(parent === undefined
              ? eq(foreignKey, Object.getOwnPropertyDescriptor(parentRow, pair.references)?.value)
              : inArray(foreignKey, valuesOf(db, parent.table, columnOf(parent, pair.references), conditions.get(parent.param))))
          }
        }

        // Who may load the record narrows the same query, so another user's
        // record, or one its column keeps private, is missing like any other.
        if (binding.access !== undefined) {
          const required: ReadonlyArray<readonly [string, unknown]> = 'ownedBy' in binding.access
            ? [[binding.access.ownedBy, userId]]
            : Object.entries(binding.access.publicWhen)

          for (const [key, wanted] of required) {
            where.push(wanted === null ? isNull(columnOf(binding, key)) : eq(columnOf(binding, key), wanted))
          }
        }

        const condition = and(...where)

        conditions.set(binding.param, condition)

        return lookUp(db, binding.table, condition)
      }))
    }).pipe(Effect.orDie)

    for (const [index, { binding }] of lookUps.entries()) {
      const rows = results[index] ?? []

      // A parent that loaded with this record holds the value it references.
      if (binding.parent && lacksReference(binding, loading.rows.get(binding.parent.param))) {
        return yield* RouteConfigurationError.relationNotFound(binding.parent.param, binding.tableName, binding.param)
      }

      const [result] = rows

      if (!result) return yield* new NotFoundError({ resource: binding.param })
      if (rows.length > 1) return yield* RouteConfigurationError.ambiguousBinding(binding.param, binding.tableName, binding.column)

      const model = yield* decodeBoundRow(binding, result)

      loading.rows.set(binding.param, result)
      loading.models.set(binding.param, model)

      const key: unknown = Object.getOwnPropertyDescriptor(result, binding.primaryKey)?.value

      if (key !== undefined && key !== null) loading.recordTags.push(formatRecordTag(binding.tableName, key))
    }

    if (refused !== undefined) return yield* Effect.fail(refused)
  })
}
