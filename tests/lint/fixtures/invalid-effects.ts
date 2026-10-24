import { Effect, Schema as S } from 'effect'
import {
  action,
  authorize,
  background,
  bound,
  cookie,
  dbBatch,
  dbMutation,
  dbQuery,
  dbTransaction,
  flash,
  json,
  purgeCache,
  recordCacheTag,
  redirect,
  render,
  responseHeader,
  back,
  validateRequest,
} from '@popcomputer/web/effect'
import { betterAuthCall } from '@popcomputer/web/auth'
import { cacheSet } from '@popcomputer/web/cache'
import { sessionCookie } from './cookies'
import { audit, projects } from './schema'

const cart = cookie('cart', S.String, { path: '/' })

export const forgets = action(Effect.gen(function* () {
  dbQuery((db) => db.select().from(audit)) // expect: no-floating-effect
  dbMutation((db) => db.insert(audit).values({ id: 'a1' })) // expect: no-floating-effect
  dbTransaction(Effect.void) // expect: no-floating-effect
  dbBatch((db) => [db.delete(audit).where(undefined)]) // expect: no-floating-effect
  flash('success', 'Saved.') // expect: no-floating-effect
  purgeCache(recordCacheTag('projects', 'p1')) // expect: no-floating-effect
  background('notify', Effect.void) // expect: no-floating-effect
  validateRequest(S.Struct({ name: S.String })) // expect: no-floating-effect
  authorize() // expect: no-floating-effect
  bound('project') // expect: no-floating-effect
  responseHeader('Cache-Control', 'no-store') // expect: no-floating-effect
  cart.set('c1') // expect: no-floating-effect
  cart.clear // expect: no-floating-effect
  sessionCookie.clear // expect: no-floating-effect
  cookie('theme', S.String).set('dark') // expect: no-floating-effect
  betterAuthCall('signOut', {}) // expect: no-floating-effect
  cacheSet('projects', 1, { ttl: '1 minute' }) // expect: no-floating-effect
  Effect.log('saved') // expect: no-floating-effect
  dbMutation((db) => db.delete(projects).where(undefined)).pipe(Effect.asVoid) // expect: no-floating-effect
  void flash('error', 'Failed.') // expect: no-floating-effect
  const saved = true
  saved && flash('success', 'Saved.') // expect: no-floating-effect
  const user = yield authorize() // expect: no-floating-effect
  void user

  if (saved) render('Projects/Index', {}) // expect: no-floating-effect
  else redirect('/projects') // expect: no-floating-effect
  back('/projects') // expect: no-floating-effect

  return yield* json({ ok: true })
}))

export const answers = Effect.gen(function* () {
  json({ ok: false }) // expect: no-floating-effect
  return yield* json({ ok: true })
})
