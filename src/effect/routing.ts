/**
 * Effect Route Builder
 *
 * Laravel-style routing with Effect handlers.
 */

import { Cause, Predicate, Context, Effect, Exit, Layer, ManagedRuntime, Option, Schema as S } from 'effect'
import type { Context as HonoContext, ExecutionContext, Hono, MiddlewareHandler, Env } from 'hono'
import { runEffectWithRuntime } from './handler.js'
import {
  bindingsConfiguration,
  buildContextLayer,
  disposeRequestRuntime,
  getEffectBridgeConfig,
  getEffectBindings,
  getEffectRuntime,
  getEffectSchema,
  observedRequestContext,
  setEffectBridgeConfig,
  type EffectBridgeConfig,
} from './bridge.js'
import {
  type AppError,
  ConfigurationError,
  NotFoundError,
  Redirect,
  RouteConfigurationError,
  UnauthorizedError,
} from './errors.js'
import { openWebContext } from '../request-context.js'
import type { CookieService } from './cookies.js'
import type { Endpoint } from '../endpoint.js'
import type { EndpointAction } from './endpoint-action.js'
import type { ResponseHeaders } from './response-headers.js'
import { allowDefaultPageCache, defaultCacheControl } from '../page-cache.js'
import {
  applyCachePolicy,
  decideCachePolicy,
  hasSessionCookie,
  isPageResponse,
  isPartialReloadRequest,
  purgeTags,
  type ResponseCachePurgeError,
  type ResponseCacheService,
  PendingPurges,
  makePendingPurges,
  PendingCacheTags,
  makePendingCacheTags,
  type CacheTag,
  formatRecordTag,
  type RouteCacheOptions,
} from './response-cache.js'
import { AuthUserService, DatabaseService, RequestService } from './services.js'
import { isDeciding, isGuard } from './guard.js'
import type {
  AuthService,
  ExecutionContextService,
  PageService,
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
  assertBindingColumns,
  assertRouteAccess,
  isGuardedBinding,
  loadDrizzle,
  type BoundModelError,
  type CompiledRouteBinding,
  type ParsedBinding,
  type RouteBindingsConfig,
  type RouteModel,
} from './binding.js'
import type { PathParamName } from '../paths.js'
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
  | PendingPurges
  | PendingCacheTags
  | CookieService
  | ResponseHeaders

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

/** The names of the route models among an Effect's requirements. */
type ModelName<Requirement> = Requirement extends RouteModel<infer K> ? K : never

/**
 * The route models a path provides, one for each `{placeholder}`, or every
 * model for a path the types cannot read.
 */
export type PathModels<Path extends string> = string extends Path
  ? RouteModel<string>
  : [PathParamName<Path>] extends [never]
    ? never
    : RouteModel<PathParamName<Path>>

/**
 * `unknown` when a route can run an action that needs `R` and fails with
 * `Err`; otherwise an object type naming what is wrong, which the action
 * cannot satisfy, so the compiler reports it at the registration.
 */
export type RouteActionCheck<R, Err, Services> = [ModelName<Exclude<R, Services>>] extends [never]
  ? [Exclude<R, Services>] extends [never]
    ? [Exclude<Err, AppError>] extends [never]
      ? unknown
      : {
          readonly unhandledErrors: ErrorTag<Exclude<Err, AppError>>
          readonly fix: "Answer each one in the action (Effect.catchTag), declare it in the endpoint's errors, or, for a failure the action cannot answer, such as another system being down, pipe that call through Effect.orDie, which answers 500 and reports it."
        }
    : {
        readonly missingServices: ServiceKey<Exclude<R, Services>>
        readonly fix: 'Configure the service: the database and auth in setupWeb, your own services with web.services({ app, request }), whose routes then accept it; or add it with routes.provide(layer).'
      }
  : {
      readonly missingRouteModels: ModelName<Exclude<R, Services>>
      readonly fix: "bound('name') reads the model a {name} placeholder in the route path loads: register the action, and any route a layer reading it guards, on a path, or under a prefix, that has one."
    }

/** A Cron Trigger's event, as the Worker's `scheduled` handler receives it. */
export interface ScheduledEvent {
  /** The cron expression that fired, as `wrangler.jsonc` lists it. */
  readonly cron: string
  /** When the run was scheduled, in milliseconds since the epoch. */
  readonly scheduledTime: number
}

/** What a queue handler knows of the message it handles. */
export interface QueueMessageInfo {
  readonly id: string
  /** How many times the queue has delivered it, this time included. */
  readonly attempts: number
}

/** A message of a queue batch, as the Worker's `queue` handler receives it. */
export interface QueueMessage extends QueueMessageInfo {
  readonly body: unknown
  ack(): void
  retry(): void
}

/** A queue batch, as the Worker's `queue` handler receives it. */
export interface QueueBatch {
  readonly messages: ReadonlyArray<QueueMessage>
}

/**
 * The paths a prefixed group registers: the declared paths that start with
 * the prefix, or any path when the application declares none.
 */
export type PathsUnder<Path extends string, Prefix extends string> = string extends Path
  ? string
  : Extract<Path, Prefix | `${Prefix}/${string}`>

/** An Effect `routes.run` can run: one whose services the routes provide. */
export type RunCheck<R, Services> = [ModelName<Exclude<R, Services>>] extends [never]
  ? [Exclude<R, Services>] extends [never]
    ? unknown
    : {
        readonly missingServices: ServiceKey<Exclude<R, Services>>
        readonly fix: 'Configure the service: the database and auth in setupWeb, your own services with web.services({ app, request }), whose routes then accept it; or add it with routes.provide(layer).'
      }
  : {
      readonly missingRouteModels: ModelName<Exclude<R, Services>>
      readonly fix: 'routes.run has no route path, so it binds no models: load the record with dbQuery, or pass it to the Effect.'
    }

