/**
 * Workers Cache Integration
 *
 * The response-cache policy for Cloudflare Workers Cache. The `cache`
 * route option declares intent; this module owns every correctness rule:
 * only successful GET/HEAD responses qualify, HTML and JSON page objects are
 * distinct variants (Vary: X-Inertia), a request with cookies never shares a
 * stored response (Vary: Cookie), and partial reloads are never stored.
 *
 * Pages (HTML documents and Inertia page objects) belong to the deploy that
 * rendered them: the document names that build's hashed assets and the page
 * object carries its props. Browsers therefore revalidate pages on every use,
 * only Cloudflare keeps them (Cloudflare-CDN-Cache-Control, which Cloudflare
 * strips before the response reaches the client), and every cached page
 * carries PAGE_CACHE_TAG. Workers Cache keys entries by Worker version, so a
 * deploy starts from an empty cache; with `cross_version_cache` enabled,
 * purge the tag after each deploy instead.
 *
 * This is the response cache in FRONT of the Worker (zero CPU on hit) —
 * distinct from CacheService, the KV-backed data cache inside actions.
 */

import { Predicate, Context, Data, Effect, Option, Schema as S } from 'effect'
import { HEADERS } from '../types.js'
import { createStructuredError, ErrorCodes } from './error-catalog.js'
import { emptyContext } from './error-context.js'
import type { ErrorContext, StructuredError } from './error-types.js'
import type { Registered } from './register.js'

/**
 * Declarative caching for a route's responses via Workers Cache.
 * Applied to GET/HEAD responses with 2xx status only.
 *
 * Pages are kept only by Cloudflare (Cloudflare-CDN-Cache-Control) and are
 * tagged with PAGE_CACHE_TAG. Browsers revalidate pages, so they never load
 * assets a deploy removed. Other responses (JSON APIs, text) use these
 * values in Cache-Control for every cache.
 */
export interface RouteCacheOptions {
  /** max-age in seconds. */
  maxAge: number
  /** stale-while-revalidate in seconds. */
  staleWhileRevalidate?: number
  /**
   * Cache-Tag values for what the page reads besides its route's records,
   * such as `['posts']` for an index the posts' routes purge. A bound route
   * is always tagged with each of its records (see recordCacheTag); these
   * append after them.
   */
  tags?: readonly CacheTag[]
}

/**
 * Cache-Tag carried by every page the `cache` route option stores. Workers
 * Cache already starts each deploy from an empty cache; with
 * `cross_version_cache` enabled, purge this tag after each deploy with
 * ResponseCacheService.
 */
export const PAGE_CACHE_TAG = 'popweb:page'

/**
 * Cache-Control browsers receive for cached pages: revalidate on every use,
 * because a page belongs to the deploy that rendered it.
 */
export const BROWSER_PAGE_CACHE_CONTROL = 'public, max-age=0, must-revalidate'

const MAX_CACHE_TAG_LENGTH = 1024

const MAX_CACHE_TAG_COUNT = 1000

const MAX_CACHE_TAG_HEADER_LENGTH = 16 * 1024

const MAX_CACHE_PURGE_TAG_COUNT = 100

export type PreparedCacheTags =
  | { readonly _tag: 'valid'; readonly tags: readonly string[] }
  | { readonly _tag: 'invalid'; readonly reason: string }

const PreparedCacheTags = Data.taggedEnum<PreparedCacheTags>()

interface ResponseCacheHeaders {
  [header: string]: string
}

/**
 * Convert tags to Cloudflare's printable-ASCII wire format. Valid tag
 * characters remain unchanged; whitespace, Unicode, control characters, and
 * commas are percent-encoded so reads and purges use the same stable value.
 */
