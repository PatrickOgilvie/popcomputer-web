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
`background()`, and the layers a builder was given with `provide`.
`routes.scheduled(job)` and `routes.queue(Schema, handle)` return the Worker's
`scheduled` and `queue` handlers, and type-check the job as a registration
does, so one that needs a service the routes do not provide is a
`missingServices` error.

```ts
import { lt } from 'drizzle-orm'
import { DateTime } from 'effect'
import { orders } from '../schema'

const forgetAbandonedOrders = Effect.gen(function* () {
  const cutoff = DateTime.toDateUtc(DateTime.subtract(yield* DateTime.now, { days: 30 }))

  yield* dbMutation((db) => db.delete(orders).where(lt(orders.paidAt, cutoff)))
})

// What the queue carries is declared once, as a schema.
const Reminder = S.Struct({ orderId: S.String })

export default {
  fetch: app.fetch,
  scheduled: routes.scheduled((event) => event.cron === '0 3 * * *' ? forgetAbandonedOrders : Effect.void),
  queue: routes.queue(Reminder, (reminder) => Effect.log('reminder', reminder.orderId)),
}
```

A scheduled job that fails rejects, so the platform records a failed run. The
queue handler decodes each message's body with the schema and handles the
messages one at a time: one whose work succeeds is acknowledged, and one whose
body does not decode, or whose work fails, is logged and left for the queue
to retry, after which the queue drops it or moves it to its dead-letter
queue. The handler also receives the message's `id` and `attempts`, for work
that must happen once however often a message is delivered. A job whose
`purgeCache` purge fails has failed too: it rejects, and the queue retries
the message.

A test calls the handlers as the platform does, with `testEnv`'s bindings, so
its fakes, clock and database apply. `testBatch` from
`@popcomputer/web/testing` makes a batch that records which messages were
acknowledged and which were left to retry:

```ts
import { testBatch, testEnv } from '@popcomputer/web/testing'

const worker = {
  scheduled: routes.scheduled(() => Effect.log('nightly sweep')),
  queue: routes.queue(S.Struct({ orderId: S.String }), (reminder) => Effect.log(reminder.orderId)),
}

const time = await testClock()
await worker.scheduled({ cron: '0 3 * * *', scheduledTime: Date.now() }, testEnv(time.layer, testBindings))

const batch = testBatch([{ orderId: 'order-1' }, { orderId: 42 }])
await worker.queue(batch, testEnv(testBindings))
batch.acked() // [{ orderId: 'order-1' }]
batch.retried() // [{ orderId: 42 }], which does not decode
```

`routes.run(effect, env, ctx)` runs any other Effect the same way, such as a
one-off job from a script, resolving with its value.

## Other patterns

- **Work after the response**, such as a confirmation email:
  `background('order-email', mailer.send(...))`. Its failure is reported, not
  shown to the visitor, so it must not be the only record of something the
  visitor needs.
