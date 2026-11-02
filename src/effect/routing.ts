/**
 * Effect Route Builder
 *
 * Laravel-style routing with Effect handlers.
 */

import { Cause, Effect, Exit, Layer, ManagedRuntime, Schema as S } from 'effect'
import { Context as HonoRequestContext } from 'hono'
import type { Context as HonoContext, ExecutionContext, Hono, MiddlewareHandler, Env } from 'hono'
import { renderErrorResponse, runEffectWithRuntime } from './handler.js'
import {
  bindingsConfiguration,
  buildContextLayer,
  disposeRequestRuntime,
  getEffectBridgeConfig,
  serviceRequestContext,
  setEffectBridgeConfig,
  type EffectBridgeConfig,
} from './bridge.js'
import {
  type AppError,
  NotFoundError,
  Redirect,
  RouteConfigurationError,
} from './errors.js'
import { openWebContext } from '../request-context.js'
import { isDevelopment } from '../development.js'
import { setupOf } from '../web-setup.js'
import { finishResponse } from '../response-output.js'
import type { CookieService } from './cookies.js'
import type { Endpoint } from '../endpoint.js'
import type { EndpointAction } from './endpoint-action.js'
import type { ResponseHeaders } from './response-headers.js'
import { allowDefaultPageCache, defaultCacheControl, isPersonalRequest, observedRequestContext } from '../page-cache.js'
import { keptFrom, recordPrivacy } from '../privacy.js'
import {
  applyRouteCacheOption,
  isPartialReloadRequest,
  purgeTags,
  type ResponseCachePurgeError,
  type ResponseCacheService,
  PendingPurges,
  makePendingPurges,
  PendingCacheTags,
  makePendingCacheTags,
  type CacheTag,
  type RouteCacheOptions,
} from './response-cache.js'
import { RequestService, type DatabaseService } from './services.js'
import { isGuard } from './guard.js'
import { RouteRecords, routeModelsLayer, routeModelsOnce, type RouteModels } from './route-models.js'
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
  bindingTableName,
  assertBindingColumns,
  assertRouteAccess,
  type BoundModelError,
  type BoundModels,
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

/**
 * The services only a request has: its input, its state, the page and the
 * response it answers with. A job, from `run`, `scheduled` or `queue`, has
 * none of them.
 */
type RequestOnlyServices =
  | RequestService
  | RequestStateService
  | PageService
  | ResponseFactoryService
  | CookieService
  | ResponseHeaders

/**
 * An Effect `routes.run`, `scheduled` and `queue` can run: one whose services
 * the routes provide, but for those only a request has.
 */
export type RunCheck<R, Services> = [ModelName<Exclude<R, Services>>] extends [never]
  ? [Extract<R, RequestOnlyServices>] extends [never]
    ? [Exclude<R, Services>] extends [never]
      ? unknown
      : {
          readonly missingServices: ServiceKey<Exclude<R, Services>>
          readonly fix: 'Configure the service: the database and auth in setupWeb, your own services with web.services({ app, request }), whose routes then accept it; or add it with routes.provide(layer).'
        }
    : {
        readonly requestOnlyServices: ServiceKey<Extract<R, RequestOnlyServices>>
        readonly fix: 'A job has no request: no input to validate, no cookies or headers, and no page or response to answer with. Pass what it needs as its input, from the route that sends it, and return a value.'
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

/**
 * What readying a job's services gave: the failure that refuses every job,
 * such as bindings the env declaration refuses, or what releases them once
 * the job's background work has settled.
 */
export type JobPreparation =
  | { readonly failure: Error }
  | { readonly release: () => Promise<void> }

type JobPreparer<E extends Env> = (c: HonoContext<E>) => Promise<JobPreparation>

/**
 * How each app's setupWeb readies a job's services on a context of the
 * job's own, kept for any app's Env: each is read back by that app's
 * builders, with its own.
 */
const appJobs = new WeakMap<object, (c: never) => Promise<JobPreparation>>()

/**
 * Record how setupWeb readies a job's services, so `run`, `scheduled` and
 * `queue` build them as a request's middleware would, with no request.
 */
export function declareAppJobs<E extends Env>(app: Hono<E>, prepare: JobPreparer<E>): void {
  appJobs.set(app, prepare)
}

/**
 * The path the route that `run` sends its Effects through answers on, for a
 * stack composed by hand, which has no setupWeb to ready a job's services.
 */
const RUN_PATH = '/__popweb/run'

/** An Effect waiting for `run`'s request, keyed by that request. */
interface RunJob {
  readonly effect: Effect.Effect<unknown, unknown, never>
  readonly done: (exit: Exit.Exit<unknown, unknown>) => void
}

const runJobs = new WeakMap<Request, RunJob>()
const appsWithRunner = new WeakSet<object>()

/** A job's value, or its failure thrown, as `run` rejects with it. */
function jobResult<A>(exit: Exit.Exit<A, unknown>): A {
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)

  return exit.value
}

