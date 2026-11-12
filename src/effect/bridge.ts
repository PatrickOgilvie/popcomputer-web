/**
 * Hono-Effect Bridge
 *
 * Middleware that connects Hono's request handling to Effect's runtime.
 */

import { SignInLimits } from './sign-in-limits.js'
import { Cause, Config, ConfigProvider, Context as EffectContext, Duration, Effect, Exit, Layer, ManagedRuntime, Option, Schema as S, Scope } from 'effect'
import { getCookie } from 'hono/cookie'
import { serialize } from 'hono/utils/cookie'
import { CookieService, type CookieJar } from './cookies.js'
import { ResponseHeaders } from './response-headers.js'
import type { Context as HonoContext, MiddlewareHandler, Env } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { RequestServicesLayer, WebRequestContext } from '../request-context.js'
import { openWebContext } from '../request-context.js'
import { Visitor } from '../visitor.js'
import { HEADER_READS, markPageDynamic, observedRequestContext, trackDatabase } from '../page-cache.js'
import {
  ResponseCacheService,
  createWorkersResponseCacheClient,
  createUnavailableResponseCacheClient,
  resolveWorkersCachePurgeApi,
  withOwnPurges,
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
import { reportRelease, reportThrough, type ReportingRuntime } from './report.js'
import { BodyTooLarge, DEFAULT_BODY_LIMIT, isStreamedAsRead, readBody, streamsAsRead } from './body-limit.js'
import { setupOf, WebSetupService } from '../web-setup.js'
import { queueCookie, queueHeader, refuseAfterFinish } from '../response-output.js'

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

/** The most bytes the route's body may have: its action's form's, else setupWeb's. */
function routeBodyLimit<E extends Env>(c: HonoContext<E>): number {
  return openWebContext(c).routeBodyLimit ?? setupOf(c).bodyLimit ?? DEFAULT_BODY_LIMIT
}

/** The body kinds HonoRequest keeps in its body cache, which another reader may have read. */
const READ_BODIES = ['arrayBuffer', 'text', 'blob', 'json', 'formData'] as const

/**
 * The request's body, read once into Hono's body cache, so its json() and
 * parseBody() parse that copy and a later read reuses it, and checked against
 * `limit`: each reader is held to its own limit, and the first cannot choose
 * the read's, which is the route's unless it asks for more. A body Hono
 * middleware read before is measured, and held to the limit too.
 */
function bodyWithin<E extends Env>(c: HonoContext<E>, limit: number): Promise<void> {
  // HonoRequest keeps each body read's promise in bodyCache and reads the
  // other kinds from it (#cachedBody), though its type names the values.
  const cache = c.req.bodyCache
  const cached = (kind: (typeof READ_BODIES)[number]): Promise<unknown> | undefined => {
    const value: unknown = Reflect.get(cache, kind)

    return value instanceof Promise ? value : undefined
  }

  if (cached('arrayBuffer') === undefined) {
    const read = READ_BODIES.find((kind) => cached(kind) !== undefined)
    const earlier = read === undefined ? undefined : cached(read)

    Object.assign(cache, {
      arrayBuffer: earlier === undefined
        ? readBody(c.req.raw, Math.max(limit, routeBodyLimit(c)))
        // A parsed body, as a json key would hold, is measured as its JSON.
        : earlier.then((body) => new Response(isBodyInit(body) ? body : JSON.stringify(body)).arrayBuffer()),
    })
  }

  return Promise.resolve(cached('arrayBuffer')).then((bytes) => {
    if (bytes instanceof ArrayBuffer && bytes.byteLength > limit) throw new BodyTooLarge({ limit })
  })
}

/** Whether a body another reader read is one a Response can hold as it is. */
const isBodyInit = (body: unknown): body is BodyInit =>
  typeof body === 'string' || body instanceof ArrayBuffer || body instanceof Blob || body instanceof FormData

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
    json: (options): Promise<unknown> => bodyWithin(c, options?.bodyLimit ?? routeBodyLimit(c)).then(() => c.req.json()),
    // The raw request carries every header, and Cloudflare's `cf` data.
    raw: () => {
      markPageDynamic(c)

      return c.req.raw
    },
    parseBody: (options) => bodyWithin(c, options?.bodyLimit ?? routeBodyLimit(c)).then(() => c.req.parseBody({ all: true })),
    header: (name: string) => {
      markPageDynamic(c)

      return c.req.header(name)
    },
    // The route's, read when a reader asks, after the route's facts are set.
    get bodyLimit() {
      return routeBodyLimit(c)
    },
  }
}

