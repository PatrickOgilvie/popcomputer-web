/* oxlint-disable effecttsgo/async-function -- Test entrypoints call fetch, a native Promise contract. */
/**
 * Machines 49 and 57: the `fetch` stand-ins testOAuthProvider installs, and
 * the codes and tokens its provider issues. Every install is one entry of one
 * process-wide stack, removed once, in any order, by its own handle or its
 * provider's `restore()`; a code is spent by any exchange that names it; an
 * access token reads the person for the hour its `expires_in` says.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { testClock, testOAuthProvider, type TestOAuthProvider } from '../../src/testing.js'

const network = globalThis.fetch

/** The `fetch` under every stand-in, answering each request itself. */
const base: typeof fetch = Object.assign(
  async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('base', { headers: { 'X-Answered-By': 'base' } }),
  { preconnect: network.preconnect }
)

const providerAt = (host: string) =>
  testOAuthProvider({
    authorizationUrl: `https://${host}/authorize`,
    tokenUrl: `https://${host}/token`,
    userInfoUrl: `https://${host}/userinfo`,
    client: { id: 'app', secret: 'app-secret' },
  })

const a = providerAt('a.test')
const b = providerAt('b.test')

/** Who answers a request for `host`'s user info: its provider, or the `fetch` under every stand-in. */
async function answerer(host: string): Promise<string> {
  const res = await fetch(`https://${host}/userinfo`)

  return res.headers.get('X-Answered-By') ?? `${host} (${res.status})`
}

beforeEach(() => {
  globalThis.fetch = base
})

afterEach(() => {
  setSystemTime()
  // Whatever a test left installed, so the next starts with none.
  for (const provider of [a, b]) for (let i = 0; i < 4; i += 1) provider.restore()
  globalThis.fetch = network
})

describe('machine 49: the fetch stand-in stack', () => {
  test('M49.T7: restoring a provider with another installed above leaves the other answering', async () => {
    a.install()
    b.install()
    a.restore()

    expect(await answerer('b.test')).toBe('b.test (401)')
    expect(await answerer('a.test')).toBe('base')
  })

  test('M49.T7: each install is removed by its own handle, in any order', async () => {
    const first = a.install()
    const second = b.install()

    first[Symbol.dispose]()
    expect(await answerer('b.test')).toBe('b.test (401)')
    expect(await answerer('a.test')).toBe('base')

    second[Symbol.dispose]()
    expect(globalThis.fetch).toBe(base)
  })

  test('M49.T12: once both are restored, out of order, fetch is the one before either', async () => {
    a.install()
    b.install()
    a.restore()
    b.restore()

    expect(globalThis.fetch).toBe(base)
  })

  test('M49.T13: a restore after every install is removed leaves no stand-in in place', async () => {
    a.install()
    b.install()
    a.restore()
    b.restore()
    a.restore()

    expect(globalThis.fetch).toBe(base)
    expect(await answerer('a.test')).toBe('base')
  })

  test('M49.T14: a restored provider answers nothing, whatever order its neighbours were restored in', async () => {
    a.install()
    b.install()
    a.restore()
    b.restore()
    const before = a.requests.length

    expect(await answerer('a.test')).toBe('base')
    expect(a.requests.length).toBe(before)
  })

  test('M49.T15: a manual restore inside using removes the inner install, and its dispose then removes nothing', async () => {
    a.install()
    {
      using _inner = a.install()
      a.restore()
    }

    expect(await answerer('a.test')).toBe('a.test (401)')

    a.restore()
    expect(globalThis.fetch).toBe(base)
  })

  test('M49.T16: disposing one install twice removes it once', async () => {
    a.install()
    const inner = a.install()

    inner[Symbol.dispose]()
    inner[Symbol.dispose]()

    expect(await answerer('a.test')).toBe('a.test (401)')

    a.restore()
    expect(globalThis.fetch).toBe(base)
  })

  test('M49.T17: an install in effect records each request it answers, and none it passes on', async () => {
    a.install()
    const before = a.requests.length

    expect(await answerer('a.test')).toBe('a.test (401)')
    expect(await (await fetch('https://elsewhere.test/page')).text()).toBe('base')
    expect(a.requests.slice(before)).toEqual([{ method: 'GET', url: 'https://a.test/userinfo' }])
  })

  test("M49.T8: restoring the latest install puts back the fetch before it, dropping a test's own fetch assigned since", async () => {
    a.install()
    globalThis.fetch = Object.assign(async () => new Response('mine'), { preconnect: network.preconnect })
    a.restore()

    expect(globalThis.fetch).toBe(base)
  })

  test("M49.T7: removing an install under a test's own fetch leaves that fetch, and the install passes requests on", async () => {
    a.install()
    const standIn = globalThis.fetch
    const mine = Object.assign((input: RequestInfo | URL, init?: RequestInit) => standIn(input, init), { preconnect: network.preconnect })
    globalThis.fetch = mine
    b.install()
    a.restore()

    expect(await answerer('a.test')).toBe('base')
    expect(await answerer('b.test')).toBe('b.test (401)')

    b.restore()
    expect(globalThis.fetch).toBe(mine)
    expect(await answerer('a.test')).toBe('base')
  })
})

