/**
 * Which cookies the framework takes for the session's, in each place that
 * decides: whether a request is someone's own, whether the session lookup
 * asks Better Auth, whether a response that sets one clears Inertia's
 * history, and whether sign-out expires one.
 *
 * Each place has its own rule today, and they disagree: a `__Host-` session
 * cookie, or one under Better Auth's `cookiePrefix`, is no one's own to the
 * cache policy yet starts a session for the history. The table pins today's
 * answers. Step 1a of plans/request-pipeline.md gives every place one rule,
 * and changes the rows it fixes.
 */

import { describe, expect, test } from 'bun:test'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { betterAuthLogoutAction } from '../src/effect/auth.js'
import { render } from '../src/effect/responses.js'
import { RequestService } from '../src/effect/services.js'
import { DEFAULT_CACHE_CONTROL } from '../src/page-cache.js'
import { testBrowser } from '../src/testing.js'

/** The application's own session cookie, `auth.sessionCookie`. */
const SESSION_COOKIE = 'sid'

/** What each place decides for one cookie name. */
interface Decisions {
  /** A response that states no Cache-Control is no shared cache's (the default policy, the page cache and the route cache share this check). */
  readonly personal: boolean
  /** With `auth.sessionCookie: 'sid'`, a request carrying it has the session lookup ask Better Auth. */
  readonly lookedUp: boolean
  /** A response that sets it has the next page clear Inertia's history. */
  readonly clearsHistory: boolean
  /** Sign-out expires it when Better Auth's answer expires no cookie. */
  readonly expiredOnSignOut: boolean
}

const today: ReadonlyArray<readonly [name: string, decisions: Decisions]> = [
  ['better-auth.session_token', { personal: true, lookedUp: false, clearsHistory: true, expiredOnSignOut: true }],
  ['__Secure-better-auth.session_token', { personal: true, lookedUp: false, clearsHistory: true, expiredOnSignOut: true }],
  ['__Host-better-auth.session_token', { personal: false, lookedUp: false, clearsHistory: true, expiredOnSignOut: false }],
  // Better Auth's `advanced.cookiePrefix: 'myapp'`.
  ['myapp.session_token', { personal: false, lookedUp: false, clearsHistory: true, expiredOnSignOut: false }],
  ['better-auth.session_data', { personal: true, lookedUp: false, clearsHistory: false, expiredOnSignOut: true }],
  ['sid', { personal: true, lookedUp: true, clearsHistory: true, expiredOnSignOut: false }],
  ['__Secure-sid', { personal: true, lookedUp: true, clearsHistory: true, expiredOnSignOut: false }],
  ['__Host-sid', { personal: false, lookedUp: true, clearsHistory: true, expiredOnSignOut: false }],
  // Another cookie whose name ends in the session cookie's.
  ['notsid', { personal: false, lookedUp: true, clearsHistory: false, expiredOnSignOut: false }],
  ['theme', { personal: false, lookedUp: false, clearsHistory: false, expiredOnSignOut: false }],
]

/** The part of the Inertia page object that says what the client does with its history. */
const PageHistory = S.Struct({ clearHistory: S.optional(S.Boolean) })

function sessionApp() {
  const lookups = { count: 0 }
  const app = new Hono()
  const { routes } = setupWeb(app, {
    version: '1',
    render: (page) => JSON.stringify(page),
    // Guest pages keep their history, so only a session change clears it.
    history: { encrypt: false },
    auth: {
      client: () => ({
        api: {
          getSession: async () => {
            lookups.count += 1

            return null
          },
        },
        handler: async () => new Response(null),
      }),
      sessionCookie: SESSION_COOKIE,
    },
  })

  routes
    .get('/plain', action(Effect.succeed(new Response('ok'))))
    .get('/page', action(render('Home')))
    // Sets the cookie the query names, as a sign-in sets the session's.
    .post('/set', action(Effect.gen(function* () {
      const request = yield* RequestService
      const name = new URL(request.url).searchParams.get('name') ?? ''

      return new Response(null, { status: 303, headers: { Location: '/page', 'Set-Cookie': `${name}=new; Path=/; Secure; HttpOnly` } })
    })))
    .post('/sign-out', action(betterAuthLogoutAction()))

  return { app, lookups }
}

async function decisionsFor(name: string): Promise<Decisions> {
  const { app, lookups } = sessionApp()
  const plain = await app.request('/plain', { headers: { Cookie: `${name}=value` } })

  const browser = testBrowser(app)
  await browser.request(`/set?name=${encodeURIComponent(name)}`, { method: 'POST' })
  const next = await browser.request('/page', { headers: { 'X-Inertia': 'true', 'X-Inertia-Version': '1' } })
  const page = S.decodeUnknownSync(PageHistory)(await next.json())

  const signOut = await testBrowser(app).request('/sign-out', { method: 'POST' })
  const expired = signOut.headers.getSetCookie().map((cookie) => cookie.slice(0, cookie.indexOf('=')))

  return {
    personal: plain.headers.get('Cache-Control') !== DEFAULT_CACHE_CONTROL,
    lookedUp: lookups.count > 0,
    clearsHistory: page.clearHistory === true,
    expiredOnSignOut: expired.includes(name),
  }
}

describe('session cookies', () => {
  test('a request with no cookie is no one in particular, and its page keeps the history', async () => {
    expect(await decisionsFor('')).toEqual({ personal: false, lookedUp: false, clearsHistory: false, expiredOnSignOut: false })
  })

  test.each(today)('%s', async (name, decisions) => {
    expect(await decisionsFor(name)).toEqual(decisions)
  })
})