function prepareCacheTagsWithLimits(
  tags: readonly string[],
  limits: {
    readonly maxCount: number
    readonly maxAggregateLength?: number
  }
): PreparedCacheTags {
  const prepared: string[] = []
  const identities = new Set<string>()

  for (const [index, tag] of tags.entries()) {
    if (!S.is(S.String)(tag) || tag.length === 0) {
      return PreparedCacheTags.invalid({
        reason: `cache tag at index ${index} must be a non-empty string`
      })
    }

    let encoded = ''

    for (const character of tag) {
      const codePoint = character.codePointAt(0)

      if (
        codePoint !== undefined &&
        codePoint >= 0x21 &&
        codePoint <= 0x7e &&
        character !== ','
      ) {
        encoded += character
        continue
      }

      try {
        encoded += encodeURIComponent(character)
      } catch {
        return PreparedCacheTags.invalid({
          reason: `cache tag at index ${index} contains invalid Unicode`
        })
      }
    }

    if (encoded.length > MAX_CACHE_TAG_LENGTH) {
      return PreparedCacheTags.invalid({
        reason:
          `cache tag at index ${index} exceeds Cloudflare's ` +
          `${MAX_CACHE_TAG_LENGTH}-character limit after encoding`
      })
    }

    const identity = encoded.toLowerCase()

    if (!identities.has(identity)) {
      identities.add(identity)
      prepared.push(encoded)
    }
  }

  if (prepared.length > limits.maxCount) {
    return PreparedCacheTags.invalid({
      reason: `cache tag count exceeds Cloudflare's ${limits.maxCount}-tag limit`
    })
  }

  if (
    limits.maxAggregateLength !== undefined &&
    prepared.join(',').length > limits.maxAggregateLength
  ) {
    return PreparedCacheTags.invalid({
      reason:
        `Cache-Tag header exceeds Cloudflare's ` +
        `${limits.maxAggregateLength}-character aggregate limit`
    })
  }

  return PreparedCacheTags.valid({
    tags: prepared,
  })
}

export function prepareCacheTags(
  tags: readonly string[]
): PreparedCacheTags {
  return prepareCacheTagsWithLimits(tags, {
    maxCount: MAX_CACHE_TAG_COUNT,
    maxAggregateLength: MAX_CACHE_TAG_HEADER_LENGTH,
  })
}

export function prepareCachePurgeTags(
  tags: readonly string[]
): PreparedCacheTags {
  return prepareCacheTagsWithLimits(tags, {
    maxCount: MAX_CACHE_PURGE_TAG_COUNT,
  })
}

type DeclaredSchema = Registered<'schema', never>

/** A table of the application's registered Drizzle schema. */
export type TableName = [DeclaredSchema] extends [never] ? string : Extract<keyof DeclaredSchema, string>

/**
 * A Cache-Tag the application names: a table of its schema, by its key in the
 * schema (`planPrices`, not the SQL name `plan_prices`), which an index of the
 * table's records carries, or one record, `recordCacheTag(table, key)`. Any
 * string before the application registers its schema.
 */
export type CacheTag = [DeclaredSchema] extends [never] ? string : TableName | `${TableName}:${string}`

/**
 * The Cache-Tag that names one database record: `{table}:{primary key}`. A
 * cached page tags itself with the record of each of its route's bindings,
 * and `purges: true` purges the records its route's bindings name, so a page
 * read through `/posts/{post:slug}` is purged by `PUT /posts/{post}`. Purge
 * it yourself when a record changes elsewhere, such as in a queue consumer.
 *
 * @example
 * yield* cache.purge({ tags: [recordCacheTag('posts', post.id)] })
 */
export function recordCacheTag<const Table extends TableName>(
  table: Table,
  key: string | number | bigint
): `${Table}:${string}` {
  // SAFETY: formatRecordTag writes `${table}:${key}`.
  return formatRecordTag(table, key) as `${Table}:${string}`
}

/** recordCacheTag for a table name the route's binding plan resolved. */
export function formatRecordTag(table: string, key: unknown): string {
  return `${table}:${String(key)}`
}

/**
 * Inputs to the pure cache-policy decision, extracted from the request,
 * the response, and the route configuration by the routing shell.
 */
export interface CachePolicyInput {
  readonly method: string
  readonly status: number
  /** True when the request carries X-Inertia-Partial-* headers. */
  readonly isPartialReload: boolean
  /**
   * True when the response sets a cookie, or web() will write one on it
   * (an application cookie, Better Auth's, set-auth-token, the session
   * lookup's or the flash cookie): never stored by any cache.
   */
  readonly setsCookie: boolean
  /**
   * True when the request carries authentication or other private state.
   * Workers Cache may serve a hit without running the Worker, so public cache
   * entries must not depend on Authorization/Cookie headers or auth props.
   */
  readonly hasPrivateRequestState: boolean
  /** Existing Cache-Control header from the handler response, if any. */
  readonly existingCacheControl?: string | null
  /** True when the response is a page (see isPageResponse). */
  readonly isPage: boolean
  /** The route's record tags (see recordCacheTag); static option tags append. */
  readonly derivedTags: readonly string[]
  readonly options: RouteCacheOptions
}

