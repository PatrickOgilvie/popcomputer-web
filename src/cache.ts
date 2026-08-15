/**
 * Cache Module
 *
 * Simple cache abstraction for storing expensive DB operations.
 * Uses CacheService which is automatically provided and backed by Cloudflare KV by default.
 * Can be swapped for Redis, Memcached, or any other implementation.
 *
 * Supports stale-while-revalidate (SWR) pattern for improved latency and resilience.
 */

import { Duration, Effect, Option, Schema } from 'effect'
import { CacheService, CacheClientError, ExecutionContextService } from './effect/services.js'

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
// Errors
// ============================================================================

export class CacheError extends Schema.TaggedError<CacheError>()('CacheError', {
  reason: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// ============================================================================
// Internal
// ============================================================================

/** Internal schema for storing value with metadata */
const CacheEntrySchema = <V>(valueSchema: Schema.Codec<V>) =>
  Schema.Struct({
    v: valueSchema,
    t: Schema.Number, // cachedAt timestamp
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
const hashSchema = <V>(schema: Schema.Codec<V>): string => {
  // Stringify the AST - this captures the schema structure
  const astString = JSON.stringify(schema.ast)
  return hashString(astString)
}

/**
 * Resolve the effective cache key with optional versioning.
 */
const resolveKey = <V>(
  key: string,
  schema: Schema.Codec<V>,
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
  schema: Schema.Codec<V>,
  options: CacheOptions
): Effect.Effect<V, E | CacheError | CacheClientError | Schema.SchemaError, R | CacheService | ExecutionContextService> =>
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

    // Helper to store a value in cache
    const storeInCache = (value: V) =>
      Effect.gen(function* () {
        const newEntry: CacheEntry<V> = { v: value, t: Date.now() }
        const serialized = yield* Schema.encodeEffect(jsonSchema)(newEntry)
        yield* cacheService.put(effectiveKey, serialized, { expirationTtl: totalTtlSeconds })
      })

    // Check cache first
    const cached = yield* cacheService.get(effectiveKey)

    if (cached !== null) {
      const entry = yield* Schema.decodeUnknownEffect(jsonSchema)(cached)
      const age = Date.now() - entry.t

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
  })

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
  schema: Schema.Codec<V>,
  options?: CacheGetOptions
): Effect.Effect<Option.Option<V>, CacheError | CacheClientError | Schema.SchemaError, CacheService> =>
  Effect.gen(function* () {
    const cacheService = yield* CacheService
    const entrySchema = CacheEntrySchema(schema)
    const jsonSchema = Schema.fromJsonString(entrySchema)

    const effectiveKey = resolveKey(key, schema, options?.version)
    const cached = yield* cacheService.get(effectiveKey)

    if (cached === null) {
      return Option.none<V>()
    }

    const entry = yield* Schema.decodeUnknownEffect(jsonSchema)(cached)
    return Option.some(entry.v)
  })

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
  schema: Schema.Codec<V>,
  options: CacheOptions
): Effect.Effect<void, CacheError | CacheClientError | Schema.SchemaError, CacheService> =>
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

    const entry: CacheEntry<V> = { v: value, t: Date.now() }
    const serialized = yield* Schema.encodeEffect(jsonSchema)(entry)

    yield* cacheService.put(effectiveKey, serialized, { expirationTtl: totalTtlSeconds })
  })

export type CacheInvalidateOptions<V> = {
  /** Schema used when caching (required if version is set) */
  schema: Schema.Codec<V>
  /** Version option (must match what was used when caching) */
  version: string | boolean
}

/**
 * Invalidate a cache key.
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
): Effect.Effect<void, CacheClientError, CacheService> =>
  Effect.gen(function* () {
    const cacheService = yield* CacheService
    const effectiveKey = options
      ? resolveKey(key, options.schema, options.version)
      : key
    yield* cacheService.delete(effectiveKey)
  })

/**
 * Invalidate all cache keys with a given prefix.
 *
 * @example
 * ```typescript
 * yield* cacheInvalidatePrefix(`user:${userId}:`)
 * ```
 */
export const cacheInvalidatePrefix = (
  prefix: string
): Effect.Effect<void, CacheClientError, CacheService> =>
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
  })
