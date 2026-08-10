/**
 * Hono-Effect Bridge
 *
 * Middleware that connects Hono's request handling to Effect's runtime.
 */

import { Cause, Effect, Layer, ManagedRuntime, Option } from 'effect'
import type { Context as HonoContext, MiddlewareHandler, Env } from 'hono'
import { openHonertiaContext } from '../request-context.js'
import {
  ResponseCacheService,
  createWorkersResponseCacheClient,
  createUnavailableResponseCacheClient,
  resolveWorkersCachePurgeApi,
} from './response-cache.js'
import {
  DatabaseService,
  AuthService,
  AuthUserService,
  PageService,
  RequestService,
  RequestStateService,
  ResponseFactoryService,
  BindingsService,
  CacheService,
  CacheClientError,
  ExecutionContextService,
  type RequestContext,
  type RequestStateClient,
  type ResponseFactory,
  type PageRenderer,
  type CacheClient,
  type ExecutionContextClient,
  type BindingsType,
} from './services.js'
import { TestCaptureService } from './test-layers.js'
import type { RouteBindingsConfig } from './binding.js'
import { observeEffectErrorEvent } from './error-observer.js'

/**
 * Configuration for the Effect bridge.
 *
 * @typeParam E - Hono environment type
 * @typeParam CustomServices - Custom services provided via the `services` option
 *
 * @example
 * // Provide Cloudflare Worker bindings as a service
 * effectBridge<Env, BindingsService>({
 *   services: (c) => Layer.succeed(BindingsService, c.env),
 * })
 *
 * @example
 * // Provide multiple custom services
 * effectBridge<Env, BindingsService | LoggerService>({
 *   services: (c) => Layer.mergeAll(
 *     Layer.succeed(BindingsService, c.env),
 *     Layer.succeed(LoggerService, createLogger(c)),
 *   ),
 * })
 */
export interface EffectBridgeConfig<E extends Env, CustomServices = never> {
  /**
   * Custom services to provide to all Effect handlers.
   * Return a Layer that provides your custom services.
   */
  services?: (c: HonoContext<E>) => Layer.Layer<CustomServices, never, never>
  /**
   * Drizzle schema for route model binding.
   * Usually configured via `setupHonertia(app, { honertia: { schema } })`.
   * Can also be passed here for standalone effectBridge usage.
   */
  schema?: Record<string, unknown>
  /** Row parsers and optional scope metadata for route-model bindings. */
  bindings?: RouteBindingsConfig
}

// Unconfigured services are simply not provided to the Effect layer. When a
// handler yields a tag that was never configured, Effect dies with a
// missing-service defect that handler.ts classifies into the structured
// HonertiaConfigurationError response (see classifyMissingService).
// The per-request runtime, bridge config, and binding schema live in the
// typed request context (see request-context.ts).

/**
 * Create a RequestContext from Hono context.
 */
function createRequestContext<E extends Env>(c: HonoContext<E>): RequestContext {
  return {
    method: c.req.method,
    url: c.req.url,
    headers: c.req.raw.headers,
    env: (c.env ?? {}) as Record<string, unknown>,
    param: (name: string) => c.req.param(name),
    params: () => {
      const params = c.req.param()
      return typeof params === 'string' ? {} : params
    },
    query: () => c.req.query(),
    json: <T>() => c.req.json<T>(),
    parseBody: () => c.req.parseBody() as Promise<Record<string, unknown>>,
    header: (name: string) => c.req.header(name),
  }
}

/**
 * Create a RequestStateClient backed by Hono context variables.
 * Values are shared with Hono middleware through c.set / c.var.
 */
function createRequestStateClient<E extends Env>(c: HonoContext<E>): RequestStateClient {
  return {
    // Arbitrary keys are not represented in Hono's ContextVariableMap typing,
    // so reads and writes go through the untyped context surface.
    get: <T>(key: string) =>
      ((c.var as Record<string, unknown> | undefined)?.[key]) as T | undefined,
    set: (key: string, value: unknown) => {
      ;(c as { set: (key: string, value: unknown) => void }).set(key, value)
    },
  }
}

/**
 * Create a ResponseFactory from Hono context.
 */
