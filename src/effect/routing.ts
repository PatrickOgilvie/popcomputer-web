/**
 * Effect Route Builder
 *
 * Laravel-style routing with Effect handlers.
 */

import { Predicate, Context, Effect, Exit, Layer, ManagedRuntime, Option, Schema as S } from 'effect'
import type { Context as HonoContext, Hono, MiddlewareHandler, Env } from 'hono'
import { runEffectWithRuntime } from './handler.js'
import {
  bindingsConfiguration,
  buildContextLayer,
  disposeRequestRuntime,
  getEffectBridgeConfig,
  getEffectBindings,
  getEffectRuntime,
  getEffectSchema,
  setEffectBridgeConfig,
  type EffectBridgeConfig,
} from './bridge.js'
import {
  type AppError,
  ConfigurationError,
  NotFoundError,
  Redirect,
  RouteConfigurationError,
} from './errors.js'
import { openWebContext } from '../request-context.js'
import { allowDefaultPageCache } from '../page-cache.js'
import {
  applyCachePolicy,
  decideCachePolicy,
  hasSessionCookie,
  isPageResponse,
  isPartialReloadRequest,
  prepareCachePurgeTags,
  ResponseCachePurgeError,
  ResponseCachePurgeFailure,
  ResponseCacheService,
  formatRecordTag,
  type RouteCacheOptions,
} from './response-cache.js'
import { DatabaseService } from './services.js'
import type {
  AuthService,
  ExecutionContextService,
  PageService,
  RequestService,
  RequestStateService,
  ResponseFactoryService,
  BindingsService,
} from './services.js'
import {
  parseBindings,
  toHonoPath,
  BoundModels,
  bindingTableName,
  compileBindingPlan,
  decodeBindingParam,
  decodeBoundRow,
  inferParamsSchema,
  loadDrizzle,
  type BoundModelError,
  type CompiledRouteBinding,
  type ParsedBinding,
  type RouteBindingsConfig,
} from './binding.js'
import type { RouteRegistry } from './route-registry.js'
import {
  getAppRouteRegistry,
  type HttpMethod,
  type RouteMetadata,
  type RouteMetadataJson,
} from './route-registry.js'

/**
 * Type for Effect-based route handlers.
 * Expected failures must be one of the package's typed application errors.
 */
export type EffectHandler<R = never, E extends AppError = AppError> = Effect.Effect<
  Response | Redirect,
  E,
  R
>

/**
 * Services every route can use, whatever setupWeb configures.
 */
export type CoreServices =
  | RequestService
  | RequestStateService
  | ResponseCacheService
  | ResponseFactoryService
  | PageService
  | BindingsService
  | BoundModels
  | ExecutionContextService

/**
 * Every service the framework can provide to a route: the core services plus
 * the database and auth services. `effectRoutes(app)` assumes all of them;
 * the `routes` that setupWeb returns include only what it configures.
 */
export type BaseServices = CoreServices | DatabaseService | AuthService

/** The key a service tag declares, for naming it in a type error. */
type ServiceKey<Service> = Service extends { readonly key: infer Key extends string }
  ? Key
  : 'unnamed service'

/** The `_tag` of an error, for naming it in a type error. */
type ErrorTag<Failure> = Failure extends { readonly _tag: infer Tag extends string }
  ? Tag
  : 'untagged error'

/**
 * `unknown` when a route can run an action that needs `R` and fails with
 * `Err`; otherwise an object type naming what is wrong, which the action
 * cannot satisfy, so the compiler reports it at the registration.
 */
export type RouteActionCheck<R, Err, Services> = [Exclude<R, Services>] extends [never]
  ? [Exclude<Err, AppError>] extends [never]
    ? unknown
    : {
        readonly unhandledErrors: ErrorTag<Exclude<Err, AppError>>
        readonly fix: 'Handle these errors in the action (Effect.catchTag), or fail with one of the package errors such as HttpError.'
      }
  : {
      readonly missingServices: ServiceKey<Exclude<R, Services>>
      readonly fix: 'Configure the service in setupWeb (database, auth, services.app, services.request), or add it with routes.provide(layer).'
    }

