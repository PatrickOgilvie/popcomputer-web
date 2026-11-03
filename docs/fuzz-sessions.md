# Fuzzing sessions

A request sent alone to a fresh database, as
[Fuzzing](fuzzing.md#requests-to-the-application) sends each, never names a record another
request created. A bug that needs "ada creates, grace reads, ada deletes,
grace writes" is never generated. A session is that sequence: requests from
each person, against one database, where a step may name a record an
earlier step created.

| Piece | What it gives |
| --- | --- |
| `fuzzSession({ ...requestOptions, creates, maxLength })` | sequences of `fuzzRequest`'s requests, whose placeholders `creates` names may take a record an earlier step created |
| `startFuzzSession(app, { paths, env, owners, created })` | a session against one application: a `testBrowser` for each person, and a model of who owns each record |
| `session.send(step)` | sends a step, its references replaced by the records they name, and updates the model |
| `session.ownerOf(id)`, `session.exists(id)`, `session.canaries(viewer, canaries)` | the model, as the rules read it |
| `session.probe(request)`, `session.history` | a request beside the session, and a line for each step sent |

## Sessions of steps

`fuzzSession` takes `fuzzRequest`'s options and gives `stepsOf` sequences of
its requests, of every length up to `maxLength`, 24 by default. Six in ten
are a browser's, three send one part another way and one every part, so
most reach their actions and leave state for the next: `mix` weighs them
otherwise. Each placeholder `creates` names takes references beside its
values, `~project.0` for the latest project a step created and `~project.1`
for the one before, counting round the ones there are. A reference to a
record no step has created yet names none.

## The session and its model

`startFuzzSession` sends the steps to one application. Each person, and a
signed-out visitor, has a `testBrowser`, so cookies and flash carry between
their steps, and the session keeps a model of who owns each record: the
seeded ones `owners` gives, and each one a step created, which `created`
reads from an answer that succeeded. A created record belongs to the owner
of the record its path names last, such as the project a task was posted
to, or else to its sender. A DELETE that succeeds marks the record its path
names last deleted. After each step, the rules check the answer against the
model:

```ts
// src/sessions.test.ts
import { test } from 'bun:test'
import {
  brokenPromises,
  fuzz,
  fuzzSession,
  fuzzTimeout,
  leaks,
  refusedWrites,
  startFuzzSession,
  strangerWrites,
  type FuzzAnswer,
  type FuzzRequest,
} from '@popcomputer/web/fuzz'
import { signedIn, testEnv } from '@popcomputer/web/testing'
import app from './app'
import { paths } from './paths'
import './routes'
import { projects, user } from './schema'
import { testBindings } from './test-bindings'
import { freshDatabase } from './test-databases'

const canaries = { ada: 'canary-ada-7f3a', grace: 'canary-grace-91c2' }

const sessions = fuzzSession({
  paths,
  params: {
    project: ['p-ada', 'p-grace', 'missing'],
    task: ['missing'],
    showcase: ['secret'],
    organization: ['acme'],
    member: ['ada'],
    provider: ['acme'],
  },
  people: ['ada', 'grace'],
  // Later steps may name the projects steps created.
  creates: ['project'],
  forms: [
    { method: 'POST', path: paths.projects, fields: ['name=Apollo'] },
    { method: 'PUT', path: paths.project, fields: ['name=Renamed'] },
    { method: 'DELETE', path: paths.project, fields: [] },
  ],
})

/** The project a POST created, which its redirect names. */
function created(sent: FuzzRequest, answer: FuzzAnswer) {
  const id = /^\/projects\/([^/]+)$/.exec(answer.response.headers.get('location') ?? '')?.[1]

  return sent.method.toUpperCase() === 'POST' && id !== undefined ? { project: id } : undefined
}

test('any session keeps the rules after each step', () => fuzz(sessions, async (steps) => {
  const { db, close } = freshDatabase()

  try {
    await db.insert(user).values([
      { id: 'ada', name: 'Ada', email: 'ada@example.com' },
      { id: 'grace', name: 'Grace', email: 'grace@example.com' },
    ])
    await db.insert(projects).values([
      { id: 'p-ada', userId: 'ada', name: canaries.ada, slug: 'secret' },
      { id: 'p-grace', userId: 'grace', name: canaries.grace, slug: 'secret-too' },
    ])

    const session = startFuzzSession(app, {
      paths,
      env: (person: 'ada' | 'grace' | null) => person === null
        ? testEnv(testBindings, { database: db })
        : testEnv(signedIn({ id: person }), testBindings, { database: db }),
      owners: { 'p-ada': 'ada', 'p-grace': 'grace' },
      created,
    })
    const rows = () => db.select({ id: projects.id, userId: projects.userId, name: projects.name }).from(projects).orderBy(projects.id)

    for (const step of steps) {
      const before = await rows()
      const result = await session.send(step)

      if (result === undefined) continue

      const { sent, answer } = result
      const change = { before, after: await rows() }
      const broken = [
        ...brokenPromises(sent, answer),
        ...leaks(sent, answer, session.canaries(sent.person, canaries)),
        ...strangerWrites(sent, change, { id: (row) => row.id, owner: (row) => session.ownerOf(row.id) ?? 'no one' }),
        ...refusedWrites(answer, change),
      ]

      // The steps so far, with the ids they named, and what the last one broke.
      if (broken.length > 0) return [...session.history, ...broken]
    }

    return undefined
  } finally {
    await close()
  }
}, { runs: 100 }), fuzzTimeout)
```

`session.canaries(viewer, canaries)` adds to each person's canaries the ids
of the records they own that steps created, unless `viewer` has sent one:
no one else learns them unless the application shows them. Give `creates`
each placeholder that binds the same table, as `project` and `showcase`
bind projects, and have `created` return the record under each.

`session.probe(request)` sends a request beside the session, with the
cookies the person's browser held before their last step, keeping none the
answer sets. A rule that compares a refusal with the same request naming a
missing record sends that one this way, and `session.exists(id)` says which
segments of the path name a record to swap. A failing session shrinks toward
the steps it needs, and `session.history` shows them with the ids they named
and each answer's status.

## What it finds

The package's own `tests/fuzz/sessions.test.ts` finds, within the gate's
runs and from every seed tried, two bugs that no request to a fresh
database reaches, each shrunk to two or three steps:

- an action that looks a record up by the id its form sends, without
  scoping the query to the bound model: ada adds a note to her project, and
  grace edits it through hers;
- a delete that leaves a record's children, which a query that hides only
  the children of private records then shows: grace deletes her project,
  and a visitor lists its tasks.