/**
 * Ends `run`'s job with a failure the framework found outside the job, such
 * as bindings the env declaration refuses before it or a failed purge of
 * what it changed after it, so `run` rejects with it rather than with the
 * error page's status. A no-op for any request that is not `run`'s.
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
   * vary on X-Inertia and Cookie, so a visitor with cookies never receives
   * the copy visitors without cookies share. Requires
   * `"cache": { "enabled": true }` in wrangler config.
   */
  cache?: RouteCacheOptions | 'private' | 'no-store'
  /**
   * After this route's effect succeeds (any Redirect, including the one
   * `redirectNow` leaves with, or a Response below 400), purge these Workers
   * Cache tags. `true` purges the record of each
   * of the route's model bindings, the tag every cached page that reads it
   * carries (see recordCacheTag), and the table of its last binding:
   * PUT /projects/{project} purges `projects:{id}` and `projects`. Records
   * the action changes that the route does not name, it purges with
   * `purgeCache(...tags)`.
   */
  purges?: true | readonly CacheTag[]
}

const BODYLESS_METHODS = new Set(['GET', 'HEAD'])

/**
 * The action, and once a page it answers succeeds, the records its route read
 * and the tags it added with tagCache, handed to `record` for the page's
 * Cache-Tag.
 */
function recordingTags<A, Err, R>(
  effect: Effect.Effect<A, Err, R>,
  hasModels: boolean,
  record: (tags: readonly string[]) => void
): Effect.Effect<A, Err | BoundModelError, R | RouteRecords | PendingCacheTags> {
  return effect.pipe(
    Effect.tap((result) =>
      result instanceof Response && result.status >= 200 && result.status < 300
        ? Effect.gen(function* () {
            const records = hasModels ? yield* Effect.flatMap(RouteRecords, (route) => route.tags) : []
            const added = yield* Effect.flatMap(PendingCacheTags, (pending) => pending.take)

            record([...new Set([...records, ...added])])
          })
        : Effect.void
    )
  )
}

/**
 * The tags a route purges once its action succeeds: those it declares, or
 * for `purges: true` its records' and the table the last of them is in,
 * which a write to it changes.
 */
function routePurgesOf(
  purges: true | readonly CacheTag[] | undefined,
  route: RouteModels
): Effect.Effect<readonly string[], BoundModelError, RouteRecords> {
  if (purges !== true) return Effect.succeed(purges ?? [])

  const written = route.modelBindings[route.modelBindings.length - 1]
  const writtenTable = written ? [bindingTableName(written, route.configuredBindings, route.schema)] : []

  return Effect.map(Effect.flatMap(RouteRecords, (records) => records.tags), (tags) => [...tags, ...writtenTable])
}

/**
 * The action, then, once it succeeds (any redirect, or a response below
 * 400), the route's purges and those it asked for with purgeCache, once:
 * inside the Effect, so a failed purge surfaces as its failure rather than
 * leaving stale entries silently. `onFailure` hears a failed purge first.
 */
function purgingOnSuccess<Err, R>(
  effect: Effect.Effect<Response | Redirect, Err, R>,
  routePurges: Effect.Effect<readonly string[], BoundModelError, RouteRecords>,
  onFailure: (error: BoundModelError | ResponseCachePurgeError) => void
): Effect.Effect<Response | Redirect, Err | BoundModelError | ResponseCachePurgeError, R | RouteRecords | PendingPurges | ResponseCacheService> {
  return effect.pipe(
    Effect.tap((result) => {
      if (!(result instanceof Redirect || (result instanceof Response && result.status < 400))) return Effect.void

      return Effect.gen(function* () {
        const requested = yield* Effect.flatMap(PendingPurges, (pending) => pending.take)

        yield* purgeTags([...new Set([...(yield* routePurges), ...requested])])
      }).pipe(Effect.tapError((error) => Effect.sync(() => onFailure(error))))
    })
  )
}

