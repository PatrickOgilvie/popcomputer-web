/**
 * Effect Route Builder
 *
 * Laravel-style routing with Effect handlers.
 */

import { Cause, Effect, Exit, Layer, Option, Schema as S } from 'effect'
import type { Context as HonoContext, Hono, MiddlewareHandler, Env } from 'hono'
import { effectHandler, errorToResponse } from './handler.js'
import {
  buildContextLayer,
  getEffectRuntime,
  getEffectSchema,
  isUnconfiguredService,
  setEffectBridgeConfig,
  type EffectBridgeConfig,
} from './bridge.js'
import {
  type AppError,
  Redirect,
  ValidationError,
} from './errors.js'
import {
  DatabaseService,
  AuthService,
  HonertiaService,
  RequestService,
  ResponseFactoryService,
  BindingsService,
} from './services.js'
import { ValidatedBodyService, ValidatedQueryService } from './validated-services.js'
import { createBodyParseValidationError, validateUnknown } from './validation.js'
import {
  parseBindings,
  toHonoPath,
  pluralize,
  findRelation,
  BoundModels,
  inferParamsSchema,
  type ParsedBinding,
} from './binding.js'
import {
  RouteRegistry,
  getGlobalRegistry,
  type HttpMethod,
  type RouteMetadata,
} from './route-registry.js'

/**
 * Type for Effect-based route handlers.
 * Error type includes Error for compatibility with Effect.tryPromise.
 */
export type EffectHandler<R = never, E extends AppError | Error = AppError | Error> = Effect.Effect<
  Response | Redirect,
  E,
  R
>

/**
 * Base services available in every route.
 */
export type BaseServices =
  | RequestService
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
}

const BODYLESS_METHODS = new Set(['GET', 'HEAD'])

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

