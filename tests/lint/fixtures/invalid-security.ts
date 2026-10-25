import { betterAuth } from 'better-auth'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb, verifyOrigin, webDefaults } from '@popcomputer/web'
import { action, json, render, routeBinding, validateRequest } from '@popcomputer/web/effect'
import { betterAuthHandler } from '@popcomputer/web/auth'
import * as schema from './schema'

const UPLOAD_LIMIT = 8 * 1024 * 1024

export const web = setupWeb(new Hono(), {
  version: '1',
  render: (page) => JSON.stringify(page),
  bodyLimit: 4_000_000, // expect: explain-security-loosening
  history: { encrypt: false }, // expect: explain-security-loosening
  security: {
    verifyOrigin: { allowedOrigins: ['https://partner.example'] }, // expect: explain-security-loosening
    headers: false, // expect: explain-security-loosening
  },
  bindings: {
    listing: routeBinding(schema.projects, { public: true }), // expect: explain-security-loosening
    note: { schema: schema.tasks, public: true }, // expect: explain-security-loosening
  },
})

export const other = setupWeb(new Hono(), {
  version: '1',
  render: (page) => JSON.stringify(page),
  security: { verifyOrigin: false }, // expect: explain-security-loosening
})

export const middleware = [
  webDefaults({ verifyOrigin: { allowedOrigins: (origin) => origin.endsWith('.example') } }), // expect: explain-security-loosening
  verifyOrigin({ allowedOrigins: ['myapp://'] }), // expect: explain-security-loosening
]

export const apiHandler = betterAuthHandler({ settable: ['timeZone'] }) // expect: explain-security-loosening

export const upload = action(Effect.gen(function* () {
  const input = yield* validateRequest(S.Struct({ name: S.String }), { bodyLimit: UPLOAD_LIMIT }) // expect: explain-security-loosening
  return yield* json(input)
}))

export const plain = action(render('Projects/Index', {}, { encryptHistory: false })) // expect: explain-security-loosening

export const auth = betterAuth({
  emailAndPassword: { enabled: true }, // expect: explain-security-loosening
  emailVerification: {
    autoSignInAfterVerification: true, // expect: explain-security-loosening
  },
})

export const unverified = betterAuth({
  emailAndPassword: { enabled: true, requireEmailVerification: false }, // expect: explain-security-loosening
})

// The defaults, a smaller limit, settable: [] and an empty allow list keep each protection.
export const kept = setupWeb(new Hono(), {
  version: '1',
  render: (page) => JSON.stringify(page),
  bodyLimit: 512 * 1024,
  history: { encrypt: true },
  security: { verifyOrigin: { allowedOrigins: [] }, headers: { frames: 'same-origin' } },
  bindings: { project: routeBinding(schema.projects, { ownedBy: 'userId' }) },
})
export const strictHandler = betterAuthHandler({ settable: [] })
export const verified = betterAuth({
  emailAndPassword: { enabled: true, requireEmailVerification: true },
  emailVerification: { autoSignInAfterVerification: false },
})
export const statelessAuth = betterAuth({ secret: 'x' })
