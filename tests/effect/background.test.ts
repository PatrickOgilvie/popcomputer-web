/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
import { describe, expect, test } from 'bun:test'
import { Context, Deferred, Duration, Effect, Layer, Logger, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../../src/setup.js'
import { cache, kvCache, type KVNamespaceLike } from '../../src/cache.js'
import { background } from '../../src/effect/background.js'
import { purgeCache, recordCacheTag, ResponseCachePurgeError } from '../../src/effect/response-cache.js'
import { json } from '../../src/effect/responses.js'
import { HttpError } from '../../src/effect/errors.js'
import {
  EffectErrorObserverService,
  type EffectErrorEvent,
} from '../../src/effect/error-observer.js'
import { effectRoutes } from '../../src/effect/routing.js'
import { ExecutionContextService } from '../../src/effect/services.js'
import { testEnv } from '../../src/testing.js'

class ScopedBackgroundResource extends Context.Service<
  ScopedBackgroundResource,
  { readonly isReleased: () => boolean }
>()('test/ScopedBackgroundResource') {}

describe('background', () => {
  test('keeps Worker work alive and observes failures with its operation name', async () => {
    const events: EffectErrorEvent[] = []
    const waitUntilPromises: Promise<unknown>[] = []
    const releaseBackground = Deferred.makeUnsafe<void>()
    const app = new Hono()

    setupWeb(app, {
      version: '1.0.0',
      render: (page) => JSON.stringify(page),
    }).services({
      request: () =>
        Layer.succeed(EffectErrorObserverService, {
          observe: (event) => Effect.sync(() => events.push(event)),
        }),
    })

    effectRoutes(app).post(
      '/events',
      Effect.gen(function* () {
        yield* background(
          'analytics.record-signup',
          Deferred.await(releaseBackground).pipe(
            Effect.andThen(Effect.fail(HttpError.internal('analytics unavailable')))
          )
        )

        return new Response(null, { status: 202 })
      })
    )

    const response = await app.fetch(
      new Request('http://localhost/events', { method: 'POST' }),
      {},
      {
        waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
        passThroughOnException: () => {},
        props: {},
      }
    )

    expect(response.status).toBe(202)
    expect(waitUntilPromises.length).toBeGreaterThan(0)
    await Effect.runPromise(Deferred.succeed(releaseBackground, undefined))
    await Promise.allSettled(waitUntilPromises)
    expect(events).toHaveLength(1)
    expect(events[0].metadata).toEqual({ operation: 'analytics.record-signup' })
    expect(events[0].handling).toBe('unhandled')
  })

  test("keeps a promise handed to waitUntil alive, and observes its failure", async () => {
    const events: EffectErrorEvent[] = []
    const waitUntilPromises: Promise<unknown>[] = []
    const app = new Hono()

    setupWeb(app, {
      version: '1.0.0',
      render: (page) => JSON.stringify(page),
    }).services({
      request: () =>
        Layer.succeed(EffectErrorObserverService, {
          observe: (event) => Effect.sync(() => events.push(event)),
        }),
    })

    effectRoutes(app).post(
      '/events',
      Effect.gen(function* () {
        const execution = yield* ExecutionContextService
        execution.waitUntil(Promise.reject(new Error('webhook delivery failed')))

        return new Response(null, { status: 202 })
      })
    )

    const response = await app.fetch(
      new Request('http://localhost/events', { method: 'POST' }),
      {},
      {
        waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
        passThroughOnException: () => {},
        props: {},
      }
    )

    expect(response.status).toBe(202)
    expect(waitUntilPromises.length).toBeGreaterThan(0)
    await Promise.allSettled(waitUntilPromises)
    expect(events.map((event) => event.metadata)).toEqual([{ operation: 'external-background' }])
  })

  test('runs safely before completion when no Worker execution context exists', async () => {
    let completed = false
    const app = new Hono()

    setupWeb(app, {
      version: '1.0.0',
      render: (page) => JSON.stringify(page),
    })
    effectRoutes(app).post(
      '/events',
      Effect.gen(function* () {
        yield* background(
          'events.persist',
          Effect.sync(() => {
            completed = true
          })
        )

        return new Response(null, { status: 202 })
      })
    )

    const response = await app.request('/events', { method: 'POST' })
    expect(response.status).toBe(202)
    expect(completed).toBe(true)
  })

  test('keeps a standalone route runtime alive until scoped background work settles', async () => {
    let released = false
    let backgroundObservedReleasedResource: boolean | undefined
    const waitUntilPromises: Promise<unknown>[] = []
    const releaseBackground = Deferred.makeUnsafe<void>()
    const app = new Hono()

    const resourceLayer = Layer.effect(
      ScopedBackgroundResource,
      Effect.acquireRelease(
        Effect.succeed({ isReleased: () => released }),
        () => Effect.sync(() => {
          released = true
        })
      )
    )

    effectRoutes(app, { services: () => resourceLayer }).post(
      '/events',
      Effect.gen(function* () {
        yield* background(
          'events.use-scoped-resource',
          Deferred.await(releaseBackground).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const resource = yield* ScopedBackgroundResource
                backgroundObservedReleasedResource = resource.isReleased()
              })
            )
          )
        )

        return new Response(null, { status: 202 })
      })
    )

    const response = await app.fetch(
      new Request('http://localhost/events', { method: 'POST' }),
      {},
      {
        waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
        passThroughOnException: () => {},
        props: {},
      }
    )

    expect(response.status).toBe(202)
    expect(waitUntilPromises.length).toBeGreaterThan(0)
    expect(released).toBe(false)
    await Effect.runPromise(Deferred.succeed(releaseBackground, undefined))
    await Promise.allSettled(waitUntilPromises)
    expect(backgroundObservedReleasedResource).toBe(false)
    expect(released).toBe(true)
  })

  test('logs failed work through the Effect logger when no observer is installed', async () => {
    const logs: Array<{ readonly level: string; readonly message: unknown }> = []
    const recording = Logger.layer([
      Logger.make((options) => logs.push({ level: options.logLevel, message: options.message })),
    ])
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1.0.0', render: (page) => JSON.stringify(page) })

    routes.post('/events', Effect.gen(function* () {
      yield* background('record-activity', Effect.fail(new HttpError({ status: 500, message: 'activity table missing' })))

      return new Response(null, { status: 202 })
    }))

    const response = await app.request('/events', { method: 'POST' }, testEnv(recording))

    expect(response.status).toBe(202)
    expect(logs).toContainEqual({ level: 'Error', message: ['Background work failed', expect.any(HttpError)] })
  })
})

