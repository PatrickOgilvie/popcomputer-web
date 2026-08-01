/**
 * Workers Cache Integration
 *
 * Honertia's response-cache policy for Cloudflare Workers Cache. The `cache`
 * route option declares intent; this module owns every correctness rule:
 * only successful GET/HEAD responses qualify, HTML and JSON page objects are
 * distinct variants (Vary: X-Inertia), and partial reloads are never stored.
 *
 * This is the response cache in FRONT of the Worker (zero CPU on hit) —
 * distinct from CacheService, the KV-backed data cache inside actions.
 */

import { Context, Data, Effect } from 'effect'
import { HEADERS } from '../types.js'
import { pluralize, type ParsedBinding } from './binding.js'

/**
 * Declarative caching for a route's responses via Workers Cache.
 * Applied to GET/HEAD responses with 2xx status only.
 */
export interface RouteCacheOptions {
  /** Cache-Control max-age in seconds. */
  maxAge: number
  /** Cache-Control stale-while-revalidate in seconds. */
  staleWhileRevalidate?: number
  /**
   * Extra static Cache-Tag values. Binding-derived tags
   * (`{param}:{value}` and `{pluralized-param}`) are always included on
   * bound routes; these append after them.
   */
  tags?: readonly string[]
}

const MAX_CACHE_TAG_LENGTH = 1024
const MAX_CACHE_TAG_COUNT = 1000
const MAX_CACHE_TAG_HEADER_LENGTH = 16 * 1024
const MAX_CACHE_PURGE_TAG_COUNT = 100

export type PreparedCacheTags =
  | { readonly _tag: 'valid'; readonly tags: readonly string[] }
  | { readonly _tag: 'invalid'; readonly reason: string }

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
    if (typeof tag !== 'string' || tag.length === 0) {
      return {
        _tag: 'invalid',
        reason: `cache tag at index ${index} must be a non-empty string`,
      }
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
        return {
          _tag: 'invalid',
          reason: `cache tag at index ${index} contains invalid Unicode`,
        }
      }
    }

    if (encoded.length > MAX_CACHE_TAG_LENGTH) {
      return {
        _tag: 'invalid',
        reason:
          `cache tag at index ${index} exceeds Cloudflare's ` +
          `${MAX_CACHE_TAG_LENGTH}-character limit after encoding`,
      }
    }

    const identity = encoded.toLowerCase()
    if (!identities.has(identity)) {
      identities.add(identity)
      prepared.push(encoded)
    }
  }

  if (prepared.length > limits.maxCount) {
    return {
      _tag: 'invalid',
      reason: `cache tag count exceeds Cloudflare's ${limits.maxCount}-tag limit`,
    }
  }

  if (
    limits.maxAggregateLength !== undefined &&
    prepared.join(',').length > limits.maxAggregateLength
  ) {
    return {
      _tag: 'invalid',
      reason:
        `Cache-Tag header exceeds Cloudflare's ` +
        `${limits.maxAggregateLength}-character aggregate limit`,
    }
  }

  return { _tag: 'valid', tags: prepared }
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

/**
 * Derive Cache-Tag values from a route's resolved bindings: one
 * `{param}:{value}` tag per bound model (value = the binding's lookup
 * column) and one `{pluralized-param}` collection tag per binding. The same
 * derivation feeds tagging on reads and purging on mutations, so the two
 * can never drift.
 */
export function deriveCacheTags(
  bindings: readonly ParsedBinding[],
  models: ReadonlyMap<string, unknown>
): readonly string[] {
  const tags: string[] = []

  for (const binding of bindings) {
    const model = models.get(binding.param) as Record<string, unknown> | undefined
    const value = model?.[binding.column]
    if (value !== undefined && value !== null) {
      tags.push(`${binding.param}:${String(value)}`)
    }
  }

  for (const binding of bindings) {
    const collection = pluralize(binding.param)
    if (!tags.includes(collection)) {
      tags.push(collection)
    }
  }

  return tags
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
  /** True when the response sets a cookie — never publicly cacheable. */
  readonly setsCookie: boolean
  /**
   * True when the request carries authentication or other private state.
   * Workers Cache may serve a hit without running the Worker, so public cache
   * entries must not depend on Authorization/Cookie headers or auth props.
   */
  readonly hasPrivateRequestState: boolean
  /** Existing Cache-Control header from the handler response, if any. */
  readonly existingCacheControl?: string | null
  /** Binding-derived tags (see deriveCacheTags); static option tags append. */
  readonly derivedTags: readonly string[]
  readonly options: RouteCacheOptions
}

