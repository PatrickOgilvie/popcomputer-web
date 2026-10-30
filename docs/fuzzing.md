# Fuzzing

`@popcomputer/web/fuzz` checks rules on inputs it generates, rather than on
the few a test writes by hand: any text a validator is given, any request a
browser or an attacker sends to the application's routes, any order of the
steps a lifecycle takes. Its pieces stand alone, on Effect's generators
(`effect/Arbitrary`), so an application's fuzz tests start from them and add
the application's own records and rules.

| Piece | What it gives |
| --- | --- |
| `fuzz(arbitrary, holds, { runs })` | runs a property: resolves when every case holds, rejects with the shrunk case, why it was refused and a replay token |
| `pick`, `oneOf`, `weighted`, `textOf`, `anyText`, `show` | generators that shrink toward their first choice, and a value shown with its invisible characters escaped |
| `fuzzRequest({ paths, params, people, forms })` | requests to the application's declared paths, from each person and a signed-out visitor |
| `sendFuzzRequest(app, sent, env)` | sends one through the application, as `app.request` does |
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

A failure prints the smallest case Effect's shrinking found, the reason the
property gave, and a replay token: `FUZZ_REPLAY='<token>' bun test -t
'<name>'` runs that case again. Once the bug is fixed, keep the case as a
plain test beside the property. As every test must (rule 12 of `AGENTS.md`),
a new property fails first on code with its bug planted.

## Requests to the application

`fuzzRequest` reads the application's paths and generates what reaches
them: any method, each path with each of its placeholders' values, the same
paths spelled another way (encoded, doubled slashes, dot segments, other
case), each form an action accepts with fields added, queries, bodies in
every shape and Content-Type, and headers from this site and others. Most
requests are ones a browser on the site sends, so they reach their actions;
the rest test the refusals.

```ts
// src/requests.test.ts
import { test } from 'bun:test'
import {
  brokenPromises,
  fuzz,
  fuzzRequest,
  fuzzTimeout,
  leaks,
  refusedWrites,
  sendFuzzRequest,
  strangerWrites,
} from '@popcomputer/web/fuzz'
import { signedIn, testEnv } from '@popcomputer/web/testing'
import app from './app'
import { paths } from './paths'
import './routes'
import { projects, user } from './schema'
import { testBindings } from './test-bindings'
import { freshDatabase } from './test-databases'

// Text only each person's private project holds: an answer that shows it to anyone else leaked it.
const canaries = { ada: 'canary-ada-7f3a', grace: 'canary-grace-91c2' }

const requests = fuzzRequest({
  paths,
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
  // A request each action accepts.
  forms: [
    { method: 'POST', path: paths.projects, fields: ['name=Apollo'] },
    { method: 'PUT', path: paths.project, fields: ['name=Renamed'] },
    { method: 'DELETE', path: paths.project, fields: [] },
  ],
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
      ...strangerWrites(sent, change, { id: (row) => row.id, owner: (row) => row.userId }),
      ...refusedWrites(answer, change),
    ]
  } finally {
    await close()
  }
}, { runs: 200 }), fuzzTimeout)
```

`params` is typed by the paths: a path added to `src/paths.ts` with a new
placeholder is a type error here until the test names its values. Add a form
beside each new action, so its writes are generated with valid fields.

The rules each answer keeps:

- `brokenPromises`: the framework's, for any application. No request is
  answered 500; another site's write, by its Origin or else its Referer, is
  refused with a 403 unless it carries an Authorization no browser attaches
  by itself; a signed-in answer, or one that sets a cookie, is never kept by
  a shared cache; a JSON client gets each failure in the JSON envelope and is
  never sent to sign in; an Inertia visit that changes something is
  redirected with a 303. Give it `{ origin, signInPath }` when the
  application's differ from `http://localhost` and `/login`.
- `leaks`: no answer shows one person's canary to anyone else, in its body
  or its headers.
- `strangerWrites`: no row is changed or deleted by anyone but its owner,
  moved to another owner, or created for someone other than its sender.
- `refusedWrites`: a 4xx answer changed no rows.

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

`fuzzRequest` returns an `Arbitrary`, so `Arbitrary.map` changes what it
generates: an API's requests carry a key,
`Arbitrary.map(requests, (sent) => ({ ...sent, headers: { ...sent.headers, authorization: 'Bearer test-key' } }))`.
A person per role the application has (an owner, a member, a guest) lets
the rules see more.

## Steps over lasting state

State that lasts between requests, a cart, a balance, a sign-in count, is
fuzzed as sequences of steps: generate a list of steps, run each against the
application and against a small model of the rule, and compare them after
each step.

```ts
// src/cart.test.ts
import { test } from 'bun:test'
import { Arbitrary, Schema as S } from 'effect'
import { fuzz, fuzzTimeout, pick, show, weighted } from '@popcomputer/web/fuzz'
import { readJson, testBrowser, testEnv } from '@popcomputer/web/testing'
import app from './app'
import { testBindings } from './test-bindings'

const step = Arbitrary.all({
  act: weighted<'add' | 'remove' | 'checkout'>(['add', 3], ['remove', 2], ['checkout', 1]),
  product: pick(['tea', 'cake']),
  quantity: pick([1, 2, 5]),
})

const Cart = S.Record(S.String, S.Number)

test('the cart holds what its model holds', () => fuzz(Arbitrary.array(step, { maxLength: 12 }), async (steps) => {
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

    const cart = await readJson(await browser.request('/cart', { headers: { Accept: 'application/json' } }), Cart)
    const expected = [...model].filter(([, quantity]) => quantity > 0).sort()

    if (show(Object.entries(cart).sort()) !== show(expected)) {
      return `after step ${index + 1} of ${show(steps)}, the cart held ${show(cart)}`
    }
  }

  return undefined
}), fuzzTimeout)
```

The property returns the first step where the application and the model
disagree, with the steps before it, and Effect shrinks them to the fewest
that still disagree. Steps sent together, `Promise.all` over a step's requests, find
the races a sequence alone cannot. The package's own suite (`tests/fuzz` in
its repository) has one for each lifecycle `docs/state-machines.md` lists.
