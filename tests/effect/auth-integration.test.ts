/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Auth Flow Tests
 *
 * Sign-in, sign-out and Better Auth's own API are ordinary routes on the
 * `routes` setupWeb returns: guards come from `routes.provide`, a sign-in
 * action validates its form and calls `betterAuthRedirect`, and a signed-out
 * visitor goes to setupWeb's `auth.signInPath`.
 */

import { describe, expect, test } from 'bun:test'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../../src/setup.js'
import { action } from '../../src/effect/action.js'
import { intendedUrl, RequireAuthLayer, RequireGuestLayer } from '../../src/effect/auth.js'
import { betterAuthCall, betterAuthHandler, betterAuthLogoutAction, betterAuthRedirect } from '../../src/auth.js'
import { json, render } from '../../src/effect/responses.js'
import { requiredString } from '../../src/effect/schema.js'
import { ValidationError } from '../../src/effect/errors.js'
import { validateRequest } from '../../src/effect/validation.js'
import { signedIn, testEnv } from '../../src/testing.js'
import type { WebDeclaration } from '../../src/effect/register.js'

/** A Better Auth with email and password, in memory, limiting requests as `rateLimit` says. */
function createAuth(rateLimit: { readonly enabled: boolean } = { enabled: false }) {
  return betterAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], rateLimit: [] }),
    baseURL: 'http://localhost',
    secret: 'auth-flow-test-secret-with-enough-entropy-0123456789',
    emailAndPassword: { enabled: true },
    rateLimit: { ...rateLimit, storage: 'memory' },
    logger: { disabled: true },
  })
}

declare module '../../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{
      auth: ReturnType<typeof createAuth>
    }>
  }
}

const SignIn = S.Struct({ email: requiredString, password: requiredString })

const signIn = action(Effect.gen(function* () {
  const input = yield* validateRequest(SignIn)
  const redirectTo = yield* intendedUrl('/dashboard')

  return yield* betterAuthRedirect('signInEmail', { body: input }, {
    redirectTo,
    errors: (error) => ({ email: error.message }),
  })
}))

// Sign-up lands on the new member's first team, which the redirect computes.
const signUp = action(Effect.gen(function* () {
  const input = yield* validateRequest(SignIn)

  return yield* betterAuthRedirect('signUpEmail', { body: { ...input, name: 'Grace' } }, {
    redirectTo: (result) => Effect.succeed(`/teams/first-of-${result.user.id}`),
  })
}))

// Sign-up whose follow-up refuses after Better Auth created the user.
const signUpThenRefuse = action(Effect.gen(function* () {
  const input = yield* validateRequest(SignIn)

  return yield* betterAuthRedirect('signUpEmail', { body: { ...input, name: 'Ada' } }, {
    redirectTo: () => Effect.fail(new ValidationError({ errors: { invitation: 'This invitation has expired.' } })),
  })
}))

// A password check whose result the action uses.
const checkPassword = action(Effect.gen(function* () {
  const input = yield* validateRequest(SignIn)
  const result = yield* betterAuthCall('signInEmail', { body: input }, {
    errors: (error) => ({ password: error.message }),
  })

  return yield* json({ checked: result.user.email === input.email })
}))

async function createApp(rateLimit?: { readonly enabled: boolean }) {
  const auth = createAuth(rateLimit)
  await auth.api.signUpEmail({ body: { name: 'Ada', email: 'ada@example.com', password: 'correct horse' } })

  const app = new Hono()
  const { routes } = setupWeb(app, {
    version: '1',
    render: (page) => JSON.stringify(page),
    auth: { client: () => auth, signInPath: '/sign-in' },
  })

  routes
    .provide(RequireGuestLayer)
    .get('/sign-in', action(render('Auth/SignIn')))
    .post('/sign-in', signIn)
    .post('/sign-up', signUp)
    .post('/sign-up-refused', signUpThenRefuse)
    .post('/check-password', checkPassword)

  routes
    .provide(RequireAuthLayer)
    .get('/dashboard', action(render('Dashboard')))

  routes
    .post('/sign-out', betterAuthLogoutAction())
    .all('/api/auth/*', betterAuthHandler())

  return app
}

const SESSION = 'better-auth.session_token='
const hasSession = (res: Response) => res.headers.getSetCookie().some((cookie) => cookie.startsWith(SESSION) && !cookie.startsWith(`${SESSION};`))

const page = { 'X-Inertia': 'true', 'X-Inertia-Version': '1' }

const submitSignIn = (app: Hono, password: string) =>
  app.request('/sign-in', {
    method: 'POST',
    headers: { ...page, 'Content-Type': 'application/json', Referer: 'http://localhost/sign-in' },
    body: JSON.stringify({ email: 'ada@example.com', password }),
  })