/**
 * The cache-policy decision for one response.
 * - apply: emit the given headers
 * - noStore: partial reload on a cache-enabled route; forbid storage
 * - skip: leave the response untouched; `warning` names a route
 *   misconfiguration worth surfacing in development
 */
export type CachePolicyDecision =
  | { readonly _tag: 'apply'; readonly headers: Readonly<Record<string, string>> }
  | { readonly _tag: 'noStore' }
  | { readonly _tag: 'skip'; readonly warning?: string }

const CACHEABLE_METHODS = new Set(['GET', 'HEAD'])

/**
 * Decide the cache headers for a response. Pure: all request/response facts
 * arrive as inputs, making the policy directly testable.
 */
export function decideCachePolicy(input: CachePolicyInput): CachePolicyDecision {
  if (!CACHEABLE_METHODS.has(input.method.toUpperCase())) {
    return { _tag: 'skip' }
  }

  // Partial reloads are keyed by unbounded X-Inertia-Partial-* combinations;
  // storing them would explode the variant space. Forbid storage outright.
  if (input.isPartialReload) {
    return { _tag: 'noStore' }
  }

  if (input.status < 200 || input.status >= 300) {
    return { _tag: 'skip' }
  }

  // The handler's own directives win when they are stricter than the route
  // policy: no-store (never store), private (per-recipient), and no-cache
  // (revalidate every use) must not be replaced with `public, max-age`.
  if (
    hasCacheControlDirective(input.existingCacheControl, 'no-store') ||
    hasCacheControlDirective(input.existingCacheControl, 'private') ||
    hasCacheControlDirective(input.existingCacheControl, 'no-cache')
  ) {
    return { _tag: 'skip' }
  }

  // A Set-Cookie response is per-recipient by definition.
  if (input.setsCookie) {
    return { _tag: 'skip' }
  }

  // Publicly caching private request state would serve one visitor's page
  // (including shared auth props) to everyone. Fail safe: skip caching and
  // tell the developer in development.
  if (input.hasPrivateRequestState) {
    return {
      _tag: 'skip',
      warning:
        'has the `cache` route option but this request carries private/authentication state; ' +
        'public caching is disabled for it. Cache only guest routes, or key ' +
        'per-user at a gateway boundary.',
    }
  }

  const directives = [`public`, `max-age=${input.options.maxAge}`]
  if (input.options.staleWhileRevalidate !== undefined) {
    directives.push(`stale-while-revalidate=${input.options.staleWhileRevalidate}`)
  }

  const headers: Record<string, string> = {
    'Cache-Control': directives.join(', '),
    Vary: HEADERS.HONERTIA,
  }

  const preparedTags = prepareCacheTags([
    ...input.derivedTags,
    ...(input.options.tags ?? []),
  ])
  if (preparedTags._tag === 'invalid') {
    return {
      _tag: 'skip',
      warning:
        `has an invalid Cache-Tag configuration (${preparedTags.reason}); ` +
        'public caching is disabled for it.',
    }
  }
  if (preparedTags.tags.length > 0) {
    headers['Cache-Tag'] = preparedTags.tags.join(',')
  }

  return { _tag: 'apply', headers }
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
 * Cookie-name prefixes that carry Honertia-managed session state.
 * better-auth's cookies all share one prefix (session_token, session_data,
 * account_data, dont_remember), with a `__Secure-` variant over HTTPS.
 */
const SESSION_COOKIE_PREFIXES = ['better-auth.', '__Secure-better-auth.']

