import { describe, it, expect, beforeEach } from 'bun:test'
import { Effect, Layer, Option, Schema as S, Duration } from 'effect'
import {
  CacheService,
  CacheClientError,
  ExecutionContextService,
  cache,
  cacheGet,
  cacheSet,
  cacheInvalidate,
  cacheInvalidatePrefix,
  CacheError,
  type CacheClient,
  type CacheOptions,
  type ExecutionContextClient,
} from '../src/effect/index'

// ============================================================================
// Test ExecutionContext Layer
// ============================================================================

const makeTestExecutionContext = (): {
  layer: Layer.Layer<ExecutionContextService>
  backgroundTasks: Promise<unknown>[]
  awaitAll: () => Promise<void>
} => {
  const tasks: Promise<unknown>[] = []

  const client: ExecutionContextClient = {
    isAvailable: true,
    waitUntil: (promise) => {
      tasks.push(promise)
    },
    runInBackground: (effect) =>
      Effect.flatMap(Effect.context<any>(), (context) =>
        Effect.sync(() => {
          const promise = Effect.runPromise(
            effect.pipe(
              Effect.provide(context),
              Effect.catchAllCause(() => Effect.void)
            )
          )
          tasks.push(promise)
        })
      ),
    schedule: (_operation, effect) =>
      Effect.flatMap(Effect.context<any>(), (context) =>
        Effect.sync(() => {
          const promise = Effect.runPromise(
            effect.pipe(
              Effect.provide(context),
              Effect.catchAllCause(() => Effect.void)
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

const makeNoopExecutionContext = (): {
  layer: Layer.Layer<ExecutionContextService>
} => {
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

const makeTestCache = (): {
  layer: Layer.Layer<CacheService | ExecutionContextService>
  store: Map<string, { value: string; expiresAt: number }>
  executionContext: {
    backgroundTasks: Promise<unknown>[]
    awaitAll: () => Promise<void>
  }
} => {
  const store = new Map<string, { value: string; expiresAt: number }>()

  const client: CacheClient = {
    get: (key) =>
      Effect.sync(() => {
        const entry = store.get(key)
        if (!entry || entry.expiresAt < Date.now()) {
          store.delete(key)
          return null
        }
        return entry.value
      }),
    put: (key, value, options) =>
      Effect.sync(() => {
        const ttlMs = (options?.expirationTtl ?? 3600) * 1000
        store.set(key, { value, expiresAt: Date.now() + ttlMs })
      }),
    delete: (key) =>
      Effect.sync(() => {
        store.delete(key)
      }),
    list: (options) =>
      Effect.sync(() => ({
        keys: [...store.keys()]
          .filter((k) => !options?.prefix || k.startsWith(options.prefix))
          .map((name) => ({ name })),
        list_complete: true,
      })),
  }

  const execCtx = makeTestExecutionContext()

  return {
    layer: Layer.merge(
      Layer.succeed(CacheService, client),
      execCtx.layer
    ),
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

const ProjectSchema = S.Struct({
  id: S.String,
  name: S.String,
  userId: S.String,
})

// ============================================================================
// Tests
// ============================================================================

describe('cache', () => {
  describe('cache()', () => {
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
        const compute = Effect.fail(new Error('Database connection failed'))

        return yield* cache('user:1', compute, UserSchema, { ttl: Duration.hours(1) })
      }).pipe(Effect.provide(layer), Effect.either, Effect.runPromise)

      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left).toBeInstanceOf(Error)
        expect((result.left as Error).message).toBe('Database connection failed')
      }
    })

    it('handles schema decode errors for invalid cached data', async () => {
      const { layer, store } = makeTestCache()

      // Pre-populate cache with invalid data (missing required fields in value)
      store.set('user:1', {
        value: JSON.stringify({ v: { id: '1', invalid: 'data' }, t: Date.now() }),
        expiresAt: Date.now() + 3600000,
      })

      const result = await Effect.gen(function* () {
        const compute = Effect.sync(() => ({
          id: '1',
          name: 'Test User',
          email: 'test@example.com',
        }))

        return yield* cache('user:1', compute, UserSchema, { ttl: Duration.hours(1) })
      }).pipe(Effect.provide(layer), Effect.either, Effect.runPromise)

      expect(result._tag).toBe('Left')
    })

    it('caches complex nested objects', async () => {
      const { layer } = makeTestCache()

      const ComplexSchema = S.Struct({
        id: S.String,
        data: S.Struct({
          items: S.Array(S.Struct({ name: S.String, value: S.Number })),
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
        value: JSON.stringify({ v: { id: '1', name: 'Test', email: 'test@example.com' }, t: Date.now() }),
        expiresAt: Date.now() + 3600000,
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
        value: JSON.stringify({ v: { id: '1', name: 'Test', email: 'test@example.com' }, t: Date.now() }),
        expiresAt: Date.now() - 1000, // Expired
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
        const parsed = JSON.parse(entry!.value)
        expect(parsed.v).toEqual(user)
        expect(typeof parsed.t).toBe('number')
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
        expect(JSON.parse(entry!.value).v).toEqual(user2)
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('respects TTL', async () => {
      const { layer, store } = makeTestCache()

      await Effect.gen(function* () {
        const user = { id: '1', name: 'Test', email: 'test@example.com' }
        yield* cacheSet('user:1', user, UserSchema, { ttl: Duration.seconds(60) })

        const entry = store.get('user:1')
        const expectedExpiry = Date.now() + 60000
        // Allow 1 second tolerance
        expect(entry!.expiresAt).toBeGreaterThan(expectedExpiry - 1000)
        expect(entry!.expiresAt).toBeLessThan(expectedExpiry + 1000)
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })
  })

  describe('cacheInvalidate()', () => {
    it('removes key from cache', async () => {
      const { layer, store } = makeTestCache()

      store.set('user:1', {
        value: JSON.stringify({ id: '1', name: 'Test', email: 'test@example.com' }),
        expiresAt: Date.now() + 3600000,
      })

      await Effect.gen(function* () {
        yield* cacheInvalidate('user:1')
        expect(store.has('user:1')).toBe(false)
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('succeeds for non-existent keys', async () => {
      const { layer } = makeTestCache()

      await Effect.gen(function* () {
        // Should not throw
        yield* cacheInvalidate('nonexistent')
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })
  })

  describe('cacheInvalidatePrefix()', () => {
    it('removes all keys with matching prefix', async () => {
      const { layer, store } = makeTestCache()

      // Pre-populate cache with multiple keys
      store.set('user:1:profile', {
        value: '{}',
        expiresAt: Date.now() + 3600000,
      })
      store.set('user:1:settings', {
        value: '{}',
        expiresAt: Date.now() + 3600000,
      })
      store.set('user:1:notifications', {
        value: '{}',
        expiresAt: Date.now() + 3600000,
      })
      store.set('user:2:profile', {
        value: '{}',
        expiresAt: Date.now() + 3600000,
      })
      store.set('other:key', {
        value: '{}',
        expiresAt: Date.now() + 3600000,
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

      store.set('key1', { value: '{}', expiresAt: Date.now() + 3600000 })
      store.set('key2', { value: '{}', expiresAt: Date.now() + 3600000 })

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

      store.set('user:1:profile', { value: '{}', expiresAt: Date.now() + 3600000 })
      store.set('user:1:settings', { value: '{}', expiresAt: Date.now() + 3600000 })
      store.set('user:1:notifications', { value: '{}', expiresAt: Date.now() + 3600000 })
      store.set('user:1:projects', { value: '{}', expiresAt: Date.now() + 3600000 })
      store.set('user:2:profile', { value: '{}', expiresAt: Date.now() + 3600000 })

      const cacheClient: CacheClient = {
        get: (key) =>
          Effect.sync(() => {
            const entry = store.get(key)
            if (!entry || entry.expiresAt < Date.now()) {
              store.delete(key)
              return null
            }
            return entry.value
          }),
        put: (key, value, options) =>
          Effect.sync(() => {
            const ttlMs = (options?.expirationTtl ?? 3600) * 1000
            store.set(key, { value, expiresAt: Date.now() + ttlMs })
          }),
        delete: (key) =>
          Effect.sync(() => {
            store.delete(key)
          }),
        list: (options) =>
          Effect.sync(() => {
            listCalls.push(options?.cursor)
            if (listedSnapshot === null) {
              listedSnapshot = [...store.keys()]
                .filter((k) => !options?.prefix || k.startsWith(options.prefix))
                .sort()
            }

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
        Effect.provide(Layer.succeed(CacheService, cacheClient)),
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
    it('wraps cache client errors in CacheClientError', async () => {
      const failingClient: CacheClient = {
        get: () => Effect.fail(new CacheClientError('Connection failed', new Error('ECONNREFUSED'))),
        put: () => Effect.fail(new CacheClientError('Connection failed')),
        delete: () => Effect.fail(new CacheClientError('Connection failed')),
        list: () => Effect.fail(new CacheClientError('Connection failed')),
      }

      const failingLayer = Layer.succeed(CacheService, failingClient)

      const result = await Effect.gen(function* () {
        return yield* cacheGet('key', UserSchema)
      }).pipe(Effect.provide(failingLayer), Effect.either, Effect.runPromise)

      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left).toBeInstanceOf(CacheClientError)
        expect((result.left as CacheClientError).reason).toBe('Connection failed')
      }
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
        value: JSON.stringify({ v: { id: '1', name: 'Cached User', email: 'cached@example.com' }, t: Date.now() }),
        expiresAt: Date.now() + 3600000,
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
      const twoHoursAgo = Date.now() - Duration.toMillis(Duration.hours(2))
      store.set('user:1', {
        value: JSON.stringify({ v: { id: '1', name: 'Stale User', email: 'stale@example.com' }, t: twoHoursAgo }),
        expiresAt: Date.now() + 3600000, // KV hasn't expired yet (TTL + SWR window)
      })

      // Use async compute to simulate real DB call
      const compute = Effect.async<{ id: string; name: string; email: string }>((resume) => {
        computeStarted = true
        // Simulate async work
        setTimeout(() => {
          callCount++
          resume(Effect.succeed({ id: '1', name: 'Fresh User', email: 'fresh@example.com' }))
        }, 10)
      })

      const result = await Effect.gen(function* () {
        return yield* cache('user:1', compute, UserSchema, {
          ttl: Duration.hours(1),
          swr: Duration.hours(2), // SWR window covers the staleness
        })
      }).pipe(Effect.provide(layer), Effect.runPromise)

      // Returns stale value immediately
      expect(result.name).toBe('Stale User')

      // Background refresh was triggered (compute started)
      expect(computeStarted).toBe(true)
      expect(executionContext.backgroundTasks.length).toBe(1)

      // Wait for background refresh to complete
      await executionContext.awaitAll()

      // Now the compute function completed
      expect(callCount).toBe(1)

      // Cache should be updated with fresh value
      const cachedEntry = store.get('user:1')
      expect(cachedEntry).toBeDefined()
      const parsed = JSON.parse(cachedEntry!.value)
      expect(parsed.v.name).toBe('Fresh User')
    })

    it('recomputes when past SWR window', async () => {
      const { layer, store } = makeTestCache()
      let callCount = 0

      // Pre-populate cache with very stale entry (cached 3 hours ago)
      const threeHoursAgo = Date.now() - Duration.toMillis(Duration.hours(3))
      store.set('user:1', {
        value: JSON.stringify({ v: { id: '1', name: 'Very Stale User', email: 'stale@example.com' }, t: threeHoursAgo }),
        expiresAt: Date.now() + 3600000,
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
        const expectedExpiry = Date.now() + (3600 + 1800) * 1000
        expect(entry!.expiresAt).toBeGreaterThan(expectedExpiry - 1000)
        expect(entry!.expiresAt).toBeLessThan(expectedExpiry + 1000)
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('recomputes synchronously when ExecutionContext is unavailable', async () => {
      // Create cache layer with noop ExecutionContext
      const store = new Map<string, { value: string; expiresAt: number }>()
      const cacheClient: CacheClient = {
        get: (key) =>
          Effect.sync(() => {
            const entry = store.get(key)
            if (!entry || entry.expiresAt < Date.now()) {
              store.delete(key)
              return null
            }
            return entry.value
          }),
        put: (key, value, options) =>
          Effect.sync(() => {
            const ttlMs = (options?.expirationTtl ?? 3600) * 1000
            store.set(key, { value, expiresAt: Date.now() + ttlMs })
          }),
        delete: (key) => Effect.sync(() => { store.delete(key) }),
        list: (options) =>
          Effect.sync(() => ({
            keys: [...store.keys()]
              .filter((k) => !options?.prefix || k.startsWith(options.prefix))
              .map((name) => ({ name })),
            list_complete: true,
          })),
      }

      const { layer: noopExecCtx } = makeNoopExecutionContext()
      const layer = Layer.merge(
        Layer.succeed(CacheService, cacheClient),
        noopExecCtx
      )

      let callCount = 0

      // Pre-populate cache with stale entry
      const twoHoursAgo = Date.now() - Duration.toMillis(Duration.hours(2))
      store.set('user:1', {
        value: JSON.stringify({ v: { id: '1', name: 'Stale User', email: 'stale@example.com' }, t: twoHoursAgo }),
        expiresAt: Date.now() + 3600000,
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
      const parsed = JSON.parse(cachedEntry!.value)
      expect(parsed.v.name).toBe('Fresh User')
    })

    it('subsequent request gets fresh value after background refresh completes', async () => {
      const { layer, store, executionContext } = makeTestCache()
      let callCount = 0

      // Pre-populate cache with stale entry
      const twoHoursAgo = Date.now() - Duration.toMillis(Duration.hours(2))
      store.set('user:1', {
        value: JSON.stringify({ v: { id: '1', name: 'Stale User', email: 'stale@example.com' }, t: twoHoursAgo }),
        expiresAt: Date.now() + 3600000,
      })

      // Use async compute to simulate real DB call
      const makeCompute = () =>
        Effect.async<{ id: string; name: string; email: string }>((resume) => {
          setTimeout(() => {
            callCount++
            resume(Effect.succeed({ id: '1', name: `Fresh User ${callCount}`, email: 'fresh@example.com' }))
          }, 10)
        })

      // First request: returns stale, triggers background refresh
      const firstResult = await Effect.gen(function* () {
        return yield* cache('user:1', makeCompute(), UserSchema, {
          ttl: Duration.hours(1),
          swr: Duration.hours(2),
        })
      }).pipe(Effect.provide(layer), Effect.runPromise)

      expect(firstResult.name).toBe('Stale User')

      // Wait for background refresh
      await executionContext.awaitAll()
      expect(callCount).toBe(1)

      // Second request: should get the fresh value from cache (not compute again)
      const secondResult = await Effect.gen(function* () {
        return yield* cache('user:1', makeCompute(), UserSchema, {
          ttl: Duration.hours(1),
          swr: Duration.hours(2),
        })
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
      const { layer, store } = makeTestCache()

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
      const { layer, store } = makeTestCache()

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
      const { layer, store } = makeTestCache()

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
      const { layer, store } = makeTestCache()
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
      const { layer, store } = makeTestCache()
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
