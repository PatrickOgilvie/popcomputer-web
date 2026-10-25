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
import { phoneNumber, username } from 'better-auth/plugins'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../../src/setup.js'
import { action } from '../../src/effect/action.js'
import { betterAuthCall, betterAuthHandler, betterAuthRedirect } from '../../src/auth.js'
import { json } from '../../src/effect/responses.js'
import { validateRequest } from '../../src/effect/validation.js'
import { currentPassword, email, requiredString } from '../../src/effect/schema.js'
import { accountOf, sweepSignInFailures } from '../../src/effect/sign-in-limits.js'
import { testBrowser, testClock, testEnv, testRateLimiter, type TestRateLimiter } from '../../src/testing.js'
import type { WebDeclaration } from '../../src/effect/register.js'

const rateLimit = sqliteTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: integer('last_request').notNull(),
})

/** How the application configures what the limits read of Better Auth. */
interface AuthOptions {
  /** The username plugin's options, such as its usernameNormalization. */
  readonly username?: Parameters<typeof username>[0]
  /** Better Auth's own limits, off unless a test turns them on. */
  readonly rateLimit?: { readonly enabled?: boolean; readonly storage?: 'memory' | 'database'; readonly modelName?: string }
}

function createAuth(options: AuthOptions = {}) {
  return betterAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], rateLimit: [] }),
    baseURL: 'http://localhost',
    secret: 'sign-in-limits-test-secret-with-enough-entropy-0123',
    emailAndPassword: { enabled: true },
    user: { deleteUser: { enabled: true } },
    rateLimit: options.rateLimit ?? { enabled: false },
    logger: { disabled: true },
    // Two more doors to the same password: a username, and a phone number.
    plugins: [username(options.username), phoneNumber({ sendOTP: async () => {} })],
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

const SignInWithPhone = S.Struct({ phoneNumber: requiredString, password: currentPassword })

const signInWithPhone = action(Effect.gen(function* () {
  const input = yield* validateRequest(SignInWithPhone)

  return yield* betterAuthRedirect('signInPhoneNumber', { body: input }, {
    redirectTo: '/home',
    errors: (error) => ({ phoneNumber: error.message }),
  })
}))

const confirmPassword = action(Effect.gen(function* () {
  const input = yield* validateRequest(S.Struct({ password: currentPassword }))
  yield* betterAuthCall('verifyPassword', { body: input }, { errors: (error) => ({ password: error.message }) })

  return yield* json({ confirmed: true })
}))