/**
 * Whether a Cookie header carries a session cookie Honertia knows about:
 * better-auth's cookies by prefix, plus any custom names registered on the
 * request context (e.g. via loadUser's `sessionCookie` config), including
 * their `__Secure-` variants.
 *
 * Unknown cookies (analytics, consent, bot-management) do NOT count —
 * they don't personalize Honertia responses, and treating every cookie as
 * private would disable caching for essentially all browser traffic.
 * Apps with custom cookie auth outside Honertia must register their cookie
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
  if (decision._tag === 'skip') {
    return response
  }

  const result = new Response(response.body, response)

  if (decision._tag === 'noStore') {
    result.headers.set('Cache-Control', 'no-store')
    return result
  }

  for (const [name, value] of Object.entries(decision.headers)) {
    if (name.toLowerCase() === 'vary' && result.headers.has('Vary')) {
      const existing = result.headers
        .get('Vary')!
        .split(',')
        .map((v) => v.trim())
      if (!existing.includes(value)) {
        result.headers.set('Vary', [...existing, value].join(', '))
      }
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
export class ResponseCachePurgeError extends Data.TaggedError('ResponseCachePurgeError')<{
  readonly input: ResponseCachePurgeInput
  readonly cause: unknown
}> {}

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

export class ResponseCacheService extends Context.Tag('honertia/ResponseCache')<
  ResponseCacheService,
  ResponseCacheClient
>() {}

/**
 * The purge surface Workers Cache exposes — on the execution context
 * (ctx.cache) or as the `cache` export of the `cloudflare:workers` module —
 * when caching is enabled in wrangler config.
 */
export interface WorkersCachePurgeApi {
  purge(input: { tags?: string[]; purgeEverything?: boolean }): Promise<unknown>
}

interface WorkersCachePurgeFailure {
  readonly code?: number
  readonly message?: string
}

type WorkersCachePurgeResult =
  | { readonly _tag: 'accepted' }
  | {
      readonly _tag: 'rejected'
      readonly errors: readonly WorkersCachePurgeFailure[]
    }
  | { readonly _tag: 'invalid' }

function parseWorkersCachePurgeResult(value: unknown): WorkersCachePurgeResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { _tag: 'invalid' }
  }

  const result = value as Record<string, unknown>
  if (typeof result.success !== 'boolean') {
    return { _tag: 'invalid' }
  }
  if (result.success) {
    return { _tag: 'accepted' }
  }

  const errors = Array.isArray(result.errors)
    ? result.errors.flatMap((error): WorkersCachePurgeFailure[] => {
        if (error === null || typeof error !== 'object' || Array.isArray(error)) {
          return []
        }
        const candidate = error as Record<string, unknown>
        return [{
          ...(typeof candidate.code === 'number'
            ? { code: candidate.code }
            : {}),
          ...(typeof candidate.message === 'string'
            ? { message: candidate.message }
            : {}),
        }]
      })
    : []

  return { _tag: 'rejected', errors }
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
  executionCtx: unknown
): Effect.Effect<WorkersCachePurgeApi | null> {
  return Effect.promise(async () => {
    const ctxCache = (executionCtx as { cache?: WorkersCachePurgeApi } | undefined)
      ?.cache
    if (typeof ctxCache?.purge === 'function') {
      return ctxCache
    }

    workersModuleCacheProbe ??= (async () => {
      try {
        // Non-literal specifier: TypeScript must not try to resolve types for
        // this runtime-provided module (and an ambient declaration would
        // conflict with @cloudflare/workers-types in consumer apps). workerd
        // resolves non-literal dynamic imports of cloudflare:* at runtime —
        // verified empirically against wrangler 4.107 local and remote.
        const specifier = 'cloudflare:workers' as string
        const mod = (await import(specifier)) as { cache?: WorkersCachePurgeApi }
        return typeof mod.cache?.purge === 'function' ? mod.cache : null
      } catch {
        return null
      }
    })()

    return workersModuleCacheProbe
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
      const preparedTags = input.everything
        ? { _tag: 'valid' as const, tags: [] as readonly string[] }
        : prepareCachePurgeTags(input.tags ?? [])

      if (preparedTags._tag === 'invalid') {
        return Effect.fail(
          new ResponseCachePurgeError({
            input,
            cause: {
              _tag: 'InvalidCacheTags',
              reason: preparedTags.reason,
            },
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
          const parsed = parseWorkersCachePurgeResult(result)
          if (parsed._tag === 'accepted') {
            return Effect.void
          }

          return Effect.fail(
            new ResponseCachePurgeError({
              input,
              cause:
                parsed._tag === 'rejected'
                  ? {
                      _tag: 'WorkersCachePurgeRejected',
                      errors: parsed.errors,
                    }
                  : { _tag: 'InvalidWorkersCachePurgeResult' },
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
