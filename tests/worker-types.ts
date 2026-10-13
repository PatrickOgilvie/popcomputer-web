/**
 * routes.scheduled and routes.queue accept only jobs whose services the
 * routes provide, as routes.run does. If this file compiles, the types are
 * correct.
 */
import { Context, Effect, Layer, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'

class Mailer extends Context.Service<Mailer, { readonly send: (to: string) => Effect.Effect<void> }>()('Mailer') {}

const { routes } = setupWeb(new Hono<{ Bindings: { readonly REGION: string } }>(), {
  version: 'type-test',
  render: (page) => JSON.stringify(page),
})

const Reminder = S.Struct({ to: S.String })
const remind = (reminder: { readonly to: string }) => Mailer.use((mailer) => mailer.send(reminder.to))

// @ts-expect-error Nothing provides Mailer.
routes.queue(Reminder, remind)
// @ts-expect-error Nothing provides Mailer.
routes.scheduled(() => remind({ to: 'ops@example.com' }))

const mailing = routes.provide(Layer.succeed(Mailer, Mailer.of({ send: () => Effect.void })))

export const worker = {
  scheduled: mailing.scheduled(() => remind({ to: 'ops@example.com' })),
  queue: mailing.queue(Reminder, (reminder, message) => Effect.andThen(remind(reminder), Effect.log(message.id))),
}

// The handlers take the platform's arguments, with bindings that may be partial in a test.
export const ran = worker.scheduled({ cron: '0 3 * * *', scheduledTime: 0 }, {})