/**
 * The cache-policy decision for one response.
 * - apply: emit the given headers
 * - noStore: a partial reload, a signed-in request, or a response that sets
 *   a cookie; forbid storage
 * - skip: leave the response untouched; `warning` names a route
 *   misconfiguration worth surfacing in development
 */
export type CachePolicyDecision =
  | { readonly _tag: 'apply'; readonly headers: Readonly<Record<string, string>> }
  | { readonly _tag: 'noStore' }
  | { readonly _tag: 'skip'; readonly warning?: string }

const CachePolicyDecision = Data.taggedEnum<CachePolicyDecision>()

const CACHEABLE_METHODS = new Set(['GET', 'HEAD'])

/**
 * Workers Cache answers before the Worker runs, so a cached response must
 * name every request header it depends on: the Inertia variant, and the
 * cookies that sign a visitor in or carry a flashed form error. Requests
 * without cookies share one copy; any other request renders afresh.
 */
const CACHED_RESPONSE_VARY = `${HEADERS.INERTIA}, Cookie`

/**
 * Decide the cache headers for a response. Pure: all request/response facts
 * arrive as inputs, making the policy directly testable.
 */
export function decideCachePolicy(input: CachePolicyInput): CachePolicyDecision {
  if (!CACHEABLE_METHODS.has(input.method.toUpperCase())) {
    return CachePolicyDecision.skip({})
  }

  // Partial reloads are keyed by unbounded X-Inertia-Partial-* combinations;
  // storing them would explode the variant space. Forbid storage outright.
  if (input.isPartialReload) {
    return CachePolicyDecision.noStore()
  }

  if (input.status < 200 || input.status >= 300) {
    return CachePolicyDecision.skip({})
  }

  // The handler's own directives win when they are stricter than the route
  // policy: no-store (never store), private (per-recipient), and no-cache
  // (revalidate every use) must not be replaced with `public, max-age`.
  if (
    hasCacheControlDirective(input.existingCacheControl, 'no-store') ||
    hasCacheControlDirective(input.existingCacheControl, 'private') ||
    hasCacheControlDirective(input.existingCacheControl, 'no-cache')
  ) {
    return CachePolicyDecision.skip({})
  }

  // A Set-Cookie response is per-recipient by definition: no cache may keep it.
  if (input.setsCookie) {
    return CachePolicyDecision.noStore()
  }

  // A signed-in visitor's response is their own. Cached responses vary on
  // Cookie, so this visitor never receives the guests' copy either.
  if (input.hasPrivateRequestState) {
    return CachePolicyDecision.noStore()
  }

  const directives = [`public`, `max-age=${input.options.maxAge}`]

  if (input.options.staleWhileRevalidate !== undefined) {
    directives.push(`stale-while-revalidate=${input.options.staleWhileRevalidate}`)
  }

  // A page names one deploy's hashed assets (HTML) or carries its props
  // (page object). A browser copy cannot be purged, so browsers revalidate
  // every use and only shared caches, which a deploy can purge by tag, keep it.
  const headers: ResponseCacheHeaders = input.isPage
    ? {
        'Cache-Control': BROWSER_PAGE_CACHE_CONTROL,
        'Cloudflare-CDN-Cache-Control': directives.join(', '),
        Vary: CACHED_RESPONSE_VARY,
      }
    : {
        'Cache-Control': directives.join(', '),
        Vary: CACHED_RESPONSE_VARY,
      }

  const preparedTags = prepareCacheTags([
    ...input.derivedTags,
    ...(input.options.tags ?? []),
    ...(input.isPage ? [PAGE_CACHE_TAG] : []),
  ])

  if (Predicate.isTagged(preparedTags, 'invalid')) {
    return CachePolicyDecision.skip({
      warning:
        `has an invalid Cache-Tag configuration (${preparedTags.reason}); ` +
        'public caching is disabled for it.'
    })
  }

  if (preparedTags.tags.length > 0) {
    headers['Cache-Tag'] = preparedTags.tags.join(',')
  }

  return CachePolicyDecision.apply({ headers })
}

