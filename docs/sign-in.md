# Signing in and out

Sign-in, sign-up and sign-out are ordinary routes on the `routes` setupWeb
returns. `routes.provide(layer)` guards every route registered through it:
`RequireGuestLayer` sends a signed-in member home, and `RequireAuthLayer`
sends a signed-out visitor to `auth.signInPath` (default `/login`), as
`authorize()` does. A sign-in action validates its form like any action, then
calls a Better Auth endpoint, by its name on `auth.api`, through
`betterAuthRedirect`, which answers with a redirect carrying the session
cookie:

```ts
// src/actions/auth.ts
import { Effect } from 'effect'
import { action, intendedUrl, validateRequest } from '@popcomputer/web/effect'
import { betterAuthRedirect } from '@popcomputer/web/auth'
import { SignIn } from '../forms'
import { paths } from '../paths'

export const signIn = action(
  Effect.gen(function* () {
    const input = yield* validateRequest(SignIn)
    const redirectTo = yield* intendedUrl(paths.projects)

    return yield* betterAuthRedirect('signInEmail', { body: input }, {
      redirectTo,
      errors: (error) => ({ email: error.message }),
    })
  })
)
```

The call goes through Better Auth's request handler, as its own client's
calls do, so its rate limits, origin checks and plugins' hooks apply to the
form as they do to its routes; a call to `auth.api` from server code skips
them, which leaves a sign-in form open to password guessing. Better Auth's
types name the endpoints, including those its plugins add, and type each
one's body and result, so a misspelled endpoint or a missing password is a
type error. A sign-in refused for its rate limit fails with
`AuthRateLimitError`, which the error page answers with a 429; show it on the
form instead with
`Effect.catchTag('AuthRateLimitError', () => invalid({ email: 'Too many attempts. Try again in a minute.' }))`.
Validate a sign-in's password with `currentPassword`, which keeps it as typed:
`requiredString` trims, so a password chosen with outer spaces would never
sign in. `password({ min: 12 })` checks one a visitor chooses, on signing up.
`RequireGuestLayer` sends a signed-in visitor from a guest page to
`setupWeb`'s `auth.homePath`, `/` by default.
In tests, each `testBrowser` is a client at its own address, so the limits
count each browser apart.

```ts
// src/auth-routes.ts
import { action, render, RequireAuthLayer, RequireGuestLayer } from '@popcomputer/web/effect'
import { betterAuthLogoutAction } from '@popcomputer/web/auth'
import { routes } from './app'
import { signIn } from './actions/auth'
import { showDashboard } from './actions/dashboard'
import { paths } from './paths'

routes
  .provide(RequireGuestLayer)
  .get(paths.login, action(render('Auth/Login')))
  .post(paths.login, signIn)

routes.provide(RequireAuthLayer).get(paths.dashboard, showDashboard)

routes.post(paths.logout, betterAuthLogoutAction({ redirectTo: paths.login }))
```

