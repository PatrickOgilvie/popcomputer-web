/**
 * routes.scheduled and routes.queue accept only jobs whose services the
 * routes provide, as routes.run does, and none that needs a request, which a
 * job does not have. If this file compiles, the types are correct.
 */
import { Context, Effect, Layer, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { authorize, type AuthUser } from '../src/effect/services.js'
import { validateRequest } from '../src/effect/validation.js'
import { json, render } from '../src/effect/responses.js'
import { cookie } from '../src/effect/cookies.js'
import type { CoreServices, RunCheck } from '../src/effect/routing.js'
import type { ForbiddenError, UnauthorizedError } from '../src/effect/errors.js'

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

// A job has no request: no input to validate, no page to render, no response or cookie to answer with.
// run, scheduled and queue check a job with RunCheck, which refuses what only a request has.
type RefusedAsRequestOnly<R> = RunCheck<R, CoreServices> extends { readonly requestOnlyServices: string } ? true : false
type RequirementsOf<T> = T extends Effect.Effect<unknown, unknown, infer R> ? R : never

export const refusesValidation: RefusedAsRequestOnly<RequirementsOf<ReturnType<typeof validateRequest<{ readonly to: string }, { readonly to: string }>>>> = true
export const refusesRender: RefusedAsRequestOnly<RequirementsOf<ReturnType<typeof render>>> = true
export const refusesJson: RefusedAsRequestOnly<RequirementsOf<ReturnType<typeof json>>> = true
export const refusesCookies: RefusedAsRequestOnly<RequirementsOf<ReturnType<ReturnType<typeof cookie<string, string>>['set']>>> = true
// Its own work, with the routes' services, runs.
export const runsOwnWork: RefusedAsRequestOnly<RequirementsOf<ReturnType<typeof remind>>> = false
export const counted = mailing.run(Effect.as(remind({ to: 'ops@example.com' }), 1), {})

// The handlers take the platform's arguments, with bindings that may be partial in a test.
export const ran = worker.scheduled({ cron: '0 3 * * *', scheduledTime: 0 }, {})

// authorize() without a check fails only with UnauthorizedError; a check adds ForbiddenError.
export const signedInOnly: Effect.Effect<AuthUser, UnauthorizedError> = authorize()
// @ts-expect-error A check can forbid.
export const checkedOnly: Effect.Effect<AuthUser, UnauthorizedError> = authorize(() => true)
export const checked: Effect.Effect<AuthUser, UnauthorizedError | ForbiddenError> = authorize(() => true, 'Only staff can do this.')