/**
 * Whether a Hono route pattern matches every request a later path would:
 * each of its `:param` segments matches any one segment, including the later
 * path's own placeholders, and a trailing `*` matches the rest.
 */
function patternMatches(pattern: string, path: string): boolean {
  const segments = pattern.split('/')
  const target = path.split('/')

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]

    if (segment === '*' && i === segments.length - 1) return target.length >= segments.length - 1
    if (i >= target.length) return false
    if (segment.startsWith(':')) {
      // A parameter with a pattern or that is optional may not match it.
      if (target[i] === '' || segment.includes('{') || segment.endsWith('?')) return false
      continue
    }
    if (segment !== target[i]) return false
  }

  return segments.length === target.length
}

/** The bindings and schema setupWeb declared for an app, which registration checks paths against. */
const declaredBindings = new WeakMap<object, { readonly bindings?: RouteBindingsConfig; readonly schema?: object }>()

/** Record setupWeb's bindings and schema, so routes registered on the app are checked against them. */
export function declareAppBindings(app: object, declared: { readonly bindings?: RouteBindingsConfig; readonly schema?: object }): void {
  declaredBindings.set(app, declared)
}

/** The path the route that `run` sends its Effects through answers on. */
const RUN_PATH = '/__popweb/run'

/** An Effect waiting for `run`'s request, keyed by that request. */
interface RunJob {
  readonly effect: Effect.Effect<unknown, unknown, never>
  readonly done: (exit: Exit.Exit<unknown, unknown>) => void
}

const runJobs = new WeakMap<Request, RunJob>()
const appsWithRunner = new WeakSet<object>()

/**
 * Ends `run`'s job with a failure the framework's middleware found before
 * the job's route, such as bindings the env declaration refuses, so `run`
 * rejects with it rather than with the error page's status.
 *
 * @internal
 */
export function failRun(request: Request, error: unknown): void {
  runJobs.get(request)?.done(Exit.fail(error))
}

/**
 * An action a route with `Services` can run, under layers that need the
 * route models `Needs`.
 */
export type RouteAction<R, Err, Services, Needs = never> = Effect.Effect<Response | Redirect, Err, R> &
  RouteActionCheck<R | Needs, Err, Services>

/** A route path with its placeholders filled from the request's parameters: `{project}` and `{project:slug}` by `project`. */
function fillPlaceholders(path: string, params: Readonly<Record<string, string>>): string {
  return path.replace(/\{(\w+)(?::\w+)?\}/g, (placeholder, name: string) => {
    const value = params[name]

    return value === undefined ? placeholder : encodeURIComponent(value)
  })
}

/**
 * The action as the route runs it. RouteActionCheck rejects, at the call
 * site, any action whose failures are not AppError, so registered actions
 * fail only with AppError.
 */
function checkedAction<R, Err, Services, Needs>(
  action: RouteAction<R, Err, Services, Needs>
): Effect.Effect<Response | Redirect, AppError, R> {
  // SAFETY: see above; an action with other failures does not compile.
  return action as Effect.Effect<Response | Redirect, AppError, R>
}

/**
 * A declared path whose placeholders the route's own path provides: a page
 * the route's form can be on.
 */
export type FormPage<RoutePath extends string, Paths extends string> = Paths extends unknown
  ? [PathParamName<Paths>] extends [never]
    ? Paths
    : [Exclude<PathParamName<Paths>, PathParamName<RoutePath>>] extends [never]
      ? Paths
      : never
  : never

/** A route's options, with its form's page one of the declared paths its placeholders fill. */
export type RouteOptionsFor<RoutePath extends string, Paths extends string> =
  Omit<EffectRouteOptions, 'form'> & { readonly form?: FormPage<RoutePath, Paths> }

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
   * The page this route's form is on, which a failed form goes back to when
   * the request names no page of this site as its Referer, as a test that
   * posts without visiting the page first does. Its placeholders come from
   * this route's own. Without it, a route whose path also has a page (a
   * GET route) goes back to that page, and any other goes home.
   *
   * @example
   * ```typescript
   * routes.post(paths.bookSlot, bookSlot, { form: paths.slots })
   * ```
   */
  form?: string
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
   * `'private'` renders this route for every request, for pages whose
   * output changes without the framework seeing it (external fetches, the
   * current time): only the visitor's browser keeps the page, and checks
   * back each time (`Cache-Control: private, no-cache`). `'no-store'` keeps
   * it out of every cache, the browser's included, for a page only its link
   * should show, such as a signed preview.
   *
   * An object caches this route's responses for a fixed time via Cloudflare
   * Workers Cache instead, data reads included. Applied to successful
   * GET/HEAD responses only; partial reloads, signed-in requests and
   * responses that set a cookie are marked no-store, and stored responses
   * vary on X-Inertia and Cookie, so only visitors without cookies share
   * them. Requires
   * `"cache": { "enabled": true }` in wrangler config.
   */
  cache?: RouteCacheOptions | 'private' | 'no-store'
  /**
   * After this route's effect succeeds (any Redirect, or a Response below
   * 400), purge these Workers Cache tags. `true` purges the record of each
   * of the route's model bindings, the tag every cached page that reads it
   * carries (see recordCacheTag), and the table of its last binding:
   * PUT /projects/{project} purges `projects:{id}` and `projects`. Records
   * the action changes that the route does not name, it purges with
   * `purgeCache(...tags)`.
   */
  purges?: true | readonly CacheTag[]
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
/** A signed-in user's id: Better Auth's are strings, or numbers when it generates serial ids. */
type UserId = string | number | bigint

const isUserId = (value: unknown): value is UserId =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'