/** An action a route with `Services` can run. */
export type RouteAction<R, Err, Services> = Effect.Effect<Response | Redirect, Err, R> &
  RouteActionCheck<R, Err, Services>

/**
 * The action as the route runs it. RouteActionCheck rejects, at the call
 * site, any action whose failures are not AppError, so registered actions
 * fail only with AppError.
 */
function checkedAction<R, Err, Services>(
  action: RouteAction<R, Err, Services>
): Effect.Effect<Response | Redirect, AppError, R> {
  // SAFETY: see above; an action with other failures does not compile.
  return action as Effect.Effect<Response | Redirect, AppError, R>
}

/**
 * Route-level configuration options.
 */
export interface EffectRouteOptions {
  /**
   * Validate route params with the provided schema.
   * Invalid values will return a 404 before the handler runs.
   *
   * @example
   * ```typescript
   * effectRoutes(app).get(
   *   '/projects/{project}',
   *   showProject,
   *   { params: S.Struct({ project: uuid }) }
   * )
   * ```
   */
  params?: S.Codec<unknown, unknown, never, never>
  /**
   * Named route for reverse routing and test helpers.
   *
   * @example
   * ```typescript
   * effectRoutes(app).get(
   *   '/projects/{project}',
   *   showProject,
   *   { name: 'projects.show' }
   * )
   * ```
   */
  name?: string
  /**
   * Leave unset for the default page cache: a page that reads no bindings,
   * headers or request state is cached at the edge until the next deploy.
   *
   * `false` always renders this route fresh, for pages whose output changes
   * without the framework seeing it (external fetches, the current time).
   *
   * An object caches this route's responses for a fixed time via Cloudflare
   * Workers Cache instead, data reads included. Applied to successful
   * GET/HEAD responses only; partial reloads are marked no-store and
   * HTML/JSON page objects vary on X-Inertia. Requires
   * `"cache": { "enabled": true }` in wrangler config.
   */
  cache?: RouteCacheOptions | false
  /**
   * After this route's effect succeeds (any Redirect, or a Response below
   * 400), purge these Workers Cache tags. `true` purges the record of each
   * of the route's bindings, the tag every cached page that reads it carries
   * (see recordCacheTag), and the table of the record it writes:
   * PUT /projects/{project} purges `projects:{id}` and `projects`.
   */
  purges?: true | readonly string[]
}

const BODYLESS_METHODS = new Set(['GET', 'HEAD'])

/** The Cache-Tag of each record a route's bindings name. Internal to routing. */
class RouteRecords extends Context.Service<
  RouteRecords,
  { readonly tags: Effect.Effect<readonly string[], BoundModelError> }
>()('@popcomputer/web/RouteRecords') {}

/** A route's models, and the Cache-Tag of each one's record. */
interface LoadedModels {
  readonly models: ReadonlyMap<string, unknown>
  readonly recordTags: readonly string[]
}

/** The result of loading a route's models. */
type BindingLoadOutcome =
  | LoadedModels
  | { readonly missing: string }
  | { readonly failure: RouteConfigurationError }

/**
 * Whether the app is running in development. Used to gate developer warnings.
 * Mirrors the explicit-signal policy used elsewhere (no CF_PAGES_BRANCH).
 */
function isDevEnv<E extends Env>(c: HonoContext<E>): boolean {
  const env = c.env ?? {}

  return (
    Object.getOwnPropertyDescriptor(env, 'ENVIRONMENT')?.value === 'development' ||
    Object.getOwnPropertyDescriptor(env, 'NODE_ENV')?.value === 'development'
  )
}

