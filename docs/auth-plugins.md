# Better Auth's plugins

Better Auth's plugins (organizations and teams, two-factor, magic links,
OAuth providers, passkeys, admin) stay Better Auth's: add them to
`betterAuth({ plugins })` and their tables to the schema, and call their
endpoints by name, as `betterAuthRedirect` and `betterAuthCall` call any
other, typed from the registered client. Where they meet the application:

- A plugin's session fields, such as the organization plugin's
  `activeOrganizationId` or the admin plugin's `impersonatedBy`, reach
  `authorize()` once `betterAuthSession` is given the `session` table.
- Two-factor: signing in a member with two-factor on answers
  `{ twoFactorRedirect: true }` rather than a session, so the sign-in's
  `redirectTo` is `(result) => 'twoFactorRedirect' in result ? paths.twoFactor : paths.dashboard`,
  and the code form's action calls `betterAuthRedirect('verifyTOTP', { body: input }, { redirectTo, errors })`.
- An OAuth provider, a company's own or GitHub's: see
  [Signing in with an OAuth provider](#signing-in-with-an-oauth-provider).
- A magic link, or another link Better Auth emails: the action verifying its
  token, `betterAuthRedirect('magicLinkVerify', { query: input }, { redirectTo })`,
  fails as a rejection does once the link is used or expired, so it shows a
  page instead: `.pipe(Effect.catchTag('ValidationError', () => render('Auth/LinkExpired')))`.
- Organizations: the plugin's `member` table is the membership a guard reads,
  as [Roles belong to memberships](guards.md#roles-belong-to-memberships-read-by-a-guard)
  shows, with the organization bound by its route:
  `bindings: { organization: schema.organization }`. Check a role in the
  guard or the action before calling the plugin's endpoint, so a member
  without it gets a 403: the plugin's own refusal fails as a rejection does,
  sending the form back with its message.
- Writes that must happen together: Better Auth writes each row in its own
  statement, which on D1 is never a transaction. The organization plugin's
  `createOrganization` checks the slug is free, writes the organization, then
  its owner's membership, so a failure between leaves an organization nobody
  owns, and two requests for one slug end in a 500. On D1, write an
  organization and its owner in one `dbBatch` of your own, into the plugin's
  tables, and turn the plugin's off with `allowUserToCreateOrganization:
  false`. Give the tables the constraints its checks stand in for (a unique
  slug, one membership per person and organization, one pending invitation
  per address), so a second, simultaneous request fails rather than writes a
  duplicate.

The package's own tests drive each of these through an application on every
Better Auth release it supports.

## Signing in with an OAuth provider

A provider Better Auth knows, such as GitHub or Google, goes in
`betterAuth({ socialProviders })`; any other OAuth 2.0 or OpenID Connect
provider, such as a company's own, goes in the `genericOAuth` plugin. Either
way, signing in is Better Auth's `signInSocial` with the provider's id, and
the provider sends the browser back to Better Auth's callback,
`/api/auth/callback/{provider}`:

```ts
// src/acme-auth.ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { genericOAuth } from 'better-auth/plugins'
import type { Database } from './db'
import * as schema from './schema'

export interface CreateAcmeAuthOptions {
  readonly db: Database
  readonly secret: string
  readonly baseURL: string
  readonly clientId: string
  readonly clientSecret: string
}

export function createAcmeAuth(options: CreateAcmeAuthOptions) {
  return betterAuth({
    database: drizzleAdapter(options.db, { provider: 'pg', schema }),
    secret: options.secret,
    baseURL: options.baseURL,
    plugins: [
      genericOAuth({
        config: [{
          providerId: 'acme',
          clientId: options.clientId,
          clientSecret: options.clientSecret,
          authorizationUrl: 'https://id.acme.example/oauth/authorize',
          tokenUrl: 'https://id.acme.example/oauth/token',
          userInfoUrl: 'https://id.acme.example/oauth/userinfo',
          pkce: true,
        }],
      }),
    ],
    // A person is their account at the provider, not an email address: an
    // account there reporting someone's email is refused, not given theirs.
    account: { accountLinking: { disableImplicitLinking: true } },
    // A refused sign-in lands on the application's page, with `?error=`.
    onAPIError: { errorURL: '/login' },
    // Better Auth allows three sign-ins from one address in ten seconds, and
    // an office signs in through one address.
    rateLimit: { enabled: true, storage: 'memory', customRules: { '/sign-in/social': { window: 60, max: 30 } } },
  })
}
```

A sign-in button posts to an action that starts the sign-in. The provider is
another site, so the answer to an Inertia visit is the 409 and
`X-Inertia-Location` Inertia asks for, and it loads the provider as a full
page:

```ts
// src/actions/acme.ts
import { action } from '@popcomputer/web/effect'
import { betterAuthRedirect } from '@popcomputer/web/auth'
import { paths } from '../paths'

export const signInWithAcme = action(
  betterAuthRedirect('signInSocial', {
    body: { provider: 'acme', callbackURL: paths.projects, errorCallbackURL: paths.login },
  }, { redirectTo: (result) => result.url ?? paths.login })
)
```

Register it for guests, and Better Auth's handler on the callback alone, so
no other endpoint of Better Auth's is reachable past the application's
guards:

```ts
import { RequireGuestLayer } from '@popcomputer/web/effect'
import { betterAuthHandler } from '@popcomputer/web/auth'
import { signInWithAcme } from '../actions/acme'

routes.provide(RequireGuestLayer).post(paths.loginWithAcme, signInWithAcme)
routes.get(paths.authCallback, betterAuthHandler())
```

Better Auth checks the callback's `state` against a cookie it set in the
browser that started the sign-in, so a sign-in finished in another browser
is refused. `auth.signInLimits` does not count sign-ins through a provider
against the client's address: they check no password here.

A refused sign-in lands on `errorURL` with Better Auth's code as `?error=`,
which the sign-in page turns into words: `state_mismatch` (finished in
another browser, or too late), `account_not_linked` (an account here already
has that email), `unable_to_get_user_info`, and any code the application's
own hooks throw. Decide what an email the provider has not verified may do:
with implicit linking off, an account created from one holds that address
against its real owner. To refuse one, throw from
`databaseHooks.user.create.before`, as
`throw new APIError('FORBIDDEN', { message: 'Your email is not verified.', code: 'email_not_verified' })`
with `APIError` from `better-auth/api`; returning `false` fails the sign-in
without a code. A person's name and email are the provider's at their first
sign-in and stay so unless the provider's config sets `overrideUserInfo:
true`, which fails a later sign-in whose email another account here holds.

A test stands in for the provider with `testOAuthProvider` from
`@popcomputer/web/testing`, which answers the application's `fetch` requests
to the provider's token and user info endpoints as the provider would,
refusing what it would refuse: a code exchanged twice, or without the
client's secret or the PKCE verifier its authorization named. `signIn` starts
the sign-in through the application's route and returns the callback's
answer, as the provider sends the browser back once the person has signed in
there:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { testBrowser, testEnv, testOAuthProvider } from '@popcomputer/web/testing'

const acme = testOAuthProvider({
  authorizationUrl: 'https://id.acme.example/oauth/authorize',
  tokenUrl: 'https://id.acme.example/oauth/token',
  userInfoUrl: 'https://id.acme.example/oauth/userinfo',
  client: { id: 'test-client', secret: 'test-secret' },
})

beforeEach(() => acme.install())
afterEach(() => acme.restore())

test('a person signs in with their Acme account', async () => {
  const browser = testBrowser(app, testEnv(testBindings, { database: testDb }))
  const res = await acme.signIn(browser, paths.loginWithAcme, { id: 'acme-1', email: 'ada@example.com', name: 'Ada' })

  expect(res.headers.get('Location')).toBe(paths.projects)
})
```

`authorization(response)` and `callback(authorization, person)` take the
same steps one at a time, for a test of a sign-in finished in another
browser, and `accessTokens` holds the tokens it issued, for a test that no
page shows one. A person's `emailVerified: false` tests what an unverified
email at the provider can reach.
