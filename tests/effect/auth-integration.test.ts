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
import { APIError } from 'better-auth'
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

const SESSION = 'better-auth.session_token=session-1; Path=/; HttpOnly; SameSite=Lax'

/** A Better Auth client that accepts one password. */
const fakeAuth = {
  api: {
    signInEmail: async (input: {
      readonly body: { readonly email: string; readonly password: string }
      readonly headers: Headers
      readonly returnHeaders: true
    }) => {
      if (input.body.password !== 'correct horse') {
        throw new APIError('UNAUTHORIZED', { message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' })
      }

      return { headers: new Headers({ 'set-cookie': SESSION }) }
    },
    signUpEmail: async (input: { readonly body: { readonly email: string; readonly password: string }; readonly returnHeaders: true }) => ({
      headers: new Headers({ 'set-cookie': SESSION }),
      response: { user: { id: 'user-2', email: input.body.email } },
    }),
    signOut: async () => ({ headers: new Headers({ 'set-cookie': 'better-auth.session_token=; Max-Age=0; Path=/' }) }),
    getSession: async () => null,
  },
  handler: async (request: Request) => Response.json({ forwarded: new URL(request.url).pathname }),
}

declare module '../../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{
      auth: typeof fakeAuth
    }>
  }
}

const SignIn = S.Struct({ email: requiredString, password: requiredString })

const signIn = action(Effect.gen(function* () {
  const input = yield* validateRequest(SignIn)
  const redirectTo = yield* intendedUrl('/dashboard')

  return yield* betterAuthRedirect(
    (auth, request) => auth.api.signInEmail({ body: input, headers: request.headers, returnHeaders: true }),
    { redirectTo, errors: (error) => ({ email: error.message }) }
  )
}))

// Sign-up lands on the new member's first team, which the redirect computes.
const signUp = action(Effect.gen(function* () {
  const input = yield* validateRequest(SignIn)

  return yield* betterAuthRedirect(
    (auth) => auth.api.signUpEmail({ body: input, returnHeaders: true }),
    { redirectTo: (result) => Effect.succeed(`/teams/first-of-${result.response.user.id}`) }
  )
}))

// Sign-up whose follow-up refuses after Better Auth created the user.
const signUpThenRefuse = action(Effect.gen(function* () {
  const input = yield* validateRequest(SignIn)

  return yield* betterAuthRedirect(
    (auth) => auth.api.signUpEmail({ body: input, returnHeaders: true }),
    { redirectTo: () => Effect.fail(new ValidationError({ errors: { invitation: 'This invitation has expired.' } })) }
  )
}))

// A password check whose result the action uses.
const checkPassword = action(Effect.gen(function* () {
  const input = yield* validateRequest(SignIn)
  const result = yield* betterAuthCall(
    (auth, request) => auth.api.signInEmail({ body: input, headers: request.headers, returnHeaders: true }),
    { errors: (error) => ({ password: error.message }) }
  )

  return yield* json({ checked: result.headers instanceof Headers })
}))

function createApp() {
  const app = new Hono()
  const { routes } = setupWeb(app, {
    version: '1',
    render: (page) => JSON.stringify(page),
    auth: { client: () => fakeAuth, signInPath: '/sign-in' },
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
    .all('/api/auth/*', betterAuthHandler)

  return app
}

const page = { 'X-Inertia': 'true', 'X-Inertia-Version': '1' }

const submitSignIn = (app: Hono, password: string) =>
  app.request('/sign-in', {
    method: 'POST',
    headers: { ...page, 'Content-Type': 'application/json', Referer: 'http://localhost/sign-in' },
    body: JSON.stringify({ email: 'ada@example.com', password }),
  })

describe('auth flow on routes', () => {
  test('betterAuthCall returns the result, or the rejection as field errors', async () => {
    const app = createApp()
    const check = (password: string) => app.request('/check-password', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.com', password }),
    })

    const passed = await check('correct horse')
    const failed = await check('wrong')

    expect(await passed.json()).toEqual({ checked: true })
    expect(passed.headers.getSetCookie().some((cookie) => cookie.startsWith('better-auth.session_token='))).toBe(true)
    expect(failed.status).toBe(422)
    expect((await failed.json()).errors).toEqual({ password: 'Invalid email or password' })
  })

  test('a sign-up whose redirectTo fails keeps the session Better Auth created', async () => {
    const res = await createApp().request('/sign-up-refused', {
      method: 'POST',
      headers: { Accept: 'text/html', Referer: 'http://localhost/invitations/abc' },
      body: new URLSearchParams({ email: 'ada@example.com', password: 'correct horse' }),
    })

    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/invitations/abc')
    expect(res.headers.getSetCookie().some((cookie) => cookie.startsWith('better-auth.session_token=session-1'))).toBe(true)
  })

  test('a signed-out visitor to a member route goes to the configured sign-in path', async () => {
    const res = await createApp().request('/dashboard')

    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/sign-in?redirect=%2Fdashboard')
  })

  test('signing in returns to the page the visitor was sent away from', async () => {
    const app = createApp()
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
    const res = await submitSignIn(createApp(), 'correct horse')

    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/dashboard')
    expect(res.headers.getSetCookie()).toContain(SESSION)
  })

  test('a rejected sign-in goes back to the form with the error on its field', async () => {
    const app = createApp()
    const rejected = await submitSignIn(app, 'wrong')
    const flash = rejected.headers.getSetCookie().find((cookie) => cookie.startsWith('popweb-flash='))?.split(';')[0] ?? ''

    const form = await app.request('/sign-in', { headers: { ...page, Cookie: flash } })

    expect(rejected.status).toBe(303)
    expect(rejected.headers.get('Location')).toBe('/sign-in')
    expect((await form.json()).props.errors).toEqual({ email: 'Invalid email or password' })
  })

  test('signing up can redirect by Better Auth\'s result', async () => {
    const res = await createApp().request('/sign-up', {
      method: 'POST',
      headers: { ...page, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'grace@example.com', password: 'correct horse' }),
    })

    expect(res.headers.get('Location')).toBe('/teams/first-of-user-2')
    expect(res.headers.getSetCookie()).toContain(SESSION)
  })

  test('a signed-in member visiting a guest page goes home', async () => {
    const res = await createApp().request('/sign-in', {}, testEnv(signedIn({ id: 'user-1' })))

    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/')
  })

  test('signing out clears the session and goes home', async () => {
    const res = await createApp().request('/sign-out', { method: 'POST', headers: page })

    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/')
    expect(res.headers.getSetCookie().join()).toContain('better-auth.session_token=;')
  })

  test("betterAuthHandler forwards the request to Better Auth's API", async () => {
    const res = await createApp().request('/api/auth/get-session')

    expect(await res.json()).toEqual({ forwarded: '/api/auth/get-session' })
  })
})
