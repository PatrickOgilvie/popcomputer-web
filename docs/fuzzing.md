# Fuzzing

`@popcomputer/web/fuzz` checks rules on inputs it generates, rather than on
the few a test writes by hand: any text a validator is given, any request a
browser or an attacker sends to the application's routes, any order of a
lifecycle's steps. Its pieces stand alone, on Effect's generators
(`effect/Arbitrary`), so a fuzz test adds the application's own rules.

| Piece | What it gives |
| --- | --- |
| `fuzz(arbitrary, holds, { runs, shrinks })` | runs a property: resolves when every case holds, rejects with the case shrunk through up to `shrinks` candidates (1,000, or `FUZZ_SHRINKS`), why it was refused and a replay token; shrinking stops, saying so, with a quarter of `fuzzTimeout` left |
| `pick`, `oneOf`, `weighted`, `textOf`, `stepsOf`, `anyText`, `show` | generators that shrink toward their first choice, sequences of a lifecycle's steps of every length up to `maxLength`, and a value shown with its invisible characters escaped |
| `fuzzRequest({ paths, routes, params, people })` | requests to the application's declared paths, and a form for each route that writes, from each person and a signed-out visitor |
| `ownership(routes, table)` | the keys `strangerWrites` reads a table's rows by: its primary key and the column its binding's `ownedBy` names |
| `sendFuzzRequest(app, sent, env)` | sends one through the application, as `app.request` does |
| `fuzzSession({ ...requestOptions, creates })`, `startFuzzSession(app, { paths, env, owners, created })` | sequences of those requests to one database, where a step names records earlier steps created, and a model of who owns each |
| `brokenPromises`, `leaks`, `strangerWrites`, `refusedWrites` | how an answer broke a rule, as a list empty when it kept them |
| `realmGuard()` | what a call wrote onto the realm's built-ins, such as `Object.prototype` |

Like `@popcomputer/web/testing`, it is for tests: `no-testing-in-production` reports it anywhere else.

## A property

A property returns why it refused an input, or nothing when it holds:

```ts
// src/slug.test.ts
import { test } from 'bun:test'
import { anyText, fuzz, fuzzTimeout, oneOf, show, textOf } from '@popcomputer/web/fuzz'

function slugOf(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// Names made of pieces that mean something to the rule, or any text at all.
const names = oneOf(textOf(['Apollo', ' ', '-', '--', 'É', ' ', '/', '..', '1']), anyText)

test('a slug is one URL segment of lowercase words', () => fuzz(names, (name) => {
  const slug = slugOf(name)

  return /^([a-z0-9]+(-[a-z0-9]+)*)?$/.test(slug) ? undefined : `${show(name)} gave ${show(slug)}`
}), fuzzTimeout)
```

`bun test` runs each property for 300 cases from a fixed seed, so the commit
gate gives the same answer each time; `{ runs }` lowers it for a property
whose cases are slow. Run many more from a random seed now and then:

```bash
FUZZ_RUNS=20000 FUZZ_SEED=random bun test
```

A failure prints the smallest case shrinking found, the reason the property
gave, and a replay token: `FUZZ_REPLAY='<token>' bun test -t '<name>'` runs
that case again; one that holds when run again failed on what earlier cases
left, and says so. Keep a fixed bug's case as a plain test beside the
property; a new one must first fail on its bug planted (rule 12 of `AGENTS.md`).

## Requests to the application

`fuzzRequest` reads the application's paths and generates what reaches
them: any method, each path with each of its placeholders' values, the same
paths spelled another way (encoded, doubled slashes, dot segments, other
case), each form an action accepts with fields added, queries, bodies in
every shape and Content-Type, and headers from this site and others. Most
are a browser's own, or one with a single part sent another way, so they
reach their actions; the rest send every part any way.

