# Fuzzing requests

Generated requests to the application's routes, from `@popcomputer/web/fuzz`,
each sent alone against the seeded database, and the rules each answer
keeps. [Fuzzing](fuzzing.md) has `fuzz` itself and the steps of a lifecycle;
[Fuzzing sessions](fuzz-sessions.md) sends sequences of these requests to one
database, so a record one step creates is one a later step names.

## Requests to the application

`fuzzRequest` reads the application's paths and generates what reaches
them: any method, each path with each of its placeholders' values, the same
paths spelled another way (encoded, doubled slashes, dot segments, other
case), each form an action accepts with fields added, queries, bodies in
every shape and Content-Type, and headers from this site and others. Most
are a browser's own, or one with a single part sent another way, so they
reach their actions; the rest send every part any way, as `mix` weighs them:
`{ browser: 3, onePart: 4, any: 3 }` by default.

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
beside each new action, so its writes are generated with valid fields. A
form whose body names a record takes its placeholder's values there too:
`{ method: 'PUT', path: paths.notes, fields: ['note={note}', 'body=Edited'] }`.

The rules each answer keeps:

- `brokenPromises`: the framework's, for any application. No request is
  answered 500; another site's write, by its Origin or else its Referer, is
  refused with a 403 unless it carries an Authorization no browser attaches
  by itself; a signed-in answer, or one that sets a cookie, is never kept by
  a shared cache; a JSON client gets each failure in the JSON envelope and is
  never sent to sign in; an Inertia visit that changes something is
  redirected with a 303; no answer redirects to a site the request named.
  Give it `{ origin, signInPath }` when the application's differ from
  `http://localhost` and `/login`.
- `leaks`: no answer shows one person's canary to anyone else, in its body
  or its headers.
- `strangerWrites`: no row is changed or deleted by anyone but its owner,
  moved to another owner, or created for someone other than its sender.
- `refusedWrites`: a 4xx answer changed no rows. Refusing everything keeps
  every rule, so also check after `fuzz` that a share reached the actions.

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
