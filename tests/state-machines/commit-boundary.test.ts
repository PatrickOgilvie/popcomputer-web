/**
 * Machines 26 and 29: work a rollback must cancel waits for the commit, and a
 * write that committed is purged whatever the request then answers.
 */
import { describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { Effect, Layer, Option, Schema as S } from 'effect'
import { Hono } from 'hono'
import { CacheService, cache, cacheGet, invalidateCacheTags } from '../../src/cache.js'
import { action } from '../../src/effect/action.js'
import { background } from '../../src/effect/background.js'
import { dbMutation, dbQuery, dbTransaction } from '../../src/effect/database.js'
import type { WebDeclaration } from '../../src/effect/register.js'
import { ResponseCacheService, purgeCache, type ResponseCachePurgeInput } from '../../src/effect/response-cache.js'
import { DatabaseService } from '../../src/effect/services.js'
import { forbidden, json } from '../../src/effect/responses.js'
import { requiredString } from '../../src/effect/schema.js'
import { validateRequest } from '../../src/effect/validation.js'
import { setupWeb } from '../../src/setup.js'
import { testEnv } from '../../src/testing.js'

const items = pgTable('items', { id: text('id').primaryKey() })
const schema = { items }

type TestDatabase = ReturnType<typeof drizzle<typeof schema>>

declare module '../../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{ database: TestDatabase }>
  }
}

const api = { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}' }

async function harness() {
  const client = new PGlite()

  await client.exec('create table items (id text primary key)')

  const db = drizzle(client, { schema })
  const purged: string[][] = []
  const store = new Map<string, string>()
  const app = new Hono()
  // The data cache, as an application gives it, in memory.
  const dataCache = Layer.succeed(CacheService, CacheService.of({
    get: (key) => Effect.sync(() => store.get(key) ?? null),
    put: (key, value) => Effect.sync(() => void store.set(key, value)),
    delete: (key) => Effect.sync(() => void store.delete(key)),
    list: () => Effect.succeed({ keys: [], list_complete: true }),
  }))
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page), database: () => db })
    .services({ request: () => dataCache })
  // Workers Cache, recording what each request purges.
  const env = testEnv(Layer.succeed(ResponseCacheService, {
    isAvailable: true,
    purge: (input: ResponseCachePurgeInput) => Effect.sync(() => void purged.push([...(input.tags ?? [])])),
  }), {})
  const ids = async () => (await client.query<{ id: string }>('select id from items order by id')).rows.map((row) => row.id)
  const insert = (id: string) => dbMutation((tx) => tx.insert(items).values({ id }))

  /** A Worker's execution context, which runs work after the response, as Cloudflare does. */
  const worker = () => {
    const waiting: Promise<unknown>[] = []

    return {
      context: { waitUntil: (promise: Promise<unknown>) => void waiting.push(promise), passThroughOnException: () => {}, props: {} },
      settled: async () => {
        while (waiting.length > 0) await Promise.allSettled(waiting.splice(0))
      },
    }
  }

  /** Which database an Effect was handed: the application's, or a transaction, which alone can roll back. */
  const which = Effect.map(DatabaseService, (service) => (Reflect.get(service, 'rollback') instanceof Function ? 'a transaction' : 'the database'))

  return { app, routes, env, purged, store, ids, insert, worker, which }
}

describe('a write that committed', () => {
  test('M26.T5: is purged though the action then fails', async () => {
    const { app, routes, env, purged, ids, insert } = await harness()

    routes.post('/save', action(Effect.gen(function* () {
      yield* insert('saved')
      yield* purgeCache('items')
      yield* validateRequest(S.Struct({ name: requiredString }))

      return yield* json({ ok: true })
    })))

    expect((await app.request('/save', api, env)).status).toBe(422)
    expect(await ids()).toEqual(['saved'])
    expect(purged).toEqual([['items']])
  })

  test('M26.T6: and though it answers a failure itself', async () => {
    const { app, routes, env, purged, insert } = await harness()

    routes.post('/save', action(Effect.gen(function* () {
      yield* insert('saved')
      yield* purgeCache('items')

      return yield* json({ conflict: true }, { status: 409 })
    })))

    expect((await app.request('/save', api, env)).status).toBe(409)
    expect(purged).toEqual([['items']])
  })

  test("M26.T7: takes the route's declared purges with it", async () => {
    const { app, routes, env, purged, insert } = await harness()

    routes.post('/save', action(Effect.gen(function* () {
      yield* insert('saved')

      return yield* forbidden('Signed out halfway.')
    })), { purges: ['items'] })

    expect((await app.request('/save', api, env)).status).toBe(403)
    expect(purged).toEqual([['items']])
  })

  test('a failure before any write purges nothing', async () => {
    const { app, routes, env, purged } = await harness()

    routes.post('/save', action(Effect.gen(function* () {
      yield* purgeCache('items')
      yield* validateRequest(S.Struct({ name: requiredString }))

      return yield* json({ ok: true })
    })), { purges: ['declared'] })

    expect((await app.request('/save', api, env)).status).toBe(422)
    expect(purged).toEqual([])
  })

  test('a 400 is a failure: with no write behind it, it purges nothing', async () => {
    const { app, routes, env, purged } = await harness()

    routes.post('/save', action(Effect.gen(function* () {
      yield* purgeCache('items')

      return yield* json({ invalid: true }, { status: 400 })
    })))

    expect((await app.request('/save', api, env)).status).toBe(400)
    expect(purged).toEqual([])
  })

  test('a rolled-back transaction purges nothing it asked for', async () => {
    const { app, routes, env, purged, ids, insert } = await harness()

    routes.post('/save', action(Effect.gen(function* () {
      yield* dbTransaction(Effect.gen(function* () {
        yield* insert('undone')
        yield* purgeCache('items')

        return yield* forbidden('Changed my mind.')
      })).pipe(Effect.catchTag('ForbiddenError', () => Effect.void))

      return yield* json({ ok: true })
    })))

    expect((await app.request('/save', api, env)).status).toBe(200)
    expect(await ids()).toEqual([])
    expect(purged).toEqual([])
  })
})

