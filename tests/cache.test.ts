/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
import assert from 'node:assert/strict'
import { TestClock } from 'effect/testing'
import { describe, it, expect } from 'bun:test'
import { Clock, Deferred, Predicate, Effect, Layer, Option, Schema as S, Duration } from 'effect'
import {
  CacheService,
  CacheError,
  cache,
  cacheGet,
  cacheSet,
  cacheInvalidate,
  cacheInvalidatePrefix,
  invalidateCacheTags,
  kvCache,
  type CacheClient,
} from '../src/cache.js'
import { ExecutionContextService, type ExecutionContextClient } from '../src/effect/index.js'
import { EffectErrorObserverService } from '../src/effect/error-observer.js'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { json } from '../src/effect/responses.js'
import { purgeCache } from '../src/effect/response-cache.js'
import { testEnv } from '../src/testing.js'

// ============================================================================
// Test ExecutionContext Layer
// ============================================================================

const makeTestExecutionContext = () => {
  const tasks: Promise<unknown>[] = []

  const client: ExecutionContextClient = {
    isAvailable: true,
    waitUntil: (promise) => {
      tasks.push(promise)
    },
    runInBackground: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(Effect.context<R>(), (context) =>
        Effect.sync(() => {
          const promise = Effect.runPromise(
            effect.pipe(
              Effect.provide(context),
              Effect.catchCause(() => Effect.void)
            )
          )

          tasks.push(promise)
        })
      ),
    schedule: <A, E, R>(_operation: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(Effect.context<R>(), (context) =>
        Effect.sync(() => {
          const promise = Effect.runPromise(
            effect.pipe(
              Effect.provide(context),
              Effect.catchCause(() => Effect.void)
            )
          )

          tasks.push(promise)
        })
      ),
  }

  return {
    layer: Layer.succeed(ExecutionContextService, client),
    backgroundTasks: tasks,
    awaitAll: () => Promise.all(tasks).then(() => {}),
  }
}

const makeNoopExecutionContext = () => {
  const client: ExecutionContextClient = {
    isAvailable: false,
    waitUntil: () => {},
    runInBackground: () => Effect.void,
    schedule: () => Effect.void,
  }

  return {
    layer: Layer.succeed(ExecutionContextService, client),
  }
}

// ============================================================================
// Test Cache Layer
// ============================================================================

const makeTestCache = () => {
  const store = new Map<string, { value: string; expiresAt: number }>()

  const client: CacheClient = {
    get: (key) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const entry = store.get(key)

        if (!entry || entry.expiresAt <= now) {
          store.delete(key)

          return null
        }

        return entry.value
      }),
    put: (key, value, options) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const ttlMs = (options?.expirationTtl ?? 3600) * 1000
        store.set(key, { value, expiresAt: now + ttlMs })
      }),
    delete: (key) =>
      Effect.sync(() => {
        store.delete(key)
      }),
    list: (options) =>
      Effect.sync(() => ({
        keys: [...store.keys()]
          .flatMap((name) => !options?.prefix || name.startsWith(options.prefix) ? [{ name }] : []),
        list_complete: true,
      })),
  }

  const execCtx = makeTestExecutionContext()

  return {
    layer: Layer.mergeAll(
      Layer.succeed(CacheService, client),
      execCtx.layer,
      TestClock.layer(),
    ),
    storeLayer: Layer.succeed(CacheService, client),
    store,
    executionContext: {
      backgroundTasks: execCtx.backgroundTasks,
      awaitAll: execCtx.awaitAll,
    },
  }
}

// ============================================================================
// Test Schemas
// ============================================================================

const UserSchema = S.Struct({
  id: S.String,
  name: S.String,
  email: S.String,
})

const UserCacheEntry = S.fromJsonString(S.Struct({
  v: UserSchema,
  t: S.Finite,
}))

const ProjectSchema = S.Struct({
  id: S.String,
  name: S.String,
  userId: S.String,
})

// ============================================================================
// Tests
// ============================================================================

