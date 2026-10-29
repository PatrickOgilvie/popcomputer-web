/**
 * `@popcomputer/web/cache`: a schema-checked data cache.
 *
 * Provide a store with `kvCache(c.env.KV)` in `web.services({ request })`,
 * or any other CacheClient through CacheService. `cache()` wraps a
 * computation, with stale-while-revalidate, and never fails because of the
 * store: an unreachable store or an unreadable entry computes the value
 * instead, and the failure is reported to EffectErrorObserverService.
 */

import { Clock, Duration, Effect, Layer, Option, Random, Schema } from 'effect'
import { CacheService, ExecutionContextService, type CacheClient } from './effect/services.js'
import { CacheError } from './effect/errors.js'
import { observeOrLog } from './effect/error-observer.js'
import type { CacheTag } from './effect/response-cache.js'

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
  /**
   * The cache tags the value depends on, as a route's `purges`, `purgeCache`
   * and `recordCacheTag` name them: a route that purges one of them after a
   * write also invalidates this entry, as it does a cached response.
   */
  tags?: ReadonlyArray<CacheTag>
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
    g: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)), // tag generations
  })

type CacheEntry<V> = { v: V; t: number; g?: Readonly<Record<string, string>> }

/** The store key holding a cache tag's generation, which each purge replaces. */
const tagGenerationKey = (tag: string): string => `popweb:tag:${tag}`

/** How long a tag's generation is kept after it is created or replaced. */
const TAG_GENERATION_TTL_SECONDS = 30 * 24 * 60 * 60

/** A value no earlier generation of any tag has had. */
const newGeneration: Effect.Effect<string> = Effect.gen(function* () {
  return `${(yield* Clock.currentTimeMillis).toString(36)}.${(yield* Random.nextInt).toString(36)}`
})

/**
 * Each tag's current generation. A tag no entry has used yet gets its first
 * generation here, before the value is computed, so a purge that follows a
 * write during the computation replaces it; a purge of a tag without one
 * writes nothing.
 */
const readTagGenerations = (
  client: CacheClient,
  tags: ReadonlyArray<string>
): Effect.Effect<Readonly<Record<string, string>>, CacheError> =>
  Effect.forEach(
    tags,
    (tag) => Effect.gen(function* () {
      const current = yield* client.get(tagGenerationKey(tag))

      if (current !== null) return [tag, current] as const

      const first = yield* newGeneration
      yield* client.put(tagGenerationKey(tag), first, { expirationTtl: TAG_GENERATION_TTL_SECONDS })

      return [tag, first] as const
    }),
    { concurrency: 'unbounded' }
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)))

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

/** The shortest expiry Workers KV accepts. */
const KV_MINIMUM_TTL_SECONDS = 60

/**
 * Where the cache keeps its keys in a KV namespace. The namespace can hold
 * other data, such as an audit log, which the cache never reads, lists or
 * deletes: even `cacheInvalidatePrefix('')` reaches only the cache's keys.
 */
const KV_CACHE_PREFIX = 'popweb:cache:'

/**
 * Provide CacheService backed by a Workers KV namespace, keeping its keys
 * under `popweb:cache:`, so the namespace can hold other data too. KV keeps
 * an entry at least 60 seconds; `cache()` still treats it as fresh only for
 * its `ttl`.
 *
 * @example
 * export const { app, routes } = web.services({ request: (c) => kvCache(c.env.KV) })
 */