describe('work inside a transaction waits for its commit', () => {
  test('M29.T23, T32: background work runs after the commit, on the database, not the closed transaction', async () => {
    const { app, routes, env, ids, insert, worker, which } = await harness()
    const ctx = worker()
    const ranOn: string[] = []

    routes.post('/save', action(Effect.gen(function* () {
      yield* dbTransaction(Effect.gen(function* () {
        yield* insert('now')
        yield* background('later', Effect.andThen(Effect.tap(which, (seen) => Effect.sync(() => void ranOn.push(seen))), insert('after-commit')))
      }))

      return yield* json({ ok: true })
    })))

    expect((await app.request('/save', api, env, ctx.context)).status).toBe(200)
    await ctx.settled()

    expect(ranOn).toEqual(['the database'])
    expect(await ids()).toEqual(['after-commit', 'now'])
  })

  test('and work a rolled-back transaction started never runs', async () => {
    const { app, routes, env, ids, insert, worker } = await harness()
    const ctx = worker()

    routes.post('/save', action(Effect.gen(function* () {
      yield* dbTransaction(Effect.gen(function* () {
        yield* background('later', insert('never'))

        return yield* forbidden('No.')
      })).pipe(Effect.catchTag('ForbiddenError', () => Effect.void))

      return yield* json({ ok: true })
    })))

    await app.request('/save', api, env, ctx.context)
    await ctx.settled()

    expect(await ids()).toEqual([])
  })

  test('M29.T25: a stale entry refreshes after the commit, from what committed', async () => {
    const { app, routes, env, store, insert, worker, which } = await harness()
    const ctx = worker()
    const refreshedOn: string[] = []

    store.set('count', JSON.stringify({ v: 'stale', t: Date.now() - 90_000 }))
    routes.post('/save', action(Effect.gen(function* () {
      const seen = yield* dbTransaction(Effect.gen(function* () {
        yield* insert('one')

        const count = Effect.tap(which, (seen) => Effect.sync(() => void refreshedOn.push(seen))).pipe(
          Effect.andThen(dbQuery((db) => db.select().from(items))),
          Effect.map((rows) => String(rows.length)),
          Effect.orDie
        )

        return yield* cache('count', count, S.String, { ttl: '1 minute', swr: '1 hour' })
      }))

      return yield* json({ seen })
    })))

    expect(await (await app.request('/save', api, env, ctx.context)).json()).toEqual({ seen: 'stale' })
    await ctx.settled()

    expect(refreshedOn).toEqual(['the database'])
    expect(JSON.parse(store.get('count') ?? '{}').v).toBe('1')
  })

  test('M29.T26: a value computed in a transaction that rolls back is never cached', async () => {
    const { app, routes, env, store, insert } = await harness()

    routes.post('/save', action(Effect.gen(function* () {
      yield* dbTransaction(Effect.gen(function* () {
        yield* insert('never')
        yield* cache('count', dbQuery((db) => db.select().from(items)).pipe(Effect.map((rows) => String(rows.length)), Effect.orDie), S.String, { ttl: '1 hour' })

        return yield* forbidden('No.')
      })).pipe(Effect.catchTag('ForbiddenError', () => Effect.void))

      const cached = yield* cacheGet('count', S.String).pipe(Effect.orDie)

      return yield* json({ cached: Option.getOrNull(cached) })
    })))

    expect(await (await app.request('/save', api, env)).json()).toEqual({ cached: null })
    expect(store.has('count')).toBe(false)
  })

  test("M29.T27: a tag's purge waits for the commit, so nothing read before it is stored as new", async () => {
    const { app, routes, env, store, insert } = await harness()
    const generations: Array<string | undefined> = []

    routes.post('/save', action(Effect.gen(function* () {
      yield* cache('list', Effect.succeed('before'), S.String, { ttl: '1 hour', tags: ['items'] })
      generations.push(store.get('popweb:tag:items'))

      yield* dbTransaction(Effect.gen(function* () {
        yield* insert('new')
        yield* invalidateCacheTags(['items'])
        generations.push(store.get('popweb:tag:items'))
      }))
      generations.push(store.get('popweb:tag:items'))

      return yield* json({ ok: true })
    })))

    expect((await app.request('/save', api, env)).status).toBe(200)
    expect(generations[1]).toBe(generations[0])
    expect(generations[2]).not.toBe(generations[1])
  })
})
