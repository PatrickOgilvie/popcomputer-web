# Auth

The Better Auth helpers cover session loading, authenticated and guest routes,
form actions, logout, and public user projection.

`authorize()` requires a signed-in user and returns the parsed `{ user,
session }`. Given a predicate, it also requires the route's own rule:

```ts
const auth = yield* authorize()
const verified = yield* authorize(({ user }) => user.emailVerified)
```

Without a signed-in user, both fail with `UnauthorizedError`; when the
predicate returns `false`, the second fails with `ForbiddenError`.

`auth.session` decodes Better Auth's session response into the signed-in
user, so a dependency response is never trusted because it looks
session-shaped. `betterAuthSession(tableSchema(schema.user))` takes the user
from the `user` table, so a field the application adds, such as a `role`, is
declared in the table, and `authorize()`, `currentUser` and `signedIn`
follow. A plugin
that adds session fields, such as the organization plugin's
`activeOrganizationId`, adds their columns to the `session` table: give
`betterAuthSession` that table too,
`betterAuthSession(tableSchema(schema.user), tableSchema(schema.session))`,
and `authorize()` returns them. Better Auth learns of the field from the same table:
`user: { additionalFields: betterAuthFields(schema.user, { role: { input: false } }) }`
in `createAuth` takes each field's type, enum values and whether it is
required from its column, and `input` says whether a visitor may set it at
sign-up. Give a narrowed column an enum, so the session checks its values, and
take it from the Effect schema the application validates input with, so the
role is declared once: `text('role', { enum: Role.literals })` for
`const Role = S.Literals(['admin', 'member'])`. The session token is `Redacted`, so
serializing the auth user never exposes it; read it with `Redacted.value`
where it is needed. `auth.share` names the fields pages receive as
`auth.user`.

Machine clients, such as a door scanner calling a JSON API, authenticate with
Better Auth's `bearer()` plugin: a request with `Authorization: Bearer
<token>` loads its user as a session cookie does, with no setup of the
framework's own.

## Better Auth's client

`setupWeb`'s `auth.client` builds Better Auth, on [its tables](auth-tables.md),
from a small factory beside `src/db.ts`, which the [Quick start](setup.md#3-configure-the-application-once-and-register-it) shows:

```ts
// src/auth.ts
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import type { Database } from './db'
import { paths } from './paths'
import * as schema from './schema'

export interface CreateAuthOptions {
  readonly db: Database
  readonly secret: string
  /** The origin emailed links name: a declared var, never the request's URL. */
  readonly baseURL: string
  /** Delivers an email through the application's mail provider. */
  readonly sendEmail: (email: { readonly to: string; readonly subject: string; readonly text: string }) => Promise<void>
  readonly advanced?: BetterAuthOptions['advanced']
}

// Better Auth's tables (user, session, account, verification, rateLimit)
// belong in ./schema, as auth-tables.md shows.
export function createAuth(options: CreateAuthOptions) {
  return betterAuth({
    database: drizzleAdapter(options.db, { provider: 'pg', schema }),
    secret: options.secret,
    baseURL: options.baseURL,
    // A password signs in only once its address is proven, so an account
    // registered with someone else's address holds no session, password or
    // two-factor challenge when its owner signs in by a link or a provider.
    emailAndPassword: { enabled: true, requireEmailVerification: true },
    // The link proves the address and signs nobody in: the member signs in next.
    emailVerification: {
      sendVerificationEmail: ({ user, token }) => options.sendEmail({
        to: user.email,
        subject: 'Confirm your email address',
        text: `Confirm your email address to finish signing up:\n${options.baseURL}${paths.verifyEmail}?${new URLSearchParams({ token })}\n\n` +
          'If you did not sign up, ignore this email and do not follow the link: ' +
          'whoever signed up with your address chose its password, and confirming it would let them sign in as you.',
      }),
    },
    // setupWeb's auth.signInLimits limits signing in, up and every password
    // call by address and account. Better Auth's own limits stay on too, in
    // each isolate's memory (its 'database' storage deletes the accounts'
    // counts, so auth.signInLimits refuses it): three sign-ins or sign-ups
    // from one address in ten seconds, and its other endpoints. They are on
    // by default only when NODE_ENV is 'production', which a Worker's is not.
    rateLimit: { enabled: true, storage: 'memory' },
    advanced: {
      ...options.advanced,
      // Cloudflare's header, which a client cannot write; X-Forwarded-For it can.
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'], ...options.advanced?.ipAddress },
    },
  })
}

export interface CreateStatelessAuthOptions {
  readonly secret: string
  readonly advanced?: BetterAuthOptions['advanced']
}

