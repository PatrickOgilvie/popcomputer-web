/**
 * Hono-Effect Bridge
 *
 * Middleware that connects Hono's request handling to Effect's runtime.
 */

import { Cause, Config, ConfigProvider, Duration, Effect, Exit, Layer, ManagedRuntime, Option, Schema as S } from 'effect'
import { getCookie } from 'hono/cookie'
import { serialize } from 'hono/utils/cookie'
import { CookieService, type CookieJar } from './cookies.js'
import type { Context as HonoContext, MiddlewareHandler, Env } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { WebRequestContext } from '../request-context.js'
import { openWebContext } from '../request-context.js'
import { markPageDynamic } from '../page-cache.js'
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
  ExecutionContextService,
  type RequestContext,
  type RequestStateClient,
  type ResponseFactory,
  type PageRenderer,
  type ExecutionContextClient,
  type BindingsType,
} from './services.js'
import { readTestLayer } from './test-env.js'
import type { RouteBindingsConfig } from './binding.js'
import type { DeclaredFields, PageSchemas } from './pages.js'
import { observeOrLog } from './error-observer.js'

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
   * Services built once, on the first request an isolate serves, and shared
   * by every later request. They must not hold request-bound I/O objects
   * (D1, KV or Hyperdrive handles, open sockets), which Workers forbid using
   * from another request; build those in `services`. Effect `Config` reads
   * the Worker's bindings.
   */
  app?: Layer.Layer<CustomServices, Config.ConfigError, never>
  /**
   * Services built for each request, from its context and bindings. Effect
   * `Config` reads the Worker's bindings.
   */
  services?: (c: HonoContext<E>) => Layer.Layer<CustomServices, Config.ConfigError, never>
  /**
   * Drizzle schema for route model binding.
   * Usually configured via `setupWeb(app, { schema })`.
   * Can also be passed here for standalone effectBridge usage.
   */
  schema?: object
  /** Row parsers and optional scope metadata for route-model bindings. */
  bindings?: RouteBindingsConfig
  /** Each page component's props schema, which `render` checks and encodes props with. */
  pages?: PageSchemas
  /** The props shared with every page, which `share` encodes values with. */
  shared?: DeclaredFields
  /** The flash values `flash` encodes. */
  flash?: DeclaredFields
}

// Unconfigured services are simply not provided to the Effect layer. When a
// handler yields a tag that was never configured, Effect dies with a
// missing-service defect that handler.ts classifies into the structured
// ConfigurationError response (see classifyMissingService).
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
    // Headers are not part of the page-cache key, so reading them makes the page dynamic.
    get headers() {
      markPageDynamic(c)

      return c.req.raw.headers
    },
    env,
    param: (name: string) => c.req.param(name),
    params: () => {
      const params = c.req.param()

      return S.is(S.String)(params) ? {} : params
    },
    query: () => c.req.query(),
    queries: () => c.req.queries(),
    json: (): Promise<unknown> => c.req.json(),
    raw: () => c.req.raw,
    parseBody: () => c.req.parseBody({ all: true }),
    header: (name: string) => {
      markPageDynamic(c)

      return c.req.header(name)
    },
  }
}

/**
 * Create a RequestStateClient backed by Hono context variables.
 * Values are shared with Hono middleware through c.set / c.var.
 */
/**
 * The request's cookies for `cookie(...)` declarations: reading one makes the
 * page dynamic, since cookies are not part of the page cache's key, and a set
 * cookie waits in the request context until web() writes it on the response.
 */
function createCookieJar<E extends Env>(c: HonoContext<E>): CookieJar {
  const secure = new URL(c.req.url).protocol === 'https:'

  return {
    get: (name) => {
      markPageDynamic(c)

      return getCookie(c, name)
    },
    set: ({ name, value, options }) => {
      const context = openWebContext(c)
      const maxAge = options.maxAge === undefined ? undefined : Math.floor(Duration.toSeconds(Duration.fromInputUnsafe(options.maxAge)))

      context.responseCookies = [
        ...(context.responseCookies ?? []),
        serialize(name, value, {
          path: options.path ?? '/',
          httpOnly: options.httpOnly ?? true,
          secure,
          sameSite: options.sameSite ?? 'Lax',
          ...(maxAge === undefined ? {} : { maxAge }),
        }),
      ]
    },
  }
}

