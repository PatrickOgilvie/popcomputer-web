/* oxlint-disable effecttsgo/async-function -- Test entrypoints call fetch, a native Promise contract. */
/**
 * testOAuthProvider stands in for an OAuth provider as strictly as a real
 * one: a code is exchanged once, for the redirect and PKCE verifier its
 * authorization named, by the registered client, and only the token it
 * issued reads the person. The seam tests in tests/better-auth sign people in
 * through it with Better Auth's genericOAuth.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { testOAuthProvider, type TestOAuthPerson } from '../src/testing.js'

const provider = testOAuthProvider({
  authorizationUrl: 'https://id.acme.test/oauth/authorize',
  tokenUrl: 'https://id.acme.test/oauth/token',
  userInfoUrl: 'https://id.acme.test/oauth/userinfo',
  client: { id: 'app', secret: 'app-secret' },
})

const ADA: TestOAuthPerson = { id: 'acme-ada', email: 'ada@acme.test', name: 'Ada', emailVerified: false }
const VERIFIER = 'a-verifier-of-at-least-forty-three-characters-0123456789'

async function challenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))

  return btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** An authorization as the application sends the browser to it, with a PKCE challenge. */
async function authorization(): Promise<URL> {
  const url = new URL('https://id.acme.test/oauth/authorize')
  url.searchParams.set('client_id', 'app')
  url.searchParams.set('redirect_uri', 'http://localhost/api/auth/callback/acme')
  url.searchParams.set('state', 'state-1')
  url.searchParams.set('code_challenge', await challenge(VERIFIER))
  url.searchParams.set('code_challenge_method', 'S256')

  return url
}

/** The code the provider sent the browser back with. */
const codeOf = (callback: string) => new URL(callback, 'http://localhost').searchParams.get('code') ?? ''

const exchange = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch('https://id.acme.test/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields),
  })

const grant = (code: string, overrides: Record<string, string> = {}) => ({
  grant_type: 'authorization_code',
  code,
  redirect_uri: 'http://localhost/api/auth/callback/acme',
  code_verifier: VERIFIER,
  client_id: 'app',
  client_secret: 'app-secret',
  ...overrides,
})

beforeEach(() => provider.install())
afterEach(() => provider.restore())

describe('testOAuthProvider', () => {
  test("the provider sends the browser back to the authorization's redirect, with a code and its state", async () => {
    const callback = new URL(provider.callback(await authorization(), ADA), 'http://localhost')

    expect(callback.pathname).toBe('/api/auth/callback/acme')
    expect(callback.searchParams.get('state')).toBe('state-1')
    expect(callback.searchParams.get('code')).not.toBe('')
  })

  test('a code is exchanged once, for an access token that reads the person', async () => {
    const code = codeOf(provider.callback(await authorization(), ADA))
    const token = await (await exchange(grant(code))).json()
    const person = await fetch('https://id.acme.test/oauth/userinfo', { headers: { Authorization: `Bearer ${token.access_token}` } })

    expect(provider.accessTokens.has(token.access_token)).toBe(true)
    expect(await person.json()).toEqual({ id: 'acme-ada', sub: 'acme-ada', email: 'ada@acme.test', email_verified: false, name: 'Ada', picture: null })
    expect(await (await exchange(grant(code))).json()).toEqual({ error: 'invalid_grant' })
  })

  test('an exchange refuses a verifier that does not answer the challenge, and the code with it', async () => {
    const code = codeOf(provider.callback(await authorization(), ADA))

    expect((await exchange(grant(code, { code_verifier: `${VERIFIER}-wrong` }))).status).toBe(400)
    expect((await exchange(grant(code))).status).toBe(400)
  })

  test("an exchange refuses a redirect other than the authorization's", async () => {
    const code = codeOf(provider.callback(await authorization(), ADA))

    expect(await (await exchange(grant(code, { redirect_uri: 'https://evil.example/callback' }))).json()).toEqual({ error: 'invalid_grant' })
  })

  test('an exchange refuses another client, whether it names itself in the body or as Basic authentication', async () => {
    const code = codeOf(provider.callback(await authorization(), ADA))
    const { client_id: _id, client_secret: _secret, ...withoutClient } = grant(code)

    expect((await exchange(grant(code, { client_secret: 'guessed' }))).status).toBe(401)
    expect((await exchange(withoutClient, { Authorization: `Basic ${btoa('app:guessed')}` })).status).toBe(401)
    expect((await exchange(withoutClient, { Authorization: `Basic ${btoa('app:app-secret')}` })).status).toBe(200)
  })

  test('the user info refuses a token the provider did not issue', async () => {
    const res = await fetch('https://id.acme.test/oauth/userinfo', { headers: { Authorization: 'Bearer made-up' } })

    expect(res.status).toBe(401)
  })

  test("a response that does not send the browser to the provider is named in the failure", () => {
    expect(() => provider.authorization(new Response(null, { status: 303, headers: { Location: '/login' } })))
      .toThrow('Expected the response to send the browser to https://id.acme.test/oauth/authorize, but it answered 303 with a Location of /login.')
  })

  test('requests to other sites pass to the fetch installed before, and restoring puts it back', async () => {
    const before = globalThis.fetch
    const inner = testOAuthProvider({
      authorizationUrl: 'https://other.test/authorize',
      tokenUrl: 'https://other.test/token',
      userInfoUrl: 'https://other.test/userinfo',
    })

    inner.install()
    // The outer provider, installed before, still answers its own endpoints.
    const passed = await fetch('https://id.acme.test/oauth/userinfo', { headers: { Authorization: 'Bearer made-up' } })
    inner.restore()

    expect(passed.status).toBe(401)
    expect(globalThis.fetch).toBe(before)
  })
})