function hasPrivateRequestState<E extends Env>(c: HonoContext<E>): boolean {
  const requestCtx = openWebContext(c)

  return (
    requestCtx.authUser !== undefined ||
    c.req.header('Authorization') !== undefined ||
    hasSessionCookie(c.req.header('Cookie'), requestCtx.sessionCookies ?? [])
  )
}


/**
 * Effect Route Builder with layer composition.
 */
export class EffectRouteBuilder<
  E extends Env,
  Services = BaseServices
> {
  constructor(
    private readonly app: Hono<E>,
    private readonly layers: Layer.Layer<never, AppError, never>[] = [],
    private readonly pathPrefix: string = '',
    private readonly bridgeConfig?: EffectBridgeConfig<E, never>,
    private readonly registry: RouteRegistry = getAppRouteRegistry(app),
    private readonly middlewares: MiddlewareHandler<E>[] = []
  ) {}

  /**
   * Add a layer to provide services to all routes in this builder.
   * The layer may be self-contained (`R = never`) or consume services already
   * available in this route context (`BaseServices`, previously provided services,
   * and bridge-level custom services).
   * The layer's error type must be handled by the effect bridge (AppError or subtype).
   */
  provide<
    S,
    LayerErr extends AppError,
    LayerReq extends Services
  >(
    layer: Layer.Layer<S, LayerErr, LayerReq>
  ): EffectRouteBuilder<E, Services | S> {
    // SAFETY: The route builder established the matching Drizzle and Effect contracts; this adapter only restores generic information their public types erase.
    return new EffectRouteBuilder(
      this.app,
      [
        ...this.layers,
        // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- SAFETY: provide's LayerReq constraint only accepts base, bridge, or previously provided services; createHandler composes those before this private layer is built. Preserve LayerErr for the request error boundary.
        layer as Layer.Layer<S, LayerErr, never>,
      ],
      this.pathPrefix,
      this.bridgeConfig,
      this.registry,
      this.middlewares
    )
  }

  /**
   * Add Hono middleware that runs before the Effect handler.
   * Use this for middleware that needs to redirect or short-circuit requests
   * before the Effect computation runs (e.g., auth redirects, rate limiting).
   *
   * @example
   * ```typescript
   * effectRoutes(app)
   *   .middleware(ensureAuthMiddleware)  // Can redirect before Effect runs
   *   .provide(RequireAuthLayer)         // Provides services within Effect
   *   .group((route) => {
   *     route.get('/dashboard', showDashboard)
   *   })
   * ```
   */
  middleware(
    ...handlers: MiddlewareHandler<E>[]
  ): EffectRouteBuilder<E, Services> {
    return new EffectRouteBuilder(
      this.app,
      this.layers,
      this.pathPrefix,
      this.bridgeConfig,
      this.registry,
      [...this.middlewares, ...handlers]
    )
  }

  /**
   * Attach Hono middleware to the builder's whole prefix, including paths
   * that match no route. Use this for cross-cutting response policy (error
   * redaction, envelope shaping, security headers) that must also apply to
   * 404s — per-route `.middleware()` never runs when no route matches.
   *
   * Registers immediately against the current prefix, so call it after
   * `.prefix()`:
   *
   * @example
   * ```typescript
   * effectRoutes(app)
   *   .prefix('/api')
   *   .prefixMiddleware(redactErrorDetails)  // wraps /api hits AND misses
   *   .group((route) => {
   *     route.get('/status', showStatus)
   *   })
   * ```
   */
  prefixMiddleware(
    ...handlers: MiddlewareHandler<E>[]
  ): EffectRouteBuilder<E, Services> {
    if (this.pathPrefix) {
      // Two patterns: '/api/*' does not match '/api' itself in Hono
      this.app.use(this.pathPrefix, ...handlers)
      this.app.use(`${this.pathPrefix}/*`, ...handlers)
    } else {
      this.app.use('/*', ...handlers)
    }

    return this
  }

  /**
   * Set path prefix for all routes in this builder.
   */
  prefix(path: string): EffectRouteBuilder<E, Services> {
    const normalizedPath = path.replace(/\/$/, '')

    return new EffectRouteBuilder(
      this.app,
      this.layers,
      this.pathPrefix + normalizedPath,
      this.bridgeConfig,
      this.registry,
      this.middlewares
    )
  }

  /**
   * Register routes that share this builder's prefix, layers and middleware.
   * Returns the builder so registrations can continue after the group.
   */
  group(callback: (route: EffectRouteBuilder<E, Services>) => void): this {
    callback(this)

    return this
  }

  /**
   * Resolve the full path.
   */
  private resolvePath(path: string): string {
    if (this.pathPrefix) {
      return path === '/' ? this.pathPrefix : `${this.pathPrefix}${path}`
    }

    return path
  }

  /**
   * Validate route params against a schema.
   */
  // oxlint-disable-next-line effecttsgo/async-function -- This Hono adapter awaits request parsing and runtime completion, then maps the result to an HTTP response.
  private async ensureParams(
    c: HonoContext<E>,
    schema?: S.Codec<unknown, unknown, never, never>
  ): Promise<Response | null> {
    if (!schema) return null

    const rawParams = c.req.param()

    const params: Record<string, string> =
      S.is(S.String)(rawParams) ? {} : rawParams

    const decode = S.decodeUnknownEffect(schema)
    const exit = await Effect.runPromiseExit(decode(params))

    if (Exit.isFailure(exit)) {
      return c.notFound()
    }

    return null
  }

  /**
   * Load the route's models from the database, parents first so each child
   * is scoped to its parent. Reports the first binding without a row.
   */
  // oxlint-disable-next-line effecttsgo/async-function -- This Hono/Drizzle adapter awaits native query builders sequentially to enforce parent binding scope before returning HTTP results.
  private async resolveBindings<Database>(
    c: HonoContext<E>,
    plan: readonly CompiledRouteBinding[],
    db: Database,
  ): Promise<BindingLoadOutcome> {
    if (plan.length === 0) {
      return { models: new Map(), recordTags: [] }
    }

    const { eq, and } = await loadDrizzle()

    const models = new Map<string, S.Schema.Type<typeof S.Unknown>>()
    const rows = new Map<string, object>()
    const recordTags: string[] = []

    for (const binding of plan) {
      const rawParam = c.req.param(binding.param)

      if (!rawParam) {
        return { missing: binding.param }
      }

      const paramValue = await decodeBindingParam(binding, rawParam)

      if (paramValue === undefined) {
        return { missing: binding.param }
      }

      // QueryBuilder type compatible with all Drizzle databases (PostgreSQL, MySQL, SQLite)
      type QueryBuilder = {
        where: <Condition>(condition: Condition) => QueryBuilder
        limit: (n: number) => PromiseLike<object[]>
      }

      // SAFETY: The route builder established the matching Drizzle and Effect contracts; this adapter only restores generic information their public types erase.
      let whereCondition: unknown = eq(
        Object.getOwnPropertyDescriptor(binding.table, binding.column)?.value as Parameters<typeof eq>[0],
        paramValue
      )

      if (binding.parent) {
        const parentRow = rows.get(binding.parent.param)

        if (!parentRow) {
          throw RouteConfigurationError.relationNotFound(
            binding.parent.param,
            binding.tableName,
            binding.param
          )
        }

        // SAFETY: The route builder established the matching Drizzle and Effect contracts; this adapter only restores generic information their public types erase.
        const conditions: Parameters<typeof and> = [
          whereCondition as Parameters<typeof and>[number],
        ]

        for (const pair of binding.parent.relation.columnPairs) {
          const parentReferenceValue = Object.getOwnPropertyDescriptor(
            parentRow,
            pair.references
          )?.value

          if (parentReferenceValue === undefined || parentReferenceValue === null) {
            throw RouteConfigurationError.relationNotFound(
              binding.parent.param,
              binding.tableName,
              binding.param
            )
          }

          // SAFETY: The route builder established the matching Drizzle and Effect contracts; this adapter only restores generic information their public types erase.
          conditions.push(
            eq(
              Object.getOwnPropertyDescriptor(
                binding.table,
                pair.foreignKey
              )?.value as Parameters<typeof eq>[0],
              parentReferenceValue
            )
          )
        }

        whereCondition = and(...conditions)
      }

      // SAFETY: The route builder established the matching Drizzle and Effect contracts; this adapter only restores generic information their public types erase.
      const dbClient = db as {
        select: () => { from: <TableValue>(table: TableValue) => QueryBuilder }
      }

      const query: QueryBuilder = dbClient.select().from(binding.table).where(whereCondition)

      // Execute the query - use .limit(1) for cross-database compatibility
      // (PostgreSQL/MySQL don't have .get(), only SQLite does)
      const results = await query.limit(1)
      const result = results[0]

      if (!result) {
        return { missing: binding.param }
      }

      // SAFETY: The route builder established the matching Drizzle and Effect contracts; this adapter only restores generic information their public types erase.
      rows.set(binding.param, result)
      models.set(binding.param, await decodeBoundRow(binding, result))
      recordTags.push(formatRecordTag(binding.tableName, Object.getOwnPropertyDescriptor(result, binding.primaryKey)?.value))
    }

    return { models, recordTags }
  }

  private createHandler<R>(
    effect: Effect.Effect<Response | Redirect, AppError, R>,
    bindings: ParsedBinding[],
    options?: EffectRouteOptions
  ): MiddlewareHandler<E> {
    const layers = this.layers
    const bridgeConfig = this.bridgeConfig
    let bindingPlanPromise: Promise<readonly CompiledRouteBinding[]> | undefined
    // Dev-only observability for an ineffective `cache` option:
    // once per route (this handler closure), not once per request.
    let warnedIneffectiveCache = false

    // A bound route reads its model from the database, and an explicit cache
    // option owns this route's caching.
    const allowsDefaultPageCache = options?.cache === undefined && bindings.length === 0

    // oxlint-disable-next-line effecttsgo/async-function -- This Hono adapter awaits request parsing and runtime completion, then maps the result to an HTTP response.
    return async (c) => {
      setEffectBridgeConfig(c, bridgeConfig)

      if (allowsDefaultPageCache) {
        allowDefaultPageCache(c)
      }

      // Get schema from bridgeConfig or from context (set by setupWeb/effectBridge)
      const schema = bridgeConfig?.schema ?? getEffectSchema(c)
      const configuredBindings = bridgeConfig?.bindings ?? getEffectBindings(c)

      // Use provided params schema, or infer from database schema if available
      const paramsSchema = options?.params ?? (
        bindings.length > 0 && schema
          ? inferParamsSchema(bindings, schema) ?? undefined
          : undefined
      )

      const validation = await this.ensureParams(c, paramsSchema)

      if (validation) return validation

      const requestRuntime = getEffectRuntime(c)

      // A request service that fails to build, such as one reading a missing
      // binding with Config, fails the action with its error.
      let contextLayer = requestRuntime
        ? Layer.effectContext(requestRuntime.contextEffect)
        : buildContextLayer(c, bridgeConfig ?? getEffectBridgeConfig(c))

      if (requestRuntime && bridgeConfig?.services) {
        contextLayer = Layer.merge(
          contextLayer,
          bridgeConfig.services(c).pipe(Layer.provide(bindingsConfiguration(c.env)))
        )
      }

      // Resolve route model bindings if we have any and schema is configured
      // Route models load on the action's first bound() call, after guards.

      // oxlint-disable-next-line effecttsgo/async-function -- This Hono/Drizzle adapter awaits native query builders sequentially to enforce parent binding scope before returning a typed outcome.
      const loadModels = async (
        bindingSchema: object,
        parsers: RouteBindingsConfig,
        db: object
      ): Promise<BindingLoadOutcome> => {
        try {
          bindingPlanPromise ??= compileBindingPlan(bindings, bindingSchema, parsers)

          return await this.resolveBindings(c, await bindingPlanPromise, db)
        } catch (cause) {
          // Misconfigured bindings are typed failures; anything else, such as
          // a failed query, is a defect for the error boundary.
          if (cause instanceof RouteConfigurationError) return { failure: cause }

          throw cause
        }
      }

      // Models load through the request's DatabaseService, so a database a
      // test provides with testEnv serves bound() as it serves dbQuery.
      const loadAllModels = (
        database: Option.Option<object>
      ): Effect.Effect<LoadedModels, BoundModelError> =>
        Effect.gen(function* () {
          if (bindings.length === 0) {
            return { models: new Map(), recordTags: [] }
          }

          if (!configuredBindings) {
            return yield* RouteConfigurationError.bindingParserNotConfigured(bindings[0].param)
          }

          if (Option.isNone(database)) {
            return yield* ConfigurationError.databaseNotConfigured()
          }

          const db = database.value

          const outcome = yield* Effect.promise(() =>
            loadModels(schema ?? {}, configuredBindings, db)
          )

          if ('failure' in outcome) return yield* outcome.failure

          if ('missing' in outcome) {
            return yield* new NotFoundError({ resource: outcome.missing })
          }

          return outcome
        })

      // bound() and the route's cache tags read the same models, loaded once.
      const boundModelsLayer = Layer.effectContext(
        Effect.gen(function* () {
          const database = yield* Effect.serviceOption(DatabaseService)
          const load = yield* Effect.cached(loadAllModels(database))

          const models = BoundModels.of({
            get: (key) => {
              if (!bindings.some((binding) => binding.param === key)) {
                return Effect.fail(RouteConfigurationError.bindingNotInRoute(key))
              }

              if (!schema) {
                return Effect.fail(RouteConfigurationError.schemaNotConfigured(key))
              }

              return Effect.map(load, (loaded) => loaded.models.get(key))
            },
          })

          // A record the action removed, or never loaded and no longer
          // exists, names no cached page.
          const records = RouteRecords.of({
            tags: load.pipe(
              Effect.map((loaded) => loaded.recordTags),
              Effect.catchTag('NotFoundError', () => Effect.succeed([]))
            ),
          })

          return Context.make(BoundModels, models).pipe(Context.add(RouteRecords, records))
        })
      )

      let fullLayer: Layer.Layer<never, AppError, never> = Layer.provideMerge(boundModelsLayer, contextLayer)

      for (const layer of layers) {
        fullLayer = Layer.provideMerge(layer, fullLayer)
      }

      let handlerEffect: Effect.Effect<
        Response | Redirect,
        AppError | ResponseCachePurgeError,
        R | ResponseCacheService | RouteRecords
      > = effect

      // A cacheable page is tagged with the records its route read, so a
      // write to any of them purges it.
      let recordTags: readonly string[] = []
      const cacheOption = options?.cache

      if (cacheOption && bindings.length > 0 && BODYLESS_METHODS.has(c.req.method)) {
        handlerEffect = handlerEffect.pipe(
          Effect.tap((result) =>
            result instanceof Response && result.status >= 200 && result.status < 300
              ? Effect.flatMap(RouteRecords, (records) => records.tags).pipe(
                  Effect.map((tags) => {
                    recordTags = tags
                  })
                )
              : Effect.void
          )
        )
      }

      // After a successful mutation, purge the declared Workers Cache tags.
      // Runs inside the effect so a failed purge surfaces in the typed error
      // channel instead of leaving stale entries silently.
      const purges = options?.purges

      if (purges) {
        const writtenTable = bindings.length > 0
          ? [bindingTableName(bindings[bindings.length - 1], configuredBindings)]
          : []

        const purgeTags: Effect.Effect<readonly string[], BoundModelError, RouteRecords> = purges === true
          ? Effect.flatMap(RouteRecords, (records) => records.tags).pipe(
              Effect.map((tags) => [...tags, ...writtenTable])
            )
          : Effect.succeed(purges)

        handlerEffect = handlerEffect.pipe(
          Effect.tap((result) => {
            const succeeded =
              result instanceof Redirect ||
              (result instanceof Response && result.status < 400)

            if (!succeeded) return Effect.void

            return Effect.flatMap(purgeTags, (tags) => {
              if (tags.length === 0) return Effect.void

              const preparedTags = prepareCachePurgeTags(tags)

              if (Predicate.isTagged(preparedTags, 'invalid')) {
                return Effect.fail(
                  new ResponseCachePurgeError({
                    input: { tags },
                    cause: ResponseCachePurgeFailure.InvalidCacheTags({
                      reason: preparedTags.reason,
                    }),
                  })
                )
              }

              return Effect.flatMap(ResponseCacheService, (cache) =>
                cache.purge({ tags: preparedTags.tags })
              )
            })
          })
        )
      }

      // The route runtime owns every provided Layer until background work has
      // settled, including scoped services added with route.provide().
      // SAFETY: the route's Services type admits only actions whose
      // requirements setupWeb, effect.services and provide() supply, and the
      // composition above provides those services; acquisition failures remain
      // AppError. effectRoutes(app) assumes every framework service, so an
      // unconfigured one is still reported at runtime as a configuration error.
      const routeRuntime = ManagedRuntime.make(
        fullLayer as Layer.Layer<R | ResponseCacheService | RouteRecords, AppError>
      )

      let response: Response

      try {
        response = await runEffectWithRuntime(handlerEffect, c, routeRuntime)
      } finally {
        await disposeRequestRuntime(c, routeRuntime)
      }

      if (!options?.cache || !(response instanceof Response)) {
        return response
      }

      const decision = decideCachePolicy({
        method: c.req.method,
        status: response.status,
        isPartialReload: isPartialReloadRequest((name) => c.req.header(name)),
        setsCookie: response.headers.has('Set-Cookie'),
        hasPrivateRequestState: hasPrivateRequestState(c),
        existingCacheControl: response.headers.get('Cache-Control'),
        isPage: isPageResponse(response.headers),
        derivedTags: recordTags,
        options: options.cache,
      })

      if (
        Predicate.isTagged(decision, 'skip') &&
        decision.warning &&
        !warnedIneffectiveCache &&
        isDevEnv(c)
      ) {
        warnedIneffectiveCache = true
        // oxlint-disable-next-line effecttsgo/global-console -- This outer Hono adapter emits a once-per-route development configuration warning after the request runtime has been disposed.
        console.warn(`[@popcomputer/web] Route '${c.req.path}' ${decision.warning}`)
      }

      return applyCachePolicy(response, decision)
    }
  }

  /**
   * Register a route with the given HTTP method.
   * Parses Laravel-style bindings and converts to Hono path format.
   */
  private registerRoute<R>(
    method: HttpMethod,
    path: string,
    effect: Effect.Effect<Response | Redirect, AppError, R>,
    options?: EffectRouteOptions
  ): void {
    const bindings = parseBindings(path)
    const honoPath = toHonoPath(path)
    const fullPath = this.resolvePath(honoPath)

    // Register route metadata
    const metadata: RouteMetadata = {
      method,
      path,
      honoPath,
      fullPath,
      bindings,
      prefix: this.pathPrefix,
      name: options?.name,
    }

    this.registry.register(metadata)

    // Register with Hono - apply middlewares before the Effect handler
    const handler = this.createHandler(effect, bindings, options)

    if (this.middlewares.length > 0) {
      // SAFETY: The method is selected from the finite Hono routing-method union and every supplied handler uses the builder's Env.
      const register = this.app[method] as (
        path: string,
        ...handlers: MiddlewareHandler<E>[]
      ) => void

      register(
        fullPath,
        ...this.middlewares,
        handler
      )
    } else {
      this.app[method](fullPath, handler)
    }
  }

  /** Register a GET route. Supports Laravel-style route model binding: /projects/{project} */
  get<R, Err>(
    path: string,
    effect: RouteAction<R, Err, Services>,
    options?: EffectRouteOptions
  ): this {
    this.registerRoute('get', path, checkedAction(effect), options)

    return this
  }

  /** Register a POST route. Supports Laravel-style route model binding: /projects/{project} */
  post<R, Err>(
    path: string,
    effect: RouteAction<R, Err, Services>,
    options?: EffectRouteOptions
  ): this {
    this.registerRoute('post', path, checkedAction(effect), options)

    return this
  }

  /** Register a PUT route. Supports Laravel-style route model binding: /projects/{project} */
  put<R, Err>(
    path: string,
    effect: RouteAction<R, Err, Services>,
    options?: EffectRouteOptions
  ): this {
    this.registerRoute('put', path, checkedAction(effect), options)

    return this
  }

  /** Register a PATCH route. Supports Laravel-style route model binding: /projects/{project} */
  patch<R, Err>(
    path: string,
    effect: RouteAction<R, Err, Services>,
    options?: EffectRouteOptions
  ): this {
    this.registerRoute('patch', path, checkedAction(effect), options)

    return this
  }

  /** Register a DELETE route. Supports Laravel-style route model binding: /projects/{project} */
  delete<R, Err>(
    path: string,
    effect: RouteAction<R, Err, Services>,
    options?: EffectRouteOptions
  ): this {
    this.registerRoute('delete', path, checkedAction(effect), options)

    return this
  }

  /** Register a route for all HTTP methods. Supports Laravel-style route model binding: /projects/{project} */
  all<R, Err>(
    path: string,
    effect: RouteAction<R, Err, Services>,
    options?: EffectRouteOptions
  ): this {
    this.registerRoute('all', path, checkedAction(effect), options)

    return this
  }

  /** Every route registered on this builder's application, as JSON. */
  toJson(): RouteMetadataJson[] {
    return this.registry.toJson()
  }

  /** The application's route registry. */
  getRegistry(): RouteRegistry {
    return this.registry
  }
}

