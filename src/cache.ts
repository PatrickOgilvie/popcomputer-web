/**
 * `@popcomputer/web/cache`: a schema-checked data cache.
 *
 * Provide a store with `kvCache(c.env.KV)` in setupWeb's `services.request`,
 * or any other CacheClient through CacheService. `cache()` wraps a
 * computation, with stale-while-revalidate, and never fails because of the
 * store: an unreachable store or an unreadable entry computes the value
 * instead, and the failure is reported to EffectErrorObserverService.
 */

import { Clock, Duration, Effect, Layer, Option, Schema } from 'effect'
import { CacheService, ExecutionContextService, type CacheClient } from './effect/services.js'
import { CacheError } from './effect/errors.js'
import { observeOrLog } from './effect/error-observer.js'

// ============================================================================
// Types
// ============================================================================

export type CacheOptions = {
  /** Time-to-live for cached values */
  ttl: Duration.Input
  /**
   * Stale-while-revalidate window. When set, stale values within this window
   * are returned immediately while a background refresh is triggered.
   * Without ExecutionContext, stale entries are recomputed synchronously.
   */
  swr?: Duration.Input
  /**
   * Cache key versioning for safe schema migrations.
   * - `string`: Explicit version prefix (e.g., 'v2')
   * - `true`: Auto-generate version from schema hash
   * - `false` or omitted: No versioning
   */
  version?: string | boolean
}

export type CacheGetOptions = {
  /**
   * Cache key versioning (must match what was used when caching).
   * - `string`: Explicit version prefix
   * - `true`: Auto-generate version from schema hash
   */
  version?: string | boolean
}

// ============================================================================
// Internal
// ============================================================================

/** Internal schema for storing value with metadata */
/** The schema a cached value is checked against; it needs no services. */
export type CacheSchema<V> = Schema.Codec<V, unknown, never, never>

// The value is stored as JSON through its schema's JSON codec, so values such
// as dates, which JSON would turn into strings, decode back to themselves.
const CacheEntrySchema = <V>(valueSchema: CacheSchema<V>) =>
  Schema.Struct({
    v: Schema.toCodecJson(valueSchema),
    t: Schema.Finite, // cachedAt timestamp
  })

type CacheEntry<V> = { v: V; t: number }

/**
 * Simple string hash function (djb2 algorithm).
 * Produces a short, deterministic hash for cache key versioning.
 */
const hashString = (str: string): string => {
  let hash = 5381

  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i)
  }

  // Convert to unsigned 32-bit and then to base36 for short strings
  return (hash >>> 0).toString(36)
}

/**
 * Generate a version string from a schema's AST.
 * The hash changes when the schema structure changes.
 */
const hashSchema = <V>(schema: CacheSchema<V>): string => {
  // Stringify the AST - this captures the schema structure
  const astString = JSON.stringify(schema.ast)

  return hashString(astString)
}

/**
 * Resolve the effective cache key with optional versioning.
 */
const resolveKey = <V>(
  key: string,
  schema: CacheSchema<V>,
  version: string | boolean | undefined
): string => {
  if (version === true) {
    return `${hashSchema(schema)}:${key}`
  }

  if (Schema.is(Schema.String)(version)) {
    return `${version}:${key}`
  }

  return key
}

/** Report a store failure the cache recovered from. */
const reportStoreFailure = (operation: string) => (error: CacheError | Schema.SchemaError) =>
  observeOrLog({
    source: 'framework',
    handling: 'handled',
    kind: 'failure',
    error,
    metadata: { operation },
  }, 'Cache store failed; the value was computed instead')

/**
 * Report an invalidation the store failed. The write it follows has
 * happened, so failing the request would misreport it; the entry stays stale
 * until it expires.
 */
const reportInvalidationFailure = (operation: string) => (error: CacheError) =>
  observeOrLog({
    source: 'framework',
    handling: 'handled',
    kind: 'failure',
    error,
    metadata: { operation },
  }, 'Cache invalidation failed; the entry stays until it expires')

/** A failure to encode or decode an entry, as the CacheError explicit operations fail with. */
const entryError = (reason: string) => (cause: Schema.SchemaError) =>
  new CacheError({ reason, cause })

// ============================================================================
// Stores
// ============================================================================

/** The part of Cloudflare's KVNamespace the cache uses. */
export interface KVNamespaceLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>
    list_complete: boolean
    cursor?: string
  }>
}

/**
 * Provide CacheService backed by a Workers KV namespace. KV keeps an entry
 * at least 60 seconds; `cache()` still treats it as fresh only for its `ttl`.
 *
 * @example
 * setupWeb(app, { version, render, services: { request: (c) => kvCache(c.env.KV) } })
 */
/** The shortest expiry Workers KV accepts. */
const KV_MINIMUM_TTL_SECONDS = 60

