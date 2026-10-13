import { Config, Effect, Schema as S } from 'effect'
import type { Context } from 'hono'
import { action, AuthService, DatabaseService, dbMutation, dbQuery, json, RequestService, validateRequest } from '@popcomputer/web/effect'
import { audit } from './schema'
import { endpoint } from '@popcomputer/web/endpoint'
import { effectifyBetterAuth } from '@popcomputer/web/auth'

declare const c: Context
declare const SomeLayer: never

export const readsAround = action(Effect.gen(function* () {
  const request = yield* RequestService
  const body = yield* Effect.promise(() => request.json()) // expect: no-raw-request-input
  const page = request.query() // expect: no-raw-request-input
  const db = yield* DatabaseService // expect: no-database-service-in-action
  const key = c.env // expect: no-hono-context-in-action
  void [body, page, db, key]

  Effect.runPromise(Effect.void) // expect: no-effect-runner-in-action
  yield* dbMutation((db) => db.insert(audit).values({ id: 'a1' })).pipe(Effect.catch(() => Effect.void)) // expect: no-catch-all-in-action
  yield* Effect.orDie(dbQuery((db) => db.select().from(audit))) // expect: no-catch-all-in-action
  yield* dbQuery((db) => db.select().from(audit)).pipe(Effect.orDie) // expect: no-catch-all-in-action
  yield* S.decodeUnknownEffect(S.String)(body).pipe(Effect.catch(() => Effect.succeed('')))
  yield* Effect.void.pipe(Effect.provide(SomeLayer)) // expect: no-provision-in-action
  request.raw().signal.addEventListener('abort', () => undefined)

  return new Response('ok') // expect: no-raw-response-in-action
}))

declare const executionCtx: { waitUntil(promise: Promise<unknown>): void }

export const detaches = action(Effect.gen(function* () {
  executionCtx.waitUntil(Promise.resolve()) // expect: require-background
  return yield* json({ ok: true })
}))

const ping = endpoint.post('/ping', { body: S.Struct({ name: S.String }), success: S.Struct({ ok: S.Boolean }) })

export const pinged = action(ping, () => Effect.gen(function* () {
  yield* validateRequest(S.Struct({ name: S.String })) // expect: no-validation-in-endpoint
  return yield* json({ ok: true }) // expect: no-validation-in-endpoint
}))

export const signsInAround = action(Effect.gen(function* () {
  const auth = yield* AuthService
  const request = yield* RequestService
  yield* Effect.promise(() => auth.api.signInEmail({ body: { email: 'a@example.com', password: 'x' }, headers: request.headers })) // expect: no-auth-api-in-action
  const authEffect = effectifyBetterAuth(auth)
  yield* authEffect.api.signInEmail({ body: { email: 'a@example.com', password: 'x' } }) // expect: no-auth-api-in-action
  yield* effectifyBetterAuth(auth).api.signUpEmail({ body: { email: 'a@example.com', password: 'x', name: 'A' } }) // expect: no-auth-api-in-action
  return yield* json({ ok: true })
}))

export const readsConfig = Effect.gen(function* () {
  return yield* Config.Redacted('STRIPE_KEY') // expect: prefer-checked-config
})