```ts
// src/requests.test.ts
import { test } from 'bun:test'
import { brokenPromises, fuzz, fuzzRequest, fuzzTimeout, leaks, ownership, refusedWrites, sendFuzzRequest, strangerWrites } from '@popcomputer/web/fuzz'
import { signedIn, testEnv } from '@popcomputer/web/testing'
import app, { routes } from './app'
import { paths } from './paths'
import './routes'
import { projects, user } from './schema'
import { testBindings } from './test-bindings'
import { freshDatabase } from './test-databases'

// Text only each person's private project holds: an answer that shows it to anyone else leaked it.
const canaries = { ada: 'canary-ada-7f3a', grace: 'canary-grace-91c2' }

const requests = fuzzRequest({
  paths,
  // A form for each route that writes, with fields that pass its action's form(Schema).
  routes,
  // Every placeholder in src/paths.ts, with each person's records, a public one and a missing one.
  params: {
    project: ['p-ada', 'p-grace', 'p-public', 'missing'],
    task: ['t-ada', 't-grace'],
    showcase: ['apollo', 'secret'],
    organization: ['acme', 'globex'],
    member: ['ada', 'grace'],
    provider: ['acme'],
  },
  people: ['ada', 'grace'],
})

test('any request keeps the rules', () => fuzz(requests, async (sent) => {
  const { db, close } = freshDatabase()

  try {
    await db.insert(user).values([
      { id: 'ada', name: 'Ada', email: 'ada@example.com' },
      { id: 'grace', name: 'Grace', email: 'grace@example.com' },
    ])
    await db.insert(projects).values([
      { id: 'p-ada', userId: 'ada', name: canaries.ada, slug: 'secret' },
      { id: 'p-grace', userId: 'grace', name: canaries.grace, slug: 'secret-too' },
      { id: 'p-public', userId: 'ada', name: 'Apollo', slug: 'apollo', isPublic: true },
    ])

    const rows = () => db.select({ id: projects.id, userId: projects.userId, name: projects.name, isPublic: projects.isPublic }).from(projects).orderBy(projects.id)
    const env = sent.person === null
      ? testEnv(testBindings, { database: db })
      : testEnv(signedIn({ id: sent.person }), testBindings, { database: db })
    const before = await rows()
    const answer = await sendFuzzRequest(app, sent, env)

    // A request fetch refuses to make never reaches the Worker.
    if (answer === undefined) return undefined

    const change = { before, after: await rows() }

    return [
      ...brokenPromises(sent, answer),
      ...leaks(sent, answer, canaries),
      ...strangerWrites(sent, change, ownership(routes, 'projects')),
      ...refusedWrites(answer, change),
    ]
  } finally {
    await close()
  }
}, { runs: 200 }), fuzzTimeout)
```

`params` is typed by the paths, so a new placeholder is a type error here
until the test names its values. `routes` makes a form for each route that
writes, with fields that pass its action's `form(Schema)`, so a new action
is fuzzed once registered; `forms: [{ method, path, fields }]` adds what it
cannot generate, a file or an action's `validateRequest` fields.
`ownership(routes, 'projects')` reads a row's primary key and its binding's
`ownedBy` column, by property key or snake_case name; give `{ id, owner }`
for a table no binding owns, and check a visitor's new account with a rule
of your own. Each request comes from its own client address.

The rules each answer keeps:

- `brokenPromises`: the framework's, for any application. No request is
  answered 500 or makes a defect, even one no answer shows, as in background
  work (`sendFuzzRequest` records what the error observer sees); another
  site's write, by its Origin or else its Referer, is refused with a 403
  unless it carries an Authorization no browser attaches by itself; a
  signed-in answer, or one that sets a cookie, is never kept by a shared
  cache; a JSON client gets each failure in the JSON envelope and is never
  sent to sign in; an Inertia visit that changes something is redirected
  with a 303; no answer redirects to a site the request named. Give it
  `{ origin, signInPath }` unless they are `http://localhost` and `/login`.