/** The request reads a request service may make through its context that no cache key holds. */
const SERVICE_REQUEST_READS: ReadonlySet<PropertyKey> = new Set([...HEADER_READS, 'url'])

/**
 * The context `web.services`' request callback receives. A service built from
 * a request header, the raw request or its URL, such as a tenant read from
 * `X-Tenant`, makes every response that uses it depend on what no cache key
 * holds, so reading one marks the page dynamic, as RequestService does.
 */
export function serviceRequestContext<E extends Env>(c: HonoContext<E>): HonoContext<E> {
  return observedRequestContext(c, { reads: SERVICE_REQUEST_READS })
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
      const maxAge = options.maxAge === undefined ? undefined : Math.floor(Duration.toSeconds(Duration.fromInputUnsafe(options.maxAge)))
      const routeParams = c.req.param()
      const params: Readonly<Record<string, string>> = S.is(S.String)(routeParams) ? {} : routeParams
      // A declared path's placeholders are filled from the route setting it.
      const path = (options.path ?? '/').replace(/\{(\w+)\}/g, (_placeholder, param: string) => {
        const filled = params[param]

        if (filled === undefined) {
          throw new Error(`Cookie '${name}' has the path ${options.path}, but this route has no {${param}} to fill it.`)
        }

        return encodeURIComponent(filled)
      })

      queueCookie(c, serialize(name, value, {
        path,
        httpOnly: options.httpOnly ?? true,
        secure,
        sameSite: options.sameSite ?? 'Lax',
        ...(maxAge === undefined ? {} : { maxAge }),
      }))
    },
    append: (setCookie) => queueCookie(c, setCookie),
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
  /**
   * Release what a request or job holds once the work it started has
   * settled: wait for that work, reporting each failure through `runtime`
   * first, run `release`, then wait for what its finalizers started.
   * Releases run in the order they were asked for, so a route's runtime is
   * released before the request's services it was built on. In a Worker
   * with work still running it returns at once, and the Worker waits for
   * the rest; elsewhere it resolves once all of it is done. It never rejects.
   */
  readonly settle: (release: () => Promise<void>, runtime?: ReportingRuntime) => Promise<void>
  /** A body that holds the request's services until it ends or the client cancels it. */
  readonly holdUntilSent: (body: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>
  /**
   * Cancel each held body the answer will not send, which nothing would
   * otherwise read or cancel: every one for a HEAD request, whose body Hono
   * drops, and otherwise each but the answer's own, as one a later failure's
   * answer replaced.
   */
  readonly cancelUnsent: (answer: ReadableStream<Uint8Array> | null, head: boolean) => void
}

/**
 * The response, with a body `file()` streams holding the request's services
 * until it has been sent: the Stream's chunks are produced as the body is
 * read, after the answer, and read the services the action had.
 */
export function holdUntilSent<E extends Env>(c: HonoContext<E>, response: Response): Response {
  const body = response.body

  if (body === null || !isStreamedAsRead(body)) return response

  const held = getOrCreateBackgroundSupervisor(c).holdUntilSent(body)

  streamsAsRead(held)

  return new Response(held, { status: response.status, statusText: response.statusText, headers: response.headers })
}

/**
 * Cancel the bodies `file()` streams that the request's final answer will not
 * send, so the services they hold are released: see
 * `BackgroundSupervisor.cancelUnsent`. setupWeb's outermost member calls it
 * once every member has answered.
 */