export function kvCache(kv: KVNamespaceLike): Layer.Layer<CacheService> {
  const attempt = <A>(reason: string, run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => new CacheError({ reason, cause }) })

  const client: CacheClient = {
    get: (key) => attempt('Could not read from the cache.', () => kv.get(key)),
    // KV rejects an expiry under 60 seconds; cache() judges freshness from
    // the entry's own time, so a shorter TTL is kept the minimum time.
    put: (key, value, options) =>
      attempt('Could not write to the cache.', () =>
        kv.put(key, value, options?.expirationTtl === undefined
          ? options
          : { ...options, expirationTtl: Math.max(KV_MINIMUM_TTL_SECONDS, options.expirationTtl) })
      ),
    delete: (key) => attempt('Could not delete from the cache.', () => kv.delete(key)),
    list: (options) => attempt('Could not list cache keys.', () => kv.list(options)),
  }

  return Layer.succeed(CacheService, client)
}

// ============================================================================
// Composable API
// ============================================================================

/**
 * Cache a computed value with automatic serialization and TTL.
 * Supports stale-while-revalidate (SWR) for improved latency.
 *
 * @example
 * ```typescript
 * // Basic usage
 * const user = yield* cache(
 *   `user:${id}`,
 *   Effect.tryPromise(() => db.query.users.findFirst({ where: eq(users.id, id) })),
 *   UserSchema,
 *   { ttl: Duration.hours(1) }
 * )
 *
 * // With stale-while-revalidate
 * const user = yield* cache(
 *   `user:${id}`,
 *   fetchUser(id),
 *   UserSchema,
 *   { ttl: Duration.hours(1), swr: Duration.minutes(5) }
 * )
 *
 * // With auto schema versioning (cache auto-invalidates when schema changes)
 * const user = yield* cache(
 *   `user:${id}`,
 *   fetchUser(id),
 *   UserSchema,
 *   { ttl: Duration.hours(1), version: true }
 * )
 *
 * // With explicit version
 * const user = yield* cache(
 *   `user:${id}`,
 *   fetchUser(id),
 *   UserSchema,
 *   { ttl: Duration.hours(1), version: 'v2' }
 * )
 * ```
 */
export const cache = <V, E, R>(
  key: string,
  compute: Effect.Effect<V, E, R>,
  schema: CacheSchema<V>,
  options: CacheOptions
): Effect.Effect<V, E, R | CacheService | ExecutionContextService> =>
  Effect.gen(function* () {
    const cacheService = yield* CacheService
    const executionContext = yield* ExecutionContextService
    const entrySchema = CacheEntrySchema(schema)
    const jsonSchema = Schema.fromJsonString(entrySchema)

    const effectiveKey = resolveKey(key, schema, options.version)
    const ttlMs = Duration.toMillis(Duration.fromInputUnsafe(options.ttl))

    const swrMs = options.swr
      ? Duration.toMillis(Duration.fromInputUnsafe(options.swr))
      : 0

    const totalTtlSeconds = Math.ceil((ttlMs + swrMs) / 1000)

    // Store a computed value; a failed write leaves the value uncached.
    const storeInCache = (value: V) =>
      Effect.gen(function* () {
        const newEntry: CacheEntry<V> = { v: value, t: yield* Clock.currentTimeMillis }
        const serialized = yield* Schema.encodeEffect(jsonSchema)(newEntry)
        yield* cacheService.put(effectiveKey, serialized, { expirationTtl: totalTtlSeconds })
      }).pipe(Effect.catch(reportStoreFailure('cache.put')))

    // An unreadable store or entry is a miss.
    const cached = yield* cacheService.get(effectiveKey).pipe(
      Effect.catch((error) => Effect.as(reportStoreFailure('cache.get')(error), null))
    )

    const entry = cached === null
      ? undefined
      : yield* Schema.decodeEffect(jsonSchema)(cached).pipe(
          Effect.catch((error) => Effect.as(reportStoreFailure('cache.decode')(error), undefined))
        )

    if (entry !== undefined) {
      const age = (yield* Clock.currentTimeMillis) - entry.t

      if (age < ttlMs) {
        // Fresh - return immediately
        return entry.v
      }

      if (swrMs > 0 && age < ttlMs + swrMs) {
        // Stale but within SWR window - return stale, trigger background refresh
        if (executionContext.isAvailable) {
          yield* executionContext.runInBackground(
            Effect.gen(function* () {
              const freshValue = yield* compute
              yield* storeInCache(freshValue)
            })
          )

          return entry.v
        }

        // No background execution available (tests/local dev): refresh inline.
        // Fall through to synchronous recompute below.
      }

      // Beyond SWR window - fall through to recompute
    }

    // Compute value (cold cache or expired)
    const value = yield* compute

    // Store with timestamp
    yield* storeInCache(value)

    return value
  }).pipe(Effect.withSpan('Web.cache'))

/**
 * Get a value from cache without computing.
 * Returns any entry still present in the backing cache store.
 * This does not apply `ttl`/`swr` freshness checks used by `cache()`.
 *
 * @example
 * ```typescript
 * const cached = yield* cacheGet(`user:${id}`, UserSchema)
 * if (Option.isSome(cached)) {
 *   return cached.value
 * }
 *
 * // With versioning (must match what was used when caching)
 * const cached = yield* cacheGet(`user:${id}`, UserSchema, { version: true })
 * ```
 */
