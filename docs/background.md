# Background, scheduled and queued work

## Work after the response

For runtime-owned work that must outlive a response, name the work and pass
the Effect. The name identifies the work in error reports:

```ts
yield* background('audit.send', sendAuditEvent(event))
```

In a Worker, background work starts at once and runs beside the rest of the
action: the response does not wait for it, and the Worker's execution context
keeps it alive after the response. Without an execution context, as in tests,
it runs where it is called, before the response returns, so a test sees its
effects but not a race between them; pass an execution context as
`app.request`'s fourth argument to test concurrent behaviour. Tags the work
names with `purgeCache` are purged once it succeeds, and a failed purge is
reported as the work's failure. Work handed to `ExecutionContextService`'s
`runInBackground` or `schedule` purges the same way; `purgeCache` called by
work that outlived what it belongs to, such as a detached fiber, is a defect
rather than a purge nothing would send.

## Scheduled and queued work

A Cron Trigger's and a Queue consumer's work runs with the application's
services, as an action does: the database, the layers given to
`web.services`, `Config` and
`background()`, and the layers a builder was given with `provide`, which
stay open until the background work the job started has settled. It runs
through no middleware, the application's included: a job has no request.
So one that validates input, renders a page, answers JSON or sets a cookie
is a type error naming `requestOnlyServices`: pass what it needs as its
input, from the route that sends it, and return a value.
`routes.scheduled(job)` and `routes.queue(queue, handle)` return the Worker's
`scheduled` and `queue` handlers, and type-check the job as a registration
does, so one that needs a service the routes do not provide is a
`missingServices` error.

A queue is declared once, with the binding its messages are sent to and the
schema they keep, and an action or a job sends through the declaration:

```ts
// src/queues.ts
import { Schema as S } from 'effect'
import { queue } from '@popcomputer/web/effect'

export const reminders = queue('REMINDERS', S.Struct({ orderId: S.String, dueAt: S.Date }))
```

`yield* reminders.send({ orderId: order.id, dueAt }, { delaySeconds: 3600 })`
encodes the message by the schema as JSON, so a `Date` arrives as it left,
and `sendBatch` sends several in one request. A queue that refuses a message
fails the send with `QueueSendError`, which answers 503, and a binding the
Worker lacks is a configuration error naming it. A send inside
`dbTransaction` goes out though the transaction may roll back: send after it
commits. `routes.queue(Schema, handle)` decodes a queue something else sends
to.

```ts
import { lt } from 'drizzle-orm'
import { DateTime } from 'effect'
import { reminders } from '../queues'
import { orders } from '../schema'

const forgetAbandonedOrders = Effect.gen(function* () {
  const cutoff = DateTime.toDateUtc(DateTime.subtract(yield* DateTime.now, { days: 30 }))

  yield* dbMutation((db) => db.delete(orders).where(lt(orders.paidAt, cutoff)))
})

export default {
  fetch: app.fetch,
  scheduled: routes.scheduled((event) => event.cron === '0 3 * * *' ? forgetAbandonedOrders : Effect.void),
  queue: routes.queue(reminders, (reminder) => Effect.log('reminder', reminder.orderId, reminder.dueAt)),
}
```

A scheduled job that fails rejects, so the platform records a failed run. The
queue handler decodes each message's body with the queue's schema and
handles the messages one at a time: one whose work succeeds is acknowledged, and one whose
body does not decode, or whose work fails, is logged and left for the queue
to retry, after which the queue drops it or moves it to its dead-letter
queue. The handler also receives the message's `id` and `attempts`, for work
that must happen once however often a message is delivered. A job whose
`purgeCache` purge fails has failed too: it rejects, and the queue retries
the message.

A test calls the handlers as the platform does, with `testEnv`'s bindings, so
its fakes, clock and database apply. `testQueue()` from
`@popcomputer/web/testing` is a queue binding that keeps what it is sent, as
JSON carries it, and `testBatch` makes a batch of it that records which
messages were acknowledged and which were left to retry:

```ts
import { testBatch, testEnv, testQueue } from '@popcomputer/web/testing'
import { reminders } from '../queues'

const worker = {
  scheduled: routes.scheduled(() => Effect.log('nightly sweep')),
  queue: routes.queue(reminders, (reminder) => Effect.log(reminder.orderId)),
}

const time = await testClock()
await worker.scheduled({ cron: '0 3 * * *', scheduledTime: Date.now() }, testEnv(time.layer, testBindings))

const sent = testQueue()
await routes.run(reminders.send({ orderId: 'order-1', dueAt: new Date() }), testEnv({ ...testBindings, REMINDERS: sent }))

const batch = testBatch([...sent.sent(), { orderId: 42 }])
await worker.queue(batch, testEnv(testBindings))
batch.acked() // the reminder for order-1
batch.retried() // [{ orderId: 42 }], which does not decode
```

`sent.messages()` keeps each message's `delaySeconds`, and `sent.fail()` makes
the sends after it refuse, as an unavailable queue does.

`routes.run(effect, env, ctx)` runs any other Effect the same way, such as a
one-off job from a script, resolving with its value.

## Other patterns

- **Work after the response**, such as a confirmation email:
  `background('order-email', mailer.send(...))`. Its failure is reported, not
  shown to the visitor, so it must not be the only record of something the
  visitor needs.