describe('cache', () => {
  it('uses the Effect clock for cache freshness and stored timestamps', async () => {
    const { layer, store } = makeTestCache()
    let computations = 0
    const value = { id: 'clock-user', name: 'Clock User', email: 'clock@example.com' }

    const compute = Effect.sync(() => {
      computations++

      return value
    })

    const program = Effect.gen(function*() {
      yield* cache('clock-key', compute, UserSchema, { ttl: '1 second' })
      yield* TestClock.adjust('500 millis')
      yield* cache('clock-key', compute, UserSchema, { ttl: '1 second' })
      expect(computations).toBe(1)

      yield* TestClock.adjust('500 millis')
      yield* cache('clock-key', compute, UserSchema, { ttl: '1 second' })
      expect(computations).toBe(2)

      yield* cacheSet('manual-clock-key', value, UserSchema, { ttl: '1 second' })
      const entry = store.get('manual-clock-key')
      assert.ok(entry)

      const decoded = yield* S.decodeEffect(S.fromJsonString(S.Struct({
        v: UserSchema,
        t: S.Finite,
      })))(entry.value)

      expect(decoded.t).toBe(1000)
      expect(decoded.v).toEqual(value)
    })

    await Effect.runPromise(program.pipe(
      Effect.provide(layer),
    ))
  })

  it('recomputes an entry stored after now, as when a test sets the clock back', async () => {
    const { layer } = makeTestCache()
    let computations = 0
    const compute = Effect.sync(() => ++computations)

    await Effect.gen(function* () {
      yield* TestClock.adjust('1 day')
      yield* cache('k', compute, S.Number, { ttl: '1 hour' })
      yield* TestClock.setTime(0)

      expect(yield* cache('k', compute, S.Number, { ttl: '1 hour' })).toBe(2)
    }).pipe(Effect.provide(layer), Effect.runPromise)
  })

  it('serves a cached value that holds dates, as JSON would turn them into strings', async () => {
    const { layer } = makeTestCache()
    const Stats = S.Struct({ total: S.Number, computedAt: S.Date })
    let computations = 0

    const compute = Effect.sync(() => {
      computations++

      return { total: 3, computedAt: new Date(Date.UTC(2026, 9, 13)) }
    })

    const [first, second] = await Effect.runPromise(Effect.all([
      cache('stats', compute, Stats, { ttl: '1 minute' }),
      cache('stats', compute, Stats, { ttl: '1 minute' }),
    ]).pipe(Effect.provide(layer)))

    expect(computations).toBe(1)
    expect(second.computedAt).toBeInstanceOf(Date)
    expect(second).toEqual(first)
  })

  describe('cache()', () => {
    it('reads an entry with a non-finite timestamp as absent', async () => {
      const { layer, store } = makeTestCache()
      store.set('user:1', {
        value: '{"v":{"id":"1","name":"Test","email":"test@example.com"},"t":1e999}',
        expiresAt: 3_600_000,
      })

      const result = await Effect.runPromise(cacheGet('user:1', UserSchema).pipe(
        Effect.provide(layer),
      ))

      expect(Option.isNone(result)).toBe(true)
    })

    it('computes and caches value on first call', async () => {
      const { layer } = makeTestCache()
      let callCount = 0

      await Effect.gen(function* () {
        const compute = Effect.sync(() => {
          callCount++

          return { id: '1', name: 'Test User', email: 'test@example.com' }
        })

        const result = yield* cache('user:1', compute, UserSchema, { ttl: Duration.hours(1) })

        expect(result).toEqual({ id: '1', name: 'Test User', email: 'test@example.com' })
        expect(callCount).toBe(1)
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('returns cached value on subsequent calls without recomputing', async () => {
      const { layer } = makeTestCache()
      let callCount = 0

      await Effect.gen(function* () {
        const compute = Effect.sync(() => {
          callCount++

          return { id: '1', name: 'Test User', email: 'test@example.com' }
        })

        const first = yield* cache('user:1', compute, UserSchema, { ttl: Duration.hours(1) })
        const second = yield* cache('user:1', compute, UserSchema, { ttl: Duration.hours(1) })
        const third = yield* cache('user:1', compute, UserSchema, { ttl: Duration.hours(1) })

        expect(first).toEqual(second)
        expect(second).toEqual(third)
        expect(callCount).toBe(1) // Only computed once
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('recomputes after cache invalidation', async () => {
      const { layer } = makeTestCache()
      let callCount = 0

      await Effect.gen(function* () {
        const compute = Effect.sync(() => {
          callCount++

          return { id: '1', name: `User ${callCount}`, email: 'test@example.com' }
        })

        const first = yield* cache('user:1', compute, UserSchema, { ttl: Duration.hours(1) })
        expect(first.name).toBe('User 1')

        yield* cacheInvalidate('user:1')

        const second = yield* cache('user:1', compute, UserSchema, { ttl: Duration.hours(1) })
        expect(second.name).toBe('User 2')
        expect(callCount).toBe(2)
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('propagates compute errors', async () => {
      const { layer } = makeTestCache()

      const result = await Effect.gen(function* () {
        const failure = new CacheError({ reason: 'Database connection failed' })
        const compute = Effect.fail(failure)

        return yield* cache('user:1', compute, UserSchema, { ttl: Duration.hours(1) })
      }).pipe(Effect.provide(layer), Effect.result, Effect.runPromise)

      expect(result._tag).toBe('Failure')

      if (Predicate.isTagged(result, 'Failure')) {
        expect(result.failure).toBeInstanceOf(CacheError)

        if (result.failure instanceof CacheError) {
          expect(result.failure.reason).toBe('Database connection failed')
        }
      }
    })

    it('recomputes and replaces an entry that no longer matches the schema', async () => {
      const { layer, store } = makeTestCache()

      // Pre-populate cache with invalid data (missing required fields in value)
      store.set('user:1', {
        value: JSON.stringify({ v: { id: '1', invalid: 'data' }, t: 0 }),
        expiresAt: 3600000,
      })

      const result = await Effect.gen(function* () {
        const compute = Effect.sync(() => ({
          id: '1',
          name: 'Test User',
          email: 'test@example.com',
        }))

        return yield* cache('user:1', compute, UserSchema, { ttl: Duration.hours(1) })
      }).pipe(Effect.provide(layer), Effect.runPromise)

      expect(result).toEqual({ id: '1', name: 'Test User', email: 'test@example.com' })
      expect(JSON.parse(store.get('user:1')?.value ?? 'null').v).toEqual(result)
    })

    it('caches complex nested objects', async () => {
      const { layer } = makeTestCache()

      const ComplexSchema = S.Struct({
        id: S.String,
        data: S.Struct({
          items: S.Array(S.Struct({ name: S.String, value: S.Finite })),
          metadata: S.Struct({
            createdAt: S.String,
            tags: S.Array(S.String),
          }),
        }),
      })

      await Effect.gen(function* () {
        const complex = {
          id: '1',
          data: {
            items: [
              { name: 'item1', value: 100 },
              { name: 'item2', value: 200 },
            ],
            metadata: {
              createdAt: '2024-01-01',
              tags: ['tag1', 'tag2'],
            },
          },
        }

        const compute = Effect.succeed(complex)
        const result = yield* cache('complex:1', compute, ComplexSchema, { ttl: Duration.hours(1) })

        expect(result).toEqual(complex)
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })
  })

  describe('cacheGet()', () => {
    it('returns Option.none for missing keys', async () => {
      const { layer } = makeTestCache()

      await Effect.gen(function* () {
        const result = yield* cacheGet('nonexistent', UserSchema)
        expect(Option.isNone(result)).toBe(true)
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('returns Option.some with decoded value for existing keys', async () => {
      const { layer, store } = makeTestCache()

      // Pre-populate cache with new internal format
      store.set('user:1', {
        value: JSON.stringify({ v: { id: '1', name: 'Test', email: 'test@example.com' }, t: 0 }),
        expiresAt: 3600000,
      })

      await Effect.gen(function* () {
        const result = yield* cacheGet('user:1', UserSchema)

        expect(Option.isSome(result)).toBe(true)

        if (Option.isSome(result)) {
          expect(result.value).toEqual({ id: '1', name: 'Test', email: 'test@example.com' })
        }
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('returns Option.none for expired entries', async () => {
      const { layer, store } = makeTestCache()

      // Pre-populate cache with expired entry
      store.set('user:1', {
        value: JSON.stringify({ v: { id: '1', name: 'Test', email: 'test@example.com' }, t: 0 }),
        expiresAt: -1000, // Expired
      })

      await Effect.gen(function* () {
        const result = yield* cacheGet('user:1', UserSchema)
        expect(Option.isNone(result)).toBe(true)
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })
  })

  describe('cacheSet()', () => {
    it('stores value in cache', async () => {
      const { layer, store } = makeTestCache()

      await Effect.gen(function* () {
        const user = { id: '1', name: 'Test', email: 'test@example.com' }
        yield* cacheSet('user:1', user, UserSchema, { ttl: Duration.hours(1) })

        const entry = store.get('user:1')
        expect(entry).toBeDefined()
        assert.ok(entry)
        const parsed = yield* S.decodeEffect(UserCacheEntry)(entry.value)
        expect(parsed.v).toEqual(user)
        expect(parsed.t).toEqual(expect.any(Number))
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('overwrites existing value', async () => {
      const { layer, store } = makeTestCache()

      await Effect.gen(function* () {
        const user1 = { id: '1', name: 'User 1', email: 'user1@example.com' }
        const user2 = { id: '1', name: 'User 2', email: 'user2@example.com' }

        yield* cacheSet('user:1', user1, UserSchema, { ttl: Duration.hours(1) })
        yield* cacheSet('user:1', user2, UserSchema, { ttl: Duration.hours(1) })

        const entry = store.get('user:1')
        assert.ok(entry)
        const parsed = yield* S.decodeEffect(UserCacheEntry)(entry.value)
        expect(parsed.v).toEqual(user2)
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('respects TTL', async () => {
      const { layer, store } = makeTestCache()

      await Effect.gen(function* () {
        const user = { id: '1', name: 'Test', email: 'test@example.com' }
        yield* cacheSet('user:1', user, UserSchema, { ttl: Duration.seconds(60) })

        const entry = store.get('user:1')
        const expectedExpiry = 60000
        assert.ok(entry)
        expect(entry.expiresAt).toBe(expectedExpiry)
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })
  })

  describe('cacheInvalidate()', () => {
    it('removes key from cache', async () => {
      const { layer, store } = makeTestCache()

      store.set('user:1', {
        value: JSON.stringify({ id: '1', name: 'Test', email: 'test@example.com' }),
        expiresAt: 3600000,
      })

      await Effect.gen(function* () {
        yield* cacheInvalidate('user:1')
        expect(store.has('user:1')).toBe(false)
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('succeeds for non-existent keys', async () => {
      const { layer } = makeTestCache()

      await cacheInvalidate('nonexistent').pipe(Effect.provide(layer), Effect.runPromise)
    })
  })

  describe('cacheInvalidatePrefix()', () => {
    it('removes all keys with matching prefix', async () => {
      const { layer, store } = makeTestCache()

      // Pre-populate cache with multiple keys
      store.set('user:1:profile', {
        value: '{}',
        expiresAt: 3600000,
      })
      store.set('user:1:settings', {
        value: '{}',
        expiresAt: 3600000,
      })
      store.set('user:1:notifications', {
        value: '{}',
        expiresAt: 3600000,
      })
      store.set('user:2:profile', {
        value: '{}',
        expiresAt: 3600000,
      })
      store.set('other:key', {
        value: '{}',
        expiresAt: 3600000,
      })

      await Effect.gen(function* () {
        yield* cacheInvalidatePrefix('user:1:')

        expect(store.has('user:1:profile')).toBe(false)
        expect(store.has('user:1:settings')).toBe(false)
        expect(store.has('user:1:notifications')).toBe(false)
        expect(store.has('user:2:profile')).toBe(true) // Not deleted
        expect(store.has('other:key')).toBe(true) // Not deleted
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('handles empty prefix (deletes nothing)', async () => {
      const { layer, store } = makeTestCache()

      store.set('key1', { value: '{}', expiresAt: 3600000 })
      store.set('key2', { value: '{}', expiresAt: 3600000 })

      await Effect.gen(function* () {
        yield* cacheInvalidatePrefix('nonexistent:')

        expect(store.has('key1')).toBe(true)
        expect(store.has('key2')).toBe(true)
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('paginates through all list results', async () => {
      const store = new Map<string, { value: string; expiresAt: number }>()
      const listCalls: Array<string | undefined> = []
      let listedSnapshot: string[] | null = null

      store.set('user:1:profile', { value: '{}', expiresAt: 3600000 })
      store.set('user:1:settings', { value: '{}', expiresAt: 3600000 })
      store.set('user:1:notifications', { value: '{}', expiresAt: 3600000 })
      store.set('user:1:projects', { value: '{}', expiresAt: 3600000 })
      store.set('user:2:profile', { value: '{}', expiresAt: 3600000 })

      const cacheClient: CacheClient = {
        get: (key) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const entry = store.get(key)

            if (!entry || entry.expiresAt <= now) {
              store.delete(key)

              return null
            }

            return entry.value
          }),
        put: (key, value, options) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const ttlMs = (options?.expirationTtl ?? 3600) * 1000
            store.set(key, { value, expiresAt: now + ttlMs })
          }),
        delete: (key) =>
          Effect.sync(() => {
            store.delete(key)
          }),
        list: (options) =>
          Effect.sync(() => {
            listCalls.push(options?.cursor)

            listedSnapshot ??= [...store.keys()]
              .filter((k) => !options?.prefix || k.startsWith(options.prefix))
              .sort()

            const pageSize = 2
            const offset = Number(options?.cursor ?? '0')
            const page = listedSnapshot.slice(offset, offset + pageSize)
            const nextOffset = offset + page.length
            const listComplete = nextOffset >= listedSnapshot.length

            return {
              keys: page.map((name) => ({ name })),
              list_complete: listComplete,
              cursor: listComplete ? undefined : String(nextOffset),
            }
          }),
      }

      await Effect.gen(function* () {
        yield* cacheInvalidatePrefix('user:1:')

        expect(store.has('user:1:profile')).toBe(false)
        expect(store.has('user:1:settings')).toBe(false)
        expect(store.has('user:1:notifications')).toBe(false)
        expect(store.has('user:1:projects')).toBe(false)
        expect(store.has('user:2:profile')).toBe(true)
      }).pipe(
        Effect.provideService(CacheService, cacheClient),
        Effect.runPromise
      )

      expect(listCalls).toEqual([undefined, '2'])
    })
  })

  describe('CacheService directly', () => {
    it('provides raw access to cache operations', async () => {
      const { layer } = makeTestCache()

      await Effect.gen(function* () {
        const cacheClient = yield* CacheService

        // Raw put
        yield* cacheClient.put('raw:key', '{"data":"value"}', { expirationTtl: 3600 })

        // Raw get
        const raw = yield* cacheClient.get('raw:key')
        expect(raw).toBe('{"data":"value"}')

        // List
        const keys = yield* cacheClient.list({ prefix: 'raw:' })
        expect(keys.keys).toHaveLength(1)
        expect(keys.keys[0].name).toBe('raw:key')

        // Delete
        yield* cacheClient.delete('raw:key')
        const deleted = yield* cacheClient.get('raw:key')
        expect(deleted).toBeNull()
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })
  })

  describe('error handling', () => {
    const failingClient: CacheClient = {
      get: () => Effect.fail(new CacheError({ reason: 'Connection failed', cause: new Error('ECONNREFUSED') })),
      put: () => Effect.fail(new CacheError({ reason: 'Connection failed' })),
      delete: () => Effect.fail(new CacheError({ reason: 'Connection failed' })),
      list: () => Effect.fail(new CacheError({ reason: 'Connection failed' })),
    }

    it('explicit reads fail with CacheError when the store fails', async () => {
      const failingLayer = Layer.succeed(CacheService, failingClient)

      const result = await cacheGet('key', UserSchema).pipe(Effect.provide(failingLayer), Effect.result, Effect.runPromise)

      expect(result._tag).toBe('Failure')

      if (Predicate.isTagged(result, 'Failure')) {
        expect(result.failure).toBeInstanceOf(CacheError)
        expect(result.failure.reason).toBe('Connection failed')
      }
    })

    it('cache() computes the value when the store fails, and reports the failure', async () => {
      const observed: string[] = []

      const observer = Layer.succeed(EffectErrorObserverService, {
        observe: (event) => Effect.sync(() => {
          observed.push(String(event.metadata?.operation))
        }),
      })

      const value = await cache(
        'user:1',
        Effect.succeed({ id: '1', name: 'Ada', email: 'ada@example.com' }),
        UserSchema,
        { ttl: Duration.hours(1) }
      ).pipe(
        Effect.provide(Layer.mergeAll(Layer.succeed(CacheService, failingClient), observer, makeTestExecutionContext().layer)),
        Effect.runPromise
      )

      expect(value.name).toBe('Ada')
      expect(observed).toEqual(['cache.get', 'cache.put'])
    })

    it('invalidation reports a store that fails instead of failing the write it follows', async () => {
      const observed: string[] = []

      const observer = Layer.succeed(EffectErrorObserverService, {
        observe: (event) => Effect.sync(() => {
          observed.push(String(event.metadata?.operation))
        }),
      })

      await Effect.gen(function* () {
        yield* cacheInvalidate('user:1')
        yield* cacheInvalidatePrefix('user:')
      }).pipe(
        Effect.provide(Layer.mergeAll(Layer.succeed(CacheService, failingClient), observer)),
        Effect.runPromise
      )

      expect(observed).toEqual(['invalidate', 'invalidatePrefix'])
    })
  })

  describe('integration scenarios', () => {
    it('handles typical read-through cache pattern', async () => {
      const { layer } = makeTestCache()
      let dbCalls = 0

      const fetchFromDb = (id: string) =>
        Effect.sync(() => {
          dbCalls++

          return { id, name: `Project ${id}`, userId: 'user-1' }
        })

      await Effect.gen(function* () {
        // First request - cache miss, fetches from DB
        const project1 = yield* cache(
          'project:1',
          fetchFromDb('1'),
          ProjectSchema,
          { ttl: Duration.minutes(5) }
        )

        expect(project1.id).toBe('1')
        expect(dbCalls).toBe(1)

        // Second request - cache hit
        const project1Again = yield* cache(
          'project:1',
          fetchFromDb('1'),
          ProjectSchema,
          { ttl: Duration.minutes(5) }
        )

        expect(project1Again.id).toBe('1')
        expect(dbCalls).toBe(1) // Still 1, no DB call

        // Different key - cache miss
        const project2 = yield* cache(
          'project:2',
          fetchFromDb('2'),
          ProjectSchema,
          { ttl: Duration.minutes(5) }
        )

        expect(project2.id).toBe('2')
        expect(dbCalls).toBe(2)
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('handles write-through invalidation pattern', async () => {
      const { layer } = makeTestCache()
      let version = 1

      const fetchProject = () =>
        Effect.sync(() => ({
          id: '1',
          name: `Project v${version}`,
          userId: 'user-1',
        }))

      const updateProject = () =>
        Effect.sync(() => {
          version++
        })

      await Effect.gen(function* () {
        // Initial fetch
        const v1 = yield* cache('project:1', fetchProject(), ProjectSchema, { ttl: Duration.hours(1) })
        expect(v1.name).toBe('Project v1')

        // Update (simulated DB write)
        yield* updateProject()

        // Still returns cached v1
        const stillV1 = yield* cache('project:1', fetchProject(), ProjectSchema, { ttl: Duration.hours(1) })
        expect(stillV1.name).toBe('Project v1')

        // Invalidate after write
        yield* cacheInvalidate('project:1')

        // Now gets fresh v2
        const v2 = yield* cache('project:1', fetchProject(), ProjectSchema, { ttl: Duration.hours(1) })
        expect(v2.name).toBe('Project v2')
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })
  })

  describe('stale-while-revalidate (SWR)', () => {
    it('returns fresh value when within TTL', async () => {
      const { layer, store } = makeTestCache()
      let callCount = 0

      // Pre-populate cache with fresh entry (cached just now)
      store.set('user:1', {
        value: JSON.stringify({ v: { id: '1', name: 'Cached User', email: 'cached@example.com' }, t: 0 }),
        expiresAt: 3600000,
      })

      await Effect.gen(function* () {
        const compute = Effect.sync(() => {
          callCount++

          return { id: '1', name: 'Fresh User', email: 'fresh@example.com' }
        })

        const result = yield* cache('user:1', compute, UserSchema, {
          ttl: Duration.hours(1),
          swr: Duration.minutes(5),
        })

        expect(result.name).toBe('Cached User') // Returns cached, not computed
        expect(callCount).toBe(0) // No recompute
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('returns stale value when within SWR window and triggers background refresh', async () => {
      const { layer, store, executionContext } = makeTestCache()
      let callCount = 0
      let computeStarted = false

      // Pre-populate cache with stale entry (cached 2 hours ago, TTL is 1 hour)
      const twoHoursAgo = -Duration.toMillis(Duration.hours(2))
      store.set('user:1', {
        value: JSON.stringify({ v: { id: '1', name: 'Stale User', email: 'stale@example.com' }, t: twoHoursAgo }),
        expiresAt: 3600000, // KV hasn't expired yet (TTL + SWR window)
      })

      const releaseCompute = Deferred.makeUnsafe<void>()

      const compute = Effect.gen(function* () {
        computeStarted = true
        yield* Deferred.await(releaseCompute)
        callCount++

        return { id: '1', name: 'Fresh User', email: 'fresh@example.com' }
      })

      const result = await cache('user:1', compute, UserSchema, {
          ttl: Duration.hours(1),
          swr: Duration.hours(2), // SWR window covers the staleness
        }).pipe(Effect.provide(layer), Effect.runPromise)

      // Returns stale value immediately
      expect(result.name).toBe('Stale User')

      // Background refresh was triggered (compute started)
      expect(computeStarted).toBe(true)
      expect(executionContext.backgroundTasks.length).toBe(1)

      // Release the pending refresh after verifying the stale response.
      expect(callCount).toBe(0)
      await Effect.runPromise(Deferred.succeed(releaseCompute, undefined))
      await executionContext.awaitAll()

      // Now the compute function completed
      expect(callCount).toBe(1)

      // Cache should be updated with fresh value
      const cachedEntry = store.get('user:1')
      expect(cachedEntry).toBeDefined()
      assert.ok(cachedEntry)
      const parsed = await Effect.runPromise(S.decodeEffect(UserCacheEntry)(cachedEntry.value))
      expect(parsed.v.name).toBe('Fresh User')
    })

    it('recomputes when past SWR window', async () => {
      const { layer, store } = makeTestCache()
      let callCount = 0

      // Pre-populate cache with very stale entry (cached 3 hours ago)
      const threeHoursAgo = -Duration.toMillis(Duration.hours(3))
      store.set('user:1', {
        value: JSON.stringify({ v: { id: '1', name: 'Very Stale User', email: 'stale@example.com' }, t: threeHoursAgo }),
        expiresAt: 3600000,
      })

      await Effect.gen(function* () {
        const compute = Effect.sync(() => {
          callCount++

          return { id: '1', name: 'Fresh User', email: 'fresh@example.com' }
        })

        const result = yield* cache('user:1', compute, UserSchema, {
          ttl: Duration.hours(1),
          swr: Duration.hours(1), // Only 1 hour SWR, so 3 hours ago is past the window
        })

        expect(result.name).toBe('Fresh User') // Recomputed
        expect(callCount).toBe(1)
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('extends KV TTL to cover SWR window', async () => {
      const { layer, store } = makeTestCache()

      await Effect.gen(function* () {
        const user = { id: '1', name: 'Test', email: 'test@example.com' }
        yield* cacheSet('user:1', user, UserSchema, {
          ttl: Duration.hours(1),
          swr: Duration.minutes(30),
        })

        const entry = store.get('user:1')
        // TTL should be 1 hour + 30 minutes = 5400 seconds
        const expectedExpiry = (3600 + 1800) * 1000
        assert.ok(entry)
        expect(entry.expiresAt).toBe(expectedExpiry)
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('recomputes synchronously when ExecutionContext is unavailable', async () => {
      // Create cache layer with noop ExecutionContext
      const store = new Map<string, { value: string; expiresAt: number }>()

      const cacheClient: CacheClient = {
        get: (key) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const entry = store.get(key)

            if (!entry || entry.expiresAt <= now) {
              store.delete(key)

              return null
            }

            return entry.value
          }),
        put: (key, value, options) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const ttlMs = (options?.expirationTtl ?? 3600) * 1000
            store.set(key, { value, expiresAt: now + ttlMs })
          }),
        delete: (key) => Effect.sync(() => { store.delete(key) }),
        list: (options) =>
          Effect.sync(() => ({
            keys: [...store.keys()]
              .flatMap((name) => !options?.prefix || name.startsWith(options.prefix) ? [{ name }] : []),
            list_complete: true,
          })),
      }

      const { layer: noopExecCtx } = makeNoopExecutionContext()

      const layer = Layer.mergeAll(
        Layer.succeed(CacheService, cacheClient),
        noopExecCtx,
        TestClock.layer(),
      )

      let callCount = 0

      // Pre-populate cache with stale entry
      const twoHoursAgo = -Duration.toMillis(Duration.hours(2))
      store.set('user:1', {
        value: JSON.stringify({ v: { id: '1', name: 'Stale User', email: 'stale@example.com' }, t: twoHoursAgo }),
        expiresAt: 3600000,
      })

      await Effect.gen(function* () {
        const compute = Effect.sync(() => {
          callCount++

          return { id: '1', name: 'Fresh User', email: 'fresh@example.com' }
        })

        const result = yield* cache('user:1', compute, UserSchema, {
          ttl: Duration.hours(1),
          swr: Duration.hours(2),
        })

        expect(result.name).toBe('Fresh User')
        expect(callCount).toBe(1)
      }).pipe(Effect.provide(layer), Effect.runPromise)

      // Cache was refreshed synchronously
      const cachedEntry = store.get('user:1')
      assert.ok(cachedEntry)
      const parsed = await Effect.runPromise(S.decodeEffect(UserCacheEntry)(cachedEntry.value))
      expect(parsed.v.name).toBe('Fresh User')
    })

    it('subsequent request gets fresh value after background refresh completes', async () => {
      const { layer, store, executionContext } = makeTestCache()
      let callCount = 0

      // Pre-populate cache with stale entry
      const twoHoursAgo = -Duration.toMillis(Duration.hours(2))
      store.set('user:1', {
        value: JSON.stringify({ v: { id: '1', name: 'Stale User', email: 'stale@example.com' }, t: twoHoursAgo }),
        expiresAt: 3600000,
      })

      const releaseCompute = Deferred.makeUnsafe<void>()

      const compute = Effect.gen(function* () {
        yield* Deferred.await(releaseCompute)
        callCount++

        return { id: '1', name: `Fresh User ${callCount}`, email: 'fresh@example.com' }
      })

      // First request: returns stale, triggers background refresh
      const firstResult = await cache('user:1', compute, UserSchema, {
          ttl: Duration.hours(1),
          swr: Duration.hours(2),
        }).pipe(Effect.provide(layer), Effect.runPromise)

      expect(firstResult.name).toBe('Stale User')

      // Complete the pending refresh before making the next request.
      expect(callCount).toBe(0)
      await Effect.runPromise(Deferred.succeed(releaseCompute, undefined))
      await executionContext.awaitAll()
      expect(callCount).toBe(1)

      // Second request: should get the fresh value from cache (not compute again)
      const secondResult = await cache('user:1', compute, UserSchema, {
          ttl: Duration.hours(1),
          swr: Duration.hours(2),
        }).pipe(Effect.provide(layer), Effect.runPromise)

      expect(secondResult.name).toBe('Fresh User 1') // Fresh value from background refresh
      expect(callCount).toBe(1) // No additional compute
    })
  })

  describe('cache versioning', () => {
    it('uses explicit version prefix in cache key', async () => {
      const { layer, store } = makeTestCache()

      await Effect.gen(function* () {
        const user = { id: '1', name: 'Test', email: 'test@example.com' }
        yield* cacheSet('user:1', user, UserSchema, { ttl: Duration.hours(1), version: 'v2' })

        // Key should be prefixed with version
        expect(store.has('v2:user:1')).toBe(true)
        expect(store.has('user:1')).toBe(false)
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('retrieves versioned cache with matching version', async () => {
      const { layer } = makeTestCache()

      await Effect.gen(function* () {
        const user = { id: '1', name: 'Test', email: 'test@example.com' }
        yield* cacheSet('user:1', user, UserSchema, { ttl: Duration.hours(1), version: 'v2' })

        // Can retrieve with same version
        const result = yield* cacheGet('user:1', UserSchema, { version: 'v2' })
        expect(Option.isSome(result)).toBe(true)

        if (Option.isSome(result)) {
          expect(result.value.name).toBe('Test')
        }

        // Cannot retrieve without version (different key)
        const noVersion = yield* cacheGet('user:1', UserSchema)
        expect(Option.isNone(noVersion)).toBe(true)
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('auto-generates version from schema hash when version=true', async () => {
      const { layer, store } = makeTestCache()

      await Effect.gen(function* () {
        const user = { id: '1', name: 'Test', email: 'test@example.com' }
        yield* cacheSet('user:1', user, UserSchema, { ttl: Duration.hours(1), version: true })

        // Key should have a hash prefix (not 'user:1' and not 'true:user:1')
        const keys = [...store.keys()]
        expect(keys.length).toBe(1)
        expect(keys[0]).not.toBe('user:1')
        expect(keys[0]).not.toBe('true:user:1')
        expect(keys[0]).toMatch(/^[a-z0-9]+:user:1$/) // hash:key format
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('same schema produces same hash', async () => {
      const { layer } = makeTestCache()

      await Effect.gen(function* () {
        const user = { id: '1', name: 'Test', email: 'test@example.com' }

        // Set with auto version
        yield* cacheSet('user:1', user, UserSchema, { ttl: Duration.hours(1), version: true })

        // Get with auto version should find it
        const result = yield* cacheGet('user:1', UserSchema, { version: true })
        expect(Option.isSome(result)).toBe(true)
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('different schemas produce different hashes', async () => {
      const { layer } = makeTestCache()

      const OtherSchema = S.Struct({
        id: S.String,
        title: S.String, // Different field
      })

      await Effect.gen(function* () {
        const user = { id: '1', name: 'Test', email: 'test@example.com' }
        yield* cacheSet('item:1', user, UserSchema, { ttl: Duration.hours(1), version: true })

        // Different schema should not find the cached value
        const result = yield* cacheGet('item:1', OtherSchema, { version: true })
        expect(Option.isNone(result)).toBe(true)
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('cache() respects versioning', async () => {
      const { layer } = makeTestCache()
      let callCount = 0

      await Effect.gen(function* () {
        const compute = Effect.sync(() => {
          callCount++

          return { id: '1', name: 'Test User', email: 'test@example.com' }
        })

        // First call with version
        const first = yield* cache('user:1', compute, UserSchema, {
          ttl: Duration.hours(1),
          version: 'v1',
        })

        expect(first.name).toBe('Test User')
        expect(callCount).toBe(1)

        // Second call with same version - cache hit
        const second = yield* cache('user:1', compute, UserSchema, {
          ttl: Duration.hours(1),
          version: 'v1',
        })

        expect(second.name).toBe('Test User')
        expect(callCount).toBe(1) // No recompute

        // Third call with different version - cache miss
        const third = yield* cache('user:1', compute, UserSchema, {
          ttl: Duration.hours(1),
          version: 'v2',
        })

        expect(third.name).toBe('Test User')
        expect(callCount).toBe(2) // Recomputed for new version
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('cacheInvalidate() respects versioning', async () => {
      const { layer, store } = makeTestCache()

      await Effect.gen(function* () {
        const user = { id: '1', name: 'Test', email: 'test@example.com' }

        // Set both versioned and unversioned
        yield* cacheSet('user:1', user, UserSchema, { ttl: Duration.hours(1) })
        yield* cacheSet('user:1', user, UserSchema, { ttl: Duration.hours(1), version: 'v2' })

        expect(store.has('user:1')).toBe(true)
        expect(store.has('v2:user:1')).toBe(true)

        // Invalidate only versioned
        yield* cacheInvalidate('user:1', { schema: UserSchema, version: 'v2' })

        expect(store.has('user:1')).toBe(true) // Unversioned still exists
        expect(store.has('v2:user:1')).toBe(false) // Versioned deleted
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('schema change auto-invalidates when using version=true', async () => {
      const { layer } = makeTestCache()
      let callCount = 0

      // Original schema
      const UserSchemaV1 = S.Struct({
        id: S.String,
        name: S.String,
        email: S.String,
      })

      // Updated schema with new field
      const UserSchemaV2 = S.Struct({
        id: S.String,
        name: S.String,
        email: S.String,
        avatar: S.optional(S.String), // New field
      })

      await Effect.gen(function* () {
        // Cache with v1 schema
        const computeV1 = Effect.sync(() => {
          callCount++

          return { id: '1', name: 'User V1', email: 'v1@example.com' }
        })

        yield* cache('user:1', computeV1, UserSchemaV1, {
          ttl: Duration.hours(1),
          version: true,
        })
        expect(callCount).toBe(1)

        // Try to get with v2 schema - different hash, so cache miss
        const computeV2 = Effect.sync(() => {
          callCount++

          return { id: '1', name: 'User V2', email: 'v2@example.com' }
        })

        const result = yield* cache('user:1', computeV2, UserSchemaV2, {
          ttl: Duration.hours(1),
          version: true,
        })

        expect(result.name).toBe('User V2') // Got v2, not v1
        expect(callCount).toBe(2) // Recomputed because schema changed
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })
  })
})

describe('cache tags', () => {
  const ttl = { ttl: Duration.hours(1) }

  it('recomputes an entry once one of its tags is invalidated, and leaves untagged entries', async () => {
    const { layer } = makeTestCache()
    let computations = 0
    const compute = Effect.sync(() => ++computations)

    await Effect.gen(function* () {
      expect(yield* cache('flags:e1', compute, S.Number, { ...ttl, tags: ['environments:e1', 'flags'] })).toBe(1)
      expect(yield* cache('flags:e1', compute, S.Number, { ...ttl, tags: ['environments:e1', 'flags'] })).toBe(1)
      expect(yield* cache('untagged', compute, S.Number, ttl)).toBe(2)

      yield* invalidateCacheTags(['environments:e2'])
      expect(yield* cache('flags:e1', compute, S.Number, { ...ttl, tags: ['environments:e1', 'flags'] })).toBe(1)

      yield* invalidateCacheTags(['flags'])
      expect(yield* cache('flags:e1', compute, S.Number, { ...ttl, tags: ['environments:e1', 'flags'] })).toBe(3)
      expect(yield* cache('flags:e1', compute, S.Number, { ...ttl, tags: ['environments:e1', 'flags'] })).toBe(3)
      expect(yield* cache('untagged', compute, S.Number, ttl)).toBe(2)
    }).pipe(Effect.provide(layer), Effect.runPromise)
  })

  it('does not keep a value computed while one of its tags was invalidated', async () => {
    const { layer } = makeTestCache()
    let computations = 0

    // The write the purge follows lands while the first value is computed.
    const compute = Effect.gen(function* () {
      computations += 1
      if (computations === 1) yield* invalidateCacheTags(['projects:p1'])

      return computations
    })

    await Effect.gen(function* () {
      expect(yield* cache('project:p1', compute, S.Number, { ...ttl, tags: ['projects:p1'] })).toBe(1)
      expect(yield* cache('project:p1', compute, S.Number, { ...ttl, tags: ['projects:p1'] })).toBe(2)
      expect(yield* cache('project:p1', compute, S.Number, { ...ttl, tags: ['projects:p1'] })).toBe(2)
    }).pipe(Effect.provide(layer), Effect.runPromise)
  })

  it('does not serve a stale tagged entry while revalidating', async () => {
    const { layer } = makeTestCache()
    let computations = 0
    const compute = Effect.sync(() => ++computations)
    const options = { ttl: '1 minute', swr: '1 hour', tags: ['projects'] } as const

    await Effect.gen(function* () {
      yield* cache('projects', compute, S.Number, options)
      yield* TestClock.adjust('2 minutes')
      yield* invalidateCacheTags(['projects'])

      expect(yield* cache('projects', compute, S.Number, options)).toBe(2)
    }).pipe(Effect.provide(layer), Effect.runPromise)
  })

  it('computes without storing when the tags cannot be read', async () => {
    const reported: unknown[] = []
    let puts = 0
    const failing: CacheClient = {
      get: (key) => key.startsWith('popweb:tag:') ? Effect.fail(new CacheError({ reason: 'down' })) : Effect.succeed(null),
      put: () => Effect.sync(() => { puts += 1 }),
      delete: () => Effect.void,
      list: () => Effect.succeed({ keys: [], list_complete: true }),
    }

    const value = await cache('k', Effect.succeed(7), S.Number, { ...ttl, tags: ['t'] }).pipe(
      Effect.provide(Layer.mergeAll(
        Layer.succeed(CacheService, failing),
        makeNoopExecutionContext().layer,
        Layer.succeed(EffectErrorObserverService, {
          observe: (event) => Effect.sync(() => { reported.push(event.metadata?.operation) }),
        })
      )),
      Effect.runPromise
    )

    expect(value).toBe(7)
    expect(puts).toBe(0)
    expect(reported).toEqual(['cache.tags'])
  })

  it('a route that purges a tag invalidates data cached with it, as routes.run does', async () => {
    const { storeLayer } = makeTestCache()
    const app = new Hono()
    const { routes } = setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
    }).services({ request: () => storeLayer })
    let computations = 0

    routes
      .get('/flags', action(Effect.gen(function* () {
        const evaluated = yield* cache('flags:e1', Effect.sync(() => ++computations), S.Number, {
          ttl: Duration.hours(1),
          tags: ['environments:e1'],
        })

        return yield* json({ evaluated })
      })))
      .post('/flags', action(Effect.gen(function* () {
        yield* purgeCache('environments:e1')

        return yield* json({ saved: true })
      })))

    const env = testEnv(Layer.empty)
    const evaluated = async () => (await (await app.request('/flags', {}, env)).json() as { evaluated: number }).evaluated

    expect(await evaluated()).toBe(1)
    expect(await evaluated()).toBe(1)

    await app.request('/flags', { method: 'POST' }, env)
    expect(await evaluated()).toBe(2)

    await routes.run(purgeCache('environments:e1'), env)
    expect(await evaluated()).toBe(3)
  })

  it('writes nothing for a purged tag no entry uses', async () => {
    const { layer, store } = makeTestCache()

    await Effect.gen(function* () {
      yield* invalidateCacheTags(['projects:p1'])
      expect([...store.keys()]).toEqual([])

      yield* cache('project:p1', Effect.succeed(1), S.Number, { ttl: Duration.hours(1), tags: ['projects:p1'] })
      const first = store.get('popweb:tag:projects:p1')?.value

      yield* invalidateCacheTags(['projects:p1'])
      expect(store.get('popweb:tag:projects:p1')?.value).not.toBe(first)
    }).pipe(Effect.provide(layer), Effect.runPromise)
  })

  it('does nothing without a cache store', async () => {
    await Effect.runPromise(invalidateCacheTags(['projects']))
  })
})

describe('kvCache', () => {
  it('keeps an entry KV\'s minimum 60 seconds, and cache() still treats it as fresh only for its ttl', async () => {
    const expirations: Array<number | undefined> = []
    const values = new Map<string, string>()
    const kv = {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
        // Workers KV rejects shorter expiries: "Expiration TTL must be at least 60".
        if (options?.expirationTtl !== undefined && options.expirationTtl < 60) {
          throw new Error(`Invalid expiration_ttl of ${options.expirationTtl}`)
        }
        expirations.push(options?.expirationTtl)
        values.set(key, value)
      },
      delete: async (key: string) => {
        values.delete(key)
      },
      list: async () => ({ keys: [], list_complete: true }),
    }
    let computed = 0
    const read = cache('flags:production', Effect.sync(() => ++computed), S.Number, { ttl: Duration.seconds(30) })

    await Effect.gen(function* () {
      yield* read
      yield* read
      yield* TestClock.adjust('31 seconds')
      yield* read
    }).pipe(
      Effect.provide(Layer.mergeAll(kvCache(kv), makeTestExecutionContext().layer, TestClock.layer())),
      Effect.runPromise
    )

    expect(expirations).toEqual([60, 60])
    expect(computed).toBe(2)
  })
})