- `leaks`: no answer shows a person's canary to anyone else, in body or headers.
- `strangerWrites`: no row is changed or deleted by anyone but its owner,
  moved to another owner, or created for someone other than its sender.
- `refusedWrites`: a 4xx answer changed no rows. Refusing everything keeps
  every rule, so also check after `fuzz` that each route that writes
  answered 2xx or wrote; a failed form's 303 back reaches nothing, and an
  app of thirty routes needs more than 200 cases to reach each.

Each request starts from the database the test seeded. To send sequences of
them, each naming the records earlier ones created, see
[Fuzzing sessions](fuzz-sessions.md).

## Building on it

The test is the application's to grow. Each rule is a function of the
request and the answer, so the application's own rules go beside them in
the list the property returns:

```ts
import type { FuzzRequest, RowsChange } from '@popcomputer/web/fuzz'

/** No request makes a private project public: only the visibility form may, and it is not generated. */
function madePublic(sent: FuzzRequest, change: RowsChange<{ readonly id: string; readonly isPublic: boolean }>): string[] {
  return change.after
    .filter((row) => row.isPublic && change.before.some((was) => was.id === row.id && !was.isPublic))
    .map((row) => `${sent.person ?? 'a visitor'} made ${row.id} public`)
}
```

A property may change a request before sending and checking it, as an API's
test adds its key: `{ ...sent, headers: { ...sent.headers, authorization: 'Bearer test-key' } }`.
A person per role (an owner, a member, a guest) lets the rules see more.

## Steps over lasting state

State that lasts between requests, a cart, a balance, a sign-in count, is
fuzzed as sequences of steps, generated by `stepsOf` from a step, such as
`pick(['finish', 'invoice', 'signOff'])`, or a record of fields, as here:
the test runs each step against the application and against a small model
of the rule, and compares them after each step.

```ts
// src/cart.test.ts
import { test } from 'bun:test'
import { Schema as S } from 'effect'
import { fuzz, fuzzTimeout, pick, show, stepsOf, weighted } from '@popcomputer/web/fuzz'
import { readJson, testBrowser, testEnv } from '@popcomputer/web/testing'
import app from './app'
import { testBindings } from './test-bindings'

const cartSteps = stepsOf({
  act: weighted<'add' | 'remove' | 'checkout'>(['add', 3], ['remove', 2], ['checkout', 1]),
  product: pick(['tea', 'cake']),
  quantity: pick([1, 2, 5]),
}, { maxLength: 12 })

test('the cart holds what its model holds', () => fuzz(cartSteps, async (steps) => {
  const browser = testBrowser(app, testEnv(testBindings))
  const model = new Map<string, number>()

  for (const [index, sent] of steps.entries()) {
    const held = model.get(sent.product) ?? 0

    if (sent.act === 'add') model.set(sent.product, held + sent.quantity)
    if (sent.act === 'remove') model.set(sent.product, Math.max(0, held - sent.quantity))
    if (sent.act === 'checkout') model.clear()

    await browser.request(`/cart/${sent.act}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product: sent.product, quantity: sent.quantity }),
    })

    const cart = await readJson(await browser.request('/cart', { headers: { Accept: 'application/json' } }), S.Record(S.String, S.Number))
    const expected = [...model].filter(([, quantity]) => quantity > 0).sort()

    if (show(Object.entries(cart).sort()) !== show(expected)) {
      return `after step ${index + 1} of ${show(steps)}, the cart held ${show(cart)}`
    }
  }

  return undefined
}), fuzzTimeout)
```

The property returns the first step where the application and the model
disagree, with the steps before it. `stepsOf` draws each sequence's length
evenly up to `maxLength` and shrinks a failing one to the steps it needs.
Steps sent together, `Promise.all` over a step's requests, find the races a
sequence alone cannot. The package's own `tests/fuzz` has one for each
lifecycle `docs/state-machines.md` lists.
