/**
 * Effect Route Builder
 *
 * Laravel-style routing with Effect handlers.
 */

import { Cause, Effect, Exit, Layer, ManagedRuntime, Option, Schema as S } from 'effect'
import type { ParseOptions } from 'effect/SchemaAST'
import type { Context as HonoContext, Hono, MiddlewareHandler, Env } from 'hono'
import { errorToResponse, runEffectWithRuntime } from './handler.js'
import {
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
  HonertiaConfigurationError,
  Redirect,
  RouteConfigurationError,
  ValidationError,
} from './errors.js'
import { openHonertiaContext } from '../request-context.js'
import {
  applyCachePolicy,
  decideCachePolicy,
  deriveCacheTags,
  hasSessionCookie,
  isPartialReloadRequest,
  prepareCachePurgeTags,
  prepareCacheTags,
  ResponseCachePurgeError,
  ResponseCacheService,
  type RouteCacheOptions,
} from './response-cache.js'
import {
  DatabaseService,
  AuthService,
  HonertiaService,
  RequestService,
  RequestStateService,
  ResponseFactoryService,
  BindingsService,
} from './services.js'
import { ValidatedBodyService, ValidatedQueryService } from './validated-services.js'
import { createBodyParseValidationError, validateUnknown } from './validation.js'
import {
  parseBindings,
  toHonoPath,
  BoundModels,
  compileBindingPlan,
  decodeBindingParam,
  decodeBoundRow,
  inferParamsSchema,
  type CompiledRouteBinding,
  type ParsedBinding,
} from './binding.js'
import {
  RouteRegistry,
  getAppRouteRegistry,
  type HttpMethod,
  type RouteMetadata,
} from './route-registry.js'

/**
 * Type for Effect-based route handlers.
 * Expected failures must be one of Honertia's typed application errors.
 */
export type EffectHandler<R = never, E extends AppError = AppError> = Effect.Effect<
  Response | Redirect,
  E,
  R
>

/**
 * Base services available in every route.
 */
export type BaseServices =
  | RequestService
  | RequestStateService
  | ResponseCacheService
  | ResponseFactoryService
  | HonertiaService
  | DatabaseService
  | AuthService
  | BindingsService
  | BoundModels
  | ValidatedBodyService
  | ValidatedQueryService

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
  params?: S.Schema.Any
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
   * Validate request body with the provided schema.
   * Automatically returns a 422 ValidationError on failure.
   */
  body?: S.Schema.Any
  /**
   * Validate query params with the provided schema.
   * Automatically returns a 422 ValidationError on failure.
   */
  query?: S.Schema.Any
  /**
   * Response schema used for type safety and OpenAPI generation.
   * Runtime validation is opt-in via validateResponse.
   */
  response?: S.Schema.Any
  /**
   * Enable/disable automatic body validation.
   * Defaults to true when a body schema is provided.
   */
  validateBody?: boolean
  /**
   * Enable/disable runtime response validation.
   * Defaults to false.
   */
  validateResponse?: boolean
  /**
   * Effect Schema ParseOptions applied to body and query validation.
   * Use `{ onExcessProperty: 'error' }` to reject request payloads that
   * carry fields the schema does not declare (mass-assignment hardening).
   */
  parseOptions?: ParseOptions
  /**
   * Cache this route's responses via Cloudflare Workers Cache.
   * Applied to successful GET/HEAD responses only; partial reloads are
   * marked no-store and HTML/JSON page objects vary on X-Inertia.
   * Requires `"cache": { "enabled": true }` in wrangler config.
   */
  cache?: RouteCacheOptions
  /**
   * After this route's effect succeeds (any Redirect, or a Response below
   * 400), purge these Workers Cache tags. `true` derives the tags from the
   * route's bindings with the same scheme used for Cache-Tag on reads, so
   * PUT /projects/{project} purges `project:{id}` and `projects`.
   */
  purges?: true | readonly string[]
}

const BODYLESS_METHODS = new Set(['GET', 'HEAD'])

/**
 * Whether the app is running in development. Used to gate developer warnings.
 * Mirrors the explicit-signal policy used elsewhere (no CF_PAGES_BRANCH).
 */
function isDevEnv<E extends Env>(c: HonoContext<E>): boolean {
  const env = c.env as Record<string, unknown> | undefined
  return env?.ENVIRONMENT === 'development' || env?.NODE_ENV === 'development'
}

function hasPrivateRequestState<E extends Env>(c: HonoContext<E>): boolean {
  const requestCtx = openHonertiaContext(c)
  return (
    requestCtx.authUser !== undefined ||
    c.req.header('Authorization') !== undefined ||
    hasSessionCookie(c.req.header('Cookie'), requestCtx.sessionCookies ?? [])
  )
}