export function kvCache(kv: KVNamespaceLike): Layer.Layer<CacheService> {
  const attempt = <A>(reason: string, run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => new CacheError({ reason, cause }) })
  const stored = (key: string) => `${KV_CACHE_PREFIX}${key}`

  const client: CacheClient = {
    get: (key) => attempt('Could not read from the cache.', () => kv.get(stored(key))),
    // KV rejects an expiry under 60 seconds; cache() judges freshness from
    // the entry's own time, so a shorter TTL is kept the minimum time.
    put: (key, value, options) =>
      attempt('Could not write to the cache.', () =>
        kv.put(stored(key), value, options?.expirationTtl === undefined
          ? options
          : { ...options, expirationTtl: Math.max(KV_MINIMUM_TTL_SECONDS, options.expirationTtl) })
      ),
    delete: (key) => attempt('Could not delete from the cache.', () => kv.delete(stored(key))),
    // Listed under the cache's prefix alone, and named as the cache names them.
    list: (options) =>
      attempt('Could not list cache keys.', () =>
        kv.list({ ...options, prefix: stored(options?.prefix ?? '') }).then((page) => ({
          ...page,
          keys: page.keys.map((key) => ({ ...key, name: key.name.slice(KV_CACHE_PREFIX.length) })),
        }))
      ),
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
): Effect.Effect<V, E, R | CacheService> =>
  Effect.gen(function* () {
    const cacheService = yield* CacheService
    // A stale value refreshes in the background when the request has an
    // execution context, and inline otherwise, as in a test.
    const executionContext = Option.getOrUndefined(yield* Effect.serviceOption(ExecutionContextService))
    const entrySchema = CacheEntrySchema(schema)
    const jsonSchema = Schema.fromJsonString(entrySchema)

    const effectiveKey = resolveKey(key, schema, options.version)
    const ttlMs = Duration.toMillis(Duration.fromInputUnsafe(options.ttl))

    const swrMs = options.swr
      ? Duration.toMillis(Duration.fromInputUnsafe(options.swr))
      : 0

    const totalTtlSeconds = Math.ceil((ttlMs + swrMs) / 1000)
    const tags = options.tags ?? []

    // An unreadable store or entry is a miss. The tags' generations are read
    // before the value is computed, so a purge during the computation leaves
    // the stored entry stale; without them the value is not stored.
    const [cached, generations] = yield* Effect.all([
      cacheService.get(effectiveKey).pipe(
        Effect.catch((error) => Effect.as(reportStoreFailure('cache.get')(error), null))
      ),
      tags.length === 0
        ? Effect.succeedSome<Readonly<Record<string, string>>>({})
        : readTagGenerations(cacheService, tags).pipe(
            Effect.map(Option.some),
            Effect.catch((error) => Effect.as(reportStoreFailure('cache.tags')(error), Option.none()))
          ),
    ], { concurrency: 'unbounded' })

    // Store a computed value; a failed write leaves the value uncached.
    const storeInCache = (value: V) =>
      Effect.gen(function* () {
        if (Option.isNone(generations)) return

        const t = yield* Clock.currentTimeMillis
        const newEntry: CacheEntry<V> = tags.length === 0 ? { v: value, t } : { v: value, t, g: generations.value }
        const serialized = yield* Schema.encodeEffect(jsonSchema)(newEntry)
        yield* cacheService.put(effectiveKey, serialized, { expirationTtl: totalTtlSeconds })
      }).pipe(Effect.catch(reportStoreFailure('cache.put')))

    const decoded = cached === null
      ? undefined
      : yield* Schema.decodeEffect(jsonSchema)(cached).pipe(
          Effect.catch((error) => Effect.as(reportStoreFailure('cache.decode')(error), undefined))
        )

    const now = yield* Clock.currentTimeMillis

    // A purge of any of its tags since the entry was stored makes it a miss,
    // as does an entry stored after now, by a clock a test has set back.
    const entry = decoded !== undefined && Option.isSome(generations) && decoded.t <= now &&
      tags.every((tag) => decoded.g?.[tag] === generations.value[tag])
      ? decoded
      : undefined

    if (entry !== undefined) {
      const age = now - entry.t

      if (age < ttlMs) {
        // Fresh - return immediately
        return entry.v
      }

      if (swrMs > 0 && age < ttlMs + swrMs) {
        // Stale but within SWR window - return stale, trigger background refresh
        if (executionContext?.isAvailable === true) {
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
 * Returns any entry still present in the backing cache store, unless one of
 * the tags it was stored with has been invalidated since.
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

    if (entry === undefined) return Option.none<V>()

    // So does one stored with tags, once any of them was invalidated since.
    const current = yield* Effect.forEach(
      Object.entries(entry.g ?? {}),
      ([tag, generation]) => Effect.map(cacheService.get(tagGenerationKey(tag)), (now) => now === generation),
      { concurrency: 'unbounded' }
    )

    return current.every(Boolean) ? Option.some(entry.v) : Option.none<V>()
  }).pipe(Effect.withSpan('Web.cacheGet'))

/**
 * Set a value in cache. With `tags`, the entry records their generations, as
 * `cache()` does, so invalidating any of them makes it a miss for both.
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
    const tags = options.tags ?? []
    // Its tags' generations, as cache() records them, so an invalidation of
    // any of them makes the entry a miss.
    const generations = tags.length === 0 ? undefined : yield* readTagGenerations(cacheService, tags)
    const t = yield* Clock.currentTimeMillis

    const entry: CacheEntry<V> = generations === undefined ? { v: value, t } : { v: value, t, g: generations }
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

/**
 * Give each tag a cached entry uses a new generation, so every entry `cache`
 * stored with it is a miss. A route runs it with its purges after a
 * successful write. A tag no entry uses costs one store read and no write. A
 * store failure is reported and the entries stay until they expire; without
 * a cache store it does nothing.
 */
export const invalidateCacheTags = (tags: ReadonlyArray<CacheTag>): Effect.Effect<void> =>
  Effect.flatMap(Effect.serviceOption(CacheService), (store) => {
    if (Option.isNone(store) || tags.length === 0) return Effect.void

    const client = store.value

    return Effect.forEach(
      tags,
      (tag) => Effect.gen(function* () {
        if ((yield* client.get(tagGenerationKey(tag))) === null) return

        yield* client.put(tagGenerationKey(tag), yield* newGeneration, { expirationTtl: TAG_GENERATION_TTL_SECONDS })
      }),
      { concurrency: 'unbounded', discard: true }
    ).pipe(Effect.catch(reportInvalidationFailure('cache.invalidateTags')))
  })

export { CacheService, type CacheClient } from './effect/services.js'
export { CacheError }
