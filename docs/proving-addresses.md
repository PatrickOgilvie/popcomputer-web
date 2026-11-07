# Proving an address

[`createAuth`](auth.md#better-auths-client) signs no one in by a password whose address nobody has proven.
Signing up sets no session: Better Auth emails the link `sendEmail` delivers,
to `paths.verifyEmail`, and the sign-up action redirects to a page asking the
visitor to check their inbox; a password sign-in before then is refused as
`Email not verified`, and sends a new link. A sign-up for a registered address
is answered as a new one is, so the form tells no one who has an account,
and sends a new link only to an address not yet proven. Two sign-ups for one
new address at once are both answered as new, and a sign-up that failed after
Better Auth wrote its user, when its password's account could not be written,
removes that user, so the address can sign up again. The
mailer is the application's own: `src/email.ts` exports `sendEmail(env, { to,
subject, text })`, which calls its mail provider's API. The link opens a page
whose button posts its token back, so a mail scanner that fetches the link
proves nothing. The post proves the address and signs nobody in; the member
signs in with a password next:

```ts
// src/actions/verify-email.ts
import { Effect, Schema as S } from 'effect'
import { action, prefersJson, redirect, render, validateRequest, type ValidationError } from '@popcomputer/web/effect'
import { betterAuthRedirect } from '@popcomputer/web/auth'
import { href } from '@popcomputer/web/paths'
import { requiredString } from '@popcomputer/web/schema'
import { paths } from '../paths'

const Link = S.Struct({ token: requiredString })
const expired = (error: ValidationError) =>
  Effect.flatMap(prefersJson, (json) => (json ? Effect.fail(error) : redirect(href(paths.login, {}, { error: 'link_expired' }))))

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
`'Auth/VerifyEmail': S.Struct({ token: S.String })`; a link that expired, after
an hour, lands on the sign-in page with `?error=`, and a [JSON client](json.md)
gets the 422, never a redirect to sign in. Email this page's link, not Better
Auth's own `url`, which proves the address on any fetch. A link Better Auth's
`user.changeEmail` sends to a new address completes only signed in to the
account that asked: signed out, Better Auth would move that account to the
address of whoever follows it, so the framework sends them to sign in.

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
