/**
 * Sessions of generated requests against one application, its database
 * kept between them: `fuzzSession` makes `stepsOf` sequences of
 * `fuzzRequest`'s requests to app.ts, from a visitor, ada and grace, each
 * with a browser of their own, and a step may name a project or a note an
 * earlier step created. So ada adds a note, grace edits a note by its id
 * from her own project, ada deletes a project, and a visitor lists the
 * tasks, in any order. Only steps make notes: a request to a fresh
 * application never names one.
 *
 * After every step, against the session's model of who owns each record,
 * seeded or created, the answer keeps every rule requests.test.ts checks of
 * one request:
 *
 * - the framework's (`brokenPromises`), a defect among them even where no
 *   answer shows it, and no change to the realm's built-ins and no project
 *   made public;
 * - no one but its owner sees a private record (`leaks`): the seeded
 *   canaries, and the id of a record a step created to anyone who never sent
 *   it;
 * - no one but its owner changes or deletes a record, and none is created
 *   for anyone but its sender (`strangerWrites`), where a note belongs to
 *   its project's owner;
 * - a refused request (4xx) changes no rows and sends the database no write;
 * - a request refused with a 401, 403 or 404 answers exactly as it does with
 *   each record it names, seeded or created, swapped for a missing one.
 *
 * Every one of those holds for an application that refuses everything, so
 * the test also checks that the sessions reached their actions: a quarter of
 * the steps answered below 400, steps changed records other steps created,
 * and steps named records someone else created.
 */
import { describe, expect, test } from 'bun:test'
import { Option, Schema as S } from 'effect'
import {
  brokenPromises,
  fuzz,
  fuzzSession,
  fuzzTimeout,
  leaks,
  realmGuard,
  refusedWrites,
  startFuzzSession,
  strangerWrites,
  type FuzzAnswer,
  type FuzzRequest,
  type Refusal,
} from '../../src/fuzz.js'
import { signedIn, testEnv } from '../../src/testing.js'
import { CANARIES, createApp, paths, type Person } from './app'
import { existenceShown } from './existence'

const sessions = fuzzSession({
  paths,
  // Each person's records, a public one and a missing one; a project or note a step created besides.
  params: {
    project: ['p1', 'g1', 'p2', 'missing'],
    task: ['t1', 't2', 't3'],
    note: ['missing'],
    showcase: ['p2', 'p1', 'g1'],
    organization: ['acme', 'globex'],
  },
  people: ['ada', 'grace'],
  creates: ['project', 'showcase', 'note'],
  // The forms that make, change and delete records.
  forms: [
    { method: 'POST', path: paths.projects, fields: ['name=Apollo'] },
    { method: 'PUT', path: paths.project, fields: ['name=Renamed'] },
    { method: 'DELETE', path: paths.project, fields: [] },
    { method: 'POST', path: paths.notes, fields: ['body=Draft'] },
    { method: 'PUT', path: paths.notes, fields: ['note={note}', 'body=Edited'] },
  ],
  fields: ['name=', 'visibility=public'],
  query: ['redirect=/projects/g1', 'visibility=public'],
})

/** Who owns each seeded record. */
const OWNERS: Readonly<Record<string, Person>> = { p1: 'ada', p2: 'ada', g1: 'grace', t1: 'ada', t2: 'grace', t3: 'ada' }

const Created = S.fromJsonString(S.Struct({ id: S.String }))

/** The project or note a POST created: both answer its id. */
function created(sent: FuzzRequest<Person>, answer: FuzzAnswer): Readonly<Record<string, string>> | undefined {
  const id = Option.getOrUndefined(S.decodeUnknownOption(Created)(answer.text))?.id

  if (sent.method.toUpperCase() !== 'POST' || id === undefined) return undefined
  if (id.startsWith('n-')) return { note: id }

  return id.startsWith('p-') ? { project: id, showcase: id } : undefined
}

const WRITE_STATEMENT = /^\s*(insert|update|delete)\b/i
const realmChanges = realmGuard()

const envFor = (person: Person | null) =>
  person === null ? testEnv({ ENVIRONMENT: 'production' }) : testEnv(signedIn({ id: person }), { ENVIRONMENT: 'production' })

/** How many steps were answered, how many below 400, and how many changed or named another's created record. */
const reached = { steps: 0, accepted: 0, changedCreated: 0, namedOthers: 0 }

async function run(steps: ReadonlyArray<FuzzRequest<Person>>): Promise<Refusal> {
  const { app, statements, records } = createApp()
  const session = startFuzzSession(app, { paths, env: envFor, owners: OWNERS, created })
  const ownerOf = (row: { readonly id: string }) => session.ownerOf(row.id) ?? 'no one'

  for (const step of steps) {
    const before = records()
    const written = statements.length
    const result = await session.send(step)

    if (result === undefined) continue

    const { sent, answer, referenced } = result
    const after = records()
    const status = answer.response.status
    const writes = statements.slice(written).filter((statement) => WRITE_STATEMENT.test(statement))
    const madePublic = after.filter((row) => row.kind === 'project' && row.text.endsWith('(public)') && before.some((was) => was.id === row.id && was.text !== row.text && !was.text.endsWith('(public)')))
    const changed = after.filter((row) => before.some((was) => was.id === row.id && was.text !== row.text))

    reached.steps += 1
    if (status < 400) reached.accepted += 1
    if (changed.some((row) => !Object.hasOwn(OWNERS, row.id))) reached.changedCreated += 1
    if (referenced.some((id) => session.ownerOf(id) !== sent.person)) reached.namedOthers += 1

    const broken = [
      ...brokenPromises(sent, answer),
      ...leaks(sent, answer, session.canaries(sent.person, CANARIES)),
      ...strangerWrites(sent, { before, after }, { id: (row) => row.id, owner: ownerOf }),
      ...refusedWrites(answer, { before, after }),
      ...madePublic.map((row) => `${sent.person ?? 'a visitor'} made ${row.id} public`),
      ...(status >= 400 && writes.length > 0 ? [`answered ${status} after writing: ${writes.join('; ')}`] : []),
      ...(await existenceShown(sent, answer, (segment) => session.exists(segment), (twin) => session.probe(twin))),
      ...[realmChanges()].filter((change) => change !== undefined),
    ]

    if (broken.length > 0) return [...session.history.map((line, index) => `${index + 1}. ${line}`), `the last step ${broken.join('; ')}`].join('\n')
  }

  return undefined
}

describe('any session of requests', () => {
  test('keeps every rule after each step, against the records its steps created', async () => {
    await fuzz(sessions, run)

    // A replay runs one case; a full run must have reached the records steps
    // created. Ten seeds' 300 sessions gave 3,000 to 3,600 steps, 37% or more
    // answered below 400, 9 to 22 changing a created record, and 212 to 283
    // naming someone else's.
    if (reached.steps < 1000) return

    expect(reached.accepted / reached.steps).toBeGreaterThan(0.3)
    expect(reached.changedCreated).toBeGreaterThan(4)
    expect(reached.namedOthers).toBeGreaterThan(150)
  }, fuzzTimeout)
})
