/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Sign-in limits: a Rate Limiting binding counts each client address and
 * account, and Better Auth's rateLimit table counts an account's failures,
 * cooling it down before its password is checked.
 */

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../../src/setup.js'
import { action } from '../../src/effect/action.js'
import { betterAuthHandler, betterAuthRedirect } from '../../src/auth.js'
import { validateRequest } from '../../src/effect/validation.js'
import { currentPassword, email } from '../../src/effect/schema.js'
import { sweepSignInFailures } from '../../src/effect/sign-in-limits.js'
import { testBrowser, testClock, testEnv, testRateLimiter, type TestRateLimiter } from '../../src/testing.js'
import type { WebDeclaration } from '../../src/effect/register.js'

const rateLimit = sqliteTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: integer('last_request').notNull(),
})

function createAuth() {
  return betterAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    baseURL: 'http://localhost',
    secret: 'sign-in-limits-test-secret-with-enough-entropy-0123',
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    logger: { disabled: true },
  })
}

declare module '../../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{ auth: ReturnType<typeof createAuth> }>
  }
}

const SignIn = S.Struct({ email, password: currentPassword })

const signIn = action(Effect.gen(function* () {
  const input = yield* validateRequest(SignIn)

  return yield* betterAuthRedirect('signInEmail', { body: input }, {
    redirectTo: '/home',
    errors: (error) => ({ email: error.message }),
  })
}))

async function createApp(limiter: TestRateLimiter, max = 3) {
  const auth = createAuth()
  await auth.api.signUpEmail({ body: { name: 'Ada', email: 'ada@example.com', password: 'correct horse' } })

  const sqlite = new Database(':memory:')
  sqlite.run('CREATE TABLE rate_limit (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, count INTEGER NOT NULL, last_request INTEGER NOT NULL)')
  const db = drizzle(sqlite, { schema: { rateLimit } })

  const app = new Hono()
  const { routes } = setupWeb(app, {
    version: '1',
    render: (page) => JSON.stringify(page),
    database: () => db,
    auth: {
      client: () => auth,
      signInLimits: { limiter: 'SIGN_IN_LIMITER', table: rateLimit, failures: { max, window: '15 minutes', cooldown: '1 minute' } },
    },
  })

  routes.post('/sign-in', signIn).all('/api/auth/*', betterAuthHandler())

  const time = await testClock(new Date())
  const env = testEnv(time.layer, { SIGN_IN_LIMITER: limiter })
  const rows = () => db.select().from(rateLimit).all()

  return { app, env, time, rows, routes }
}

const attempt = (browser: ReturnType<typeof testBrowser>, password: string) =>
  browser.request('/sign-in', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ada@example.com', password }),
  })