function createResponseFactory<E extends Env>(c: HonoContext<E>): ResponseFactory {
  return {
    redirect: (url: string, status = 302) => c.redirect(url, status as 301 | 302 | 303 | 307 | 308),
    json: <T>(data: T, status = 200) => c.json(data, status as any),
    text: (data: string, status = 200) => c.text(data, status as any),
    notFound: () => c.notFound(),
  }
}

/**
 * Cloudflare KV Namespace interface (subset of the full API).
 */
interface KVNamespace {
  get(key: string, options?: { type?: 'text' }): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>
    list_complete: boolean
    cursor?: string
  }>
}

/**
 * Create a CacheClient from Cloudflare KV binding.
 */
function createKVCacheClient(kv: KVNamespace): CacheClient {
  return {
    get: (key) =>
      Effect.tryPromise({
        try: () => kv.get(key),
        catch: (e) => new CacheClientError('Failed to get from cache', e),
      }),
    put: (key, value, options) =>
      Effect.tryPromise({
        try: () => kv.put(key, value, options),
        catch: (e) => new CacheClientError('Failed to set cache', e),
      }),
    delete: (key) =>
      Effect.tryPromise({
        try: () => kv.delete(key),
        catch: (e) => new CacheClientError('Failed to delete from cache', e),
      }),
    list: (options) =>
      Effect.tryPromise({
        try: () => kv.list(options),
        catch: (e) => new CacheClientError('Failed to list cache keys', e),
      }),
  }
}

/**
 * Create a no-op CacheClient that fails with helpful errors when KV is not configured.
 */
function createUnconfiguredCacheClient(): CacheClient {
  const error = new CacheClientError(
    'CacheService requires KV binding. Add KV to your wrangler.toml and ensure it is available in c.env.KV'
  )
  return {
    get: () => Effect.fail(error),
    put: () => Effect.fail(error),
    delete: () => Effect.fail(error),
    list: () => Effect.fail(error),
  }
}

/**
 * Cloudflare ExecutionContext interface (subset of the full API).
 */
interface CloudflareExecutionContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException(): void
}

/**
 * Create an ExecutionContextClient from Cloudflare's ExecutionContext.
 */
