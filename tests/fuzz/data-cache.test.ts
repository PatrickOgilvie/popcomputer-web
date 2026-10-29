/**
 * The data cache as a sequence of steps, against the real `cache`,
 * `cacheGet`, `cacheSet` and `invalidateCacheTags` over an in-memory store
 * and Effect's test clock. Three keys depend on two records: one on `a`, one
 * on `a` and `b`, one on neither. Steps compute a key (the computation may
 * be held while other steps run, as a slow query is), read one, store one,
 * write a record and purge its tag as a route's `purges` does, and let time
 * pass. Each value records the records' versions it was computed from.
 *
 * docs/state-machines/DataCache.tla checks one value under one tag; this
 * runs the code itself, with every interleaving the steps allow:
 *
 * - once a write's purge has run, no read that starts after it returns a
 *   value from before the write (NoReadAfterPurgeReturnsTheOldValue);
 * - `cache` returns no value stored longer ago than its `ttl`, except the
 *   one its own computation produced. `ttl` counts from when the value was
 *   stored, so a value whose computation was slow holds data older than
 *   `ttl` by the computation's time, as a TTL counted from the write does.
 */
import { describe } from 'bun:test'
import { Arbitrary, Clock, Deferred, Effect, Fiber, Layer, Option, Schema as S } from 'effect'
import { TestClock } from 'effect/testing'
import { CacheService, cache, cacheGet, cacheSet, invalidateCacheTags, type CacheClient } from '../../src/cache.js'
import { oneOf, pick, property, show } from './property'

type Version = { a: number; b: number }

const KEYS = { one: ['a'], both: ['a', 'b'], none: [] } as const satisfies Readonly<Record<string, ReadonlyArray<keyof Version>>>

type Key = keyof typeof KEYS

const TTL_MS = 1000

const Value = S.Struct({ a: S.Number, b: S.Number, at: S.Number, by: S.Number })

type Value = typeof Value.Type

const optionsFor = (key: Key) => ({ ttl: `${TTL_MS} millis` as const, tags: KEYS[key].map((record: keyof Version) => `records:${record}`) })

type Step =
  | { readonly _tag: 'Cache'; readonly key: Key; readonly hold: boolean }
  | { readonly _tag: 'Release' }
  | { readonly _tag: 'Get'; readonly key: Key }
  | { readonly _tag: 'Set'; readonly key: Key }
  | { readonly _tag: 'Write'; readonly record: keyof Version }
  | { readonly _tag: 'Tick'; readonly ms: number }

const keys = pick(['one', 'both', 'none'])

const step = oneOf<Step>(
  Arbitrary.map(Arbitrary.all([keys, pick([false, true])]), ([key, hold]) => ({ _tag: 'Cache', key, hold })),
  Arbitrary.Constant({ _tag: 'Release' }),
  Arbitrary.map(keys, (key) => ({ _tag: 'Get', key })),
  Arbitrary.map(keys, (key) => ({ _tag: 'Set', key })),
  Arbitrary.map(pick(['a', 'b']), (record) => ({ _tag: 'Write', record })),
  Arbitrary.map(pick([400, 700, 1100]), (ms) => ({ _tag: 'Tick', ms }))
)

/** A store in memory that forgets an entry once its expiry passes on the effect's clock, as KV does. */
function memoryStore(): CacheClient {
  const store = new Map<string, { value: string; expiresAt: number }>()

  return {
    get: (key) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        const entry = store.get(key)

        return entry === undefined || entry.expiresAt <= now ? null : entry.value
      }),
    put: (key, value, options) =>
      Effect.map(Clock.currentTimeMillis, (now) => void store.set(key, { value, expiresAt: now + (options?.expirationTtl ?? 3600) * 1000 })),
    delete: (key) => Effect.sync(() => void store.delete(key)),
    list: (options) =>
      Effect.sync(() => ({
        keys: [...store.keys()].filter((name) => name.startsWith(options?.prefix ?? '')).map((name) => ({ name })),
        list_complete: true,
      })),
  }
}

interface Held {
  readonly key: Key
  readonly call: number
  readonly purgedBefore: Version
  readonly gate: Deferred.Deferred<void>
  readonly fiber: Fiber.Fiber<Value>
}