async function parseRequestBody<E extends Env>(
  c: HonoContext<E>
): Promise<unknown> {
  const contentType = c.req.header('Content-Type') ?? ''
  const isJson = contentType.includes('application/json')

  try {
    if (isJson) {
      return await c.req.json<unknown>()
    }
    return await c.req.parseBody()
  } catch (error) {
    throw createBodyParseValidationError(error, contentType)
  }
}

async function runValidation<A>(
  effect: Effect.Effect<A, ValidationError, never>
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) {
    return exit.value
  }

  const error = Cause.failureOption(exit.cause)
  if (Option.isSome(error)) {
    throw error.value
  }

  throw Cause.squash(exit.cause)
}

/**
 * Effect Route Builder with layer composition.
 */
export class EffectRouteBuilder<
  E extends Env,
  ProvidedServices = never,
  CustomServices = never
> {
  constructor(
    private readonly app: Hono<E>,
    private readonly layers: Layer.Layer<any, never, never>[] = [],
    private readonly pathPrefix: string = '',
    private readonly bridgeConfig?: EffectBridgeConfig<E, CustomServices>,
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
    LayerReq extends BaseServices | ProvidedServices | CustomServices
  >(
    layer: Layer.Layer<S, LayerErr, LayerReq>
  ): EffectRouteBuilder<E, ProvidedServices | S, CustomServices> {
    return new EffectRouteBuilder(
      this.app,
      [...this.layers, layer as Layer.Layer<S, never, never>],
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
  ): EffectRouteBuilder<E, ProvidedServices, CustomServices> {
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
  ): EffectRouteBuilder<E, ProvidedServices, CustomServices> {
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
  prefix(path: string): EffectRouteBuilder<E, ProvidedServices, CustomServices> {
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
   * Create a nested group with the same configuration.
   */
  group(callback: (route: EffectRouteBuilder<E, ProvidedServices, CustomServices>) => void): void {
    callback(this)
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
  private async ensureParams(
    c: HonoContext<E>,
    schema?: S.Schema.Any
  ): Promise<Response | null> {
    if (!schema) return null

    const rawParams = c.req.param()
    const params: Record<string, string> =
      typeof rawParams === 'string' ? {} : rawParams

    const decode = S.decodeUnknown(schema)
    const exit = await Effect.runPromiseExit(decode(params) as Effect.Effect<unknown, unknown, never>)

    if (Exit.isFailure(exit)) {
      return c.notFound() as Response
    }

    return null
  }

  /**
   * Resolve route model bindings from the database.
   * Returns a Map of binding names to resolved models, or a 404 Response if any binding fails.
   */
  private async resolveBindings(
    c: HonoContext<E>,
    plan: readonly CompiledRouteBinding[],
    db: unknown,
  ): Promise<Map<string, unknown> | Response> {
    if (plan.length === 0) {
      return new Map()
    }

    // Dynamic import to avoid requiring drizzle-orm for non-binding users
    const { eq, and } = await import('drizzle-orm')

    const models = new Map<string, unknown>()
    const rows = new Map<string, Record<string, unknown>>()

    for (const binding of plan) {
      const rawParam = c.req.param(binding.param)
      if (!rawParam) {
        return c.notFound() as Response
      }

      const paramValue = await decodeBindingParam(binding, rawParam)
      if (paramValue === undefined) {
        return c.notFound() as Response
      }

      // QueryBuilder type compatible with all Drizzle databases (PostgreSQL, MySQL, SQLite)
      type QueryBuilder = {
        where: (c: unknown) => QueryBuilder
        limit: (n: number) => PromiseLike<unknown[]>
      }
      let whereCondition: unknown = eq(
        binding.table[binding.column] as Parameters<typeof eq>[0],
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

        const conditions: Parameters<typeof and> = [
          whereCondition as Parameters<typeof and>[number],
        ]
        for (const pair of binding.parent.relation.columnPairs) {
          const parentReferenceValue = parentRow[pair.references]
          if (parentReferenceValue === undefined || parentReferenceValue === null) {
            throw RouteConfigurationError.relationNotFound(
              binding.parent.param,
              binding.tableName,
              binding.param
            )
          }

          conditions.push(
            eq(
              binding.table[pair.foreignKey] as Parameters<typeof eq>[0],
              parentReferenceValue
            ) as Parameters<typeof and>[number]
          )
        }
        whereCondition = and(...conditions)
      }

      const dbClient = db as { select: () => { from: (t: unknown) => QueryBuilder } }
      const query: QueryBuilder = dbClient.select().from(binding.table).where(whereCondition)

      // Execute the query - use .limit(1) for cross-database compatibility
      // (PostgreSQL/MySQL don't have .get(), only SQLite does)
      const results = await query.limit(1)
      const result = results[0]

      if (!result) {
        return c.notFound() as Response
      }

      rows.set(binding.param, result as Record<string, unknown>)
      models.set(binding.param, await decodeBoundRow(binding, result))
    }

    return models
  }

  private createHandler<R extends BaseServices | ProvidedServices | CustomServices>(
    effect: EffectHandler<R, AppError>,
    bindings: ParsedBinding[],
    options?: EffectRouteOptions
  ): MiddlewareHandler<E> {
    const layers = this.layers
    const bridgeConfig = this.bridgeConfig
    let bindingPlanPromise: Promise<readonly CompiledRouteBinding[]> | undefined
    // Dev-only observability for an ineffective `cache` option:
    // once per route (this handler closure), not once per request.
    let warnedIneffectiveCache = false

    return async (c) => {
      setEffectBridgeConfig(c, bridgeConfig)

      // Get schema from bridgeConfig or from context (set by setupHonertia/effectBridge)
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

      const bodySchema = options?.body
      const querySchema = options?.query
      const shouldValidateBody = bodySchema !== undefined && (options?.validateBody ?? true)

      let validatedBody: unknown
      let validatedQuery: unknown
      let hasValidatedBody = false
      let hasValidatedQuery = false

      try {
        if (shouldValidateBody && !BODYLESS_METHODS.has(c.req.method.toUpperCase())) {
          const body = await parseRequestBody(c)
          validatedBody = await runValidation(
            validateUnknown(bodySchema as S.Schema.AnyNoContext, body, {
              parseOptions: options?.parseOptions,
            })
          )
          hasValidatedBody = true
        }

        if (querySchema) {
          const query = c.req.query()
          validatedQuery = await runValidation(
            validateUnknown(querySchema as S.Schema.AnyNoContext, query, {
              parseOptions: options?.parseOptions,
            })
          )
          hasValidatedQuery = true
        }
      } catch (error) {
        if (error instanceof ValidationError) {
          return await errorToResponse(error, c)
        }
        throw error
      }

      // Build context layer from Hono context
      const requestRuntime = getEffectRuntime(c)
      let contextLayer = requestRuntime
        ? Layer.succeedContext((await requestRuntime.runtime()).context)
        : buildContextLayer(c, bridgeConfig ?? getEffectBridgeConfig(c))
      if (requestRuntime && bridgeConfig?.services) {
        contextLayer = Layer.merge(contextLayer, bridgeConfig.services(c))
      }

      // Resolve route model bindings if we have any and schema is configured
      let boundModelsLayer: Layer.Layer<BoundModels, never, never>
      let boundModels: ReadonlyMap<string, unknown> = new Map()

      if (bindings.length > 0 && schema && configuredBindings) {
        const db = openHonertiaContext(c).db
        if (!db) {
          // A binding cannot be resolved without a database; this is
          // misconfiguration, not a missing row. Thrown to Hono's onError,
          // which renders the structured configuration error.
          throw HonertiaConfigurationError.databaseNotConfigured()
        }

        bindingPlanPromise ??= compileBindingPlan(bindings, schema, configuredBindings)
        const plan = await bindingPlanPromise
        const result = await this.resolveBindings(c, plan, db)
        if (result instanceof Response) {
          return result
        }

        boundModels = result as ReadonlyMap<string, unknown>
        boundModelsLayer = Layer.succeed(BoundModels, boundModels)
      } else if (bindings.length > 0 && !schema) {
        // Bindings exist but no schema - provide a map that signals this for better errors
        const unconfiguredMap = new Map<string, unknown>()
        unconfiguredMap.set('__schema_not_configured__', true)
        boundModelsLayer = Layer.succeed(BoundModels, unconfiguredMap as ReadonlyMap<string, unknown>)
      } else if (bindings.length > 0) {
        throw RouteConfigurationError.bindingParserNotConfigured(bindings[0].param)
      } else {
        // No bindings - empty bound models
        boundModelsLayer = Layer.succeed(BoundModels, new Map() as ReadonlyMap<string, unknown>)
      }

      // Combine with provided layers
      let fullLayer: Layer.Layer<any, never, never> = Layer.merge(contextLayer, boundModelsLayer)
      if (hasValidatedBody) {
        fullLayer = Layer.merge(
          fullLayer,
          Layer.succeed(ValidatedBodyService, validatedBody as any)
        )
      }
      if (hasValidatedQuery) {
        fullLayer = Layer.merge(
          fullLayer,
          Layer.succeed(ValidatedQueryService, validatedQuery as any)
        )
      }
      for (const layer of layers) {
        fullLayer = Layer.provideMerge(layer, fullLayer)
      }

      // After a successful mutation, purge the declared Workers Cache tags.
      // Runs inside the effect so a failed purge surfaces in the typed error
      // channel instead of leaving stale entries silently.
      const purges = options?.purges
      let handlerEffect: Effect.Effect<Response | Redirect, unknown, unknown> =
        effect as Effect.Effect<Response | Redirect, unknown, unknown>
      if (purges) {
        handlerEffect = handlerEffect.pipe(
          Effect.tap((result) => {
            const succeeded =
              result instanceof Redirect ||
              (result instanceof Response && result.status < 400)
            if (!succeeded) return Effect.void

            const tags =
              purges === true ? deriveCacheTags(bindings, boundModels) : purges
            if (tags.length === 0) return Effect.void

            const preparedTags = prepareCachePurgeTags(tags)
            if (preparedTags._tag === 'invalid') {
              return Effect.fail(
                new ResponseCachePurgeError({
                  input: { tags },
                  cause: {
                    _tag: 'InvalidCacheTags',
                    reason: preparedTags.reason,
                  },
                })
              )
            }

            return Effect.flatMap(ResponseCacheService, (cache) =>
              cache.purge({ tags: preparedTags.tags })
            )
          })
        )
      }

      // The route runtime owns every provided Layer until background work has
      // settled, including scoped services added with route.provide().
      const routeRuntime = ManagedRuntime.make(fullLayer)
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
        derivedTags: deriveCacheTags(bindings, boundModels),
        options: options.cache,
      })

      if (
        decision._tag === 'skip' &&
        decision.warning &&
        !warnedIneffectiveCache &&
        isDevEnv(c)
      ) {
        warnedIneffectiveCache = true
        console.warn(`[honertia] Route '${c.req.path}' ${decision.warning}`)
      }

      return applyCachePolicy(response, decision)
    }
  }

  /**
   * Register a route with the given HTTP method.
   * Parses Laravel-style bindings and converts to Hono path format.
   */
  private registerRoute<R extends BaseServices | ProvidedServices | CustomServices>(
    method: HttpMethod,
    path: string,
    effect: EffectHandler<R, AppError>,
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
      paramsSchema: options?.params,
      bodySchema: options?.body,
      querySchema: options?.query,
      responseSchema: options?.response,
      prefix: this.pathPrefix,
      name: options?.name,
    }
    this.registry.register(metadata)

    // Register with Hono - apply middlewares before the Effect handler
    const handler = this.createHandler(effect, bindings, options)
    if (this.middlewares.length > 0) {
      // Use type assertion for dynamic method with spread middlewares
      ;(this.app[method] as (path: string, ...handlers: MiddlewareHandler<E>[]) => void)(
        fullPath,
        ...this.middlewares,
        handler
      )
    } else {
      this.app[method](fullPath, handler)
    }
  }

  /** Register a GET route. Supports Laravel-style route model binding: /projects/{project} */
  get<R extends BaseServices | ProvidedServices | CustomServices>(
    path: string,
    effect: EffectHandler<R, AppError>,
    options?: EffectRouteOptions
  ): void {
    this.registerRoute('get', path, effect, options)
  }

  /** Register a POST route. Supports Laravel-style route model binding: /projects/{project} */
  post<R extends BaseServices | ProvidedServices | CustomServices>(
    path: string,
    effect: EffectHandler<R, AppError>,
    options?: EffectRouteOptions
  ): void {
    this.registerRoute('post', path, effect, options)
  }

  /** Register a PUT route. Supports Laravel-style route model binding: /projects/{project} */
  put<R extends BaseServices | ProvidedServices | CustomServices>(
    path: string,
    effect: EffectHandler<R, AppError>,
    options?: EffectRouteOptions
  ): void {
    this.registerRoute('put', path, effect, options)
  }

  /** Register a PATCH route. Supports Laravel-style route model binding: /projects/{project} */
  patch<R extends BaseServices | ProvidedServices | CustomServices>(
    path: string,
    effect: EffectHandler<R, AppError>,
    options?: EffectRouteOptions
  ): void {
    this.registerRoute('patch', path, effect, options)
  }

  /** Register a DELETE route. Supports Laravel-style route model binding: /projects/{project} */
  delete<R extends BaseServices | ProvidedServices | CustomServices>(
    path: string,
    effect: EffectHandler<R, AppError>,
    options?: EffectRouteOptions
  ): void {
    this.registerRoute('delete', path, effect, options)
  }

  /** Register a route for all HTTP methods. Supports Laravel-style route model binding: /projects/{project} */
  all<R extends BaseServices | ProvidedServices | CustomServices>(
    path: string,
    effect: EffectHandler<R, AppError>,
    options?: EffectRouteOptions
  ): void {
    this.registerRoute('all', path, effect, options)
  }

  /**
   * Get the route registry for this builder.
   * Useful for introspection, CLI tooling, and testing.
   */
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
 * Create an Effect route builder for an app.
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
): EffectRouteBuilder<E, never, CustomServices> {
  const registry = config?.registry ?? getAppRouteRegistry(app)
  return new EffectRouteBuilder(app, [], '', config, registry)
}