export function cancelUnsentBodies<E extends Env>(c: HonoContext<E>): void {
  openWebContext(c).backgroundSupervisor?.cancelUnsent(c.res.body, c.req.method === 'HEAD')
}

/**
 * Dispose a request runtime only after its owned background work settles.
 *
 * Worker runtimes hand the drain and disposal promise to `waitUntil`; inline
 * runtimes await completion before releasing scoped services. A finalizer
 * that dies is reported, and never changes the answer or the job's result.
 */
export function disposeRequestRuntime<E extends Env, R, RuntimeError>(
  c: HonoContext<E>,
  runtime: ManagedRuntime.ManagedRuntime<R, RuntimeError>
): Promise<void> {
  return getOrCreateBackgroundSupervisor(c).settle(
    () => Effect.runPromiseExit(runtime.disposeEffect).then((exit) => reportRelease(c, exit)),
    runtime
  )
}

/**
 * Finish background promises when outer middleware exits before the Effect
 * bridge can own request teardown.
 */
export function drainRequestBackground<E extends Env>(
  c: HonoContext<E>
): Promise<void> {
  return openWebContext(c).backgroundSupervisor?.settle(() => Promise.resolve()) ?? Promise.resolve()
}

/**
 * One request's background work, in a Worker or not: each piece runs beside
 * the request and is waited for before what it uses is released, and each
 * failure is reported. In a Worker each piece is also handed to `waitUntil`.
 */
function createBackgroundSupervisor<E extends Env>(
  c: HonoContext<E>,
  ctx: CloudflareExecutionContext | undefined
): BackgroundSupervisor {
  // Work running beside the request, each piece removed once it settles, and
  // the failures of promises handed to waitUntil, not yet reported.
  const running = new Set<Promise<void>>()
  const failures: unknown[] = []
  // The releases asked for so far, one after another, and how many of them
  // the Worker waits for after the answer.
  let releases: Promise<void> = Promise.resolve()
  let deferred = 0
  // Bodies being sent, which hold the request's services: outside a Worker
  // too, a release waits for them, after the answer.
  let sending = 0
  const unsent = new Set<ReadableStream<Uint8Array>>()

  const hold = (work: Promise<unknown>): void => {
    const held: Promise<void> = work.then(() => undefined, () => undefined).then(() => {
      running.delete(held)
    })

    running.add(held)
    ctx?.waitUntil(held)
  }

  // The work runs beside the action and may outlive it, so what it names with
  // purgeCache is its own to purge once it succeeds.
  const schedule = <A, Err, R>(
    operation: string,
    effect: Effect.Effect<A, Err, R>
  ): Effect.Effect<void, never, R> =>
    Effect.flatMap(withOwnPurges(effect), (owned) =>
      Effect.flatMap(Effect.context<R>(), (context) =>
        Effect.sync(() => hold(Effect.runPromise(makeObservedBackground(operation, owned).pipe(Effect.provide(context)))))
      )
    )

  const client: ExecutionContextClient = {
    isAvailable: ctx !== undefined,
    waitUntil: (promise) => hold(promise.then(undefined, (cause: unknown) => {
      failures.push(cause)
    })),
    runInBackground: (effect) => schedule('background', effect),
    schedule,
  }

  const hasPending = () => running.size > 0 || failures.length > 0

  // Until nothing runs and every failure is reported: work that settles may
  // start more, and a report is work of its own.
  // oxlint-disable-next-line effecttsgo/async-function -- This Hono/Worker runtime boundary owns native background promises and completes teardown before releasing the request runtime.
  const drain = async (runtime?: ReportingRuntime): Promise<void> => {
    while (hasPending()) {
      for (const cause of failures.splice(0)) {
        hold(reportThrough(c, observeOrLog({
          source: 'framework',
          handling: 'unhandled',
          kind: 'failure',
          error: cause,
          metadata: { operation: 'external-background' },
        }, 'Background work failed'), runtime))
      }

      await Promise.allSettled(running)
    }
  }

  const settle: BackgroundSupervisor['settle'] = (release, runtime) => {
    const defer = sending > 0 || deferred > 0 || (ctx !== undefined && hasPending())
    const released = releases
      .then(() => drain(runtime))
      .then(release)
      .then(undefined, (cause: unknown) => reportRelease(c, Exit.die(cause)))
    // What the finalizers started, such as work handed to waitUntil.
    const settled = released.then(() => drain())

    releases = settled
    ctx?.waitUntil(settled)

    if (!defer) return ctx === undefined ? settled : released

    // A Worker holds settled through waitUntil; elsewhere it settles once the
    // body being sent has ended, and nothing outlives the process to hold it.
    deferred += 1
    // oxlint-disable-next-line no-floating-promises -- settled never rejects, and a Worker holds it through waitUntil above; this only counts it out.
    settled.then(() => {
      deferred -= 1
    })

    return Promise.resolve()
  }

  const holdUntilSent: BackgroundSupervisor['holdUntilSent'] = (body) => {
    const reader = body.getReader()
    let sent = () => {}

    sending += 1
    hold(new Promise<void>((resolve) => {
      sent = resolve
    }).then(() => {
      sending -= 1
      unsent.delete(held)
    }))

    const held = new ReadableStream<Uint8Array>({
      pull: (controller) => reader.read().then(
        (chunk) => {
          if (!chunk.done) return controller.enqueue(chunk.value)

          controller.close()
          sent()
        },
        (error: unknown) => {
          controller.error(error)
          sent()
        }
      ),
      cancel: (reason) => reader.cancel(reason).finally(sent),
    })

    unsent.add(held)

    return held
  }

  const cancelUnsent: BackgroundSupervisor['cancelUnsent'] = (answer, head) => {
    for (const body of unsent) {
      if ((head || body !== answer) && !body.locked) hold(body.cancel('The answer does not send this body.'))
    }
  }

  return { client, hasPending, settle, holdUntilSent, cancelUnsent }
}

