/**
 * Machines 3 and 12: who is asking is a
 * closed set, so a lookup that failed or never ran reads as neither a guest
 * nor a member. The rows that need a real Better Auth are in
 * tests/better-auth/seam.test.ts.
 */
import { describe, expect, test } from 'bun:test'
import { Effect, Layer, Schema as S } from 'effect'
import { Hono } from 'hono'
import { betterAuthLogoutAction } from '../../src/auth.js'
import { action } from '../../src/effect/action.js'
import { forbidden, render } from '../../src/effect/responses.js'
import { AuthUserService, type AuthUser } from '../../src/effect/services.js'
import { setupWeb } from '../../src/setup.js'
import { testEnv } from '../../src/testing.js'

const inertia = { 'X-Inertia': 'true', 'X-Requested-With': 'XMLHttpRequest' }
const session = { Cookie: 'better-auth.session_token=live' }
const member = (id: string) => ({
  session: { id: `s-${id}`, userId: id, token: 't', expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), updatedAt: new Date() },
  user: { id, name: id, email: `${id}@example.com`, emailVerified: true, image: null, createdAt: new Date(), updatedAt: new Date() },
})

function appWith(
  getSession: (input: { readonly headers: Headers }) => Promise<unknown>,
  auth: { readonly sessionCookie?: string; readonly session?: S.Codec<AuthUser, unknown, never, never>; readonly share?: S.Codec<{ readonly name: string }, unknown, never, never> } = {}
) {
  const app = new Hono()
  const { routes } = setupWeb(app, {
    version: '1',
    render: (page) => JSON.stringify(page),
    auth: { client: () => ({ api: { getSession } }), ...auth },
  })

  routes.get('/', action(render('Home', {}))).post('/', action(render('Home', {})))

  return { app, routes }
}

describe('a page when the lookup found nobody, or could not say', () => {
  test('M3.T24: a failed lookup clears no history, since its visitor may be signed in', async () => {
    const { app } = appWith(() => Promise.reject(new Error('the session store is down')))
    const res = await app.request('/', { headers: { ...inertia, ...session } })
    const page = await res.json()

    expect(res.status).toBe(503)
    expect(page.clearHistory).toBeUndefined()
  })

  test('M3.T25: nor does a refusal before the lookup ran, for a visitor who sent a session', async () => {
    const { app } = appWith(() => Promise.resolve(null))
    const res = await app.request('https://example.com/', {
      method: 'POST',
      headers: { ...inertia, ...session, Origin: 'https://elsewhere.example', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'a=b',
    })
    const page = await res.json()

    expect(res.status).toBe(403)
    expect(page.clearHistory).toBeUndefined()
  })

  test('a guest still clears it', async () => {
    const { app } = appWith(() => Promise.resolve(null))
    const page = await (await app.request('/', { headers: inertia })).json()

    expect(page.clearHistory).toBe(true)
  })
})

describe('a member a layer gives', () => {
  test("M3.T26: an action's failure answers as its success does: encrypted, marked and no one else's", async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })
    const user = { user: { id: 'key-owner' }, session: { id: 's' } } as unknown as AuthUser

    routes.provide(Layer.succeed(AuthUserService, user))
      .get('/works', action(render('Home', {})))
      .get('/fails', action(forbidden('No.')))

    const success = await app.request('/works', { headers: inertia }, testEnv(Layer.empty, {}))
    const failure = await app.request('/fails', { headers: inertia }, testEnv(Layer.empty, {}))
    const [worked, failed] = [await success.json(), await failure.json()]

    expect(failed.version).toBe(worked.version)
    expect(failed.encryptHistory).toBe(true)
    expect(failed.clearHistory).toBeUndefined()
    expect(failure.headers.get('Cache-Control')).toBe(success.headers.get('Cache-Control'))
  })
})