function createRequestStateClient<E extends Env>(c: HonoContext<E>): RequestStateClient {
  // SAFETY: The Hono adapter has already constrained this value at the request boundary; this assertion bridges an overload its generic context cannot retain.
  return {
    // Arbitrary keys are not represented in Hono's ContextVariableMap typing,
    // so reads and writes go through the untyped context surface.
    get: <T>(key: string) => {
      // Middleware may derive request state from cookies or headers.
      markPageDynamic(c)

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
      observeOrLog({
        source: 'framework',
        handling: 'unhandled',
        kind: Option.isSome(Cause.findErrorOption(cause)) ? 'failure' : 'defect',
        error: Cause.squash(cause),
        metadata: { operation },
      }, 'Background work failed')
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
  const supervisor = openWebContext(c).backgroundSupervisor

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
  const supervisor = openWebContext(c).backgroundSupervisor

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
        const observation = observeOrLog({
          source: 'framework',
          handling: 'unhandled',
          kind: 'failure',
          error: cause,
          metadata: { operation: 'external-background' },
        }, 'Background work failed')

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
  const requestContext = openWebContext(c)

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
function createPageRenderer<E extends Env>(
  c: HonoContext<E>,
  declared: { readonly pages?: PageSchemas; readonly shared?: DeclaredFields; readonly flash?: DeclaredFields } = {}
): PageRenderer {
  const requestContext = openWebContext(c)
  const page = requestContext.web

  if (!page) {
    return {
      // oxlint-disable-next-line effecttsgo/async-function -- PageRenderer.render is a Promise-returning Hono adapter contract, including this missing-configuration response.
      render: async () => c.text('@popcomputer/web is not configured', 500),
      share: () => {},
      flash: () => {},
    }
  }

  return {
    pages: declared.pages,
    shared: declared.shared,
    flashed: declared.flash,
    render: (component, props) => Promise.resolve(page.render(component, props)),
    share: (key, value) => page.share(key, value),
    flash: (key, value) => requestContext.flash?.set(key, value),
  }
}

/**
 * Build the Effect layer from Hono context.
 */
export function buildContextLayer<E extends Env, CustomServices = never>(
  c: HonoContext<E>,
  config?: EffectBridgeConfig<E, CustomServices>,
  configuration: Layer.Layer<never> = bindingsConfiguration(c.env)
): Layer.Layer<
  | RequestService
  | RequestStateService
  | ResponseFactoryService
  | CookieService
  | PageService
  | DatabaseService
  | AuthService
  | AuthUserService
  | BindingsService
  | ExecutionContextService
  | CustomServices,
  Config.ConfigError,
  never
> {
  const requestLayer = Layer.succeed(RequestService, createRequestContext(c))

  const requestStateLayer = Layer.succeed(
    RequestStateService,
    createRequestStateClient(c)
  )

  const responseLayer = Layer.succeed(ResponseFactoryService, createResponseFactory(c))
  const cookieLayer = Layer.succeed(CookieService, createCookieJar(c))
  const pageLayer = Layer.succeed(PageService, createPageRenderer(c, config))

  // Bindings layer - always available, typed by the registered application's environment
  // SAFETY: The Hono adapter has already constrained this value at the request boundary; this assertion bridges an overload its generic context cannot retain.
  const bindingsLayer = Layer.succeed(
    BindingsService,
    (c.env ?? {}) as BindingsType
  )

  // Database and auth come from the typed request context (written by
  // setupWeb's service wiring or the webServices middleware).
  // They are provided IFF configured; absence surfaces as a missing-service
  // defect that handler.ts classifies into a configuration error.
  const requestCtx = openWebContext(c)

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

  let baseLayer: Layer.Layer<never, Config.ConfigError, never> = Layer.mergeAll(
    requestLayer,
    requestStateLayer,
    responseLayer,
    cookieLayer,
    pageLayer,
    bindingsLayer,
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
    const customServicesLayer = config.services(c).pipe(Layer.provide(configuration))
    baseLayer = Layer.merge(baseLayer, customServicesLayer)
  }

  // SAFETY: The Hono adapter has already constrained this value at the request boundary; this assertion bridges an overload its generic context cannot retain.
  return baseLayer as Layer.Layer<
    | RequestService
    | RequestStateService
    | ResponseFactoryService
    | CookieService
    | PageService
    | BindingsService
    | ExecutionContextService
    | DatabaseService
    | AuthService
    | AuthUserService
    | CustomServices,
    Config.ConfigError,
    never
  >
}

/**
 * The Worker's bindings as the Effect configuration: `Config.String('NAME')`
 * reads a var or secret, in application and request services and in actions.
 */
export function bindingsConfiguration(env: unknown): Layer.Layer<never> {
  return ConfigProvider.layer(ConfigProvider.fromUnknown(env ?? {}))
}

/**
 * Get the per-request Effect runtime (set by effectBridge).
 */
export function getEffectRuntime<E extends Env>(
  c: HonoContext<E>
): WebRequestContext<E>['runtime'] {
  return openWebContext(c).runtime
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
  openWebContext(c).bridgeConfig = config as EffectBridgeConfig<E, unknown>
}

/**
 * Get the Effect bridge config from the request context.
 */
export function getEffectBridgeConfig<E extends Env>(
  c: HonoContext<E>
): EffectBridgeConfig<E, unknown> | undefined {
  return openWebContext(c).bridgeConfig
}

/**
 * Middleware that sets up the Effect runtime for each request.
 */
export function effectBridge<E extends Env, CustomServices = never>(
  config?: EffectBridgeConfig<E, CustomServices>
): MiddlewareHandler<E> {
  // Built by the first request, with that request's bindings as its
  // configuration, and kept for the isolate's lifetime: a Worker's bindings
  // are the same for every request it serves.
  let appRuntime: ManagedRuntime.ManagedRuntime<CustomServices, Config.ConfigError> | undefined

  // oxlint-disable-next-line effecttsgo/async-function -- This Hono/Worker runtime boundary owns native background promises and completes teardown before releasing the request runtime.
  return async (c, next) => {
    setEffectBridgeConfig(c, config)
    const configuration = bindingsConfiguration(c.env)

    if (config?.app !== undefined && appRuntime === undefined) {
      appRuntime = ManagedRuntime.make(config.app.pipe(Layer.provide(configuration)))
    }

    // Later layers win: request services replace app services, and services
    // from testEnv (@popcomputer/web/testing) replace both. A layer that
    // fails to build fails the action with its error.
    const requestLayer = Layer.merge(buildContextLayer(c, config, configuration), configuration)
    const requestAppRuntime = appRuntime

    const appAndRequestLayer = requestAppRuntime === undefined
      ? requestLayer
      : Layer.merge(
          Layer.effectContext(requestAppRuntime.contextEffect.pipe(
            // A failed build is not kept: the next request builds the
            // application services again.
            Effect.tapError(() => Effect.sync(() => {
              if (appRuntime === requestAppRuntime) appRuntime = undefined
            }))
          )),
          requestLayer
        )

    const testLayer = readTestLayer(c.env)

    const runtime = ManagedRuntime.make(
      testLayer === undefined ? appAndRequestLayer : Layer.merge(appAndRequestLayer, testLayer)
    )

    // Store runtime and binding schema on the request context
    const requestCtx = openWebContext(c)
    requestCtx.runtime = runtime

    // A user that testEnv signs in replaces the session for shared props and
    // page caching, as it does for actions.
    if (testLayer !== undefined) {
      const testUser = await runtime.runPromiseExit(Effect.serviceOption(AuthUserService))

      if (Exit.isSuccess(testUser) && Option.isSome(testUser.value)) {
        requestCtx.authUser = testUser.value.value
      }
    }

    if (config?.schema) {
      requestCtx.schema = config.schema
    }

    if (config?.bindings) {
      requestCtx.bindings = config.bindings
    }

    try {
      await next()
    } finally {
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
  return openWebContext(c).schema
}

/** Get the route-model binding configuration from the request context. */
export function getEffectBindings<E extends Env>(
  c: HonoContext<E>
): RouteBindingsConfig | undefined {
  return openWebContext(c).bindings
}