function makeObservedBackground<A, E, R>(
  operation: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<void, never, R> {
  return effect.pipe(
    Effect.asVoid,
    Effect.catchAllCause((cause) =>
      observeEffectErrorEvent({
        source: 'framework',
        handling: 'unhandled',
        kind: Option.isSome(Cause.failureOption(cause)) ? 'failure' : 'defect',
        error: Cause.squash(cause),
        metadata: { operation },
      })
    )
  )
}

interface BackgroundSupervisor {
  readonly client: ExecutionContextClient
  readonly hasPending: () => boolean
  readonly drain: () => Promise<void>
}

/**
 * Dispose a request runtime only after its owned background work settles.
 *
 * Worker runtimes hand the drain and disposal promise to `waitUntil`; inline
 * runtimes await completion before releasing scoped services.
 */
export async function disposeRequestRuntime<E extends Env, R>(
  c: HonoContext<E>,
  runtime: ManagedRuntime.ManagedRuntime<R, never>
): Promise<void> {
  const supervisor = openHonertiaContext(c).backgroundSupervisor
  if (supervisor?.hasPending() && supervisor.client.isAvailable) {
    supervisor.client.waitUntil(
      supervisor.drain().then(() => runtime.dispose())
    )
    return
  }

  await supervisor?.drain()
  await runtime.dispose()
}

function createExecutionContextSupervisor(
  ctx: CloudflareExecutionContext
): BackgroundSupervisor {
  const pending = new Set<Promise<void>>()

  const schedule = <A, E, R>(
    operation: string,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<void, never, R> =>
    Effect.flatMap(Effect.context<R>(), (context) =>
      Effect.sync(() => {
        const running = Effect.runPromise(
          makeObservedBackground(operation, effect).pipe(Effect.provide(context))
        )
        let tracked: Promise<void>
        tracked = running.then(() => {
          pending.delete(tracked)
        })
        pending.add(tracked)
        ctx.waitUntil(tracked)
      })
    )

  const client: ExecutionContextClient = {
    isAvailable: true,
    waitUntil: (promise) => ctx.waitUntil(promise),
    runInBackground: (effect) => schedule('background', effect),
    schedule,
  }

  return {
    client,
    hasPending: () => pending.size > 0,
    drain: async () => {
      while (pending.size > 0) {
        await Promise.allSettled([...pending])
      }
    },
  }
}

/**
 * Create a no-op ExecutionContextClient for environments without ExecutionContext.
 */
function createInlineExecutionContextSupervisor(): BackgroundSupervisor {
  const client: ExecutionContextClient = {
    isAvailable: false,
    waitUntil: () => {
      // No-op - silently ignore in non-Worker environments
    },
    runInBackground: (effect) => makeObservedBackground('background', effect),
    schedule: (operation, effect) => makeObservedBackground(operation, effect),
  }
  return {
    client,
    hasPending: () => false,
    drain: async () => {},
  }
}

/**
 * Create a PageRenderer from Hono context.
 */
function createPageRenderer<E extends Env>(c: HonoContext<E>): PageRenderer {
  const requestContext = openHonertiaContext(c)
  const page = requestContext.web ?? requestContext.honertia
  if (!page) {
    return {
      render: async () => c.text('@popcomputer/web is not configured', 500),
      share: () => {},
      setErrors: () => {},
    }
  }
  return {
    render: (component, props) => Promise.resolve(page.render(component, props)),
    share: (key, value) => page.share(key, value),
    setErrors: (errors) => page.setErrors(errors),
  }
}

/**
 * Build the Effect layer from Hono context.
 */
export function buildContextLayer<E extends Env, CustomServices = never>(
  c: HonoContext<E>,
  config?: EffectBridgeConfig<E, CustomServices>
): Layer.Layer<
  | RequestService
  | RequestStateService
  | ResponseFactoryService
  | PageService
  | DatabaseService
  | AuthService
  | AuthUserService
  | BindingsService
  | CacheService
  | ExecutionContextService
  | CustomServices,
  never,
  never
> {
  const requestLayer = Layer.succeed(RequestService, createRequestContext(c))
  const requestStateLayer = Layer.succeed(
    RequestStateService,
    createRequestStateClient(c)
  )
  const responseLayer = Layer.succeed(ResponseFactoryService, createResponseFactory(c))
  const pageLayer = Layer.succeed(PageService, createPageRenderer(c))

  // Bindings layer - always available, typed via module augmentation
  const bindingsLayer = Layer.succeed(
    BindingsService,
    (c.env ?? {}) as BindingsType
  )

  // Cache layer - backed by KV if available, otherwise unconfigured client
  const kv = (c.env as { KV?: KVNamespace } | undefined)?.KV
  const cacheLayer = Layer.succeed(
    CacheService,
    kv ? createKVCacheClient(kv) : createUnconfiguredCacheClient()
  )

  // Database and auth come from the typed request context (written by
  // setupHonertia's service wiring or the honertiaServices middleware).
  // They are provided IFF configured; absence surfaces as a missing-service
  // defect that handler.ts classifies into a configuration error.
  const requestCtx = openHonertiaContext(c)

  // ExecutionContext layer - for background task execution
  // Note: Hono's executionCtx getter throws in non-Worker environments, so we wrap in try/catch
  let executionCtx: CloudflareExecutionContext | undefined
  try {
    executionCtx = (c as any).executionCtx
  } catch {
    executionCtx = undefined
  }
  const backgroundSupervisor = requestCtx.backgroundSupervisor ?? (
    executionCtx
      ? createExecutionContextSupervisor(executionCtx)
      : createInlineExecutionContextSupervisor()
  )
  requestCtx.backgroundSupervisor = backgroundSupervisor
  const executionContextLayer = Layer.succeed(
    ExecutionContextService,
    backgroundSupervisor.client
  )

  // Workers Cache purge API: probes ctx.cache, then the cloudflare:workers
  // module export; unavailable (no-op purge, isAvailable: false) elsewhere.
  const responseCacheLayer = Layer.effect(
    ResponseCacheService,
    resolveWorkersCachePurgeApi(executionCtx).pipe(
      Effect.map((api) =>
        api
          ? createWorkersResponseCacheClient(api)
          : createUnavailableResponseCacheClient()
      )
    )
  )

  let baseLayer: Layer.Layer<any, never, never> = Layer.mergeAll(
    requestLayer,
    requestStateLayer,
    responseLayer,
    pageLayer,
    bindingsLayer,
    cacheLayer,
    executionContextLayer,
    responseCacheLayer
  )

  if (requestCtx.db !== undefined) {
    baseLayer = Layer.merge(baseLayer, Layer.succeed(DatabaseService, requestCtx.db))
  }
  if (requestCtx.auth !== undefined) {
    baseLayer = Layer.merge(baseLayer, Layer.succeed(AuthService, requestCtx.auth))
  }

  if (requestCtx.authUser !== undefined) {
    baseLayer = Layer.merge(
      baseLayer,
      Layer.succeed(AuthUserService, requestCtx.authUser)
    )
  }

  // Merge custom services if provided
  if (config?.services) {
    const customServicesLayer = config.services(c)
    baseLayer = Layer.merge(baseLayer, customServicesLayer)
  }

  return baseLayer as Layer.Layer<
    | RequestService
    | RequestStateService
    | ResponseFactoryService
    | PageService
    | BindingsService
    | CacheService
    | ExecutionContextService
    | DatabaseService
    | AuthService
    | AuthUserService
    | CustomServices,
    never,
    never
  >
}

/**
 * Get the per-request Effect runtime (set by effectBridge).
 */
export function getEffectRuntime<E extends Env>(
  c: HonoContext<E>
): ManagedRuntime.ManagedRuntime<any, never> | undefined {
  return openHonertiaContext(c).runtime
}

/**
 * Store the Effect bridge config on the request context for downstream handlers.
 */
export function setEffectBridgeConfig<E extends Env, CustomServices = never>(
  c: HonoContext<E>,
  config?: EffectBridgeConfig<E, CustomServices>
): void {
  if (!config) return
  openHonertiaContext(c).bridgeConfig = config as EffectBridgeConfig<E, unknown>
}

/**
 * Get the Effect bridge config from the request context.
 */
export function getEffectBridgeConfig<E extends Env>(
  c: HonoContext<E>
): EffectBridgeConfig<any, any> | undefined {
  return openHonertiaContext(c).bridgeConfig as EffectBridgeConfig<any, any> | undefined
}

/**
 * Middleware that sets up the Effect runtime for each request.
 */
export function effectBridge<E extends Env, CustomServices = never>(
  config?: EffectBridgeConfig<E, CustomServices>
): MiddlewareHandler<E> {
  return async (c, next) => {
    // SAFETY: test-layer injection seam used by @popcomputer/web/test (see
    // test-layers.ts). Deliberately untyped and unchanged for now; making it
    // a construction-time config option is tracked as a follow-up.
    const testLayer =
      (c as any).var?.__testLayer ?? (c.env as Record<string, unknown> | undefined)?.__testLayer
    const hasTestLayer = Layer.isLayer(testLayer)
    setEffectBridgeConfig(c, config)
    let layer = buildContextLayer(c, config)
    if (hasTestLayer) {
      layer = Layer.merge(layer, testLayer as Layer.Layer<any, never, never>)
    }
    const runtime = ManagedRuntime.make(layer)

    // Store runtime and binding schema on the request context
    const requestCtx = openHonertiaContext(c)
    requestCtx.runtime = runtime
    if (config?.schema) {
      requestCtx.schema = config.schema
    }
    if (config?.bindings) {
      requestCtx.bindings = config.bindings
    }

    try {
      await next()
    } finally {
      if (hasTestLayer) {
        try {
          const maybeCapture = await runtime.runPromise(
            Effect.serviceOption(TestCaptureService)
          )
          if (Option.isSome(maybeCapture)) {
            const captures = await runtime.runPromise(maybeCapture.value.get())
            const response = (c as any).res
            if (response) {
              ;(response as any).__testCaptured = captures
            }
          }
        } catch {
          // Ignore capture errors during tests
        }
      }
      await disposeRequestRuntime(c, runtime)
    }

    // Return response for proper propagation in forwarding/proxy scenarios
    return c.res
  }
}

/**
 * Get the binding schema from the request context (set by effectBridge).
 */
export function getEffectSchema<E extends Env>(
  c: HonoContext<E>
): Record<string, unknown> | undefined {
  return openHonertiaContext(c).schema
}

/** Get the route-model binding configuration from the request context. */
export function getEffectBindings<E extends Env>(
  c: HonoContext<E>
): RouteBindingsConfig | undefined {
  return openHonertiaContext(c).bindings
}