// Better Auth without a database, for an application without accounts of its own.
export function createStatelessAuth(options: CreateStatelessAuthOptions) {
  return betterAuth({ secret: options.secret, advanced: options.advanced })
}
```

The `backgroundTasks` object has Better Auth's
`advanced.backgroundTasks` shape. Passing it through makes session refreshes,
email callbacks, and plugin work part of the request lifecycle: Workers use
`waitUntil`, while local and test runtimes finish the work before teardown.

Actions call Better Auth with `betterAuthRedirect` and `betterAuthCall`, as
[Signing in and out](sign-in.md) shows: they name the endpoint and
send the call through Better Auth's request handler, so its rate limits,
origin checks and plugins' hooks apply. An action reads the signed-in user
with `authorize()` or `currentUser`, never with a `getSession` call. Code
outside an action, such as a Durable Object reading the session from the
headers a request handed it, calls Better Auth's own `auth.api`, as Better
Auth documents. A refusal it throws is Better Auth's `APIError`, which code
can recognise without importing it: its `name` is `'APIError'`, its
`statusCode` the HTTP status and its `body.code` the reason, such as
`INVALID_EMAIL_OR_PASSWORD`.

## Proving an address

`createAuth` signs no one in by a password whose address nobody has proven.
Signing up sets no session: Better Auth emails the link `sendEmail` delivers,
to `paths.verifyEmail`, and the sign-up action redirects to a page asking the
visitor to check their inbox; a password sign-in before then is refused as
`Email not verified`. A sign-up for a registered address is answered as a new
one is, and sends nothing, so the form tells no one who has an account. The
mailer is the application's own: `src/email.ts` exports `sendEmail(env, { to,
subject, text })`, which calls its mail provider's API. The link opens a page
whose button posts its token back, so a mail scanner that fetches the link
proves nothing. The post proves the address and signs nobody in; the member
signs in with a password next:

```ts
// src/actions/verify-email.ts
import { Effect, Schema as S } from 'effect'
import { action, redirect, render, validateRequest } from '@popcomputer/web/effect'
import { betterAuthRedirect } from '@popcomputer/web/auth'
import { href } from '@popcomputer/web/paths'
import { requiredString } from '@popcomputer/web/schema'
import { paths } from '../paths'

const Link = S.Struct({ token: requiredString })
const expired = () => redirect(href(paths.login, {}, { error: 'link_expired' }))

export const showVerifyEmail = action(
  Effect.gen(function* () {
    const input = yield* validateRequest(Link)

    return yield* render('Auth/VerifyEmail', input)
  }).pipe(Effect.catchTag('ValidationError', expired))
)

export const verifyEmail = action(
  Effect.gen(function* () {
    const input = yield* validateRequest(Link)

    return yield* betterAuthRedirect('verifyEmail', { query: input }, { redirectTo: paths.login })
  }).pipe(Effect.catchTag('ValidationError', expired))
)
```

Register both for everyone, `routes.get(paths.verifyEmail, showVerifyEmail)`
and `.post(paths.verifyEmail, verifyEmail)`, beside the page
`'Auth/VerifyEmail': S.Struct({ token: S.String })`; a link that expired,
after an hour, lands on the sign-in page with `?error=`. Email this page's
link, not Better Auth's own `url`, which proves the address on any fetch. A
link Better Auth's `user.changeEmail` sends to a new address completes only
signed in to the account that asked to move there: Better Auth would sign
anyone else who follows it in to that account, so the framework sends them
to sign in.

Without `requireEmailVerification`, someone who registers another person's
address first is signed in, and keeps what the owner's magic-link or provider
sign-in does not revoke: a two-factor challenge or a password sign-in under
way. Leave `autoSignInAfterVerification` off, or an owner who follows a link
for an account someone else registered is signed in to it.

One risk remains, and the email warns of it: an owner who follows the link
for an account they never created proves the address for whoever chose its
password, which then signs in, and a later magic-link sign-in revokes
nothing. A password reset takes the account back: an application that adds
one sets `emailAndPassword.revokeSessionsOnPasswordReset: true`, so a reset
also ends the sessions the old password began.

## Limiting password guessing

Better Auth's own limits count each client address, so guesses at one
account's password spread across a botnet's addresses are never slowed, and
each one costs a password hash. `setupWeb`'s `auth.signInLimits` limits both,
cheapest first:

- A Cloudflare Workers Rate Limiting binding counts each client address's
  sign-in, sign-up and password calls, and each account's sign-ins, at
  Cloudflare's edge, writing nothing. `limiter` names it, and accepts only the
  bindings `src/env.ts` types `RateLimit`. Declare it in `wrangler.jsonc`; its
  `period` is 10 or 60 seconds:

  ```jsonc
  "ratelimits": [{ "name": "SIGN_IN_LIMITER", "namespace_id": "1001", "simple": { "limit": 5, "period": 60 } }]
  ```

- `table`, Better Auth's `rateLimit` table, counts each account's failed
  sign-ins over `failures.window`, 15 minutes by default. Past
  `failures.max`, 10, the account cools down for `failures.cooldown`, a
  minute, doubled by each further failure up to the window. A sign-in during
  a cooldown is refused before its password is hashed. It is a cooldown, not
  a lock: someone who knows an address can slow its owner down, never shut
  them out. Only a failure writes a row, a successful sign-in deletes it, and
  the row's key is a hash of the account, not its address.

An account is what its sign-in's endpoint finds it by, whatever else the body
sends: the email `/sign-in/email` reads, the phone-number plugin's
`/sign-in/phone-number`, or the username plugin's `/sign-in/username` as its
`usernameNormalization` folds it, so the spellings it folds share one count.
A password sign-in whose field is missing, blank or not text is refused with
a 400 before its password is checked. Each door counts apart: an account that
signs in by email and by username has a budget for each.

`betterAuthRedirect`, `betterAuthCall` and `betterAuthHandler` all apply the
limits. A refused call fails with `AuthRateLimitError`, whose
`retryAfterSeconds` the 429 sends as `Retry-After`. Rows for accounts nobody
tries again stay until a sweep deletes them; run `sweepSignInFailures` from
`@popcomputer/web/auth` from a Cron Trigger:

```ts
import { sweepSignInFailures } from '@popcomputer/web/auth'

export default {
  fetch: app.fetch,
  scheduled: routes.scheduled(() => sweepSignInFailures),
}
```

In tests, give the binding `testRateLimiter({ limit, period })` from
`@popcomputer/web/testing` among the bindings, and read the keys it refused
from its `refused`. It counts by the wall clock, as Cloudflare's does, not by
`testClock`, so a test of cooldowns gives it a limit the test never reaches.
A request whose bindings lack the limiter fails with a message naming it.
