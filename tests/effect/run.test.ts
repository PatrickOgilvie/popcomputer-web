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
