/**
 * A stand-in for an OAuth 2.0 provider in tests, as `@popcomputer/web/testing`
 * exports it: it answers the application's `fetch` requests to the provider's
 * token and user info endpoints as a real provider would, refusing what a real
 * one refuses, so a test signs a person in through the application's own
 * sign-in and Better Auth's callback.
 */

import type { TestBrowser } from './testing.js'

/** A person signing in at the provider. */
export interface TestOAuthPerson {
  /** Their stable id at the provider, which the user info answers as `id` and `sub`. */
  readonly id: string
  readonly email: string
  readonly name: string
  /** Whether the provider says it verified the email. Default true. */
  readonly emailVerified?: boolean
  readonly image?: string
}

export interface TestOAuthProviderOptions {
  /** The provider's authorization page, which the application sends the browser to. */
  readonly authorizationUrl: string
  /** Its token endpoint, which exchanges a code for an access token. */
  readonly tokenUrl: string
  /** Its user info endpoint, which answers an access token with the person. */
  readonly userInfoUrl: string
  /**
   * The client the application is registered as. When given, the provider
   * refuses an authorization or a token request from any other client, with
   * credentials in the body or as Basic authentication.
   */
  readonly client?: { readonly id: string; readonly secret?: string }
  /**
   * The user info the provider answers for a person. Defaults to
   * `{ id, sub, email, email_verified, name, picture }`, which Better Auth's
   * `genericOAuth` reads.
   */
  readonly profile?: (person: TestOAuthPerson) => Readonly<Record<string, unknown>>
}

/** A stand-in OAuth provider. */
export interface TestOAuthProvider {
  /**
   * Answer `fetch` requests to the provider's endpoints from now on, passing
   * every other request to the `fetch` installed before. Restore it with
   * `restore()`, or let `using` dispose of the result.
   *
   * @example
   * beforeEach(() => acme.install())
   * afterEach(() => acme.restore())
   */
  install(): Disposable
  /** Put back the `fetch` installed before `install()`. */
  restore(): void
  /**
   * Sign `person` in through the application: post to `path`, the
   * application's route that starts the sign-in, and return the answer to the
   * provider sending the browser back to the callback with a code, as the
   * provider would once the person has signed in there.
   */
  signIn(browser: TestBrowser, path: string, person: TestOAuthPerson, init?: RequestInit): Promise<Response>
  /**
   * The provider's authorization URL a response sends the browser to, from
   * `X-Inertia-Location` or `Location`. Fails, naming what the response was,
   * when it does not send the browser to the provider.
   */
  authorization(response: Response): URL
  /**
   * The application's callback, as a path with its query, that the provider
   * sends the browser back to once `person` signs in for `authorization`: its
   * `redirect_uri` with a new code and the authorization's `state`.
   */
  callback(authorization: URL, person: TestOAuthPerson): string
  /** The access tokens the provider issued, to check that no page shows one. */
  readonly accessTokens: ReadonlySet<string>
  /** The requests the application sent the provider, in order. */
  readonly requests: ReadonlyArray<{ readonly method: string; readonly url: string }>
}

/** A code the provider issued, and what its exchange must match. */
interface Grant {
  readonly person: TestOAuthPerson
  readonly redirectUri: string
  readonly challenge: string | null
  readonly challengeMethod: string
}

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const base64Url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

/** Whether `verifier` answers the authorization's PKCE challenge. */
async function verifies(grant: Grant, verifier: string | null): Promise<boolean> {
  if (grant.challenge === null) return true
  if (verifier === null) return false
  if (grant.challengeMethod === 'plain') return verifier === grant.challenge

  return base64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))) === grant.challenge
}

/** The client a token request names: Basic authentication, or the body's `client_id` and `client_secret`. */
function clientOf(request: Request, form: URLSearchParams): { readonly id: string | null; readonly secret: string | null } {
  const basic = request.headers.get('Authorization')

  if (basic?.startsWith('Basic ')) {
    const [id = '', secret = ''] = atob(basic.slice(6)).split(':').map(decodeURIComponent)

    return { id, secret }
  }

  return { id: form.get('client_id'), secret: form.get('client_secret') }
}

const sameEndpoint = (url: URL, endpoint: URL) => url.origin === endpoint.origin && url.pathname === endpoint.pathname

/**
 * Stand in for an OAuth 2.0 provider using the authorization code flow, such
 * as a company's own one configured in Better Auth's `genericOAuth`.
 *
 * @example
 * const acme = testOAuthProvider({
 *   authorizationUrl: 'https://id.acme.test/oauth/authorize',
 *   tokenUrl: 'https://id.acme.test/oauth/token',
 *   userInfoUrl: 'https://id.acme.test/oauth/userinfo',
 * })
 *
 * test('signing in', async () => {
 *   using _ = acme.install()
 *   const browser = testBrowser(app, env)
 *   const res = await acme.signIn(browser, '/auth/acme', { id: 'ada', email: 'ada@acme.test', name: 'Ada' })
 *   expect(res.headers.get('Location')).toBe('/studios')
 * })
 */