function hasCacheControlDirective(
  header: string | null | undefined,
  directive: string
): boolean {
  if (!header) {
    return false
  }

  const expected = directive.toLowerCase()

  return header.split(',').some((part) => {
    const [name] = part.trim().toLowerCase().split('=', 1)

    return name === expected
  })
}

/**
 * Cookie-name prefixes that carry framework-managed session state.
 * better-auth's cookies all share one prefix (session_token, session_data,
 * account_data, dont_remember), with a `__Secure-` variant over HTTPS.
 */
const SESSION_COOKIE_PREFIXES = ['better-auth.', '__Secure-better-auth.']

/**
 * Whether a Cookie header carries a session cookie the framework knows about:
 * better-auth's cookies by prefix, plus any custom names registered on the
 * request context (e.g. via loadUser's `sessionCookie` config), including
 * their `__Secure-` variants.
 *
 * Unknown cookies (analytics, consent, bot-management) do NOT count —
 * they don't personalize responses, and treating every cookie as
 * private would disable caching for essentially all browser traffic.
 * Apps with custom cookie auth outside the framework must register their cookie
 * name or avoid the `cache` option on authenticated routes.
 */
export function hasSessionCookie(
  cookieHeader: string | undefined,
  sessionCookieNames: readonly string[]
): boolean {
  if (!cookieHeader) {
    return false
  }

  const cookieNames = cookieHeader.split(';').map((part) => part.split('=', 1)[0].trim())

  return cookieNames.some(
    (name) =>
      SESSION_COOKIE_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
      sessionCookieNames.some(
        (registered) => name === registered || name === `__Secure-${registered}`
      )
  )
}

/**
 * Whether a response is a page: an HTML document, or an Inertia page object
 * (JSON marked with X-Inertia: true).
 */
export function isPageResponse(headers: Headers): boolean {
  const contentType = headers.get('Content-Type')?.toLowerCase() ?? ''

  return (
    headers.get(HEADERS.INERTIA) === 'true' ||
    contentType.startsWith('text/html')
  )
}

/**
 * Whether a request is an Inertia partial reload.
 */
export function isPartialReloadRequest(header: (name: string) => string | undefined): boolean {
  return (
    header(HEADERS.PARTIAL_COMPONENT) !== undefined ||
    header(HEADERS.PARTIAL_DATA) !== undefined ||
    header(HEADERS.PARTIAL_EXCEPT) !== undefined
  )
}

/**
 * Apply a cache-policy decision to a response. Returns the response with
 * headers applied (a copy when headers must change, since responses from
 * handlers may carry immutable header guards).
 */
export function applyCachePolicy(
  response: Response,
  decision: CachePolicyDecision
): Response {
  if (CachePolicyDecision.$is('skip')(decision)) {
    return response
  }

  const result = new Response(response.body, response)

  if (CachePolicyDecision.$is('noStore')(decision)) {
    result.headers.set('Cache-Control', 'no-store')

    return result
  }

  for (const [name, value] of Object.entries(decision.headers)) {
    const vary = result.headers.get('Vary')

    if (name.toLowerCase() === 'vary' && vary !== null) {
      const existing = vary.split(',').map((v) => v.trim())
      const added = value
        .split(',')
        .map((v) => v.trim())
        .filter((v) => !existing.some((present) => present.toLowerCase() === v.toLowerCase()))

      result.headers.set('Vary', [...existing, ...added].join(', '))
    } else {
      result.headers.set(name, value)
    }
  }

  return result
}

/**
 * Input to a Workers Cache purge.
 */
export interface ResponseCachePurgeInput {
  readonly tags?: readonly string[]
  readonly everything?: boolean
}

/**
 * A purge against Workers Cache failed. Purge failures must be observable —
 * a swallowed purge is a stale-forever bug — so this flows through the
 * standard error pipeline.
 */
export class ResponseCachePurgeError extends S.TaggedError<ResponseCachePurgeError>()('ResponseCachePurgeError', {
  input: S.Struct({ tags: S.optional(S.Array(S.String)), everything: S.optional(S.Boolean) }),
  cause: S.Unknown,
}) {
  get httpStatus(): number {
    return 500
  }

  toStructured(context: ErrorContext = emptyContext()): StructuredError {
    return createStructuredError(ErrorCodes.SVC_703_CACHE_PURGE_FAILED, {}, context)
  }
}