A signed-out visit to a guarded page goes to the sign-in path with the page as
`?redirect=`, and `intendedUrl(fallback)` returns there after signing in; it
returns only paths on this site. A rejection, such as a wrong password or an
address not yet proven, goes back to the form with the field errors `errors` returns; rate limits and Better Auth
failures stay separate typed errors. Sign-up works the same way with
`'signUpEmail'`, after whatever else the action does with the input, and
signs nobody in until the emailed link proves the address, as
[Proving an address](auth.md#proving-an-address) shows.

Signing out expires the session cookie, and the page `betterAuthLogoutAction`
redirects to clears Inertia's history: the signed-in pages, which Inertia kept
there encrypted, cannot be shown again with Back by the next person at the
browser ([Pages and props](pages.md)). Any answer that ends the session does
the same for the next page: Better Auth's client signing out through
`betterAuthHandler`, or a session lookup that finds the session revoked. A
session cookie renamed in Better Auth, rather than given a `cookiePrefix`, is
named in `setupWeb`'s `auth.sessionCookie` too, so its expiry is recognized.

Better Auth writes the new user itself, so the application's own record of
a member, such as a profile, is a second write. Make it on the member's first
visit, in a guard layer on the routes that need it: a user Better Auth
created from an OAuth provider or a magic link never passes through the
application's sign-up action, and a failure between the two writes leaves
nothing the next visit cannot repair:

```ts
// src/profiles.ts
import { eq } from 'drizzle-orm'
import { Effect, Layer } from 'effect'
import { authorize, dbMutation, dbQuery } from '@popcomputer/web/effect'
import { profiles } from './schema'

// The application's own record of each member, however they signed up.
export const EnsureProfile = Layer.effectDiscard(Effect.gen(function* () {
  const auth = yield* authorize()
  const [existing] = yield* dbQuery((db) => db.select().from(profiles).where(eq(profiles.userId, auth.user.id)).limit(1))

  if (existing === undefined) {
    yield* dbMutation((db) =>
      db.insert(profiles).values({ userId: auth.user.id, displayName: auth.user.name }).onConflictDoNothing()
    )
  }
}))
```

Provide it beside the guard:
`routes.provide(RequireAuthLayer).provide(EnsureProfile).get(paths.dashboard, showDashboard)`.

Fields the server sets rather than the form, such as a role or a team, are
`input: false` in `betterAuthFields`, so a sign-up cannot send them: keep
them in the application's own table, such as a membership, which a guard
layer reads. `redirectTo` given a function receives the endpoint's result,
sign-in's `{ token, user }`, so it reads the user's id as
`result.user.id`; sign-up's names a made-up user when the address is already
registered, so key nothing on it. A result is the JSON Better Auth's handler answered, and
typed so: its dates are ISO strings.

A Better Auth call whose result the action uses, such as enabling two-factor
(which returns the secret) or checking a password, goes through
`betterAuthCall('enableTwoFactor', { body }, { errors })` from
`@popcomputer/web/auth`, which sends it as `betterAuthRedirect` does, maps its
failures the same way and returns the result. A link
Better Auth emails, such as a reset link, points at its own `/api/auth/*`
endpoint; build the application's own link from the token with `href`, so it
lands on a page of the application. A failure Better Auth answers with a
redirect, such as a used magic link's `?error=INVALID_TOKEN`, fails as a
rejection does, with `error.code` naming it; any other redirect Better Auth
answers reaches the action as `AuthRedirect`, which the error page follows.
Better Auth keeps its own time: its token and session expiry follow the wall
clock, not `testClock`, so a test of them starts the test clock at the
present and the application's own rules read Effect's `Clock`. `signedIn`
signs a request in without a Better Auth session, so a Better Auth endpoint
that needs one, such as deleting the account, is tested after a real sign-in
through `testBrowser`.

A signed-out visitor to a guarded page is redirected with 302 on a page load
and 303 on an Inertia visit, as Inertia requires; a test asserts the
`Location`, `/login?redirect=...`, rather than the status. A form posted
while signed out, as after a session expires, cannot be replayed, so
`?redirect=` names the page the form was on, and a JSON client gets a 401.

`betterAuthHandler()` forwards a request to Better Auth's own API. Register
it on the paths the application needs Better Auth to answer itself, and no
others: an OAuth provider's callback,
`routes.get(paths.authCallback, betterAuthHandler())` with
`authCallback: '/api/auth/callback/{provider}'`, as
[Signing in with an OAuth provider](auth-plugins.md#signing-in-with-an-oauth-provider) shows.
Browser code that calls Better Auth directly (its client SDK) needs all of it,
`routes.all(paths.authApi, betterAuthHandler())` with
`authApi: '/api/auth/*'`, which exposes every endpoint Better Auth and its
plugins define past the application's guards: the organization plugin's
role changes and deletions, and sign-up, update-user and the email-OTP
sign-in and phone-number verify that make a user on first use, which write
the user fields declared `input: true` without the application's actions
checking them. Once the registered Better Auth declares such a field, TypeScript asks
for the ones visitors may set there, `betterAuthHandler({ settable: ['timeZone'] })`,
and the handler refuses a request setting any other with a 400; `settable: []`
keeps every field to the application's own forms. It reads a body within
setupWeb's `bodyLimit`, as `validateRequest` does, and answers a larger one
with a 413 before Better Auth reads it.

## The sign-in page

```tsx
// src/pages/Auth/Login.tsx
import { useForm } from '@inertiajs/react'
import type { FormEvent } from 'react'
import type { FormInput, WebPage } from '@popcomputer/web/react'
import type { SignIn } from '../../forms'
import { paths } from '../../paths'

const Login: WebPage<'Auth/Login'> = () => {
  const form = useForm<FormInput<typeof SignIn>>({ email: '', password: '' })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    form.post(paths.login, { onFinish: () => form.reset('password') })
  }

  return (
    <form onSubmit={submit}>
      <label>
        Email
        <input type="email" value={form.data.email} onChange={(event) => form.setData('email', event.target.value)} />
      </label>
      {form.errors.email && <p role="alert">{form.errors.email}</p>}

      <label>
        Password
        <input type="password" value={form.data.password} onChange={(event) => form.setData('password', event.target.value)} />
      </label>

      <button type="submit" disabled={form.processing}>Sign in</button>
    </form>
  )
}

export default Login
```