type BindingLoadOutcome =
  | LoadedModels
  | { readonly missing: string }
  | { readonly signedOut: string }
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
    // A header, cookie or request state the response depends on, such as an
    // API key a route's own layer reads, is no part of a shared cache's key.
    requestCtx.readRequestState === true ||
    c.req.header('Authorization') !== undefined ||
    hasSessionCookie(c.req.header('Cookie'), requestCtx.sessionCookies ?? [])
  )
}

/** Headers that hand the recipient something of their own, as a cookie does. */
const PER_RECIPIENT_HEADERS: ReadonlySet<string> = new Set(['set-cookie', 'set-auth-token'])

/** A route's response as its cache policy sees it, with what web() writes on it later. */
interface AnsweredResponse {
  readonly response: Response
  /** Whether the response sets a cookie, itself or through what web() writes. */
  readonly setsCookie: boolean
}

/**
 * The route's response with what web() writes on it once the route has
 * answered, which its cache policy must see: the Cache-Control headers an
 * action or layer added with responseHeader, moved onto the response, where
 * the policy keeps a stricter one and replaces any other as it does the
 * response's own; and whether it sets a cookie, as an application cookie,
 * Better Auth's cookies or set-auth-token, the session lookup's renewal or
 * expiry, or the flash cookie does.
 */
function withDeferredOutput<E extends Env>(c: HonoContext<E>, response: Response): AnsweredResponse {
  const context = openWebContext(c)
  const added = context.responseHeaders ?? []
  const setsCookie =
    response.headers.has('Set-Cookie') ||
    (context.responseCookies ?? []).length > 0 ||
    (context.sessionLookupCookies ?? []).length > 0 ||
    added.some(([name]) => PER_RECIPIENT_HEADERS.has(name.toLowerCase())) ||
    context.flash?.setsCookie(response.status) === true

  const cacheControl = added.filter(([name]) => name.toLowerCase() === 'cache-control')

  if (cacheControl.length === 0) return { response, setsCookie }

  context.responseHeaders = added.filter(([name]) => name.toLowerCase() !== 'cache-control')

  const headers = new Headers(response.headers)

  for (const [, value] of cacheControl) headers.append('Cache-Control', value)

  return {
    response: new Response(response.body, { status: response.status, statusText: response.statusText, headers }),
    setsCookie,
  }
}


/**
 * Effect Route Builder with layer composition.
 */
export class EffectRouteBuilder<
  E extends Env,
  Services = BaseServices,
  /** The paths routes may be registered on: setupWeb's `paths`, or any path. */
  Path extends string = string,
  /** The route models the provided layers read with `bound()`, which each route's path must bind. */
  Needs = never