describe('sign-in limits', () => {
  test('the binding limits each client address', async () => {
    const limiter = testRateLimiter({ limit: 2 })
    const { app, env } = await createApp(limiter, 100)
    const browser = testBrowser(app, env)
    const statuses = [await attempt(browser, 'guess-1'), await attempt(browser, 'guess-2'), await attempt(browser, 'guess-3')].map((res) => res.status)

    expect(statuses).toEqual([422, 422, 429])
    expect(limiter.refused[0]).toStartWith('address:')
  })

  test("an account's failures from many addresses cool it down, before its password is checked", async () => {
    const { app, env, time, rows } = await createApp(testRateLimiter({ limit: 100 }))

    // Each guess from another client address, as a botnet sends them.
    for (const guess of ['guess-1', 'guess-2', 'guess-3']) {
      expect((await attempt(testBrowser(app, env), guess)).status).toBe(422)
    }

    const cooling = await attempt(testBrowser(app, env), 'correct horse')

    expect(cooling.status).toBe(429)
    expect(Number(cooling.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.key).toStartWith('sign-in:')
    expect(rows()[0]?.key).not.toContain('ada')

    await time.advance('61 seconds')
    const signedIn = await attempt(testBrowser(app, env), 'correct horse')

    expect(signedIn.status).toBe(303)
    expect(rows()).toEqual([])
  })

  test('each further failure doubles the cooldown, up to the window', async () => {
    const { app, env, time } = await createApp(testRateLimiter({ limit: 100 }))

    for (const guess of ['guess-1', 'guess-2', 'guess-3']) await attempt(testBrowser(app, env), guess)
    await time.advance('61 seconds')
    expect((await attempt(testBrowser(app, env), 'guess-4')).status).toBe(422)

    const cooling = await attempt(testBrowser(app, env), 'correct horse')

    expect(cooling.status).toBe(429)
    expect(Number(cooling.headers.get('Retry-After'))).toBeGreaterThan(60)
  })

  test('the count starts again once its window has passed', async () => {
    const { app, env, time } = await createApp(testRateLimiter({ limit: 100 }))

    for (const guess of ['guess-1', 'guess-2']) await attempt(testBrowser(app, env), guess)
    await time.advance('16 minutes')
    for (const guess of ['guess-3', 'guess-4']) await attempt(testBrowser(app, env), guess)

    expect((await attempt(testBrowser(app, env), 'correct horse')).status).toBe(303)
  })

  test("Better Auth's own sign-in route counts the same", async () => {
    const { app, env } = await createApp(testRateLimiter({ limit: 100 }))
    const viaApi = (password: string) => testBrowser(app, env).request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ADA@example.com', password }),
    })

    for (const guess of ['guess-1', 'guess-2', 'guess-3']) expect((await viaApi(guess)).status).toBe(401)

    expect((await viaApi('correct horse')).status).toBe(429)
  })

  test("Better Auth's sign-in route counts however the request spells its path or its body's type", async () => {
    const { app, env } = await createApp(testRateLimiter({ limit: 100 }))
    const viaApi = (path: string, type: string, password: string) => testBrowser(app, env).request(`/api/auth${path}`, {
      method: 'POST',
      headers: { 'Content-Type': type },
      body: JSON.stringify({ email: 'ada@example.com', password }),
    })

    expect((await viaApi('/sign-in/email', 'Application/JSON', 'guess-1')).status).toBe(401)
    expect((await viaApi('/sign-in/email', 'application/json; charset=utf-8', 'guess-2')).status).toBe(401)
    // Not a sign-in: Better Auth finds no endpoint there.
    expect((await viaApi('//sign-in/email', 'application/json', 'guess-3')).status).toBe(404)
    // A body the framework cannot read is refused, so it is never an uncounted guess.
    expect((await viaApi('/sign-in/email', 'text/plain', 'guess-4')).status).toBe(415)
    expect((await viaApi('/sign-in/email', 'APPLICATION/JSON', 'guess-5')).status).toBe(401)

    expect((await viaApi('/sign-in/email', 'application/json', 'correct horse')).status).toBe(429)
  })

  test('a sign-in through an identity provider is not counted against the address', async () => {
    const limiter = testRateLimiter({ limit: 1 })
    const { app, env } = await createApp(limiter)
    const office = testBrowser(app, env)
    const start = () => office.request('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'github', callbackURL: '/home' }),
    })

    const statuses = [(await start()).status, (await start()).status, (await start()).status]

    expect(statuses).not.toContain(429)
    expect(limiter.refused).toEqual([])
  })

  test('a sweep from a Cron Trigger deletes the counts whose window has passed', async () => {
    const { app, env, time, rows, routes } = await createApp(testRateLimiter({ limit: 100 }))
    const scheduled = routes.scheduled(() => sweepSignInFailures)
    await attempt(testBrowser(app, env), 'guess-1')

    await scheduled({ cron: '0 * * * *', scheduledTime: 0 }, env)
    expect(rows()).toHaveLength(1)

    await time.advance('16 minutes')
    await scheduled({ cron: '0 * * * *', scheduledTime: 0 }, env)
    expect(rows()).toEqual([])
  })

  test('a missing binding names itself', async () => {
    const { app } = await createApp(testRateLimiter())
    const res = await attempt(testBrowser(app, testEnv({ ENVIRONMENT: 'development' })), 'guess')

    expect(res.status).toBe(500)
    expect(await res.text()).toContain('SIGN_IN_LIMITER')
  })
})