export function testOAuthProvider(options: TestOAuthProviderOptions): TestOAuthProvider {
  const authorizationUrl = new URL(options.authorizationUrl)
  const tokenUrl = new URL(options.tokenUrl)
  const userInfoUrl = new URL(options.userInfoUrl)
  const profile = options.profile ?? ((person: TestOAuthPerson) => ({
    id: person.id,
    sub: person.id,
    email: person.email,
    email_verified: person.emailVerified ?? true,
    name: person.name,
    picture: person.image ?? null,
  }))

  const grants = new Map<string, Grant>()
  const tokens = new Map<string, TestOAuthPerson>()
  const accessTokens = new Set<string>()
  const requests: Array<{ readonly method: string; readonly url: string }> = []
  const installed: Array<typeof fetch> = []

  async function exchange(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text())
    const client = clientOf(request, form)

    if (options.client !== undefined && (client.id !== options.client.id || (options.client.secret !== undefined && client.secret !== options.client.secret))) {
      return answer({ error: 'invalid_client' }, 401)
    }

    if (form.get('grant_type') !== 'authorization_code') return answer({ error: 'unsupported_grant_type' }, 400)

    const code = form.get('code') ?? ''
    const grant = grants.get(code)
    // A code is good for one exchange, whatever its outcome.
    grants.delete(code)

    if (grant === undefined || grant.redirectUri !== form.get('redirect_uri') || !(await verifies(grant, form.get('code_verifier')))) {
      return answer({ error: 'invalid_grant' }, 400)
    }

    const token = `test-oauth-${crypto.randomUUID()}`
    tokens.set(token, grant.person)
    accessTokens.add(token)

    return answer({ access_token: token, token_type: 'Bearer', expires_in: 3600 })
  }

  function userInfo(request: Request): Response {
    const person = tokens.get(request.headers.get('Authorization')?.replace(/^Bearer /i, '') ?? '')

    return person === undefined ? answer({ error: 'invalid_token' }, 401) : answer(profile(person))
  }

  /** The provider's answer to a request for one of its endpoints, or none for any other. */
  function respond(request: Request): Promise<Response> | undefined {
    const url = new URL(request.url)

    if (request.method === 'POST' && sameEndpoint(url, tokenUrl)) return exchange(request)
    if (request.method === 'GET' && sameEndpoint(url, userInfoUrl)) return Promise.resolve(userInfo(request))
    if (url.origin === tokenUrl.origin || url.origin === userInfoUrl.origin) return Promise.resolve(answer({ error: 'not_found' }, 404))

    return undefined
  }

  const provider: TestOAuthProvider = {
    accessTokens,
    requests,
    install() {
      const previous = globalThis.fetch
      const standIn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = new Request(input, init)
        const answered = respond(request)

        if (answered === undefined) return previous(input, init)

        requests.push({ method: request.method, url: request.url })

        return answered
      }

      installed.push(previous)
      // Bun's fetch carries `preconnect`, which the stand-in passes on.
      globalThis.fetch = Object.assign(standIn, { preconnect: previous.preconnect })

      return { [Symbol.dispose]: () => provider.restore() }
    },
    restore() {
      const previous = installed.pop()

      if (previous !== undefined) globalThis.fetch = previous
    },
    authorization(response) {
      const location = response.headers.get('X-Inertia-Location') ?? response.headers.get('Location')
      const url = location === null ? undefined : new URL(location, 'http://localhost')

      if (url === undefined || !sameEndpoint(url, authorizationUrl)) {
        throw new Error(
          `Expected the response to send the browser to ${authorizationUrl.href}, but it answered ${response.status}` +
            (location === null ? ' without a Location.' : ` with a Location of ${location}.`)
        )
      }

      if (options.client !== undefined && url.searchParams.get('client_id') !== options.client.id) {
        throw new Error(`The authorization names the client ${url.searchParams.get('client_id')}, not ${options.client.id}.`)
      }

      return url
    },
    callback(authorization, person) {
      const redirectUri = authorization.searchParams.get('redirect_uri')

      if (redirectUri === null) throw new Error(`The authorization ${authorization.href} has no redirect_uri.`)

      const code = `test-code-${crypto.randomUUID()}`
      grants.set(code, {
        person,
        redirectUri,
        challenge: authorization.searchParams.get('code_challenge'),
        challengeMethod: authorization.searchParams.get('code_challenge_method') ?? 'plain',
      })

      const back = new URL(redirectUri)
      back.searchParams.set('code', code)
      back.searchParams.set('state', authorization.searchParams.get('state') ?? '')

      return `${back.pathname}${back.search}`
    },
    async signIn(browser, path, person, init = {}) {
      const started = await browser.request(path, { method: 'POST', ...init })

      return browser.request(provider.callback(provider.authorization(started), person))
    },
  }

  return provider
}
