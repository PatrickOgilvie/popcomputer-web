/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * routes.run Tests
 *
 * An Effect run outside a request, as a Cron Trigger or Queue consumer runs
 * one, gets the application's services as an action does.
 */

import { describe, expect, test } from 'bun:test'
import { Clock, Config, Context, Deferred, Effect, Layer, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../../src/setup.js'
import { web } from '../../src/middleware.js'
import { webServices } from '../../src/request-context.js'
import { background } from '../../src/effect/background.js'
import { effectBridge } from '../../src/effect/bridge.js'
import { effectRoutes } from '../../src/effect/routing.js'
import { purgeCache, ResponseCachePurgeError } from '../../src/effect/response-cache.js'
import { DatabaseService } from '../../src/effect/services.js'
import type { WebDeclaration } from '../../src/effect/register.js'
import { testBatch, testClock, testEnv } from '../../src/testing.js'

class Counter extends Context.Service<Counter, { readonly next: Effect.Effect<number> }>()('test/Counter') {}

/** A request service, which counts the times it was built. */
class Reading extends Context.Service<Reading, { readonly count: number }>()('test/Reading') {}

/** A scoped service, which says whether it has been released. */
class Resource extends Context.Service<Resource, { readonly isReleased: () => boolean }>()('test/Resource') {}

/** The database these tests give a job: it names the region its bindings say. */
interface RegionDatabase {
  readonly region: string
}

declare module '../../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{
      database: RegionDatabase
    }>
  }
}

class SweepFailed extends S.TaggedError<SweepFailed>()('SweepFailed', { reason: S.String }) {}

function createApp() {
  const app = new Hono<{ Bindings: { readonly REGION: string } }>()
  let count = 0
  const counter = Layer.succeed(Counter, Counter.of({ next: Effect.sync(() => ++count) }))
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

  return { app, routes, counted: routes.provide(counter) }
}

describe('routes.run', () => {
  test('resolves with the Effect\'s value, reading the bindings it is given', async () => {
    const { routes } = createApp()

    const region = await routes.run(
      Effect.gen(function* () {
        return { region: yield* Config.String('REGION') }
      }),
      { REGION: 'weur' }
    )

    expect(region).toEqual({ region: 'weur' })
  })

  test('provides the layers its builder was given', async () => {
    const { counted } = createApp()
    const next = Effect.flatMap(Counter, (counter) => counter.next)

    expect(await counted.run(next, { REGION: 'weur' })).toBe(1)
    expect(await counted.run(next, { REGION: 'weur' })).toBe(2)
  })

  test('rejects with the Effect\'s failure', async () => {
    const { routes } = createApp()

    await expect(routes.run(Effect.fail(new SweepFailed({ reason: 'locked' })), { REGION: 'weur' })).rejects.toMatchObject({
      _tag: 'SweepFailed',
      reason: 'locked',
    })
  })

  test('runs with a test\'s layer and bindings from testEnv', async () => {
    const { routes } = createApp()
    const time = await testClock(new Date('2026-05-01T00:00:00Z'))

    const now = await routes.run(Clock.currentTimeMillis, testEnv(time.layer, { REGION: 'weur' }))

    expect(now).toBe(Date.parse('2026-05-01T00:00:00Z'))
  })

  test("gives the Effect setupWeb's database, built from the bindings it is given, and testEnv's in its place", async () => {
    const app = new Hono<{ Bindings: { readonly REGION: string } }>()
    const { routes } = setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
      database: (c) => ({ region: c.env.REGION }),
    })
    const region = Effect.map(DatabaseService, (db) => db.region)

    expect(await routes.run(region, { REGION: 'weur' })).toBe('weur')
    expect(await routes.run(region, testEnv({ REGION: 'weur' }, { database: { region: 'test' } }))).toBe('test')
  })

  test("builds web.services' request services for each run, and its app services once", async () => {
    const app = new Hono<{ Bindings: { readonly REGION: string } }>()
    const built = { app: 0, request: 0 }
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) }).services({
      app: Layer.effect(Counter, Effect.sync(() => {
        built.app += 1

        return Counter.of({ next: Effect.succeed(built.app) })
      })),
      request: () => Layer.effect(Reading, Effect.sync(() => {
        built.request += 1

        return Reading.of({ count: built.request })
      })),
    })
    const reading = Effect.all([Effect.flatMap(Counter, (counter) => counter.next), Effect.map(Reading, (r) => r.count)])

    expect(await routes.run(reading, { REGION: 'weur' })).toEqual([1, 1])
    expect(await routes.run(reading, { REGION: 'weur' })).toEqual([1, 2])
    expect(built).toEqual({ app: 1, request: 2 })
  })

  // A route keeps the scoped services it is provided until its background
  // work settles; `run` releases them when the job's Effect ends, so work it
  // handed the Worker reads a released service. Step 3 of
  // plans/request-pipeline.md fixes it, and this test then passes: drop
  // `.failing`.
  test.failing('resolves before background work the Effect hands the Worker, and keeps the services its builder provides until that work settles', async () => {
    const { routes } = createApp()
    let released = false
    let sawReleased: boolean | undefined
    const settled: Promise<unknown>[] = []
    const go = Deferred.makeUnsafe<void>()
    const resource = Layer.effect(
      Resource,
      Effect.acquireRelease(Effect.succeed(Resource.of({ isReleased: () => released })), () => Effect.sync(() => {
        released = true
      }))
    )
    const ctx = { waitUntil: (promise: Promise<unknown>) => settled.push(promise), passThroughOnException: () => {}, props: {} }

    const job = background('jobs.later', Effect.andThen(Deferred.await(go), Effect.map(Resource, (r) => {
      sawReleased = r.isReleased()
    })))

    expect(await routes.provide(resource).run(Effect.as(job, 'started'), { REGION: 'weur' }, ctx)).toBe('started')
    expect(sawReleased).toBeUndefined()
    expect(released).toBe(false)

    await Effect.runPromise(Deferred.succeed(go, undefined))
    await Promise.allSettled(settled)

    expect(sawReleased).toBe(false)
    expect(released).toBe(true)
  })

  test('without a Worker execution context, finishes background work before it resolves', async () => {
    const { routes } = createApp()
    let finished = false

    await routes.run(background('jobs.inline', Effect.sync(() => {
      finished = true
    })), { REGION: 'weur' })

    expect(finished).toBe(true)
  })

  test("runs on a stack composed by hand, with the database webServices gives and the layers effectRoutes' builder is given", async () => {
    type RegionEnv = { Bindings: { readonly REGION: string } }
    const app = new Hono<RegionEnv>()
    app.use('*', web({ version: '1', render: (page) => JSON.stringify(page) }))
    app.use('*', webServices<RegionEnv>((c) => ({ db: { region: c.env.REGION } })))
    app.use('*', effectBridge())
    const routes = effectRoutes(app).provide(Layer.succeed(Counter, Counter.of({ next: Effect.succeed(7) })))

    const read = Effect.all([Effect.map(DatabaseService, (db) => db.region), Effect.flatMap(Counter, (counter) => counter.next)])

    expect(await routes.run(read, { REGION: 'weur' })).toEqual(['weur', 7])
  })

  test('cannot be reached by a request', async () => {
    const { app } = createApp()
    const res = await app.request('/__popweb/run', {}, { REGION: 'weur' })

    expect(res.status).toBe(404)
  })
})