export const cacheGet = <V>(
  key: string,
  schema: CacheSchema<V>,
  options?: CacheGetOptions
): Effect.Effect<Option.Option<V>, CacheError, CacheService> =>
  Effect.gen(function* () {
    const cacheService = yield* CacheService
    const entrySchema = CacheEntrySchema(schema)
    const jsonSchema = Schema.fromJsonString(entrySchema)

    const effectiveKey = resolveKey(key, schema, options?.version)
    const cached = yield* cacheService.get(effectiveKey)

    if (cached === null) {
      return Option.none<V>()
    }

    // An entry that no longer matches the schema reads as absent.
    const entry = yield* Schema.decodeEffect(jsonSchema)(cached).pipe(
      Effect.catch((error) => Effect.as(reportStoreFailure('cacheGet.decode')(error), undefined))
    )

    return entry === undefined ? Option.none<V>() : Option.some(entry.v)
  }).pipe(Effect.withSpan('Web.cacheGet'))

/**
 * Set a value in cache.
 *
 * @example
 * ```typescript
 * yield* cacheSet(`user:${id}`, user, UserSchema, { ttl: Duration.hours(1) })
 *
 * // With auto schema versioning
 * yield* cacheSet(`user:${id}`, user, UserSchema, { ttl: Duration.hours(1), version: true })
 * ```
 */
export const cacheSet = <V>(
  key: string,
  value: V,
  schema: CacheSchema<V>,
  options: CacheOptions
): Effect.Effect<void, CacheError, CacheService> =>
  Effect.gen(function* () {
    const cacheService = yield* CacheService
    const entrySchema = CacheEntrySchema(schema)
    const jsonSchema = Schema.fromJsonString(entrySchema)

    const effectiveKey = resolveKey(key, schema, options.version)
    const ttlMs = Duration.toMillis(Duration.fromInputUnsafe(options.ttl))

    const swrMs = options.swr
      ? Duration.toMillis(Duration.fromInputUnsafe(options.swr))
      : 0

    const totalTtlSeconds = Math.ceil((ttlMs + swrMs) / 1000)

    const entry: CacheEntry<V> = { v: value, t: yield* Clock.currentTimeMillis }
    const serialized = yield* Schema.encodeEffect(jsonSchema)(entry).pipe(
      Effect.mapError(entryError('The value does not match the cache schema.'))
    )

    yield* cacheService.put(effectiveKey, serialized, { expirationTtl: totalTtlSeconds })
  }).pipe(Effect.withSpan('Web.cacheSet'))

export type CacheInvalidateOptions<V> = {
  /** Schema used when caching (required if version is set) */
  schema: CacheSchema<V>
  /** Version option (must match what was used when caching) */
  version: string | boolean
}

/**
 * Invalidate a cache key. A store that fails is reported to
 * `EffectErrorObserverService`, not to the visitor: the write the
 * invalidation follows has happened, and the entry expires on its own.
 *
 * @example
 * ```typescript
 * // Simple invalidation
 * yield* cacheInvalidate(`user:${id}`)
 *
 * // Invalidate versioned key
 * yield* cacheInvalidate(`user:${id}`, { schema: UserSchema, version: true })
 * ```
 */
export const cacheInvalidate = <V = unknown>(
  key: string,
  options?: CacheInvalidateOptions<V>
): Effect.Effect<void, never, CacheService> =>
  Effect.gen(function* () {
    const cacheService = yield* CacheService

    const effectiveKey = options
      ? resolveKey(key, options.schema, options.version)
      : key

    yield* cacheService.delete(effectiveKey)
  }).pipe(
    Effect.catchTag('CacheError', reportInvalidationFailure('invalidate')),
    Effect.withSpan('Web.cacheInvalidate')
  )

/**
 * Invalidate all cache keys with a given prefix. A store that fails is
 * reported, as for `cacheInvalidate`.
 *
 * @example
 * ```typescript
 * yield* cacheInvalidatePrefix(`user:${userId}:`)
 * ```
 */
export const cacheInvalidatePrefix = (
  prefix: string
): Effect.Effect<void, never, CacheService> =>
  Effect.gen(function* () {
    const cacheService = yield* CacheService
    let cursor: string | undefined = undefined

    while (true) {
      const page: {
        keys: Array<{ name: string }>
        list_complete: boolean
        cursor?: string
      } = yield* cacheService.list({ prefix, cursor })

      yield* Effect.forEach(
        page.keys,
        (key) => cacheService.delete(key.name),
        { concurrency: 10 }
      )

      if (page.list_complete || page.cursor === undefined) {
        break
      }

      cursor = page.cursor
    }
  }).pipe(
    Effect.catchTag('CacheError', reportInvalidationFailure('invalidatePrefix')),
    Effect.withSpan('Web.cacheInvalidatePrefix')
  )

export { CacheService, type CacheClient } from './effect/services.js'
export { CacheError }