async function createApp(limiter: TestRateLimiter, max = 3, options: AuthOptions = {}) {
  const auth = createAuth(options)
  const { user } = await auth.api.signUpEmail({ body: { name: 'Ada', email: 'ada@example.com', password: 'correct horse', username: 'ada' } })
  await (await auth.$context).internalAdapter.updateUser(user.id, { phoneNumber: '+15550000001', phoneNumberVerified: true })

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

  routes
    .post('/sign-in', signIn)
    .post('/sign-in/phone', signInWithPhone)
    .post('/confirm-password', confirmPassword)
    .all('/api/auth/*', betterAuthHandler({ settable: [] }))

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

/** A call to Better Auth's API from a client address of its own, as each of a botnet's guesses is. */
const fromAnywhere = (app: Hono, env: ReturnType<typeof testEnv>) =>
  (path: string, body: unknown, type = 'application/json') =>
    testBrowser(app, env).request(`/api/auth${path}`, {
      method: 'POST',
      headers: { 'Content-Type': type },
      body: JSON.stringify(body),
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

  // Each type is JSON to a parser that trims or splits it one way, and a form
  // to Better Auth's: a leading U+00A0, U+000B or U+000C is not HTTP
  // whitespace, so Headers keep it and String#trim removes it.
  test.each([
    'x/application/json+json;a=b, application/x-www-form-urlencoded',
    ' application/json; a=application/x-www-form-urlencoded',
    '\u000bapplication/json; a=application/x-www-form-urlencoded',
    '\u000capplication/json; a=application/x-www-form-urlencoded',
    ' application/vnd.api+json; a=application/x-www-form-urlencoded',
  ])('a body Better Auth would read as a form, though it reads as JSON another way, is refused uncounted (%j)', async (type) => {
    const { app, env, rows } = await createApp(testRateLimiter({ limit: 100 }))
    // As JSON it names a decoy; as the form Better Auth reads, ada.
    const guess = (index: number) => testBrowser(app, env).request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': type },
      body: JSON.stringify({ email: `decoy-${index}@example.net`, p: `&${new URLSearchParams({ email: 'ada@example.com', password: `guess-${index}` })}&` }),
    })

    expect([(await guess(1)).status, (await guess(2)).status, (await guess(3)).status]).toEqual([415, 415, 415])
    expect(rows()).toEqual([])
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

describe('each password sign-in counts against the account its endpoint checks', () => {
  test('a username sign-in counts against the username, whatever email it also sends', async () => {
    const { app, env, rows } = await createApp(testRateLimiter({ limit: 100 }))
    const api = fromAnywhere(app, env)

    // Better Auth checks the username's password and drops the email.
    for (const [index, guess] of ['guess-1', 'guess-2', 'guess-3'].entries()) {
      expect((await api('/sign-in/username', { username: 'ada', password: guess, email: `decoy-${index}@example.net` })).status).toBe(401)
    }

    expect((await api('/sign-in/username', { username: 'ada', password: 'correct horse', email: 'decoy-4@example.net' })).status).toBe(429)
    expect(rows()).toHaveLength(1)
  })

  test("every spelling the username plugin's usernameNormalization folds together counts against one account", async () => {
    // The application's normalizer drops separators, so all of these find ada.
    const usernameNormalization = (name: string) => name.toLowerCase().replaceAll('.', '').replaceAll('_', '')
    const { app, env, rows } = await createApp(testRateLimiter({ limit: 100 }), 3, { username: { usernameNormalization } })
    const api = fromAnywhere(app, env)

    for (const [index, spelling] of ['a.da', 'Ad_a', 'a_d.a'].entries()) {
      expect((await api('/sign-in/username', { username: spelling, password: `guess-${index}` })).status).toBe(401)
    }

    expect((await api('/sign-in/username', { username: 'a.d.a', password: 'correct horse' })).status).toBe(429)
    expect(rows()).toHaveLength(1)
  })

  test("the username is normalized as often as the plugin's validationOrder has its endpoint normalize it", () => {
    // Strips one leading x, so normalizing twice, as 'pre-normalization' has the endpoint do, finds a different account.
    const plugin = username({ usernameNormalization: (name) => name.replace(/^x/, ''), validationOrder: { username: 'pre-normalization' } })

    expect(accountOf('/sign-in/username', { username: 'xxada' }, { plugins: [plugin] })).toBe('ada')
    expect(accountOf('/sign-in/username', { username: 'xxada' }, { plugins: [username({ usernameNormalization: (name) => name.replace(/^x/, '') })] })).toBe('xada')
  })

  test('an email that is not text, or blank, does not take a username sign-in out of its count', async () => {
    const emails: ReadonlyArray<unknown> = [1, '', '   ', false, {}]
    const { app, env, rows } = await createApp(testRateLimiter({ limit: 100 }), emails.length)
    const api = fromAnywhere(app, env)

    for (const [index, email] of emails.entries()) {
      expect((await api('/sign-in/username', { username: 'ada', password: `guess-${index}`, email })).status).toBe(401)
    }

    expect((await api('/sign-in/username', { username: 'ada', password: 'correct horse', email: 1 })).status).toBe(429)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.count).toBe(emails.length)
  })

  test("a phone number's password sign-ins through Better Auth's API count against it", async () => {
    const { app, env } = await createApp(testRateLimiter({ limit: 100 }))
    const api = fromAnywhere(app, env)

    for (const guess of ['guess-1', 'guess-2', 'guess-3']) {
      expect((await api('/sign-in/phone-number', { phoneNumber: '+15550000001', password: guess })).status).toBe(401)
    }

    expect((await api('/sign-in/phone-number', { phoneNumber: '+15550000001', password: 'correct horse' })).status).toBe(429)
    // A body the framework cannot read is refused, so it is never an uncounted guess.
    expect((await api('/sign-in/phone-number', { phoneNumber: '+15550000001', password: 'correct horse' }, 'text/plain')).status).toBe(415)
  })

  test("a phone number's password sign-ins through an action count against it", async () => {
    const { app, env } = await createApp(testRateLimiter({ limit: 100 }))
    const attemptWithPhone = (password: string) => testBrowser(app, env).request('/sign-in/phone', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: '+15550000001', password }),
    })

    for (const guess of ['guess-1', 'guess-2', 'guess-3']) expect((await attemptWithPhone(guess)).status).toBe(422)

    expect((await attemptWithPhone('correct horse')).status).toBe(429)
  })

  test('a password sign-in that names no account is refused before a password is checked', async () => {
    const { app, env, rows } = await createApp(testRateLimiter({ limit: 100 }), 1)
    const api = fromAnywhere(app, env)
    const unnamed: ReadonlyArray<readonly [string, object]> = [
      ['/sign-in/email', { password: 'guess' }],
      ['/sign-in/email', { email: ['ada@example.com'], password: 'guess' }],
      ['/sign-in/username', { password: 'guess', email: 'ada@example.com' }],
      ['/sign-in/username', { username: 1, password: 'guess' }],
      ['/sign-in/username', { username: '   ', password: 'guess' }],
      ['/sign-in/phone-number', { phoneNumber: null, password: 'guess' }],
    ]

    for (const [path, body] of unnamed) expect({ path, body, status: (await api(path, body)).status }).toEqual({ path, body, status: 400 })

    expect(rows()).toEqual([])
    expect((await api('/sign-in/username', { username: 'ada', password: 'correct horse' })).status).toBe(200)
  })
})

