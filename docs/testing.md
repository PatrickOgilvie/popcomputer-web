# Testing

## A request through the application

Test routes through the application itself. `app.request` runs the real
middleware, route and action; `testEnv(layer, bindings)` builds the request
env. Services in the layer replace the ones the application gives, whether
in `web.services(...)` or on a route with `routes.provide()`, so a test fakes
a service that reaches another system wherever the application provides it.
The layer is built once a request, so a fake that keeps state keeps one.

`signedIn(user)` signs the request in without a session cookie. A user given
only an `id` is named `Test User`; when the user table has columns of its
own, the whole row is required, so pass the seeded row. Its session id is
`test-session`; pass `{ user, session }` for another.

```ts
// src/routes.test.ts
import { describe, expect, test } from 'bun:test'
import { readPage, signedIn, testEnv } from '@popcomputer/web/testing'
import app from './app'
import './routes'
import { testBindings } from './test-bindings'

describe('GET /projects/{project}', () => {
  test('shows a project to its owner', async () => {
    const res = await app.request(
      '/projects/project-1',
      { headers: { 'X-Inertia': 'true' } },
      testEnv(signedIn({ id: 'user-1' }), testBindings)
    )

    const page = await readPage(res, 'Projects/Show')

    expect(page.props.project.id).toBe('project-1')
  })

  test("answers 404 for another member's project", async () => {
    const res = await app.request(
      '/projects/project-1',
      {},
      testEnv(signedIn({ id: 'user-2' }), testBindings)
    )

    expect(res.status).toBe(404)
  })
})
```

`testBindings` is the application's test configuration: here, the URL of a
migrated test database with `project-1` owned by `user-1`, an auth secret, a
KV namespace and `testRateLimiter()` as the sign-in limiter. It holds every
var and secret `src/env.ts` requires, since `setupWeb` checks them as it does
in production. An `X-Inertia` request returns the page object as JSON, so tests
assert on the component and props rather than HTML.

An action is an Effect, so a test can also run it directly and provide the
services it reads, for example `Effect.provide(signedIn({ id: 'user-1' }))`.

## Reading a response

`readPage` reads a page response typed by the page registry, and rejects with
what the response was instead when it is not that page:

```ts
import { readPage, signedIn, testEnv } from '@popcomputer/web/testing'

const res = await app.request(
  '/projects/project-1',
  { headers: { 'X-Inertia': 'true' } },
  testEnv(signedIn({ id: 'user-1' }), testBindings)
)
const page = await readPage(res, 'Projects/Show')

page.props.project.createdAt // a string: the JSON the browser receives
```

The other readers work the same way, each typed and each saying what the
response was when it is not what the test expected: `readJson(res, Schema)`
for a JSON response, where `await res.json()` is `unknown` and checks
nothing, `readError(res)` for a failure's envelope (and
`readError(res, Schema)` for a body declared by a schema), `readErrorPage(res)`
for the error page a visit rendered, and `readCookie(res, cookie)` for the
value a response set for a declared cookie.

## One visitor across requests

A test that makes several requests as one visitor, such as adding to a cart
and then checking out, uses `testBrowser(app, env)`. It keeps the cookies
responses set, sends them to the paths they cover, names the page it last
showed as the `Referer` of a form it posts, and follows redirects with
`browser.follow(res)`; `browser.setCookie(name, value, path)` gives it a
cookie.

A form's next page receives its `flash` values and field errors through a
cookie the redirect sets. `testBrowser(app, env).follow(res)` requests the
redirect's `Location` as the browser would, with that cookie, whether the
browser sent the form or the test posted it with `app.request`. Post with a
`Referer`, as a browser does, so a failed form goes back to it:

```ts
import { readPage, signedIn, testBrowser, testEnv } from '@popcomputer/web/testing'

const env = testEnv(signedIn({ id: 'user-1' }), testBindings)
const failed = await app.request(
  '/projects',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Referer: 'http://localhost/projects' },
    body: JSON.stringify({ name: '' }),
  },
  env
)
const form = await readPage(await testBrowser(app, env).follow(failed), 'Projects/Index')

form.props.errors.name // 'This field is required'
```

## Fakes for other systems

Replace a service that reaches another system, such as a mailer or a payment
provider, with a fake that records what it was asked to do, and give it to
`testEnv` with the signed-in user. `Layer.succeed(Service, fake)` swaps any
service the application provides:

```ts
import { Context, Effect, Layer } from 'effect'
import { signedIn, testEnv } from '@popcomputer/web/testing'

class Mailer extends Context.Service<Mailer, {
  readonly send: (to: string, subject: string) => Effect.Effect<void>
}>()('app/Mailer') {}

const sent: Array<{ readonly to: string; readonly subject: string }> = []
const FakeMailer = Layer.succeed(Mailer, Mailer.of({
  send: (to, subject) => Effect.sync(() => { sent.push({ to, subject }) }),
}))

const env = testEnv(Layer.merge(signedIn({ id: 'user-1' }), FakeMailer), testBindings)
```

A test checks what a write purges by replacing `ResponseCacheService` with a
recorder:

```ts
import { Effect, Layer } from 'effect'
import { ResponseCacheService, type ResponseCachePurgeInput } from '@popcomputer/web/effect'
import { signedIn, testEnv } from '@popcomputer/web/testing'

const purged: ResponseCachePurgeInput[] = []
const RecordPurges = Layer.succeed(ResponseCacheService, {
  isAvailable: true,
  purge: (input) => Effect.sync(() => { purged.push(input) }),
})

const env = testEnv(Layer.merge(signedIn({ id: 'user-1' }), RecordPurges), testBindings)
```

The layers given to `web.services` are still built, so the test bindings
include the vars and secrets those layers read even when a fake replaces
them. Effect `Config` reads the request's bindings, so a test sets a var or
secret in `testEnv`'s bindings. The `app` layer is built once per test
process, from the first request's bindings: a test that needs another value
for an application service gives it a layer in `testEnv` instead.

## Time

Rules that depend on the time, such as an invitation that expires after seven
days, read it from Effect's `Clock` (`DateTime.now`, `Clock.currentTimeMillis`)
rather than `new Date()`. `testClock(start)` gives a test one clock that every
request it makes reads, and the test moves it between requests:

```ts
import { Layer } from 'effect'
import { signedIn, testClock, testEnv } from '@popcomputer/web/testing'

const time = await testClock(new Date('2026-03-01T09:00:00Z'))
const env = testEnv(Layer.merge(signedIn({ id: 'user-1' }), time.layer), testBindings)

await time.advance('8 days')
const expired = await app.request('/invites/abc', {}, env)

// A request that waits on the clock, such as a delivery retrying with
// Schedule.exponential: settle moves the clock until it answers.
const delivered = await time.settle(app.request('/webhooks/deliver', { method: 'POST' }, env))
```

## What test files share

Bun runs every test file in one module registry, so a clock or a test
database created at the top of a shared support module is shared by all the
files. A file that moves the clock sets it back in `beforeEach` (`await
time.set(start)`), and a file that writes rows seeds and reads its own. A job
that reads every tenant's rows, such as a monthly invoicing cron, sees other
files' seeds too, so seed through the application's own writes (or keep
counters and sequences consistent), and give such a test its own database.

[A database for tests](test-database.md) shows the database a test runs against.