function getOrCreateBackgroundSupervisor<E extends Env>(
  c: HonoContext<E>
): BackgroundSupervisor {
  const requestContext = openWebContext(c)

  if (requestContext.backgroundSupervisor) {
    return requestContext.backgroundSupervisor
  }

  const supervisor = createBackgroundSupervisor(c, getCloudflareExecutionContext(c))

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

  // web() is read when the action renders, shares or flashes, not when the
  // request's services are readied: on a stack composed by hand it may run
  // after effectBridge.
  return {
    pages: declared.pages,
    shared: declared.shared,
    flashed: declared.flash,
    render: (component, props, options) => {
      const page = requestContext.web

      return page === undefined
        ? Promise.resolve(c.text('@popcomputer/web is not configured', 500))
        : Promise.resolve(page.render(component, props, options))
    },
    share: (key, value) => requestContext.web?.share(key, value),
    flash: (key, value) => {
      refuseAfterFinish(c, `The flash value ${key}`)

      const store = requestContext.flash

      if (store === undefined) {
        throw new Error(`The flash value ${key} has no flash cookie to go in: web() opens it, and it has not run for this request. Register web() on the app before the routes, as setupWeb does.`)
      }

      store.set(key, value)
    },
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
  | ResponseHeaders
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
  const headersLayer = Layer.succeed(ResponseHeaders, ResponseHeaders.of({
    append: (name, value) => queueHeader(c, name, value),
  }))
  const pageLayer = Layer.succeed(PageService, createPageRenderer(c, config))
  const setupLayer = Layer.succeed(WebSetupService, setupOf(c))

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
    headersLayer,
    pageLayer,
    setupLayer,
    bindingsLayer,
    executionContextLayer,
    responseCacheLayer
  )

  // Each use of the database is a data read, so its page renders per request.
  if (requestCtx.db !== undefined) {
    baseLayer = Layer.merge(baseLayer, Layer.succeed(DatabaseService, trackDatabase(c, requestCtx.db)))
  }

  if (requestCtx.auth !== undefined) {
    baseLayer = Layer.merge(baseLayer, Layer.succeed(AuthService, requestCtx.auth))
  }

  if (requestCtx.signInLimits !== undefined) {
    baseLayer = Layer.merge(baseLayer, Layer.succeed(SignInLimits, requestCtx.signInLimits))
  }

  // The signed-in user as the request has them when its runtime is built,
  // after every middleware before the route: on a stack composed by hand,
  // loadUser may run after effectBridge.
  baseLayer = Layer.merge(
    baseLayer,
    Layer.unwrap(Effect.sync(() => requestCtx.authUser === undefined ? Layer.empty : Layer.succeed(AuthUserService, requestCtx.authUser)))
  )

  // The application's request services, built only when an action's runtime
  // is: a request that runs no action, such as a plain Hono route, never calls
  // web.services' `request(c)`, which may read bindings that route lacks.
  if (config?.services) {
    const services = config.services
    const customServicesLayer = Layer.suspend(() => services(serviceRequestContext(c))).pipe(Layer.provide(configuration))
    baseLayer = Layer.merge(baseLayer, customServicesLayer)
  }

  // SAFETY: The Hono adapter has already constrained this value at the request boundary; this assertion bridges an overload its generic context cannot retain.
  return baseLayer as Layer.Layer<
    | RequestService
    | RequestStateService
    | ResponseFactoryService
    | CookieService
    | ResponseHeaders
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
 * Each request's services as one layer: the application's own, built once
 * per isolate and shared, the request's, and its bindings as Effect Config.
 * Later layers win: request services replace app services.
 */
function requestServicesFactory<E extends Env, CustomServices>(
  config?: EffectBridgeConfig<E, CustomServices>
): (c: HonoContext<E>) => RequestServicesLayer {
  // Built by the first request, with that request's bindings as its
  // configuration, and kept for the isolate's lifetime: a Worker's bindings
  // are the same for every request it serves.
  let appRuntime: ManagedRuntime.ManagedRuntime<CustomServices, Config.ConfigError> | undefined

  return (c) => {
    const configuration = bindingsConfiguration(c.env)

    if (config?.app !== undefined && appRuntime === undefined) {
      appRuntime = ManagedRuntime.make(config.app.pipe(Layer.provide(configuration)))
    }

    // A layer that fails to build fails the action with its error.
    const requestLayer = Layer.merge(buildContextLayer(c, config, configuration), configuration)
    const requestAppRuntime = appRuntime

    if (requestAppRuntime === undefined) return requestLayer

    return Layer.merge(
      Layer.effectContext(requestAppRuntime.contextEffect.pipe(
        // A failed build is not kept, whatever ended it: the next request
        // builds the application services again. Their type admits only a
        // ConfigError, so a transient failure can only be a defect.
        Effect.tapCause(() => Effect.sync(() => {
          if (appRuntime === requestAppRuntime) appRuntime = undefined
        }))
      )),
      requestLayer
    )
  }
}

/** An application's Effect bridge: its middleware, and how it readies one request's services. */
export interface EffectBridge<E extends Env> {
  readonly middleware: MiddlewareHandler<E>
  readonly prepare: (c: HonoContext<E>) => Promise<() => Promise<void>>
}

/**
 * The Effect bridge of one application: `prepare` readies a request's
 * services on its context, for its route or its job to build the request's
 * one runtime from, and returns what releases them once its background work
 * has settled. `middleware` prepares each request.
 */
export function createEffectBridge<E extends Env, CustomServices = never>(
  config?: EffectBridgeConfig<E, CustomServices>
): EffectBridge<E> {
  const servicesOf = requestServicesFactory(config)

  const prepare = (c: HonoContext<E>): Promise<() => Promise<void>> => {
    setEffectBridgeConfig(c, config)
    const requestCtx = openWebContext(c)

    if (config?.schema) {
      requestCtx.schema = config.schema
    }

    if (config?.bindings) {
      requestCtx.bindings = config.bindings
    }

    // testEnv's services, built once in a scope of the request's own and
    // recorded: the route gives them over its own layers, so a test's fake
    // replaces the service a route provides as well.
    const testLayer = readTestLayer(c.env)
    const testScope = Scope.makeUnsafe()
    const built = testLayer === undefined
      ? Promise.resolve(undefined)
      : Effect.runPromiseExit(Layer.buildWithScope(testLayer.pipe(Layer.provide(bindingsConfiguration(c.env))), testScope))

    return built.then((tests) => readied(c, servicesOf(c), tests, testScope))
  }

  /** The request's services readied on its context, with testEnv's; what releases them. */
  const readied = (
    c: HonoContext<E>,
    services: RequestServicesLayer,
    built: Exit.Exit<EffectContext.Context<never>> | undefined,
    testScope: Scope.Closeable
  ): () => Promise<void> => {
    const requestCtx = openWebContext(c)
    let layer = services

    if (built !== undefined) {
      if (Exit.isSuccess(built)) {
        requestCtx.testServices = built.value
        // They replace the request's services beneath the route's layers too.
        layer = Layer.merge(layer, Layer.succeedContext(built.value))
        // A user that testEnv signs in replaces the session for shared props
        // and page caching, as it does for actions.
        const testUser = EffectContext.getOption(built.value, AuthUserService)

        if (Option.isSome(testUser)) {
          requestCtx.authUser = testUser.value
          requestCtx.visitor = Visitor.Member({ user: testUser.value })
        }
      } else {
        // A test layer that fails to build fails the action with its error.
        layer = Layer.merge(layer, Layer.effectDiscard(Effect.failCause(built.cause)))
      }
    }

    requestCtx.requestLayer = layer

    // Code that read the request's runtime from its context still finds one,
    // built only when it is read: routes build their own, one per request.
    // A report reads it when the route's layers failed. Once released it is
    // gone, and reading it is refused rather than building one nothing
    // releases.
    let runtime: ManagedRuntime.ManagedRuntime<never, Config.ConfigError> | undefined
    let released = false
    const requestRuntime = () => released ? undefined : runtime ??= ManagedRuntime.make(layer)

    requestCtx.requestRuntime = requestRuntime
    Object.defineProperty(requestCtx, 'runtime', {
      configurable: true,
      enumerable: true,
      get: () => {
        const current = requestRuntime()

        if (current === undefined) throw new Error("The request's runtime was released with its services, once its answer and background work were done: read it while the request runs.")

        return current
      },
    })

    // oxlint-disable-next-line effecttsgo/async-function -- This Hono/Worker runtime boundary releases the request's services after its background work, reporting any finalizer that dies.
    const release = async () => {
      released = true
      await reportRelease(c, runtime === undefined ? Exit.void : await Effect.runPromiseExit(runtime.disposeEffect))
      await reportRelease(c, await Effect.runPromiseExit(Scope.close(testScope, Exit.void)))
    }

    return () => getOrCreateBackgroundSupervisor(c).settle(release)
  }

  // oxlint-disable-next-line effecttsgo/async-function -- This Hono/Worker runtime boundary owns native background promises and completes teardown before releasing the request's services.
  const middleware: MiddlewareHandler<E> = async (c, next) => {
    const release = await prepare(c)

    try {
      await next()
    } finally {
      await release()
    }

    // Return response for proper propagation in forwarding/proxy scenarios
    return c.res
  }

  return { middleware, prepare }
}

/**
 * Middleware that readies each request's Effect services, for the routes
 * after it.
 */
export function effectBridge<E extends Env, CustomServices = never>(
  config?: EffectBridgeConfig<E, CustomServices>
): MiddlewareHandler<E> {
  return createEffectBridge(config).middleware
}

