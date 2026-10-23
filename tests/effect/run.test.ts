/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * routes.run Tests
 *
 * An Effect run outside a request, as a Cron Trigger or Queue consumer runs
 * one, gets the application's services as an action does.
 */

import { describe, expect, test } from 'bun:test'
import { Clock, Config, Context, Effect, Layer, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../../src/setup.js'
import { purgeCache, ResponseCachePurgeError } from '../../src/effect/response-cache.js'
import { testBatch, testClock, testEnv } from '../../src/testing.js'

class Counter extends Context.Service<Counter, { readonly next: Effect.Effect<number> }>()('test/Counter') {}

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