describe('auth flow on routes', () => {
  test('betterAuthCall returns the result, or the rejection as field errors', async () => {
    const app = await createApp()
    const check = (password: string) => app.request('/check-password', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.com', password }),
    })

    const passed = await check('correct horse')
    const failed = await check('wrong')

    expect(await passed.json()).toEqual({ checked: true })
    expect(hasSession(passed)).toBe(true)
    expect(failed.status).toBe(422)
    expect((await failed.json()).errors).toEqual({ password: 'Invalid email or password' })
  })

  test('a sign-up whose redirectTo fails keeps the session Better Auth created', async () => {
    const res = await (await createApp()).request('/sign-up-refused', {
      method: 'POST',
      headers: { Accept: 'text/html', Referer: 'http://localhost/invitations/abc' },
      body: new URLSearchParams({ email: 'new@example.com', password: 'correct horse' }),
    })

    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/invitations/abc')
    expect(hasSession(res)).toBe(true)
  })

  test('a signed-out visitor to a member route goes to the configured sign-in path', async () => {
    const res = await (await createApp()).request('/dashboard')

    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/sign-in?redirect=%2Fdashboard')
  })

  test('signing in returns to the page the visitor was sent away from', async () => {
    const app = await createApp()
    const signInFrom = (referer: string) =>
      app.request('/sign-in', {
        method: 'POST',
        headers: { ...page, 'Content-Type': 'application/json', Referer: referer },
        body: JSON.stringify({ email: 'ada@example.com', password: 'correct horse' }),
      })

    const intended = await signInFrom('http://localhost/sign-in?redirect=%2Fdashboard%3Ftab%3Dbilling')
    const offSite = await signInFrom('http://localhost/sign-in?redirect=%2F%2Fevil.example%2Fphish')

    expect(intended.headers.get('Location')).toBe('/dashboard?tab=billing')
    expect(offSite.headers.get('Location')).toBe('/dashboard')
  })

  test('signing in redirects with the session cookie Better Auth sets', async () => {
    const res = await submitSignIn((await createApp()), 'correct horse')

    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/dashboard')
    expect(hasSession(res)).toBe(true)
    // A response carrying a session is kept by no cache.
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  test('a rejected sign-in goes back to the form with the error on its field', async () => {
    const app = await createApp()
    const rejected = await submitSignIn(app, 'wrong')
    const flash = rejected.headers.getSetCookie().find((cookie) => cookie.startsWith('popweb-flash='))?.split(';')[0] ?? ''

    const form = await app.request('/sign-in', { headers: { ...page, Cookie: flash } })

    expect(rejected.status).toBe(303)
    expect(rejected.headers.get('Location')).toBe('/sign-in')
    expect((await form.json()).props.errors).toEqual({ email: 'Invalid email or password' })
  })

  test('signing up can redirect by Better Auth\'s result', async () => {
    const res = await (await createApp()).request('/sign-up', {
      method: 'POST',
      headers: { ...page, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'grace@example.com', password: 'correct horse' }),
    })

    expect(res.headers.get('Location')).toMatch(/^\/teams\/first-of-\w+/)
    expect(hasSession(res)).toBe(true)
  })

  test('a signed-in member visiting a guest page goes home', async () => {
    const res = await (await createApp()).request('/sign-in', {}, testEnv(signedIn({ id: 'user-1' })))

    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/')
  })

  test('signing out clears the session and goes home', async () => {
    const res = await (await createApp()).request('/sign-out', { method: 'POST', headers: page })

    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/')
    expect(res.headers.getSetCookie().join()).toContain('better-auth.session_token=;')
  })

  test("betterAuthHandler forwards the request to Better Auth's API", async () => {
    const res = await (await createApp()).request('/api/auth/get-session')

    expect(res.status).toBe(200)
    expect(await res.json()).toBeNull()
  })

  test("a sign-in form is rate limited as Better Auth's own route is", async () => {
    const app = await createApp({ enabled: true })
    const statuses: number[] = []

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const res = await app.request('/sign-in', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.7' },
        body: JSON.stringify({ email: 'ada@example.com', password: 'guess' }),
      })
      statuses.push(res.status)
    }

    // Better Auth allows three sign-ins per address in ten seconds.
    expect(statuses).toEqual([422, 422, 422, 429])
  })
})

// Better Auth's own types name the endpoints and type their bodies and results.
export const typedCalls = Effect.gen(function* () {
  // @ts-expect-error 'signInEmial' is not one of Better Auth's endpoints.
  yield* betterAuthCall('signInEmial', { body: { email: 'ada@example.com', password: 'correct horse' } })
  // @ts-expect-error Signing in takes a password.
  yield* betterAuthCall('signInEmail', { body: { email: 'ada@example.com' } })

  const signedUp = yield* betterAuthCall('signUpEmail', { body: { name: 'Ada', email: 'ada@example.com', password: 'correct horse' } })
  const id: string = signedUp.user.id
  // The result is the JSON Better Auth answered: its dates are strings.
  const createdAt: string = signedUp.user.createdAt
  // @ts-expect-error A date in the result is its ISO string, not a Date.
  const asDate: Date = signedUp.user.createdAt
  void [createdAt, asDate]

  return id
})
