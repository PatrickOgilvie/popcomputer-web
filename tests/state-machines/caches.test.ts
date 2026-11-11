/**
 * Machines 5, 6, 7 and 28: what the data cache, a route's purges and the
 * default page cache keep, and when they keep it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Deferred, Effect, Fiber, Layer, Option, Schema as S } from 'effect'
import { Hono } from 'hono'
import { CacheService, cache, cacheGet, cacheInvalidate, cacheSet, invalidateCacheTags, type CacheClient } from '../../src/cache.js'
import { action } from '../../src/effect/action.js'
import { CacheError } from '../../src/effect/errors.js'
import { ResponseCacheService, purgeCache, type ResponseCachePurgeInput } from '../../src/effect/response-cache.js'
import { json, render } from '../../src/effect/responses.js'
import type { WebDeclaration } from '../../src/effect/register.js'
import { BindingsService } from '../../src/effect/services.js'
import { setupWeb } from '../../src/setup.js'
import { testEnv } from '../../src/testing.js'

/** A binding is a class instance, as Cloudflare's are, so the page cache sees it read. */
class Kv {
  get(_key: string): Promise<string> {
    return Promise.resolve('ADA-ONLY')
  }
}

declare module '../../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{ bindings: { KV: Kv; ENVIRONMENT?: string } }>
  }
}

/** A store as KV keeps one, in memory; `lagging` reads miss what another location wrote. */
function memoryStore(options: { readonly failPuts?: boolean } = {}) {
  const entries = new Map<string, string>()
  const client = (lagging: (key: string) => boolean = () => false): CacheClient => CacheService.of({
    get: (key) => Effect.sync(() => (lagging(key) ? null : entries.get(key) ?? null)),
    put: (key, value) => options.failPuts === true && key.startsWith('popweb:tag:')
      ? Effect.fail(new CacheError({ reason: 'KV refused the write.' }))
      : Effect.sync(() => void entries.set(key, value)),
    delete: (key) => Effect.sync(() => void entries.delete(key)),
    list: () => Effect.succeed({ keys: [], list_complete: true }),
  })

  return { entries, client }
}

const run = <A, E>(effect: Effect.Effect<A, E, CacheService>, client: CacheClient) =>
  Effect.runPromise(Effect.provideService(effect, CacheService, client))

describe('the data cache', () => {
  test("M5.T10: a read that names fewer tags still sees a purge of the entry's others", async () => {
    const { client } = memoryStore()
    const kv = client()

    await run(cacheSet('k', Effect.succeed('old'), S.String, { ttl: '1 hour', tags: ['a', 'b'] }), kv)
    await run(invalidateCacheTags(['b']), kv)

    expect(await run(cache('k', Effect.succeed('fewer'), S.String, { ttl: '1 hour', tags: ['a'] }), kv)).toBe('fewer')
    await run(cacheSet('j', Effect.succeed('old'), S.String, { ttl: '1 hour', tags: ['b'] }), kv)
    await run(invalidateCacheTags(['b']), kv)
    expect(await run(cache('j', Effect.succeed('none'), S.String, { ttl: '1 hour' }), kv)).toBe('none')
  })

  test("a tag whose generation cannot be read leaves the entry a miss, not a hit", async () => {
    const { client } = memoryStore()
    const kv = client()

    await run(cacheSet('k', Effect.succeed('old'), S.String, { ttl: '1 hour', tags: ['a', 'b'] }), kv)

    const unreadable = CacheService.of({ ...kv, get: (key) => key === 'popweb:tag:b' ? Effect.fail(new CacheError({ reason: 'KV is down.' })) : kv.get(key) })

    expect(await run(cache('k', Effect.succeed('recomputed'), S.String, { ttl: '1 hour', tags: ['a'] }), unreadable)).toBe('recomputed')
  })

  test('M5.T53: a key invalidated while its value was being computed keeps nothing that computation read', async () => {
    const { client } = memoryStore()
    const kv = client()
    const readBeforeTheWrite = Effect.as(cacheInvalidate('k'), 'old')

    expect(await run(cache('k', readBeforeTheWrite, S.String, { ttl: '1 hour' }), kv)).toBe('old')
    expect(await run(cacheGet('k', S.String), kv)).toEqual(Option.none())
  })

  test('M5.T56: a computation that stores while its key is being invalidated keeps nothing either', async () => {
    const { client } = memoryStore()
    const kv = client()

    const program = Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const computing = yield* Effect.forkChild(cache('k', Effect.as(Deferred.await(release), 'old'), S.String, { ttl: '1 hour' }))
      yield* Effect.yieldNow
      // The computation finishes, and stores if it will, between the
      // invalidation's two writes.
      const between = CacheService.of({
        ...kv,
        delete: (key) => Effect.andThen(
          kv.delete(key),
          key === 'k' ? Effect.andThen(Deferred.succeed(release, undefined), Fiber.join(computing)) : Effect.void
        ),
      })
      yield* Effect.provideService(cacheInvalidate('k'), CacheService, between)

      return yield* cacheGet('k', S.String)
    })

    expect(await run(program, kv)).toEqual(Option.none())
  })

  test('M5.T42: a purge where KV has not yet seen the tag still ends the entries stored under it', async () => {
    const { client } = memoryStore()
    const here = client()
    const elsewhere = client((key) => key.startsWith('popweb:tag:'))

    await run(cache('k', Effect.succeed('old'), S.String, { ttl: '1 hour', tags: ['t'] }), here)
    await run(invalidateCacheTags(['t']), elsewhere)

    expect(await run(cacheGet('k', S.String), here)).toEqual(Option.none())
  })
})