> {
  constructor(
    private readonly app: Hono<E>,
    private readonly layers: Layer.Layer<never, AppError, never>[] = [],
    private readonly pathPrefix: string = '',
    private readonly bridgeConfig?: EffectBridgeConfig<E, never>,
    private readonly registry: RouteRegistry = getAppRouteRegistry(app),
    private readonly middlewares: MiddlewareHandler<E>[] = [],
    /** Whether every request to these routes is a JSON client (`jsonApi()`). */
    private readonly answersJson: boolean = false
  ) {
    this.installRunner()
  }

  /**
   * The route `run` sends its Effects through, registered once per app,
   * before any of the application's routes. It answers 404 to any request
   * but `run`'s own, which carries its Effect by identity.
   */
  private installRunner(): void {
    if (appsWithRunner.has(this.app)) return

    appsWithRunner.add(this.app)

    const runner = Effect.gen(function* () {
      const request = yield* RequestService
      const job = runJobs.get(request.raw())

      if (!job) return yield* new NotFoundError({ resource: 'page' })

      const exit = yield* Effect.exit(job.effect)
      job.done(exit)

      return new Response(null, { status: Exit.isSuccess(exit) ? 204 : 500 })
    })

    const base = new EffectRouteBuilder<E, Services, Path, Needs>(this.app, [], '', this.bridgeConfig, this.registry, [])

    this.app.get(RUN_PATH, base.createHandler(runner, [], { cache: 'private' }))
  }

  /**
   * Run an Effect with the application's services outside a request, such as
   * in a Cron Trigger or a Queue consumer: the database, `services`, `Config`
   * from the bindings and `background()` work as they do in an action, with
   * this builder's provided layers. Resolves with the Effect's value and
   * rejects with its failure. A test passes `testEnv(layer, bindings)` as
   * `env`, so its fakes, clock and database apply.
   *
   * @example
   * export default {
   *   fetch: app.fetch,
   *   scheduled: async (_event, env, ctx) => {
   *     await routes.run(expireHolds, env, ctx)
   *   },
   * }
   */
  async run<A, Err, R>(
    effect: Effect.Effect<A, Err, R> & RunCheck<R | Needs, Services>,
    // Partial, so a test passes testEnv's bindings and its layer applies; a
    // binding the Effect reads that is missing fails as it does in a request.
    env: Partial<E['Bindings']>,
    executionCtx?: ExecutionContext
  ): Promise<A> {
    let provided: Layer.Layer<never, AppError, never> = Layer.empty

    for (const layer of this.layers) {
      provided = Layer.provideMerge(layer, provided)
    }

    const request = new Request(`http://localhost${RUN_PATH}`)
    let result: Exit.Exit<unknown, unknown> | undefined

    runJobs.set(request, {
      // SAFETY: RunCheck admits only Effects whose services this builder's
      // routes provide; the runner route runs with the setup's services and
      // this builder's layers are provided here.
      effect: Effect.provide(effect, provided) as Effect.Effect<unknown, unknown, never>,
      done: (exit) => {
        result = exit
      },
    })

    try {
      const response = await this.app.fetch(request, env, executionCtx)

      if (result === undefined) {
        throw new Error(`routes.run could not reach its route; the app answered ${response.status}. Register catch-all routes after setupWeb.`)
      }
    } finally {
      runJobs.delete(request)
    }

    if (Exit.isFailure(result)) throw Cause.squash(result.cause)

    // SAFETY: the job's exit is the exit of `effect`, whose success is A.
    return result.value as A
  }

  /**
   * The Worker's `scheduled` handler: runs the Effect `job` returns for each
   * Cron Trigger with the application's services, as `run` does, so a failed
   * run rejects and the platform records it. A test calls the handler with
   * the event and `testEnv`'s bindings.
   *
   * @example
   * export default {
   *   fetch: app.fetch,
   *   scheduled: routes.scheduled((event) => event.cron === '0 3 * * *' ? forgetAbandonedOrders : Effect.void),
   * }
   *
   * // In a test:
   * await worker.scheduled({ cron: '0 3 * * *', scheduledTime: Date.now() }, testEnv(time.layer, testBindings))
   */
  scheduled<Err, R>(
    job: (event: ScheduledEvent) => Effect.Effect<unknown, Err, R> & RunCheck<R | Needs, Services>
  ): (event: ScheduledEvent, env: Partial<E['Bindings']>, executionCtx?: ExecutionContext) => Promise<void> {
    return async (event, env, executionCtx) => {
      await this.run(job(event), env, executionCtx)
    }
  }

  /**
   * The Worker's `queue` handler: decodes each message's body with `schema`
   * and runs the Effect `handle` returns for it with the application's
   * services, one message at a time. A message whose Effect succeeds is
   * acknowledged; one whose body does not decode, or whose Effect fails, is
   * logged and left for the queue to retry, and after its retries the queue
   * drops it or moves it to its dead-letter queue.
   *
   * @example
   * const Reminder = S.Struct({ orderId: S.String })
   *
   * export default {
   *   fetch: app.fetch,
   *   queue: routes.queue(Reminder, (reminder) => sendReminder(reminder.orderId)),
   * }
   *
   * // In a test, with testBatch from @popcomputer/web/testing:
   * const batch = testBatch([{ orderId: 'order-1' }])
   * await worker.queue(batch, testEnv(fakeMailer, testBindings))
   * expect(batch.acked()).toHaveLength(1)
   */
  queue<A, I, Err, R>(
    schema: S.Codec<A, I, never, never>,
    handle: (body: A, message: QueueMessageInfo) => Effect.Effect<unknown, Err, R> & RunCheck<R | Needs, Services>
  ): (batch: QueueBatch, env: Partial<E['Bindings']>, executionCtx?: ExecutionContext) => Promise<void> {
    const decode = S.decodeUnknownEffect(schema)

    return async (batch, env, executionCtx) => {
      for (const message of batch.messages) {
        const work = Effect.flatMap(decode(message.body), (body) => handle(body, message)).pipe(
          Effect.tapCause((cause) => Effect.logError(`Queue message ${message.id} failed; the queue will retry it.`, cause))
        )

        // SAFETY: decoding adds only a SchemaError, which `run` reports like
        // the handler's own failures; the services are the handler's, which
        // RunCheck admitted.
        const checked = work as Effect.Effect<unknown, unknown, R> & RunCheck<R | Needs, Services>

        await this.run(checked, env, executionCtx).then(
          () => message.ack(),
          () => message.retry()
        )
      }
    }
  }

  /**
   * Add a layer to provide services to all routes in this builder.
   * The layer may be self-contained (`R = never`) or consume services already
   * available in this route context (`BaseServices`, previously provided services,
   * and bridge-level custom services).
   * The layer's error type must be handled by the effect bridge (AppError or subtype).
   * A layer that reads route models with `bound()` guards only routes whose
   * paths bind them.
   */
  provide<
    S,
    LayerErr extends AppError,
    LayerReq extends Services | RouteModel<string>
  >(
    layer: Layer.Layer<S, LayerErr, LayerReq>
  ): EffectRouteBuilder<E, Services | S, Path, Needs | Exclude<LayerReq, Services>> {
    // SAFETY: The route builder established the matching Drizzle and Effect contracts; this adapter only restores generic information their public types erase.
    return new EffectRouteBuilder<E, Services | S, Path, Needs | Exclude<LayerReq, Services>>(
      this.app,
      [
        ...this.layers,
        // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- SAFETY: provide's LayerReq constraint only accepts base, bridge, or previously provided services; createHandler composes those before this private layer is built. Preserve LayerErr for the request error boundary.
        layer as Layer.Layer<S, LayerErr, never>,
      ],
      this.pathPrefix,
      this.bridgeConfig,
      this.registry,
      this.middlewares,
      this.answersJson
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
  ): EffectRouteBuilder<E, Services, Path, Needs> {
    return new EffectRouteBuilder<E, Services, Path, Needs>(
      this.app,
      this.layers,
      this.pathPrefix,
      this.bridgeConfig,
      this.registry,
      [...this.middlewares, ...handlers],
      this.answersJson
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
  ): this {
    if (this.pathPrefix) {
      const prefix = toHonoPath(this.pathPrefix)

      // Two patterns: '/api/*' does not match '/api' itself in Hono
      this.app.use(prefix, ...handlers)
      this.app.use(`${prefix}/*`, ...handlers)
    } else {
      this.app.use('/*', ...handlers)
    }

    return this
  }

  /**
   * Group routes under a path prefix. The prefix's `{placeholders}` bind
   * models for every route under it, so a guard layer provided here can read
   * them with `bound()`. In an application that declares its paths, the
   * routes under the prefix are registered with their whole declared paths,
   * which must start with it; without declared paths, a route's path may be
   * relative to the prefix.
   *
   * @example
   * routes.prefix('/orgs/{org}').provide(OrgMemberGuard)
   *   .get(paths.orgSettings, showSettings)   // '/orgs/{org}/settings'
   *   .get(paths.orgMembers, listMembers)     // '/orgs/{org}/members'
   */
  prefix<const Prefix extends string>(
    path: Prefix
  ): EffectRouteBuilder<E, Services | PathModels<Prefix>, PathsUnder<Path, Prefix>, Needs> {
    const normalizedPath = path.replace(/\/$/, '')

    return new EffectRouteBuilder<E, Services | PathModels<Prefix>, PathsUnder<Path, Prefix>, Needs>(
      this.app,
      this.layers,
      this.pathPrefix + normalizedPath,
      this.bridgeConfig,
      this.registry,
      this.middlewares,
      this.answersJson
    )
  }

  /**
   * Answer every request to these routes as a JSON client, whatever headers
   * it sends: a failure is the JSON error envelope, a signed-out request is a
   * 401 rather than a redirect to sign in, and invalid input is a 422. Use it
   * for an API whose clients may send neither `Accept` nor `Authorization`.
   *
   * @example
   * routes.jsonApi().provide(TillKeyAuth).post(paths.apiSales, recordSale)
   */
  jsonApi(): EffectRouteBuilder<E, Services, Path, Needs> {
    return new EffectRouteBuilder<E, Services, Path, Needs>(
      this.app,
      this.layers,
      this.pathPrefix,
      this.bridgeConfig,
      this.registry,
      this.middlewares,
      true
    )
  }

  /**
   * Register routes that share this builder's prefix, layers and middleware.
   * Returns the builder so registrations can continue after the group.
   */
  group(callback: (route: EffectRouteBuilder<E, Services, Path, Needs>) => void): this {
    callback(this)

    return this
  }

  /**
   * Resolve the full path.
   */
  private resolvePath(path: string): string {
    if (!this.pathPrefix) return path

    // A declared path under the prefix is whole; another is relative to it.
    if (path === this.pathPrefix || path.startsWith(`${this.pathPrefix}/`)) return path

    return path === '/' ? this.pathPrefix : `${this.pathPrefix}${path}`
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
    userId: UserId | undefined,
  ): Promise<BindingLoadOutcome> {
    if (plan.length === 0) {
      return { models: new Map(), recordTags: [] }
    }

    const { eq, and, isNull } = await loadDrizzle()

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

      // A record only its owner may load is never looked up for anyone else.
      if (binding.access !== undefined && 'ownedBy' in binding.access && userId === undefined) {
        return { signedOut: binding.param }
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

      // Who may load the record narrows the same query, so another user's
      // record, or one its column keeps private, is missing like any other.
      if (binding.access !== undefined) {
        const required: ReadonlyArray<readonly [string, unknown]> = 'ownedBy' in binding.access
          ? [[binding.access.ownedBy, userId]]
          : Object.entries(binding.access.publicWhen)
        const table = binding.table

        // SAFETY: The route builder established the matching Drizzle and Effect contracts; this adapter only restores generic information their public types erase.
        const columnOf = (key: string) => Object.getOwnPropertyDescriptor(table, key)?.value as Parameters<typeof eq>[0]

        // SAFETY: The route builder established the matching Drizzle and Effect contracts; this adapter only restores generic information their public types erase.
        whereCondition = and(
          whereCondition as Parameters<typeof and>[number],
          ...required.map(([key, value]) => value === null ? isNull(columnOf(key)) : eq(columnOf(key), value))
        )
      }

      // SAFETY: The route builder established the matching Drizzle and Effect contracts; this adapter only restores generic information their public types erase.
      const dbClient = db as {
        select: () => { from: <TableValue>(table: TableValue) => QueryBuilder }
      }

      const query: QueryBuilder = dbClient.select().from(binding.table).where(whereCondition)

      // Two rows at most: a lookup column that is not unique within the
      // route's scope names no single record, so it fails instead of
      // picking one. (.limit works on every dialect; only SQLite has .get().)
      const results = await query.limit(2)
      const result = results[0]

      if (!result) {
        return { missing: binding.param }
      }

      if (results.length > 1) {
        throw RouteConfigurationError.ambiguousBinding(binding.param, binding.tableName, binding.column)
      }

      // SAFETY: The route builder established the matching Drizzle and Effect contracts; this adapter only restores generic information their public types erase.
      rows.set(binding.param, result)
      models.set(binding.param, await decodeBoundRow(binding, result))
      const key: unknown = Object.getOwnPropertyDescriptor(result, binding.primaryKey)?.value

      if (key !== undefined && key !== null) {
        recordTags.push(formatRecordTag(binding.tableName, key))
      }
    }

    return { models, recordTags }
  }

  private createHandler<R>(
    effect: Effect.Effect<Response | Redirect, AppError, R>,
    bindings: ParsedBinding[],
    options?: EffectRouteOptions,
    routePath?: string,
    fullPath?: string
  ): MiddlewareHandler<E> {
    const layers = this.layers
    const bridgeConfig = this.bridgeConfig
    const registry = this.registry
    // The page this route's form is on: its `form` option, else its own path
    // when a page is registered there, which the first request looks up once
    // every route is registered.
    let formPage: string | null | undefined = options?.form
    const formPageOf = (): string | null => {
      formPage ??= routePath !== undefined && registry.all().some((route) => route.method === 'get' && route.fullPath === fullPath)
        ? routePath
        : null

      return formPage
    }
    let bindingPlanPromise: Promise<readonly CompiledRouteBinding[]> | undefined
    // Dev-only observability for an ineffective `cache` option:
    // once per route (this handler closure), not once per request.
    let warnedIneffectiveCache = false

    // A bound route reads its model from the database, and an explicit cache
    // option owns this route's caching. A cached page is served before any
    // guard or route middleware runs, so a route either one decides for is
    // never cached by default: it may turn visitors away by what no cache key
    // holds, such as their address or country.
    const allowsDefaultPageCache =
      options?.cache === undefined &&
      bindings.length === 0 &&
      this.middlewares.length === 0 &&
      !layers.some(isGuard)

    const answersJson = this.answersJson

    // oxlint-disable-next-line effecttsgo/async-function -- This Hono adapter awaits request parsing and runtime completion, then maps the result to an HTTP response.
    return async (c) => {
      setEffectBridgeConfig(c, bridgeConfig)

      if (answersJson) openWebContext(c).jsonApi = true

      const page = c.req.method === 'GET' ? null : formPageOf()
      if (page !== null) openWebContext(c).formPage = fillPlaceholders(page, c.req.param())

      if (allowsDefaultPageCache) {
        allowDefaultPageCache(c)
      }

      // Get schema from bridgeConfig or from context (set by setupWeb/effectBridge)
      const schema = bridgeConfig?.schema ?? getEffectSchema(c)
      const configuredBindings = bridgeConfig?.bindings ?? getEffectBindings(c)
      // A {param} with a binding parser names a model; any other is a plain
      // parameter the action reads with validateRequest.
      const modelBindings = configuredBindings
        ? bindings.filter((binding) => Object.hasOwn(configuredBindings, binding.param))
        : []

      // Use provided params schema, or infer from database schema if available
      const paramsSchema = options?.params ?? (
        modelBindings.length > 0 && schema
          ? inferParamsSchema(modelBindings, schema, configuredBindings) ?? undefined
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
          bridgeConfig.services(observedRequestContext(c)).pipe(Layer.provide(bindingsConfiguration(c.env)))
        )
      }

      // Resolve route model bindings if we have any and schema is configured
      // Route models load on the action's first bound() call, after guards.

      // A guarded binding loads once a guard(...) the route is provided has
      // read it. The route's records load together, so until then nothing
      // else may ask for any of them: an action, a layer that reads a record
      // for breadcrumbs, or a purge.
      const guarded = modelBindings.map((binding) => binding.param).filter((name) => isGuardedBinding(configuredBindings?.[name]))
      const decided = new Set<string>()
      const undecided = (): string | undefined => guarded.find((name) => !decided.has(name))

      // oxlint-disable-next-line effecttsgo/async-function -- This Hono/Drizzle adapter awaits native query builders sequentially to enforce parent binding scope before returning a typed outcome.
      const loadModels = async (
        bindingSchema: object,
        parsers: RouteBindingsConfig,
        db: object,
        userId: UserId | undefined
      ): Promise<BindingLoadOutcome> => {
        try {
          bindingPlanPromise ??= compileBindingPlan(modelBindings, bindingSchema, parsers)

          return await this.resolveBindings(c, await bindingPlanPromise, db, userId)
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
        database: Option.Option<object>,
        userId: UserId | undefined
      ): Effect.Effect<LoadedModels, BoundModelError> =>
        Effect.gen(function* () {
          if (!configuredBindings || modelBindings.length === 0) {
            return { models: new Map(), recordTags: [] }
          }

          if (Option.isNone(database)) {
            return yield* ConfigurationError.databaseNotConfigured()
          }

          const db = database.value

          const outcome = yield* Effect.promise(() =>
            loadModels(schema ?? {}, configuredBindings, db, userId)
          )

          if ('failure' in outcome) return yield* outcome.failure

          if ('signedOut' in outcome) {
            return yield* new UnauthorizedError({ message: 'Authentication required' })
          }

          if ('missing' in outcome) {
            return yield* new NotFoundError({ resource: outcome.missing })
          }

          return outcome
        })

      // bound() and the route's cache tags read the same models, loaded once.
      const boundModelsLayer = Layer.effectContext(
        Effect.gen(function* () {
          const database = yield* Effect.serviceOption(DatabaseService)
          // The signed-in user, whose id a binding only its owner may load is
          // looked up by, read when the models first load rather than now, so
          // a layer the route provides, such as an API key's, has given it.
          // AuthUserService holds the user and the session.
          const load = yield* Effect.cached(Effect.gen(function* () {
            const signedIn = yield* Effect.serviceOption(AuthUserService)
            const user: unknown = Option.isSome(signedIn) ? Reflect.get(signedIn.value, 'user') : undefined
            const userId: unknown = user instanceof Object ? Reflect.get(user, 'id') : undefined

            return yield* loadAllModels(database, isUserId(userId) ? userId : undefined)
          }))

          const models = BoundModels.of({
            get: (key) => {
              if (!bindings.some((binding) => binding.param === key)) {
                return Effect.fail(RouteConfigurationError.bindingNotInRoute(key))
              }

              if (!schema) {
                return Effect.fail(RouteConfigurationError.schemaNotConfigured(key))
              }

              if (!modelBindings.some((binding) => binding.param === key)) {
                return Effect.fail(RouteConfigurationError.bindingParserNotConfigured(key))
              }

              return Effect.flatMap(isDeciding, (deciding) => {
                if (deciding) decided.add(key)

                const unguarded = deciding ? undefined : undecided()

                return unguarded === undefined
                  ? Effect.map(load, (loaded) => loaded.models.get(key))
                  : Effect.fail(RouteConfigurationError.guardedWithoutGuard(unguarded))
              })
            },
          })

          // A record the action removed, or never loaded and no longer
          // exists, names no cached page.
          // Purging the records a route names reads them too, so a guarded
          // one no guard read purges nothing for a visitor the guard would
          // have turned away.
          const unguardedRead = Effect.suspend(() => {
            const unguarded = undecided()

            return unguarded === undefined ? Effect.void : Effect.fail(RouteConfigurationError.guardedWithoutGuard(unguarded))
          })

          const records = RouteRecords.of({
            tags: unguardedRead.pipe(
              Effect.andThen(load),
              Effect.map((loaded) => loaded.recordTags),
              Effect.catchTag('NotFoundError', () => Effect.succeed([])),
              Effect.catchTag('UnauthorizedError', () => Effect.succeed([]))
            ),
          })

          return Context.make(BoundModels, models).pipe(Context.add(RouteRecords, records))
        })
      )

      let fullLayer: Layer.Layer<never, AppError, never> = Layer.provideMerge(
        boundModelsLayer,
        Layer.mergeAll(
          contextLayer,
          Layer.succeed(PendingPurges, makePendingPurges()),
          Layer.succeed(PendingCacheTags, makePendingCacheTags())
        )
      )

      for (const layer of layers) {
        fullLayer = Layer.provideMerge(layer, fullLayer)
      }

      // The services a test gives with testEnv replace the route's own, as
      // they replace the request's: built once with the request, given last.
      const testServices = openWebContext(c).testServices

      if (testServices !== undefined) {
        fullLayer = Layer.provideMerge(Layer.succeedContext(testServices), fullLayer)
      }

      let handlerEffect: Effect.Effect<
        Response | Redirect,
        AppError | ResponseCachePurgeError,
        R | ResponseCacheService | RouteRecords | PendingPurges | PendingCacheTags
      > = effect

      // A cacheable page is tagged with the records its route read, so a
      // write to any of them purges it.
      let recordTags: readonly string[] = []
      const cacheOption = options?.cache

      if (typeof cacheOption === 'object' && BODYLESS_METHODS.has(c.req.method)) {
        handlerEffect = handlerEffect.pipe(
          Effect.tap((result) =>
            result instanceof Response && result.status >= 200 && result.status < 300
              ? Effect.gen(function* () {
                  const records = modelBindings.length > 0 ? yield* Effect.flatMap(RouteRecords, (route) => route.tags) : []
                  const added = yield* Effect.flatMap(PendingCacheTags, (pending) => pending.take)

                  recordTags = [...new Set([...records, ...added])]
                })
              : Effect.void
          )
        )
      }

      // After a successful mutation, purge the declared Workers Cache tags.
      // Runs inside the effect so a failed purge surfaces in the typed error
      // channel instead of leaving stale entries silently.
      const purges = options?.purges

      const writtenModel = modelBindings[modelBindings.length - 1]
      const writtenTable = writtenModel ? [bindingTableName(writtenModel, configuredBindings, schema)] : []

      const routePurges: Effect.Effect<readonly string[], BoundModelError, RouteRecords> =
        purges === true
          ? Effect.flatMap(RouteRecords, (records) => records.tags).pipe(
              Effect.map((tags) => [...tags, ...writtenTable])
            )
          : Effect.succeed(purges ?? [])

      // The route's purges and any the action asked for with purgeCache run
      // once, after the action succeeds.
      handlerEffect = handlerEffect.pipe(
        Effect.tap((result) => {
          const succeeded =
            result instanceof Redirect ||
            (result instanceof Response && result.status < 400)

          if (!succeeded) return Effect.void

          return Effect.gen(function* () {
            const requested = yield* Effect.flatMap(PendingPurges, (pending) => pending.take)

            yield* purgeTags([...new Set([...(yield* routePurges), ...requested])])
          })
        })
      )

      // The route runtime owns every provided Layer until background work has
      // settled, including scoped services added with route.provide().
      // SAFETY: the route's Services type admits only actions whose
      // requirements setupWeb, effect.services and provide() supply, and the
      // composition above provides those services; acquisition failures remain
      // AppError. effectRoutes(app) assumes every framework service, so an
      // unconfigured one is still reported at runtime as a configuration error.
      const routeRuntime = ManagedRuntime.make(
        fullLayer as Layer.Layer<R | ResponseCacheService | RouteRecords | PendingPurges | PendingCacheTags, AppError>
      )

      let response: Response

      try {
        response = await runEffectWithRuntime(handlerEffect, c, routeRuntime)
      } finally {
        await disposeRequestRuntime(c, routeRuntime)
      }

      if (options?.cache === 'no-store' && response instanceof Response && !response.headers.has('Cache-Control')) {
        const headers = new Headers(response.headers)
        headers.set('Cache-Control', 'no-store')

        return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
      }

      // The route says so itself, so it holds in an application composed
      // without setupWeb's privateByDefault: only the visitor's browser keeps
      // the page, or no cache at all when it is someone's own or sets a cookie.
      if (options?.cache === 'private' && response instanceof Response) {
        const answered = withDeferredOutput(c, response)

        if (answered.response.headers.has('Cache-Control')) return answered.response

        const headers = new Headers(answered.response.headers)
        headers.set('Cache-Control', defaultCacheControl(c, answered.setsCookie))

        return new Response(answered.response.body, { status: answered.response.status, statusText: answered.response.statusText, headers })
      }

      if (typeof options?.cache !== 'object' || !(response instanceof Response)) {
        return response
      }

      const answered = withDeferredOutput(c, response)

      const decision = decideCachePolicy({
        method: c.req.method,
        status: answered.response.status,
        isPartialReload: isPartialReloadRequest((name) => c.req.header(name)),
        setsCookie: answered.setsCookie,
        hasPrivateRequestState: hasPrivateRequestState(c),
        existingCacheControl: answered.response.headers.get('Cache-Control'),
        isPage: isPageResponse(answered.response.headers),
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

      return applyCachePolicy(answered.response, decision)
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
    // The prefix's placeholders are the route's too: /orgs/{org} as a prefix
    // binds org for every route under it.
    const routePath = this.resolvePath(path)
    const bindings = parseBindings(routePath)
    const honoPath = toHonoPath(path)
    const fullPath = toHonoPath(routePath)

    const configured = this.bridgeConfig?.bindings

    const declared = declaredBindings.get(this.app)
    assertBindingColumns(bindings, configured ?? declared?.bindings, this.bridgeConfig?.schema ?? declared?.schema)

    // A record that depends on who is visiting is someone's own: a shared
    // cache, which answers before the Worker runs, would hand it to the next.
    const personal = assertRouteAccess(bindings, configured ?? declared?.bindings)

    if (typeof options?.cache === 'object' && personal.size > 0) {
      throw RouteConfigurationError.cacheOnPersonalRoute(routePath, [...personal]).atStartup()
    }

    if (
      options?.purges === true &&
      !bindings.some((binding) => (configured ? Object.hasOwn(configured, binding.param) : true))
    ) {
      throw RouteConfigurationError.purgesWithoutBindings(path).atStartup()
    }

    // Routes answer in registration order, so a path an earlier route's
    // pattern matches, such as /products/new after /products/{product}, is
    // never reached.
    const shadowing = this.registry.all().find((earlier) =>
      (earlier.method === method || earlier.method === 'all') && patternMatches(earlier.fullPath, fullPath)
    )

    if (shadowing) {
      throw (shadowing.fullPath === fullPath && shadowing.method === method
        ? RouteConfigurationError.routeRegisteredTwice(method, path)
        : RouteConfigurationError.routeShadowed(method, path, shadowing.method, shadowing.path)
      ).atStartup()
    }

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
    const handler = this.createHandler(effect, bindings, options, routePath, fullPath)

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
  get<const P extends Path, R, Err>(
    path: P,
    effect: RouteAction<R, Err, Services | PathModels<P>, Needs>,
    options?: RouteOptionsFor<P, Path>
  ): this {
    this.registerRoute('get', path, checkedAction(effect), options)

    return this
  }

  /** Register a POST route. Supports Laravel-style route model binding: /projects/{project} */
  post<const P extends Path, R, Err>(
    path: P,
    effect: RouteAction<R, Err, Services | PathModels<P>, Needs>,
    options?: RouteOptionsFor<P, Path>
  ): this {
    this.registerRoute('post', path, checkedAction(effect), options)

    return this
  }

  /** Register a PUT route. Supports Laravel-style route model binding: /projects/{project} */
  put<const P extends Path, R, Err>(
    path: P,
    effect: RouteAction<R, Err, Services | PathModels<P>, Needs>,
    options?: RouteOptionsFor<P, Path>
  ): this {
    this.registerRoute('put', path, checkedAction(effect), options)

    return this
  }

  /** Register a PATCH route. Supports Laravel-style route model binding: /projects/{project} */
  patch<const P extends Path, R, Err>(
    path: P,
    effect: RouteAction<R, Err, Services | PathModels<P>, Needs>,
    options?: RouteOptionsFor<P, Path>
  ): this {
    this.registerRoute('patch', path, checkedAction(effect), options)

    return this
  }

  /** Register a DELETE route. Supports Laravel-style route model binding: /projects/{project} */
  delete<const P extends Path, R, Err>(
    path: P,
    effect: RouteAction<R, Err, Services | PathModels<P>, Needs>,
    options?: RouteOptionsFor<P, Path>
  ): this {
    this.registerRoute('delete', path, checkedAction(effect), options)

    return this
  }

  /**
   * Register an OPTIONS route, such as a CORS preflight answering which
   * origins, methods and headers a browser may use.
   */
  options<const P extends Path, R, Err>(
    path: P,
    effect: RouteAction<R, Err, Services | PathModels<P>, Needs>,
    options?: RouteOptionsFor<P, Path>
  ): this {
    this.registerRoute('options', path, checkedAction(effect), options)

    return this
  }

  /** Register a route for all HTTP methods. Supports Laravel-style route model binding: /projects/{project} */
  all<const P extends Path, R, Err>(
    path: P,
    effect: RouteAction<R, Err, Services | PathModels<P>, Needs>,
    options?: RouteOptionsFor<P, Path>
  ): this {
    this.registerRoute('all', path, checkedAction(effect), options)

    return this
  }

  /**
   * Register the action implementing an endpoint on the endpoint's method and
   * path, which its contract declares. It answers JSON, failures included,
   * as `jsonApi()` routes do.
   *
   * @example
   * routes.provide(RequireAuthLayer)
   *   .endpoint(listPlaces)
   *   .endpoint(createPlace, { name: 'places.store', purges: ['places'] })
   */
  endpoint<Ep extends Endpoint, R, Err>(
    action: EndpointAction<Ep, Err, R> & RouteActionCheck<R | Needs, Err, Services | PathModels<Ep['path']>>,
    options?: EffectRouteOptions
  ): this {
    const path = action.endpoint.path

    if (this.pathPrefix !== '' && path !== this.pathPrefix && !path.startsWith(`${this.pathPrefix}/`)) {
      throw RouteConfigurationError.endpointUnderPrefix(path, this.pathPrefix).atStartup()
    }

    // SAFETY: RouteActionCheck rejects, at the call site, an action whose
    // failures are not AppError, as checkedAction does.
    const effect = action.effect as Effect.Effect<Response, AppError, R>
    const json = this.answersJson ? this : this.jsonApi()

    json.registerRoute(action.endpoint.method, action.endpoint.path, effect, options)

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
