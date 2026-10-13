/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Tracing Tests
 *
 * Every public operation runs in a span named `Web.<operation>`, so an
 * application's traces show where request time goes.
 */

import { describe, expect, test } from 'bun:test'
import { Duration, Effect, Layer, Schema as S, Tracer } from 'effect'
import { dbMutation, dbTransaction } from '../../src/effect/action.js'
import { background } from '../../src/effect/background.js'
import { BoundModels, bound } from '../../src/effect/binding.js'
import {
  CacheService,
  ExecutionContextService,
  authorize,
} from '../../src/effect/services.js'
import { validateUnknown } from '../../src/effect/validation.js'
import {
  cache,
  cacheGet,
  cacheInvalidate,
  cacheInvalidatePrefix,
  cacheSet,
} from '../../src/cache.js'
import { signedIn } from '../../src/testing.js'

/** Run `effect` and return the names of the spans it created, in order. */
async function spanNames<A, E>(effect: Effect.Effect<A, E>): Promise<string[]> {
  const names: string[] = []
  const tracer = Tracer.make({
    span(options) {
      names.push(options.name)

      return new Tracer.NativeSpan(options)
    },
  })

  await Effect.runPromise(effect.pipe(Effect.withTracer(tracer)))

  return names
}

const store = new Map<string, string>()

const memoryCache = Layer.succeed(CacheService, {
  get: (key) => Effect.sync(() => store.get(key) ?? null),
  put: (key, value) => Effect.sync(() => void store.set(key, value)),
  delete: (key) => Effect.sync(() => void store.delete(key)),
  list: (options) =>
    Effect.sync(() => ({
      keys: [...store.keys()]
        .filter((name) => name.startsWith(options?.prefix ?? ''))
        .map((name) => ({ name })),
      list_complete: true,
    })),
})

const inlineExecution = Layer.succeed(ExecutionContextService, {
  isAvailable: false,
  waitUntil: () => {},
  runInBackground: (effect) => Effect.ignore(effect),
  schedule: (_operation, effect) => Effect.ignore(effect),
})

const cacheLayers = Layer.mergeAll(memoryCache, inlineExecution)
const ttl = { ttl: Duration.minutes(1) }

const operations: ReadonlyArray<readonly [string, Effect.Effect<unknown, unknown>]> = [
  ['Web.authorize', authorize().pipe(Effect.provide(signedIn({ id: 'user-1' })))],
  ['Web.validateUnknown', validateUnknown(S.Struct({ name: S.String }), { name: 'Ada' })],
  ['Web.bound', bound('project').pipe(Effect.provide(BoundModels.fromModels({ project: { id: 'p1' } })))],
  ['Web.dbMutation', dbMutation({}, async () => 1)],
  [
    'Web.dbTransaction',
    dbTransaction({ transaction: async <T>(run: (tx: object) => Promise<T>) => run({}) }, async () => 1),
  ],
  ['Web.background', background('tracing-test', Effect.void).pipe(Effect.provide(inlineExecution))],
  ['Web.cache', cache('user:1', Effect.succeed(1), S.Number, ttl).pipe(Effect.provide(cacheLayers))],
  ['Web.cacheSet', cacheSet('user:2', 2, S.Number, ttl).pipe(Effect.provide(memoryCache))],
  ['Web.cacheGet', cacheGet('user:2', S.Number).pipe(Effect.provide(memoryCache))],
  ['Web.cacheInvalidate', cacheInvalidate('user:2').pipe(Effect.provide(memoryCache))],
  ['Web.cacheInvalidatePrefix', cacheInvalidatePrefix('user:').pipe(Effect.provide(memoryCache))],
]

describe('tracing', () => {
  for (const [name, effect] of operations) {
    test(`${name} runs in a span named ${name}`, async () => {
      expect(await spanNames(effect)).toContain(name)
    })
  }
})
