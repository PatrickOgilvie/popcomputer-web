/**
 * Hono-Effect Bridge
 *
 * Middleware that connects Hono's request handling to Effect's runtime.
 */

import { Cause, Effect, Layer, ManagedRuntime, Option, Schema as S } from 'effect'
import type { Context as HonoContext, MiddlewareHandler, Env } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { WebRequestContext } from '../request-context.js'
import { openHonertiaContext } from '../request-context.js'
import {
  ResponseCacheService,
  createWorkersResponseCacheClient,
  createUnavailableResponseCacheClient,
  resolveWorkersCachePurgeApi,
  type WorkersCachePurgeApi,
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
import { setResponseTestCaptures } from './test-capture-store.js'
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
  schema?: object
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
function createRequestContext<E extends Env>(
  c: HonoContext<E>
): RequestContext<NonNullable<E['Bindings']>> {
  // SAFETY: Hono supplies c.env from the route Env; the empty object is used only when that optional binding bag is absent.
  const env = (c.env ?? {}) as NonNullable<E['Bindings']>

  return {
    method: c.req.method,
    url: c.req.url,
    headers: c.req.raw.headers,
    env,
    param: (name: string) => c.req.param(name),
    params: () => {
      const params = c.req.param()

      return S.is(S.String)(params) ? {} : params
    },
    query: () => c.req.query(),
    json: <T>() => c.req.json<T>(),
    parseBody: () => c.req.parseBody(),
    header: (name: string) => c.req.header(name),
  }
}

/**
 * Create a RequestStateClient backed by Hono context variables.
 * Values are shared with Hono middleware through c.set / c.var.
 */
function createRequestStateClient<E extends Env>(c: HonoContext<E>): RequestStateClient {
  // SAFETY: The Hono adapter has already constrained this value at the request boundary; this assertion bridges an overload its generic context cannot retain.
  return {
    // Arbitrary keys are not represented in Hono's ContextVariableMap typing,
    // so reads and writes go through the untyped context surface.
    get: <T>(key: string) => {
      // SAFETY: This client is the sole adapter for values written through the matching generic set method during the same request.
      return Object.getOwnPropertyDescriptor(c.var, key)?.value as T | undefined
    },
    set: <Value>(key: string, value: Value) => {
      // SAFETY: Hono stores arbitrary request-local values at runtime; this adapter confines that untyped surface behind RequestStateClient.
      const writableContext = c as {
        set: <StoredValue>(key: string, value: StoredValue) => void
      }

      writableContext.set(key, value)
    },
  }
}

/**
 * Create a ResponseFactory from Hono context.
 */
function createResponseFactory<E extends Env>(c: HonoContext<E>): ResponseFactory {
  // SAFETY: The Hono adapter has already constrained this value at the request boundary; this assertion bridges an overload its generic context cannot retain.
  return {
    redirect: (url: string, status = 302) => c.redirect(url, status as 301 | 302 | 303 | 307 | 308),
    json: <T>(data: T, status = 200) => c.json(data, status as ContentfulStatusCode),
    text: (data: string, status = 200) => c.text(data, status as ContentfulStatusCode),
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
  readonly cache?: WorkersCachePurgeApi
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
    Effect.catchCause((cause) =>
      observeEffectErrorEvent({
        source: 'framework',
        handling: 'unhandled',
        kind: Option.isSome(Cause.findErrorOption(cause)) ? 'failure' : 'defect',
        error: Cause.squash(cause),
        metadata: { operation },
      })
    )
  )
}

/** Request-owned coordinator for Effect and external background work. */
export interface BackgroundSupervisor {
  readonly client: ExecutionContextClient
  readonly hasPending: () => boolean
  readonly extendLifetime: (promise: Promise<unknown>) => void
  readonly drain: <R, RuntimeError>(
    runtime?: ManagedRuntime.ManagedRuntime<R, RuntimeError>
  ) => Promise<void>
}

/**
 * Dispose a request runtime only after its owned background work settles.
 *
 * Worker runtimes hand the drain and disposal promise to `waitUntil`; inline
 * runtimes await completion before releasing scoped services.
 */
// oxlint-disable-next-line effecttsgo/async-function -- This Hono/Worker runtime boundary owns native background promises and completes teardown before releasing the request runtime.
export async function disposeRequestRuntime<E extends Env, R, RuntimeError>(
  c: HonoContext<E>,
  runtime: ManagedRuntime.ManagedRuntime<R, RuntimeError>
): Promise<void> {
  const supervisor = openHonertiaContext(c).backgroundSupervisor

  if (supervisor?.hasPending() && supervisor.client.isAvailable) {
    supervisor.extendLifetime(
      supervisor.drain(runtime).then(() => runtime.dispose())
    )

    return
  }

  await supervisor?.drain(runtime)
  await runtime.dispose()
}

/**
 * Finish background promises when outer middleware exits before the Effect
 * bridge can own request teardown.
 */
// oxlint-disable-next-line effecttsgo/async-function -- This Hono/Worker runtime boundary owns native background promises and completes teardown before releasing the request runtime.
export async function drainRequestBackground<E extends Env>(
  c: HonoContext<E>
): Promise<void> {
  const supervisor = openHonertiaContext(c).backgroundSupervisor

  if (!supervisor?.hasPending()) return

  const draining = supervisor.drain()

  if (supervisor.client.isAvailable) {
    supervisor.extendLifetime(draining)

    return
  }

  await draining
}

function createExternalPromiseTracker() {
  const pending = new Set<Promise<void>>()
  const failures: unknown[] = []

  const track = (promise: Promise<unknown>): Promise<void> => {
    const tracked: Promise<void> = promise.then(
      () => undefined,
      (cause: unknown) => {
        failures.push(cause)
      }
    ).then(() => {
      pending.delete(tracked)
    })

    pending.add(tracked)

    return tracked
  }

  return {
    pending,
    hasWork: () => pending.size > 0 || failures.length > 0,
    track,
    // oxlint-disable-next-line effecttsgo/async-function -- This Hono/Worker runtime boundary owns native background promises and completes teardown before releasing the request runtime.
    drain: async <R, RuntimeError>(runtime?: ManagedRuntime.ManagedRuntime<R, RuntimeError>) => {
      while (pending.size > 0) {
        await Promise.allSettled(pending)
      }

      for (const cause of failures.splice(0)) {
        const observation = observeEffectErrorEvent({
          source: 'framework',
          handling: 'unhandled',
          kind: 'failure',
          error: cause,
          metadata: { operation: 'external-background' },
        })

        await (runtime
          ? runtime.runPromise(observation)
          : Effect.runPromise(observation))
      }
    },
  }
}

function createExecutionContextSupervisor(
  ctx: CloudflareExecutionContext
): BackgroundSupervisor {
  const pending = new Set<Promise<void>>()
  const external = createExternalPromiseTracker()
  let drainPromise: Promise<void> | undefined

  const schedule = <A, E, R>(
    operation: string,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<void, never, R> =>
    Effect.flatMap(Effect.context<R>(), (context) =>
      Effect.sync(() => {
        const running = Effect.runPromise(
          makeObservedBackground(operation, effect).pipe(Effect.provide(context))
        )

        const tracked: Promise<void> = running.then(() => {
          pending.delete(tracked)
        })

        pending.add(tracked)
        ctx.waitUntil(tracked)
      })
    )

  const client: ExecutionContextClient = {
    isAvailable: true,
    waitUntil: (promise) => {
      const tracked = external.track(promise)
      ctx.waitUntil(tracked)
    },
    runInBackground: (effect) => schedule('background', effect),
    schedule,
  }

  const drain: BackgroundSupervisor['drain'] = (runtime) => {
    if (drainPromise) return drainPromise

    // oxlint-disable-next-line effecttsgo/async-function -- This Hono/Worker runtime boundary owns native background promises and completes teardown before releasing the request runtime.
    drainPromise = (async () => {
      while (pending.size > 0) {
        await Promise.allSettled(pending)
      }

      await external.drain(runtime)
    })()

    return drainPromise
  }

  return {
    client,
    hasPending: () => pending.size > 0 || external.hasWork(),
    extendLifetime: (promise) => ctx.waitUntil(promise),
    drain,
  }
}

/** Create an inline owner for environments without ExecutionContext. */
function createInlineExecutionContextSupervisor(): BackgroundSupervisor {
  const external = createExternalPromiseTracker()
  let drainPromise: Promise<void> | undefined

  const client: ExecutionContextClient = {
    isAvailable: false,
    waitUntil: (promise) => {
      // oxlint-disable-next-line no-floating-promises -- external owns this promise and its rejection; the request awaits external.drain() before disposing services.
      external.track(promise)
    },
    runInBackground: (effect) => makeObservedBackground('background', effect),
    schedule: (operation, effect) => makeObservedBackground(operation, effect),
  }

  return {
    client,
    hasPending: external.hasWork,
    extendLifetime: () => {},
    drain: (runtime) => {
      drainPromise ??= external.drain(runtime)

      return drainPromise
    },
  }
}

function getOrCreateBackgroundSupervisor<E extends Env>(
  c: HonoContext<E>
): BackgroundSupervisor {
  const requestContext = openHonertiaContext(c)

  if (requestContext.backgroundSupervisor) {
    return requestContext.backgroundSupervisor
  }

  const executionContext = getCloudflareExecutionContext(c)

  const supervisor = executionContext
    ? createExecutionContextSupervisor(executionContext)
    : createInlineExecutionContextSupervisor()

  requestContext.backgroundSupervisor = supervisor

  return supervisor
}

function getCloudflareExecutionContext<E extends Env>(
  c: HonoContext<E>
): CloudflareExecutionContext | undefined {
  try {
    const candidate = c.executionCtx

    if (
      candidate instanceof Object &&
      'waitUntil' in candidate &&
      candidate.waitUntil instanceof Function &&
      'passThroughOnException' in candidate &&
      candidate.passThroughOnException instanceof Function
    ) {
      // SAFETY: both members of the deliberately minimal Worker contract were
      // checked above; methods remain owned and invoked through this object.
      return candidate
    }
  } catch {
    // Hono intentionally throws from executionCtx outside Worker runtimes.
  }

  return undefined
}

/**
 * Return the request-owned execution client, creating its supervisor before
 * application services that may schedule external background promises.
 */
export function getRequestExecutionContextClient<E extends Env>(
  c: HonoContext<E>
): ExecutionContextClient {
  return getOrCreateBackgroundSupervisor(c).client
}

/**
 * Create a PageRenderer from Hono context.
 */
function createPageRenderer<E extends Env>(c: HonoContext<E>): PageRenderer {
  const requestContext = openHonertiaContext(c)
  const page = requestContext.web ?? requestContext.honertia

  if (!page) {
    return {
      // oxlint-disable-next-line effecttsgo/async-function -- PageRenderer.render is a Promise-returning Hono adapter contract, including this missing-configuration response.
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
  // SAFETY: The Hono adapter has already constrained this value at the request boundary; this assertion bridges an overload its generic context cannot retain.
  const bindingsLayer = Layer.succeed(
    BindingsService,
    (c.env ?? {}) as BindingsType
  )

  // Cache layer - backed by KV if available, otherwise unconfigured client
  // SAFETY: The Hono adapter has already constrained this value at the request boundary; this assertion bridges an overload its generic context cannot retain.
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- TypeScript 5 needs the binding shape to retain KVNamespace through Hono's generic environment.
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
  const backgroundSupervisor = getOrCreateBackgroundSupervisor(c)

  const executionContextLayer = Layer.succeed(
    ExecutionContextService,
    backgroundSupervisor.client
  )

  // Workers Cache purge API: probes ctx.cache, then the cloudflare:workers
  // module export; unavailable (no-op purge, isAvailable: false) elsewhere.
  const executionCtx = getCloudflareExecutionContext(c)

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

  let baseLayer: Layer.Layer<never, never, never> = Layer.mergeAll(
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

  // SAFETY: The Hono adapter has already constrained this value at the request boundary; this assertion bridges an overload its generic context cannot retain.
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
): WebRequestContext<E>['runtime'] {
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
  // SAFETY: The Hono adapter has already constrained this value at the request boundary; this assertion bridges an overload its generic context cannot retain.
  openHonertiaContext(c).bridgeConfig = config as EffectBridgeConfig<E, unknown>
}

/**
 * Get the Effect bridge config from the request context.
 */
export function getEffectBridgeConfig<E extends Env>(
  c: HonoContext<E>
): EffectBridgeConfig<E, unknown> | undefined {
  return openHonertiaContext(c).bridgeConfig
}

/**
 * Middleware that sets up the Effect runtime for each request.
 */
export function effectBridge<E extends Env, CustomServices = never>(
  config?: EffectBridgeConfig<E, CustomServices>
): MiddlewareHandler<E> {
  // oxlint-disable-next-line effecttsgo/async-function -- This Hono/Worker runtime boundary owns native background promises and completes teardown before releasing the request runtime.
  return async (c, next) => {
    // SAFETY: test-layer injection seam used by @popcomputer/web/effect (see
    // test-layers.ts). Deliberately untyped and unchanged for now; making it
    // a construction-time config option is tracked as a follow-up.
    const contextTestLayer = Object.getOwnPropertyDescriptor(c.var, '__testLayer')?.value

    const envTestLayer = c.env instanceof Object
      ? Object.getOwnPropertyDescriptor(c.env, '__testLayer')?.value
      : undefined

    const testLayer: Layer.Layer<never, never, never> | undefined = contextTestLayer ?? envTestLayer
    const hasTestLayer = Layer.isLayer(contextTestLayer ?? envTestLayer)
    setEffectBridgeConfig(c, config)
    let layer = buildContextLayer(c, config)

    if (hasTestLayer && testLayer !== undefined) {
      layer = Layer.merge(layer, testLayer)
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
            const captures = await runtime.runPromise(maybeCapture.value.get)
            const response = c.res

            if (response) {
              setResponseTestCaptures(response, captures)
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
): object | undefined {
  return openHonertiaContext(c).schema
}

/** Get the route-model binding configuration from the request context. */
export function getEffectBindings<E extends Env>(
  c: HonoContext<E>
): RouteBindingsConfig | undefined {
  return openHonertiaContext(c).bindings
}