/** Whether the request's path parameters decode with the route's params schema, when it has one. */
function paramsMatch<E extends Env>(c: HonoContext<E>, schema: S.Codec<unknown, unknown, never, never> | undefined): boolean {
  if (schema === undefined) return true

  const params = c.req.param()

  return Exit.isSuccess(S.decodeUnknownExit(schema)(S.is(S.String)(params) ? {} : params))
}

/**
 * Whether a route's response depends on what no shared cache's key holds:
 * it is someone's own, or producing it read a header, a cookie or request
 * state, such as an API key a route's own layer reads.
 */
function hasPrivateRequestState<E extends Env>(c: HonoContext<E>): boolean {
  return isPersonalRequest(c) || keptFrom(c, 'route')
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
    if (appsWithRunner.has(this.app) || appJobs.has(this.app)) return

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
   * rejects with its failure, or with the failure of the purge it asked for
   * with `purgeCache`. A test passes `testEnv(layer, bindings)` as
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
    // SAFETY: setupWeb declared it for this app, whose Env this builder has.
    const prepare = appJobs.get(this.app) as JobPreparer<E> | undefined

    if (prepare === undefined) return this.runThroughRequest(effect, env, executionCtx)

    // A job has no request. Its context carries the bindings and the Worker's
    // execution context to the factories setupWeb builds services with.
    const c = new HonoRequestContext<E>(new Request('http://localhost/'), { env, executionCtx })
    const prepared = await prepare(c)

    if ('failure' in prepared) throw prepared.failure

    const requestLayer = openWebContext(c).requestLayer ?? Layer.empty
    let fullLayer: Layer.Layer<never, AppError, never> = Layer.mergeAll(
      requestLayer,
      Layer.succeed(PendingPurges, makePendingPurges()),
      Layer.succeed(PendingCacheTags, makePendingCacheTags())
    )

    for (const layer of this.layers) {
      fullLayer = Layer.provideMerge(layer, fullLayer)
    }

    // testEnv's services replace those the builder provides, as in a route.
    const testServices = openWebContext(c).testServices

    if (testServices !== undefined) {
      fullLayer = Layer.provideMerge(Layer.succeedContext(testServices), fullLayer)
    }

    // What the job names with purgeCache is purged once it succeeds; a
    // failed purge fails its run, so the queue retries and the cron fails.
    const job = Effect.tap(effect, () => Effect.flatMap(Effect.flatMap(PendingPurges, (pending) => pending.take), purgeTags))

    // One runtime holds the job's services, the builder's scoped layers
    // among them, until the background work it started has settled.
    // SAFETY: RunCheck admits only Effects whose services this builder's
    // routes provide, which the layers above are.
    const runtime = ManagedRuntime.make(fullLayer as Layer.Layer<R | PendingPurges | ResponseCacheService, unknown>)
    let exit: Exit.Exit<A, unknown>

    try {
      exit = await runtime.runPromiseExit(job)
    } finally {
      await disposeRequestRuntime(c, runtime)
      await prepared.release()
    }

    return jobResult(exit)
  }

  /**
   * `run` on a stack composed by hand, which has no setupWeb to ready a
   * job's services: a request to a route of its own carries the job through
   * the application's middleware.
   */
  private async runThroughRequest<A, Err, R>(
    effect: Effect.Effect<A, Err, R>,
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

      // The route answers 204 once the job and what follows it, such as its
      // purges, have succeeded; any other answer means something after the
      // job failed.
      if (Exit.isSuccess(result) && response.status !== 204) {
        throw new Error(`routes.run's Effect succeeded, but its route answered ${response.status}: the work after it, such as a cache purge, failed.`)
      }
    } finally {
      runJobs.delete(request)
    }

    // SAFETY: the job's exit is the exit of `effect`, whose success is A.
    return jobResult(result) as A
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
   * A header or the raw request it reads keeps the route's response out of
   * shared caches, as one read through RequestService does.
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
   * 404s — per-route `.middleware()` never runs when no route matches. A
   * cached page would be served before it runs, so pages under the prefix
   * are not cached by default.
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
    // A cached page is served before this middleware runs, and it may turn
    // visitors away, so no page under the prefix is cached by default; a
    // header it reads keeps a route's own cache option from sharing the
    // response, as one read through RequestService does.
    const checked = handlers.map((handler): MiddlewareHandler<E> => (c, next) => {
      recordPrivacy(c, 'guard')

      return handler(observedRequestContext(c), next)
    })

    if (this.pathPrefix) {
      const prefix = toHonoPath(this.pathPrefix)

      // Two patterns: '/api/*' does not match '/api' itself in Hono
      this.app.use(prefix, ...checked)
      this.app.use(`${prefix}/*`, ...checked)
    } else {
      this.app.use('/*', ...checked)
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

    const routeModelsOf = routeModelsOnce<E>(bindings, options?.params, bridgeConfig)

    // oxlint-disable-next-line effecttsgo/async-function -- This Hono adapter awaits request parsing and runtime completion, then maps the result to an HTTP response.
    return async (c) => {
      setEffectBridgeConfig(c, bridgeConfig)

      if (answersJson) openWebContext(c).jsonApi = true

      const page = c.req.method === 'GET' ? null : formPageOf()
      if (page !== null) openWebContext(c).formPage = fillPlaceholders(page, c.req.param())

      if (allowsDefaultPageCache) {
        allowDefaultPageCache(c)
      }

      const routeModels = routeModelsOf(c)
      const { modelBindings } = routeModels
      // A parameter its column cannot hold names no record: the framework's
      // 404 answers it, as the page or the JSON envelope, before any guard
      // or the action runs.
      if (!paramsMatch(c, routeModels.paramsSchema)) {
        return finishResponse(c, await renderErrorResponse(new NotFoundError({ resource: 'page' }), c, { ...setupOf(c).errors, log: false }))
      }

      // The request's services, which effectBridge readied. A request
      // service that fails to build, such as one reading a missing binding
      // with Config, fails the action with its error.
      const requestLayer = openWebContext(c).requestLayer
      let contextLayer = requestLayer ?? buildContextLayer(c, bridgeConfig ?? getEffectBridgeConfig(c))

      if (requestLayer !== undefined && bridgeConfig?.services) {
        contextLayer = Layer.merge(
          contextLayer,
          bridgeConfig.services(serviceRequestContext(c)).pipe(Layer.provide(bindingsConfiguration(c.env)))
        )
      }

      // The records the path names, which bound() loads, and the guards'
      // bookkeeping.
      const boundModelsLayer = Layer.effectContext(routeModelsLayer({
        bindings,
        models: routeModels,
        param: (name) => c.req.param(name),
        onGuard: Effect.sync(() => recordPrivacy(c, 'guard')),
      }))

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
      > = effect.pipe(
        // redirectNow leaves the action with a Redirect failure. It ends the
        // action as redirect() does and keeps what the action wrote, so the
        // route answers it as the Redirect value: its purges run below, and
        // the boundary answers with the same redirect.
        Effect.catchIf(
          (error): error is Redirect => error instanceof Redirect,
          (redirect) => Effect.succeed(redirect)
        )
      )

      // A cacheable page is tagged with the records its route read, so a
      // write to any of them purges it.
      let recordTags: readonly string[] = []

      if (typeof options?.cache === 'object' && BODYLESS_METHODS.has(c.req.method)) {
        handlerEffect = recordingTags(handlerEffect, modelBindings.length > 0, (tags) => {
          recordTags = tags
        })
      }

      // The route's purges and any the action asked for with purgeCache run
      // once, after the action succeeds, so a failed purge fails it. A job
      // that routes.run sent here fails its run, so the queue retries.
      handlerEffect = purgingOnSuccess(
        handlerEffect,
        routePurgesOf(options?.purges, routeModels),
        (error) => failRun(c.req.raw, error)
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

      // The response with every cookie and header the request queued, so the
      // cache policy below reads what the browser will receive.
      response = finishResponse(c, response)

      return applyRouteCacheOption(response, options?.cache, {
        method: c.req.method,
        isPartialReload: isPartialReloadRequest((name) => c.req.header(name)),
        hasPrivateRequestState: () => hasPrivateRequestState(c),
        derivedTags: recordTags,
        defaultCacheControl: (setsCookie) => defaultCacheControl(c, setsCookie),
        warn: (warning) => {
          if (warnedIneffectiveCache || !isDevelopment(c, setupOf(c).errors)) return

          warnedIneffectiveCache = true
          // oxlint-disable-next-line effecttsgo/global-console -- This outer Hono adapter emits a once-per-route development configuration warning after the request runtime has been disposed.
          console.warn(`[@popcomputer/web] Route '${c.req.path}' ${warning}`)
        },
      })
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

      // Route middleware reads the request through the observed context, so
      // a header it decides from, such as an API key, keeps a cached route's
      // response out of shared caches, as RequestService's reads do.
      const observed = this.middlewares.map(
        (middleware): MiddlewareHandler<E> => (c, next) => middleware(observedRequestContext(c), next)
      )

      register(fullPath, ...observed, handler)
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