/**
 * Configuration for effectRoutes().
 */
export interface EffectRoutesConfig<E extends Env, CustomServices = never>
  extends EffectBridgeConfig<E, CustomServices> {
  /**
   * Route registry for storing route metadata.
   * Defaults to the registry owned by this Hono app.
   *
   * @example
   * ```typescript
   * const registry = new RouteRegistry()
   * effectRoutes(app, { registry })
   * ```
   */
  registry?: RouteRegistry
}

/**
 * Create a route builder for an app composed by hand.
 *
 * Applications using setupWeb register routes on the `routes` it returns,
 * whose type admits only the services setupWeb configures. This builder
 * assumes every framework service is available, plus `CustomServices`.
 *
 * @example
 * effectRoutes(app)
 *   .provide(RequireAuthLayer)
 *   .prefix('/dashboard')
 *   .group((route) => {
 *     route.get('/', showDashboard)
 *     route.get('/projects', listProjects)
 *     route.post('/projects', createProject)
 *   })
 */
export function effectRoutes<E extends Env, CustomServices = never>(
  app: Hono<E>,
  config?: EffectRoutesConfig<E, CustomServices>
): EffectRouteBuilder<E, BaseServices | CustomServices> {
  const registry = config?.registry ?? getAppRouteRegistry(app)

  return new EffectRouteBuilder<E, BaseServices | CustomServices>(app, [], '', config, registry)
}