async function hydrateRequestDb<E extends Env>(c: HonoContext<E>): Promise<void> {
  const runtime = getEffectRuntime(c)
  if (!runtime) return

  const maybeDb = await runtime.runPromise(Effect.serviceOption(DatabaseService))
  if (Option.isSome(maybeDb) && !isUnconfiguredService(maybeDb.value)) {
    c.set('db' as any, maybeDb.value)
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
    private readonly registry: RouteRegistry = getGlobalRegistry(),
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
    bindings: ParsedBinding[],
    db: unknown,
    schema: Record<string, unknown>
  ): Promise<Map<string, unknown> | Response> {
    if (bindings.length === 0) {
      return new Map()
    }

    // Dynamic import to avoid requiring drizzle-orm for non-binding users
    const { eq, and } = await import('drizzle-orm')

    const models = new Map<string, unknown>()
    let parent: { tableName: string; model: Record<string, unknown> } | null = null

    for (const binding of bindings) {
      const tableName = pluralize(binding.param)
      const table = schema[tableName] as Record<string, unknown> | undefined

      if (!table) {
        return c.notFound() as Response
      }

      const paramValue = c.req.param(binding.param)
      if (!paramValue) {
        return c.notFound() as Response
      }

      // Build query with primary lookup
      const column = table[binding.column]
      if (!column) {
        return c.notFound() as Response
      }

      // QueryBuilder type compatible with all Drizzle databases (PostgreSQL, MySQL, SQLite)
      type QueryBuilder = {
        where: (c: unknown) => QueryBuilder
        limit: (n: number) => PromiseLike<unknown[]>
      }
      let whereCondition: unknown = eq(column as Parameters<typeof eq>[0], paramValue)

      // If we have a parent, try to scope the query
      if (parent) {
        const relation = findRelation(schema, tableName, parent.tableName)
        if (relation) {
          const foreignKeyColumn = table[relation.foreignKey]
          const parentReferenceValue = parent.model[relation.references]
          if (
            foreignKeyColumn &&
            parentReferenceValue !== undefined &&
            parentReferenceValue !== null
          ) {
            whereCondition = and(
              whereCondition as Parameters<typeof and>[0],
              eq(
                foreignKeyColumn as Parameters<typeof eq>[0],
                parentReferenceValue
              ) as Parameters<typeof and>[1]
            )
          }
        }
      }

      const dbClient = db as { select: () => { from: (t: unknown) => QueryBuilder } }
      const query: QueryBuilder = dbClient.select().from(table).where(whereCondition)

      // Execute the query - use .limit(1) for cross-database compatibility
      // (PostgreSQL/MySQL don't have .get(), only SQLite does)
      const results = await query.limit(1)
      const result = results[0]

      if (!result) {
        return c.notFound() as Response
      }

      models.set(binding.param, result)
      parent = { tableName, model: result as Record<string, unknown> }
    }

    return models
  }

  private createHandler<R extends BaseServices | ProvidedServices | CustomServices>(
    effect: EffectHandler<R, AppError | Error>,
    bindings: ParsedBinding[],
    options?: EffectRouteOptions
  ): MiddlewareHandler<E> {
    const layers = this.layers
    const bridgeConfig = this.bridgeConfig

    return async (c) => {
      setEffectBridgeConfig(c, bridgeConfig)

      // Get schema from bridgeConfig or from context (set by setupHonertia/effectBridge)
      const schema = bridgeConfig?.schema ?? getEffectSchema(c)

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
            validateUnknown(bodySchema as S.Schema.AnyNoContext, body)
          )
          hasValidatedBody = true
        }

        if (querySchema) {
          const query = c.req.query()
          validatedQuery = await runValidation(
            validateUnknown(querySchema as S.Schema.AnyNoContext, query)
          )
          hasValidatedQuery = true
        }
      } catch (error) {
        if (error instanceof ValidationError) {
          return await errorToResponse(error, c)
        }
        throw error
      }

      await hydrateRequestDb(c)

      // Build context layer from Hono context
      const contextLayer = buildContextLayer(c, bridgeConfig)

      // Resolve route model bindings if we have any and schema is configured
      let boundModelsLayer: Layer.Layer<BoundModels, never, never>

      if (bindings.length > 0 && schema) {
        const db = (c as { var?: { db?: unknown } }).var?.db
        if (!db) {
          return c.notFound() as Response
        }

        const result = await this.resolveBindings(c, bindings, db, schema)
        if (result instanceof Response) {
          return result
        }

        boundModelsLayer = Layer.succeed(BoundModels, result as ReadonlyMap<string, unknown>)
      } else if (bindings.length > 0 && !schema) {
        // Bindings exist but no schema - provide a map that signals this for better errors
        const unconfiguredMap = new Map<string, unknown>()
        unconfiguredMap.set('__schema_not_configured__', true)
        boundModelsLayer = Layer.succeed(BoundModels, unconfiguredMap as ReadonlyMap<string, unknown>)
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

      // Run the effect with the combined layer
      const program = effect.pipe(Effect.provide(fullLayer))

      // Use the handler
      return effectHandler<E, never, AppError>(program as any)(c, async () => {})
    }
  }

  /**
   * Register a route with the given HTTP method.
   * Parses Laravel-style bindings and converts to Hono path format.
   */
  private registerRoute<R extends BaseServices | ProvidedServices | CustomServices>(
    method: HttpMethod,
    path: string,
    effect: EffectHandler<R, AppError | Error>,
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
    effect: EffectHandler<R, AppError | Error>,
    options?: EffectRouteOptions
  ): void {
    this.registerRoute('get', path, effect, options)
  }

  /** Register a POST route. Supports Laravel-style route model binding: /projects/{project} */
  post<R extends BaseServices | ProvidedServices | CustomServices>(
    path: string,
    effect: EffectHandler<R, AppError | Error>,
    options?: EffectRouteOptions
  ): void {
    this.registerRoute('post', path, effect, options)
  }

  /** Register a PUT route. Supports Laravel-style route model binding: /projects/{project} */
  put<R extends BaseServices | ProvidedServices | CustomServices>(
    path: string,
    effect: EffectHandler<R, AppError | Error>,
    options?: EffectRouteOptions
  ): void {
    this.registerRoute('put', path, effect, options)
  }

  /** Register a PATCH route. Supports Laravel-style route model binding: /projects/{project} */
  patch<R extends BaseServices | ProvidedServices | CustomServices>(
    path: string,
    effect: EffectHandler<R, AppError | Error>,
    options?: EffectRouteOptions
  ): void {
    this.registerRoute('patch', path, effect, options)
  }

  /** Register a DELETE route. Supports Laravel-style route model binding: /projects/{project} */
  delete<R extends BaseServices | ProvidedServices | CustomServices>(
    path: string,
    effect: EffectHandler<R, AppError | Error>,
    options?: EffectRouteOptions
  ): void {
    this.registerRoute('delete', path, effect, options)
  }

  /** Register a route for all HTTP methods. Supports Laravel-style route model binding: /projects/{project} */
  all<R extends BaseServices | ProvidedServices | CustomServices>(
    path: string,
    effect: EffectHandler<R, AppError | Error>,
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
   * Defaults to the global registry.
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
  const registry = config?.registry ?? getGlobalRegistry()
  return new EffectRouteBuilder(app, [], '', config, registry)
}