describe('routes.scheduled', () => {
  test('runs the job for the cron that fired, and rejects when it fails', async () => {
    const { counted } = createApp()
    const ran: string[] = []
    const scheduled = counted.scheduled((event) =>
      event.cron === '0 3 * * *'
        ? Effect.flatMap(Counter, (counter) => Effect.map(counter.next, () => ran.push(event.cron)))
        : Effect.fail(new SweepFailed({ reason: `no job for ${event.cron}` }))
    )

    await scheduled({ cron: '0 3 * * *', scheduledTime: 0 }, { REGION: 'weur' })

    expect(ran).toEqual(['0 3 * * *'])
    await expect(scheduled({ cron: '*/5 * * * *', scheduledTime: 0 }, { REGION: 'weur' })).rejects.toMatchObject({ _tag: 'SweepFailed' })
  })
})

describe('routes.queue', () => {
  const Reminder = S.Struct({ orderId: S.String })

  test('acknowledges each message whose work succeeds, with its body decoded', async () => {
    const { counted } = createApp()
    const sent: string[] = []
    const queue = counted.queue(Reminder, (reminder, message) =>
      Effect.flatMap(Counter, (counter) => Effect.map(counter.next, (n) => sent.push(`${n}:${reminder.orderId}:${message.attempts}`)))
    )
    const batch = testBatch([{ orderId: 'order-1' }, { orderId: 'order-2' }])

    await queue(batch, { REGION: 'weur' })

    expect(sent).toEqual(['1:order-1:1', '2:order-2:1'])
    expect(batch.acked()).toHaveLength(2)
  })

  test("builds web.services' request services afresh for each message", async () => {
    const app = new Hono<{ Bindings: { readonly REGION: string } }>()
    let built = 0
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) }).services({
      request: () => Layer.effect(Reading, Effect.sync(() => Reading.of({ count: ++built }))),
    })
    const seen: number[] = []
    const queue = routes.queue(Reminder, () => Effect.map(Reading, (reading) => seen.push(reading.count)))

    await queue(testBatch([{ orderId: 'order-1' }, { orderId: 'order-2' }, { orderId: 'order-3' }]), { REGION: 'weur' })

    expect(seen).toEqual([1, 2, 3])
  })

  test('leaves a message whose body does not decode or whose work fails for the queue to retry', async () => {
    const { routes } = createApp()
    const queue = routes.queue(Reminder, (reminder) =>
      reminder.orderId === 'locked' ? Effect.fail(new SweepFailed({ reason: 'locked' })) : Effect.void
    )
    const batch = testBatch([{ orderId: 'order-1' }, { orderId: 42 }, { orderId: 'locked' }])

    await queue(batch, { REGION: 'weur' })

    expect(batch.acked()).toEqual([{ orderId: 'order-1' }])
    expect(batch.retried()).toEqual([{ orderId: 42 }, { orderId: 'locked' }])
  })
})

