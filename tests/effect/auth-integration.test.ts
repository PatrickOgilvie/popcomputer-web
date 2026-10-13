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
import { RequireAuthLayer, RequireGuestLayer } from '../../src/effect/auth.js'
import { betterAuthHandler, betterAuthLogoutAction, betterAuthRedirect } from '../../src/auth.js'
import { render } from '../../src/effect/responses.js'
import { requiredString } from '../../src/effect/schema.js'
import { validateRequest } from '../../src/effect/validation.js'
import { signedIn, testEnv } from '../../src/testing.js'

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
    signOut: async () => ({ headers: new Headers({ 'set-cookie': 'better-auth.session_token=; Max-Age=0; Path=/' }) }),
    getSession: async () => null,
  },
  handler: async (request: Request) => Response.json({ forwarded: new URL(request.url).pathname }),
}

declare module '../../src/effect/services.js' {
  interface WebAuthType {
    type: typeof fakeAuth
  }
}

const SignIn = S.Struct({ email: requiredString, password: requiredString })

const signIn = action(Effect.gen(function* () {
  const input = yield* validateRequest(SignIn)

  return yield* betterAuthRedirect(
    (auth, request) => auth.api.signInEmail({ body: input, headers: request.headers, returnHeaders: true }),
    { redirectTo: '/dashboard', errors: (error) => ({ email: error.message }) }
  )
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
  test('a signed-out visitor to a member route goes to the configured sign-in path', async () => {
    const res = await createApp().request('/dashboard')

    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/sign-in')
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