describe('a session schema with no id', () => {
  test('M3.T27: two members still have a mark each', async () => {
    const noId = S.Struct({ user: S.Struct({ name: S.String }), session: S.Struct({ id: S.String }) }) as unknown as S.Codec<AuthUser, unknown, never, never>
    let visitor = 'ada'
    const { app } = appWith(() => Promise.resolve(member(visitor)), { session: noId, share: S.Struct({ name: S.String }) })

    const ada = await (await app.request('/', { headers: { ...inertia, ...session } })).json()
    visitor = 'grace'
    const grace = await (await app.request('/', { headers: { ...inertia, ...session } })).json()

    expect(ada.version).not.toBe(grace.version)
  })
})

describe('signing out with Better Auth out of reach', () => {
  test('M13.T5: a cookie set across subdomains is expired by naming its domain', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
      auth: {
        client: () => ({
          options: { advanced: { crossSubDomainCookies: { enabled: true, domain: '.example.com' } } },
          api: { getSession: () => Promise.resolve(null) },
          handler: () => Promise.reject(new Error('Better Auth is down')),
        }),
      },
    })

    routes.post('/sign-out', betterAuthLogoutAction())

    const res = await app.request('https://example.com/sign-out', { method: 'POST', headers: { Origin: 'https://example.com', ...session } })
    const expired = res.headers.getSetCookie().filter((cookie) => cookie.startsWith('better-auth.session_token='))

    expect(res.status).toBe(303)
    expect(expired.some((cookie) => cookie.includes('Domain=.example.com'))).toBe(true)
    expect(expired.some((cookie) => !cookie.includes('Domain='))).toBe(true)
  })
})

describe('the lookup', () => {
  test('M12.T5: a bearer token is looked up beside a named session cookie', async () => {
    const seen: Array<string | null> = []
    const { app } = appWith(({ headers }) => {
      seen.push(headers.get('Authorization'))

      return Promise.resolve(member('ada'))
    }, { sessionCookie: 'app_session' })

    const page = await (await app.request('/', { headers: { ...inertia, Authorization: 'Bearer token' } })).json()

    expect(seen).toEqual(['Bearer token'])
    expect(page.encryptHistory).toBe(true)
  })

  test('with neither, nothing is looked up', async () => {
    const seen: unknown[] = []
    const { app } = appWith((input) => {
      seen.push(input)

      return Promise.resolve(null)
    }, { sessionCookie: 'app_session' })

    await app.request('/', { headers: inertia })

    expect(seen).toEqual([])
  })

  describe('the session cookie cache', () => {
    const lookedUp = async (options: object, sessionCookieCache?: 'trusted') => {
      const inputs: Array<{ readonly query?: object }> = []
      const app = new Hono()
      const { routes } = setupWeb(app, {
        version: '1',
        render: (page) => JSON.stringify(page),
        auth: {
          sessionCookieCache,
          client: () => ({
            options,
            api: {
              getSession: (input: { readonly query?: object }) => {
                inputs.push(input)

                return Promise.resolve(null)
              },
            },
          }),
        },
      })

      routes.get('/', action(render('Home', {})))
      await app.request('/', { headers: inertia })

      return inputs[0]?.query
    }

    test('M12.T14: the store is asked, where there is one', async () => {
      expect(await lookedUp({ database: {} })).toEqual({ disableCookieCache: true })
      expect(await lookedUp({ secondaryStorage: {} })).toEqual({ disableCookieCache: true })
    })

    test('unless the application trusts the cache', async () => {
      expect(await lookedUp({ database: {} }, 'trusted')).toBeUndefined()
    })

    test('and a stateless session, which only the cookie holds, is left to it', async () => {
      expect(await lookedUp({})).toBeUndefined()
    })
  })

  test('M12.T12: a lookup that fails once, as one that races a revocation does, asks again', async () => {
    let asked = 0
    const { app } = appWith(() => {
      asked += 1

      return asked === 1
        ? Promise.reject(new Error('the session row went away'))
        : Promise.resolve({ headers: new Headers({ 'set-cookie': 'better-auth.session_token=; Max-Age=0; Path=/' }), response: null })
    })
    const res = await app.request('/', { headers: { ...inertia, ...session } })

    expect(res.status).toBe(200)
    expect(asked).toBe(2)
    expect(res.headers.getSetCookie().join()).toContain('better-auth.session_token=;')
  })
})