describe('a job whose cache purge fails', () => {
  const Unpublish = S.Struct({ project: S.String })
  const unpublish = (project: string, extra = 0) =>
    Effect.as(purgeCache(`projects:${project}`, ...Array.from({ length: extra }, (_, index) => `projects:extra-${index}`)), project)

  /** A Worker's execution context whose Workers Cache purge answers with `purge`, recording the tags it was asked for. */
  const worker = (purge: () => Promise<object>) => {
    const purged: Array<readonly string[] | undefined> = []
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
      props: {},
      cache: {
        purge: (input: { readonly tags?: readonly string[] }) => {
          purged.push(input.tags)

          return purge()
        },
      },
    }

    return { ctx, purged }
  }

  const refusing = () => worker(async () => ({ success: false, errors: [{ code: 1, message: 'purge refused' }] }))
  const throwing = () => worker(async () => {
    throw new Error('purge endpoint unavailable')
  })

  for (const [name, make] of [['refused', refusing], ['thrown', throwing]] as const) {
    test(`fails its run when the purge is ${name}: run and scheduled reject, and the queue retries`, async () => {
      const { routes } = createApp()
      const { ctx, purged } = make()
      const env = { REGION: 'weur' }

      await expect(routes.run(unpublish('p2'), env, ctx)).rejects.toBeInstanceOf(ResponseCachePurgeError)
      await expect(routes.scheduled(() => unpublish('p2'))({ cron: '0 3 * * *', scheduledTime: 0 }, env, ctx)).rejects.toBeInstanceOf(ResponseCachePurgeError)

      const batch = testBatch([{ project: 'p2' }])
      await routes.queue(Unpublish, (message) => unpublish(message.project))(batch, env, ctx)

      expect(batch.acked()).toEqual([])
      expect(batch.retried()).toEqual([{ project: 'p2' }])
      expect(purged).toEqual([['projects:p2'], ['projects:p2'], ['projects:p2']])
    })
  }

  test('fails its run when it names more tags than Workers Cache purges at once', async () => {
    const { routes } = createApp()
    const env = { REGION: 'weur' }

    await expect(routes.run(unpublish('p2', 100), env)).rejects.toBeInstanceOf(ResponseCachePurgeError)
    await expect(routes.scheduled(() => unpublish('p2', 100))({ cron: '0 3 * * *', scheduledTime: 0 }, env)).rejects.toBeInstanceOf(ResponseCachePurgeError)

    const batch = testBatch([{ project: 'p2' }])
    await routes.queue(Unpublish, (message) => unpublish(message.project, 100))(batch, env)

    expect(batch.retried()).toEqual([{ project: 'p2' }])
  })

  test('rejects when its route answers anything but 204 after the job succeeds', async () => {
    const app = new Hono()
    // Stands in for a failure after the job that does not end its run itself.
    app.use('*', async (c, next) => {
      await next()
      // oxlint-disable-next-line no-param-reassign -- Hono replaces a middleware's response by assigning c.res.
      c.res = new Response(null, { status: 503 })
    })
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

    await expect(routes.run(Effect.succeed('p2'), {})).rejects.toThrow('its route answered 503')
  })

  test('resolves and acknowledges when the purge is accepted', async () => {
    const { routes } = createApp()
    const { ctx, purged } = worker(async () => ({ success: true, errors: [] }))
    const env = { REGION: 'weur' }

    expect(await routes.run(unpublish('p2'), env, ctx)).toBe('p2')
    await routes.scheduled(() => unpublish('p2'))({ cron: '0 3 * * *', scheduledTime: 0 }, env, ctx)

    const batch = testBatch([{ project: 'p2' }])
    await routes.queue(Unpublish, (message) => unpublish(message.project))(batch, env, ctx)

    expect(batch.acked()).toEqual([{ project: 'p2' }])
    expect(purged).toEqual([['projects:p2'], ['projects:p2'], ['projects:p2']])
  })
})