/**
 * Client interface for purging Workers Cache entries.
 *
 * @example
 * const cache = yield* ResponseCacheService
 * yield* cache.purge({ tags: [`project:${project.id}`] })
 */
export interface ResponseCacheClient {
  /**
   * Whether a Workers Cache purge API is present. False outside a Workers
   * runtime with `"cache": { "enabled": true }` (e.g. local tests), where
   * purge is a no-op.
   */
  readonly isAvailable: boolean
  purge(input: ResponseCachePurgeInput): Effect.Effect<void, ResponseCachePurgeError>
}

export class ResponseCacheService extends Context.Service<
  ResponseCacheService,
  ResponseCacheClient
>()('@popcomputer/web/ResponseCache') {}

/** The cache tags an action asked to purge once it succeeds. The route provides it per request. */
export class PendingPurges extends Context.Service<
  PendingPurges,
  {
    readonly add: (tags: readonly string[]) => Effect.Effect<void>
    readonly take: Effect.Effect<readonly string[]>
  }
>()('@popcomputer/web/PendingPurges') {}

/** An empty set of pending purges, for one request. */
export function makePendingPurges(): PendingPurges['Service'] {
  const tags = new Set<string>()

  return PendingPurges.of({
    add: (added) => Effect.sync(() => added.forEach((tag) => tags.add(tag))),
    take: Effect.sync(() => [...tags]),
  })
}

/** The cache tags an action added to the response it caches. The route provides it per request. */
export class PendingCacheTags extends Context.Service<
  PendingCacheTags,
  {
    readonly add: (tags: readonly string[]) => Effect.Effect<void>
    readonly take: Effect.Effect<readonly string[]>
  }
>()('@popcomputer/web/PendingCacheTags') {}

/** An empty set of added cache tags, for one request. */
export function makePendingCacheTags(): PendingCacheTags['Service'] {
  const tags = new Set<string>()

  return PendingCacheTags.of({
    add: (added) => Effect.sync(() => added.forEach((tag) => tags.add(tag))),
    take: Effect.sync(() => [...tags]),
  })
}

/**
 * Tag the response a route with the `cache` option stores with records the
 * action read beyond its route's bindings, such as the translation a fallback
 * page shows, so purging them refreshes it. A route without the `cache`
 * option stores nothing, and the tags go nowhere.
 *
 * @example
 * yield* tagCache(recordCacheTag('articles', fallback.id))
 */
export const tagCache = (...tags: readonly CacheTag[]): Effect.Effect<void, never, PendingCacheTags> =>
  Effect.flatMap(PendingCacheTags, (pending) => pending.add(tags))

/**
 * Purge cached responses with these tags once the action succeeds, with its
 * route's `purges`: what the action changed besides the records its route
 * names, such as the listing an accepted offer sold. Nothing is purged when
 * the action fails, so a rolled-back write leaves the cache alone.
 *
 * @example
 * yield* purgeCache(recordCacheTag('listings', offer.listingId), 'listings')
 */
export const purgeCache = (...tags: readonly CacheTag[]): Effect.Effect<void, never, PendingPurges> =>
  Effect.flatMap(PendingPurges, (pending) => pending.add(tags))

/**
 * The purge surface Workers Cache exposes — on the execution context
 * (ctx.cache) or as the `cache` export of the `cloudflare:workers` module —
 * when caching is enabled in wrangler config.
 */
export interface WorkersCachePurgeApi {
  purge(input: { tags?: string[]; purgeEverything?: boolean }): Promise<object>
}

interface WorkersCachePurgeFailure {
  readonly code?: number
  readonly message?: string
}

const WorkersCachePurgeResponseSchema = S.Struct({
  success: S.Boolean,
  errors: S.optional(S.Array(S.Struct({
    code: S.optional(S.Finite),
    message: S.optional(S.String),
  }))),
})

type WorkersCachePurgeResponse = S.Schema.Type<typeof WorkersCachePurgeResponseSchema>

type WorkersCachePurgeResult =
  | { readonly _tag: 'accepted' }
  | {
      readonly _tag: 'rejected'
      readonly errors: readonly WorkersCachePurgeFailure[]
    }
  | { readonly _tag: 'invalid' }

const WorkersCachePurgeResult = Data.taggedEnum<WorkersCachePurgeResult>()