/** Runs the steps, and returns every way a read broke a rule. */
const runSteps = (steps: readonly Step[]) =>
  Effect.gen(function* () {
    const db: Version = { a: 1, b: 1 }
    // Each record's version as of its latest purge that has run.
    const purged: Version = { a: 0, b: 0 }
    const held: Held[] = []
    const broken: string[] = []
    // When each computation's value was stored, by the call that computed it.
    const storedAt = new Map<number, number>()
    let calls = 0

    const checkRead = (what: string, key: Key, value: Value, purgedBefore: Version, now: number, own: number | undefined) => {
      for (const record of KEYS[key]) {
        if (value[record] < purgedBefore[record]) {
          broken.push(`${what} ${key} returned ${record}'s version ${value[record]} after version ${purgedBefore[record]}'s purge`)
        }
      }

      const stored = storedAt.get(value.by) ?? value.at

      if (what === 'cache' && value.by !== own && now - stored >= TTL_MS) {
        broken.push(`cache ${key} returned a value stored ${now - stored} ms before`)
      }
    }

    const compute = (call: number, started?: Deferred.Deferred<void>, gate?: Deferred.Deferred<void>) =>
      Effect.gen(function* () {
        const value: Value = { a: db.a, b: db.b, at: yield* Clock.currentTimeMillis, by: call }

        if (started !== undefined) yield* Deferred.succeed(started, undefined)
        if (gate !== undefined) yield* Deferred.await(gate)

        return value
      })

    const release = (entry: Held) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(entry.gate, undefined)
        const value = yield* Fiber.join(entry.fiber)
        const now = yield* Clock.currentTimeMillis

        storedAt.set(entry.call, now)
        checkRead('cache', entry.key, value, entry.purgedBefore, now, entry.call)
      })

    for (const current of steps) {
      const now = yield* Clock.currentTimeMillis

      switch (current._tag) {
        case 'Cache': {
          const call = ++calls
          const purgedBefore = { ...purged }

          if (!current.hold) {
            const value = yield* cache(current.key, compute(call), Value, optionsFor(current.key))

            storedAt.set(call, now)
            checkRead('cache', current.key, value, purgedBefore, now, call)
            break
          }

          const started = yield* Deferred.make<void>()
          const gate = yield* Deferred.make<void>()
          const fiber = yield* Effect.forkChild(cache(current.key, compute(call, started, gate), Value, optionsFor(current.key)))

          // The computation has read the records, or the call answered from the store without one.
          yield* Effect.raceFirst(Deferred.await(started), Effect.asVoid(Fiber.await(fiber)))

          if (yield* Deferred.isDone(started)) {
            held.push({ key: current.key, call, purgedBefore, gate, fiber })
          } else {
            checkRead('cache', current.key, yield* Fiber.join(fiber), purgedBefore, now, call)
          }
          break
        }
        case 'Release': {
          const oldest = held.shift()

          if (oldest !== undefined) yield* release(oldest)
          break
        }
        case 'Get': {
          const purgedBefore = { ...purged }
          const found = yield* cacheGet(current.key, Value)

          if (Option.isSome(found)) checkRead('cacheGet', current.key, found.value, purgedBefore, now, undefined)
          break
        }
        case 'Set':
          yield* cacheSet(current.key, { a: db.a, b: db.b, at: now, by: 0 }, Value, optionsFor(current.key))
          break
        case 'Write':
          db[current.record] += 1
          yield* invalidateCacheTags([`records:${current.record}`])
          purged[current.record] = db[current.record]
          break
        case 'Tick':
          yield* TestClock.adjust(`${current.ms} millis`)
          break
      }
    }

    for (const entry of held) yield* release(entry)

    return broken
  }).pipe(Effect.provide(Layer.merge(Layer.succeed(CacheService, memoryStore()), TestClock.layer())))

describe('the data cache', () => {
  property(
    'never returns a value from before a purge that ran, or one older than its ttl',
    Arbitrary.array(step, { maxLength: 16 }),
    async (steps) => {
      const broken = await Effect.runPromise(runSteps(steps))

      return broken.length === 0 ? undefined : `${broken.join('; ')} after ${show(steps)}`
    }
  )
})
