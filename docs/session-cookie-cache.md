# The session cookie cache

Better Auth's `session.cookieCache` keeps a copy of the session in a cookie, so a
request can skip the session store. A copy cannot see a session that has ended since,
so the framework asks the store anyway, and a sign-out, a ban or a password reset takes
effect at once. What the cache saves is then only Better Auth's own reads.

To keep the read it saves, and accept that a session ended elsewhere still reads as
signed in for up to its `maxAge`, give `setupWeb` `auth.sessionCookieCache: 'trusted'`.

A session with no store behind it, on a stateless Better Auth, lives only in the
cookie, which is then the authority, so this changes nothing there.