/** A code `provider` sends the browser back with, for an authorization without PKCE. */
function codeFrom(provider: TestOAuthProvider, host: string): string {
  const authorization = new URL(`https://${host}/authorize`)
  authorization.searchParams.set('client_id', 'app')
  authorization.searchParams.set('redirect_uri', 'http://localhost/callback')
  authorization.searchParams.set('state', 'state-1')

  return new URL(provider.callback(authorization, { id: 'ada', email: 'ada@a.test', name: 'Ada' }), 'http://localhost').searchParams.get('code') ?? ''
}

const exchange = (host: string, code: string, overrides: Record<string, string> = {}) =>
  fetch(`https://${host}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'http://localhost/callback',
      client_id: 'app',
      client_secret: 'app-secret',
      ...overrides,
    }),
  })

const userInfo = (host: string, token: string) =>
  fetch(`https://${host}/userinfo`, { headers: { Authorization: `Bearer ${token}` } })

describe("machine 57: the OAuth stand-in's grants", () => {
  test('M57.T3: an exchange from the wrong client spends the code', async () => {
    using _ = a.install()
    const code = codeFrom(a, 'a.test')

    expect(await (await exchange('a.test', code, { client_secret: 'guessed' })).json()).toEqual({ error: 'invalid_client' })
    expect(await (await exchange('a.test', code)).json()).toEqual({ error: 'invalid_grant' })
  })

  test('M57.T4: an exchange with the wrong grant_type spends the code', async () => {
    using _ = a.install()
    const code = codeFrom(a, 'a.test')

    expect(await (await exchange('a.test', code, { grant_type: 'password' })).json()).toEqual({ error: 'unsupported_grant_type' })
    expect(await (await exchange('a.test', code)).json()).toEqual({ error: 'invalid_grant' })
  })

  test('M57.T16: an access token expires when its expires_in has passed', async () => {
    using _ = a.install()
    setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const token = await (await exchange('a.test', codeFrom(a, 'a.test'))).json()

    expect(token.expires_in).toBe(3600)

    setSystemTime(new Date('2026-01-01T00:59:59.999Z'))
    expect((await userInfo('a.test', token.access_token)).status).toBe(200)

    setSystemTime(new Date('2026-01-01T01:00:00Z'))
    const expired = await userInfo('a.test', token.access_token)

    expect(expired.status).toBe(401)
    expect(await expired.json()).toEqual({ error: 'invalid_token' })
    expect(a.accessTokens.has(token.access_token)).toBe(true)
  })

  test("M57.T16: given a test's clock, the provider expires a token when that clock passes its hour", async () => {
    const time = await testClock(new Date('2026-01-01T00:00:00Z'))
    const provider = testOAuthProvider({
      authorizationUrl: 'https://clocked.test/authorize',
      tokenUrl: 'https://clocked.test/token',
      userInfoUrl: 'https://clocked.test/userinfo',
      now: () => time.now(),
    })
    using _ = provider.install()
    const token = await (await exchange('clocked.test', codeFrom(provider, 'clocked.test'))).json()

    await time.advance('59 minutes')
    expect((await userInfo('clocked.test', token.access_token)).status).toBe(200)

    await time.advance('1 minute')
    expect((await userInfo('clocked.test', token.access_token)).status).toBe(401)
  })
})