describe("Better Auth's other checks of the signed-in account's password", () => {
  /** A browser signed in through Better Auth's API, which counts one call against its address. */
  const signedIn = async (app: Hono, env: ReturnType<typeof testEnv>) => {
    const browser = testBrowser(app, env)
    const res = await browser.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.com', password: 'correct horse' }),
    })

    expect(res.status).toBe(200)

    return browser
  }

  test('a session guessing its password is counted against its address, through the API and through an action', async () => {
    const { app, env } = await createApp(testRateLimiter({ limit: 3 }), 100)
    const guess = (browser: ReturnType<typeof testBrowser>, path: string) => browser.request(path, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'guess' }),
    })
    const statuses: Record<string, ReadonlyArray<number>> = {}

    for (const path of ['/api/auth/verify-password', '/api/auth/delete-user', '/confirm-password']) {
      const browser = await signedIn(app, env)
      statuses[path] = [(await guess(browser, path)).status, (await guess(browser, path)).status, (await guess(browser, path)).status]
    }

    expect(statuses).toEqual({
      '/api/auth/verify-password': [400, 400, 429],
      '/api/auth/delete-user': [400, 400, 429],
      '/confirm-password': [422, 422, 429],
    })
  })
})

describe("Better Auth's own limits beside the sign-in limits", () => {
  const signInFrom = (app: Hono, env: ReturnType<typeof testEnv>) => testBrowser(app, env).request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ada@example.com', password: 'correct horse' }),
  })

  test("Better Auth's database storage, which deletes the table's rows by age, is refused, whatever its model's name", async () => {
    for (const rateLimit of [{ enabled: true, storage: 'database' }, { storage: 'database', modelName: 'rate_limit' }] as const) {
      const { app, time } = await createApp(testRateLimiter({ limit: 100 }), 3, { rateLimit })
      const env = testEnv(time.layer, { SIGN_IN_LIMITER: testRateLimiter({ limit: 100 }), ENVIRONMENT: 'development' })
      const res = await signInFrom(app, env)

      expect(res.status).toBe(500)
      expect(await res.text()).toContain("storage: 'memory'")
    }
  })

  test('the database storage is refused on the first request of any kind, as a misconfigured env is, not only when someone signs in', async () => {
    const { app, time, routes } = await createApp(testRateLimiter({ limit: 100 }), 3, { rateLimit: { enabled: true, storage: 'database' } })
    const env = testEnv(time.layer, { SIGN_IN_LIMITER: testRateLimiter({ limit: 100 }), ENVIRONMENT: 'development' })

    // A request that never reaches Better Auth: a path no route serves.
    const res = await app.request('/nothing-here', undefined, env)

    expect(res.status).toBe(500)
    expect(await res.text()).toContain("storage: 'memory'")
    // A job run through the app fails too, so a queue retries and a cron run is recorded as failed.
    await expect(routes.run(Effect.succeed('done'), env)).rejects.toThrow("storage: 'memory'")
  })

  test('its memory storage, or none, leaves the counts alone and signs in', async () => {
    for (const rateLimit of [{ enabled: true, storage: 'memory' }, { enabled: false, storage: 'database' }] as const) {
      const { app, env } = await createApp(testRateLimiter({ limit: 100 }), 3, { rateLimit })

      expect((await signInFrom(app, env)).status).toBe(200)
    }
  })
})