describe("a route's purges", () => {
  function appWith(store: ReturnType<typeof memoryStore>) {
    const purged: ResponseCachePurgeInput[] = []
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })
      .services({ request: () => Layer.succeed(CacheService, store.client()) })
    const env = testEnv(Layer.succeed(ResponseCacheService, {
      isAvailable: true,
      purge: (input: ResponseCachePurgeInput) => Effect.sync(() => void purged.push(input)),
    }), {})

    return { app, routes, env, purged }
  }

  test("M5.T41: a job whose data cache purge fails rejects, so the queue retries it", async () => {
    const { routes, env } = appWith(memoryStore({ failPuts: true }))

    await expect(routes.run(purgeCache('t'), env)).rejects.toBeDefined()
  })

  test('M6.T20: more tags than Workers Cache takes at once go in batches, after the data cache', async () => {
    const store = memoryStore()
    const { app, routes, env, purged } = appWith(store)
    const tags = Array.from({ length: 101 }, (_, index) => `t${index}`)

    await Effect.runPromise(Effect.provideService(cache('k', Effect.succeed('old'), S.String, { ttl: '1 hour', tags: ['t100'] }), CacheService, store.client()))
    routes.post('/many', action(Effect.andThen(purgeCache(...tags), json({ ok: true }))))

    expect((await app.request('/many', { method: 'POST', headers: { Accept: 'application/json' } }, env)).status).toBe(200)
    expect(purged.map((input) => input.tags?.length)).toEqual([100, 1])
    expect(await Effect.runPromise(Effect.provideService(cacheGet('k', S.String), CacheService, store.client()))).toEqual(Option.none())
  })
})

describe('the default page cache', () => {
  let stored: Map<string, Response>
  let throwOnPut = false

  beforeEach(() => {
    stored = new Map()
    throwOnPut = false
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: {
        default: {
          match: (request: Request) => Promise.resolve(stored.get(request.url)?.clone()),
          put: (request: Request, response: Response) => {
            if (throwOnPut) throw new Error('This store throws.')

            return response.arrayBuffer().then((body) => void stored.set(request.url, new Response(body, response)))
          },
        },
      },
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'caches')
  })

  const page = { headers: { Accept: 'text/html' } }
  const worker = () => {
    const waiting: Promise<unknown>[] = []

    return {
      context: { waitUntil: (promise: Promise<unknown>) => void waiting.push(promise), passThroughOnException: () => {}, props: {} },
      settledWithin: (ms: number) => Promise.race([Promise.all(waiting).then(() => true, () => true), new Promise((resolve) => setTimeout(() => resolve(false), ms))]),
    }
  }

  const streamed = (chunks: ReadonlyArray<() => string | Promise<string>>) => new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = chunks[pulled++]

      if (next === undefined) return controller.close()

      controller.enqueue(new TextEncoder().encode(await next()))
    },
  }), { headers: { 'Content-Type': 'text/html; charset=UTF-8' } })
  let pulled = 0

  test('M7.T17, M28.T12: a binding a streamed page reads after the store was decided keeps it out', async () => {
    pulled = 0
    const app = new Hono<{ Bindings: { KV: Kv; ENVIRONMENT?: string } }>()
    const { routes } = setupWeb(app, { version: '1', render: (shown) => `<html>${JSON.stringify(shown)}</html>` })

    routes.get('/feed', action(Effect.gen(function* () {
      const { KV } = yield* BindingsService

      return streamed([() => '<html>', () => KV.get('mine'), () => '</html>'])
    })))

    const ada = await app.request('/feed', page, { KV: new Kv() })
    await ada.text()

    expect(stored.size).toBe(0)
  })

  test('M7.T16: a streamed page that fails settles what the page cache held the request open for', async () => {
    pulled = 0
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (shown) => `<html>${JSON.stringify(shown)}</html>` })
    const ctx = worker()

    routes.get('/fails', action(Effect.succeed(streamed([() => '<html>', () => Promise.reject(new Error('The feed went away.'))]))))

    const res = await app.request('/fails', page, {}, ctx.context)
    await res.text().catch(() => undefined)

    expect(await ctx.settledWithin(300)).toBe(true)
    expect(stored.size).toBe(0)
  })

  test('M7.T18: a store that throws as it is called settles too', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (shown) => `<html>${JSON.stringify(shown)}</html>` })
    const ctx = worker()

    throwOnPut = true
    routes.get('/page', action(Effect.succeed(new Response('<html>a page</html>', { headers: { 'Content-Type': 'text/html; charset=UTF-8' } }))))

    await (await app.request('/page', page, {}, ctx.context)).text()

    expect(await ctx.settledWithin(300)).toBe(true)
  })
})

describe("a route's own cache option", () => {
  const sharedBy = async (reads: 'never' | 'before' | 'after') => {
    const app = new Hono()
    const { routes } = setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
      middleware: [async (c, next) => {
        if (reads === 'before') c.req.header('X-Beta')
        await next()
        if (reads === 'after') c.req.header('X-Beta')
      }],
    })

    routes.get('/plans', action(render('Plans', {})), { cache: { maxAge: 60 } })

    const res = await app.request('/plans', { headers: { 'X-Inertia': 'true' } }, testEnv({ ENVIRONMENT: 'production' }))

    return res.headers.get('Cloudflare-CDN-Cache-Control')
  }

  test('shares a page no middleware read a header for, and keeps private one a middleware read one for first', async () => {
    expect(await sharedBy('never')).toContain('max-age=60')
    expect(await sharedBy('before')).toBeNull()
  })

  test('M28.T13: and keeps private one a middleware read a header for after the route answered', async () => {
    expect(await sharedBy('after')).toBeNull()
  })
})
