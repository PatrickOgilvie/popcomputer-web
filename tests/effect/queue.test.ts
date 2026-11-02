/**
 * A queue declared once, `queue(binding, Schema)`: an action or a job sends
 * through it, each message encoded by the schema as JSON, and
 * `routes.queue(declaration, handle)` consumes it decoded by the same schema,
 * so a Date or a bigint arrives as it left. A queue that refuses a message
 * answers 503 through the error boundary, and a binding the Worker lacks is a
 * configuration error.
 */

import { describe, expect, test } from 'bun:test'
import { Effect, Layer, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../../src/setup.js'
import { action, form } from '../../src/effect/action.js'
import { EffectErrorObserverService, type EffectErrorEvent } from '../../src/effect/error-observer.js'
import { QueueSendError } from '../../src/effect/errors.js'
import { queue } from '../../src/effect/queue.js'
import { json } from '../../src/effect/responses.js'
import { requiredString } from '../../src/effect/schema.js'
import { testBatch, testEnv, testQueue, type TestQueue } from '../../src/testing.js'

const Reminder = S.Struct({ orderId: S.String, dueAt: S.Date, amountCents: S.BigInt })
const reminders = queue('REMINDERS', Reminder)

const dueAt = new Date('2030-01-01T09:00:00.000Z')
const Sent = S.Struct({ sent: S.Number })

function createApp(observed: EffectErrorEvent[] = []) {
  const app = new Hono<{ Bindings: { REMINDERS?: TestQueue } }>()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) }).services({
    app: Layer.succeed(EffectErrorObserverService, EffectErrorObserverService.of({
      observe: (event) => Effect.sync(() => void observed.push(event)),
    })),
  })

  routes
    .post('/remind', action(form(S.Struct({ orderId: requiredString })), (input) => Effect.gen(function* () {
      yield* reminders.send({ orderId: input.orderId, dueAt, amountCents: 1250n }, { delaySeconds: 3600 })

      return yield* json(Sent, { sent: 1 })
    })))
    .post('/remind-all', action(Effect.gen(function* () {
      yield* reminders.sendBatch([
        { orderId: 'order-1', dueAt, amountCents: 1n },
        { orderId: 'order-2', dueAt, amountCents: 2n },
      ])

      return yield* json(Sent, { sent: 2 })
    })))

  const received: Array<typeof Reminder.Type> = []
  const consume = routes.queue(reminders, (reminder) => Effect.sync(() => void received.push(reminder)))

  return { app, routes, consume, received }
}

const posted = (path: string, body = 'orderId=order-1'): [string, RequestInit] => [
  path,
  { method: 'POST', headers: { Accept: 'application/json', Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded' }, body },
]

describe('a declared queue', () => {
  test('carries a message from the action that sends it to the handler that consumes it, as it left', async () => {
    const { app, consume, received } = createApp()
    const reminderQueue = testQueue()

    const res = await app.request(...posted('/remind'), testEnv({ REMINDERS: reminderQueue }))

    expect(await res.json()).toEqual({ sent: 1 })
    // Encoded as JSON by the schema: an ISO date and the bigint as a string.
    expect(reminderQueue.messages()).toEqual([
      { body: { orderId: 'order-1', dueAt: '2030-01-01T09:00:00.000Z', amountCents: '1250' }, delaySeconds: 3600 },
    ])

    const batch = testBatch(reminderQueue.sent())

    await consume(batch, testEnv({}))

    expect(batch.acked()).toHaveLength(1)
    expect(received).toEqual([{ orderId: 'order-1', dueAt, amountCents: 1250n }])
  })

  test('sends several messages in one request', async () => {
    const { app } = createApp()
    const reminderQueue = testQueue()

    await app.request(...posted('/remind-all', ''), testEnv({ REMINDERS: reminderQueue }))

    expect(reminderQueue.sent()).toEqual([
      { orderId: 'order-1', dueAt: '2030-01-01T09:00:00.000Z', amountCents: '1' },
      { orderId: 'order-2', dueAt: '2030-01-01T09:00:00.000Z', amountCents: '2' },
    ])
  })

  test('sends from a job, as from an action', async () => {
    const { routes } = createApp()
    const reminderQueue = testQueue()

    await routes.run(reminders.send({ orderId: 'order-9', dueAt, amountCents: 9n }), testEnv({ REMINDERS: reminderQueue }))

    expect(reminderQueue.sent()).toEqual([{ orderId: 'order-9', dueAt: '2030-01-01T09:00:00.000Z', amountCents: '9' }])
  })

  test('answers 503 when the queue refuses a message, and the error observer sees why', async () => {
    const observed: EffectErrorEvent[] = []
    const { app } = createApp(observed)
    const reminderQueue = testQueue()

    reminderQueue.fail(new Error('Queues is unavailable'))

    const res = await app.request(...posted('/remind'), testEnv({ ENVIRONMENT: 'production', REMINDERS: reminderQueue }))

    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'WEB_SVC_704_QUEUE_SEND_FAILED' })
    expect(observed.map((event) => event.error)).toEqual([expect.any(QueueSendError)])
  })

  test('is a configuration error on a Worker without its binding', async () => {
    const { app } = createApp()
    const res = await app.request(...posted('/remind'), testEnv({}))

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ code: 'WEB_CFG_305_INVALID_CONFIG', message: expect.stringContaining('REMINDERS') })
  })
})