/** A Worker's execution context whose Workers Cache purge answers as `accepts` says, recording each. */
function workerContext(accepts: boolean) {
  const waiting: Promise<unknown>[] = []
  const purges: Array<{ readonly tags?: readonly string[] }> = []
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => waiting.push(promise),
    passThroughOnException: () => {},
    props: {},
    cache: {
      purge: async (input: { readonly tags?: readonly string[] }) => {
        purges.push(input)

        return accepts ? { success: true, errors: [] } : { success: false, errors: [{ code: 1, message: 'purge refused' }] }
      },
    },
  }
  const settle = async () => {
    while (waiting.length > 0) await Promise.allSettled(waiting.splice(0))
  }

  return { ctx, purges, settle }
}

function memoryKv(): KVNamespaceLike {
  const store = new Map<string, string>()

  return {
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => {
      store.set(key, value)
    },
    delete: async (key) => {
      store.delete(key)
    },
    list: async () => ({ keys: [...store.keys()].map((name) => ({ name })), list_complete: true }),
  }
}

const Listing = S.Struct({ posts: S.Array(S.String) })

/** A listing kept in the data cache, and a route that hides its post in background work it releases. */
function listingApp() {
  const events: EffectErrorEvent[] = []
  const published = new Set(['post-1'])
  const release = Deferred.makeUnsafe<void>()
  const kv = memoryKv()
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1.0.0', render: (page) => JSON.stringify(page) }).services({
    request: () => Layer.merge(kvCache(kv), Layer.succeed(EffectErrorObserverService, {
      observe: (event) => Effect.sync(() => events.push(event)),
    })),
  })

  routes
    .get('/explore', Effect.gen(function* () {
      const posts = yield* cache('explore', Effect.sync(() => [...published]), S.Array(S.String), { ttl: Duration.hours(1), tags: ['posts'] })

      return yield* json({ posts })
    }))
    .post('/posts/hide', Effect.gen(function* () {
      yield* background('posts.hide', Effect.gen(function* () {
        // The response has gone by the time the work changes the post.
        yield* Deferred.await(release)
        published.delete('post-1')
        yield* purgeCache(recordCacheTag('posts', 'post-1'), 'posts')
      }))

      return new Response(null, { status: 202 })
    }))

  const listing = async (ctx?: ReturnType<typeof workerContext>['ctx']) => {
    const res = await app.request('/explore', {}, {}, ctx)

    return S.decodeUnknownSync(Listing)(await res.json()).posts
  }

  return { app, events, listing, release: () => Effect.runPromise(Deferred.succeed(release, undefined)) }
}

describe('purgeCache in background work', () => {
  test('purges the Workers Cache and the data cache once work after the response succeeds', async () => {
    const { app, listing, release } = listingApp()
    const worker = workerContext(true)

    expect(await listing(worker.ctx)).toEqual(['post-1'])

    const res = await app.request('/posts/hide', { method: 'POST' }, {}, worker.ctx)

    expect(res.status).toBe(202)
    expect(worker.purges).toEqual([])
    await release()
    await worker.settle()

    expect(worker.purges).toEqual([{ tags: ['posts:post-1', 'posts'] }])
    expect(await listing(worker.ctx)).toEqual([])
  })

  test('purges the data cache when the work runs before the response, as in tests', async () => {
    const { app, listing, release } = listingApp()

    expect(await listing()).toEqual(['post-1'])
    await release()

    expect((await app.request('/posts/hide', { method: 'POST' })).status).toBe(202)
    expect(await listing()).toEqual([])
  })

  test("reports a refused purge as the work's failure, leaving the response alone", async () => {
    const { app, events, release } = listingApp()
    const worker = workerContext(false)

    const res = await app.request('/posts/hide', { method: 'POST' }, {}, worker.ctx)

    expect(res.status).toBe(202)
    await release()
    await worker.settle()

    expect(worker.purges).toEqual([{ tags: ['posts:post-1', 'posts'] }])
    expect(events).toHaveLength(1)
    expect(events[0].error).toBeInstanceOf(ResponseCachePurgeError)
    expect(events[0].metadata).toEqual({ operation: 'posts.hide' })
  })
})