type ResponseCachePurgeFailure = Data.TaggedEnum<{
  InvalidCacheTags: { readonly reason: string }
  WorkersCachePurgeRejected: { readonly errors: readonly WorkersCachePurgeFailure[] }
  InvalidWorkersCachePurgeResult: {}
}>

/** Structured causes produced by response-cache validation and purge responses. */
export const ResponseCachePurgeFailure = Data.taggedEnum<ResponseCachePurgeFailure>()

function parseWorkersCachePurgeResult(result: WorkersCachePurgeResponse): WorkersCachePurgeResult {
  if (result.success) {
    return WorkersCachePurgeResult.accepted()
  }

  return WorkersCachePurgeResult.rejected({ errors: result.errors ?? [] })
}

/** Memoized once per isolate: the cloudflare:workers module never changes. */
let workersModuleCacheProbe: Promise<WorkersCachePurgeApi | null> | undefined

/**
 * Resolve a Workers Cache purge API, probing both documented surfaces:
 * `ctx.cache` first, then the `cache` export of `cloudflare:workers`.
 * Resolves null outside a Workers runtime with caching enabled (bun tests,
 * local tooling, or runtimes where the purge API has not shipped yet) —
 * never fails.
 */
export function resolveWorkersCachePurgeApi(
  executionCtx: { readonly cache?: WorkersCachePurgeApi } | undefined
): Effect.Effect<WorkersCachePurgeApi | null> {
  return Effect.suspend(() => {
    const ctxCache = executionCtx?.cache

    if (ctxCache?.purge instanceof Function) {
      return Effect.succeed(ctxCache)
    }

    return Effect.promise(() => {
      // Non-literal specifier: TypeScript must not try to resolve types for
      // this runtime-provided module (and an ambient declaration would
      // conflict with @cloudflare/workers-types in consumer apps). workerd
      // resolves non-literal dynamic imports of cloudflare:* at runtime —
      // verified empirically against wrangler 4.107 local and remote.
      const specifier = 'cloudflare:workers'
      workersModuleCacheProbe ??= import(specifier).then(
        (mod: { cache?: WorkersCachePurgeApi }) =>
          mod.cache?.purge instanceof Function ? mod.cache : null,
      ).catch(() => null)

      return workersModuleCacheProbe
    })
  })
}

/**
 * Create a ResponseCacheClient over the Workers Cache purge API.
 */
export function createWorkersResponseCacheClient(
  cache: WorkersCachePurgeApi
): ResponseCacheClient {
  return {
    isAvailable: true,
    purge: (input) => {
      // SAFETY: The surrounding adapter established this value's runtime invariant before restoring the precise TypeScript contract.
      const preparedTags = input.everything
        ? PreparedCacheTags.valid({ tags: [] })
        : prepareCachePurgeTags(input.tags ?? [])

      if (Predicate.isTagged(preparedTags, 'invalid')) {
        return Effect.fail(
          new ResponseCachePurgeError({
            input,
            cause: ResponseCachePurgeFailure.InvalidCacheTags({
              reason: preparedTags.reason
            }),
          })
        )
      }

      return Effect.tryPromise({
        try: () =>
          cache.purge(
            input.everything
              ? { purgeEverything: true }
              : { tags: [...preparedTags.tags] }
          ),
        catch: (cause) => new ResponseCachePurgeError({ input, cause }),
      }).pipe(
        Effect.flatMap((result) => {
          const decoded = S.decodeUnknownOption(WorkersCachePurgeResponseSchema)(result)

          const parsed = Option.isSome(decoded)
            ? parseWorkersCachePurgeResult(decoded.value)
            : WorkersCachePurgeResult.invalid()

          if (Predicate.isTagged(parsed, 'accepted')) {
            return Effect.void
          }

          return Effect.fail(
            new ResponseCachePurgeError({
              input,
              cause:
                Predicate.isTagged(parsed, 'rejected')
                  ? ResponseCachePurgeFailure.WorkersCachePurgeRejected({
                      errors: parsed.errors,
                    })
                  : ResponseCachePurgeFailure.InvalidWorkersCachePurgeResult(),
            })
          )
        })
      )
    },
  }
}

/**
 * Fallback client for environments without Workers Cache (tests, non-Worker
 * runtimes). Purge is a successful no-op; check isAvailable to branch.
 */
export function createUnavailableResponseCacheClient(): ResponseCacheClient {
  return {
    isAvailable: false,
    purge: () => Effect.void,
  }
}
