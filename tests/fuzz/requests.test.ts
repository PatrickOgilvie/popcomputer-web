/**
 * Generated requests to a whole application, through setupWeb as a Worker
 * serves them, from the tools `@popcomputer/web/fuzz` gives an application:
 * `fuzzRequest` makes any method, path, query, body, Content-Type and
 * headers a browser, an API client or an attacker sends, to the paths
 * app.ts declares, from a visitor, ada or grace. Whatever arrives, each
 * answer keeps the rules the framework promises (`brokenPromises`):
 *
 * - no request makes a 500;
 * - a write another site's page sends, by its Origin or else its Referer,
 *   is refused with a 403, unless it carries an Authorization scheme no
 *   browser attaches by itself, such as Bearer (src/security.ts's
 *   originRefusal, tests/security/cross-site.test.ts);
 * - a signed-in answer, or one that sets a cookie, is never kept by a shared
 *   cache (docs/page-cache.md);
 * - a JSON client gets every failure in the JSON envelope, and a 401 rather
 *   than a redirect to sign in (docs/json.md);
 * - an Inertia visit that changes something is redirected with a 303, which
 *   Inertia's protocol requires so the browser follows it with a GET.
 *
 * and the rules of this application's own records, as an application's fuzz
 * test adds them on top:
 *
 * - no one but its owner sees, renames or deletes a private record
 *   (`leaks`, `strangerWrites`), and no request makes one public;
 * - a request refused with a 401, 403 or 404 answers exactly as the same
 *   request does with each record it names swapped for a missing one, so a
 *   refusal never tells whether someone else's record exists;
 * - the page a visitor signed in for is on this site;
 * - a refused request (4xx) sends the database no write;
 * - no request makes a defect, or changes the realm's built-ins.
 *
 * Every one of those holds for an application that refuses everything, so
 * the test also checks that the requests reached their actions: a quarter
 * or more answered below 400, and some changed the database.
 */
import { describe, expect, test } from 'bun:test'
import {
  brokenPromises,
  fuzz,
  fuzzRequest,
  fuzzTimeout,
  leaks,
  realmGuard,
  sendFuzzRequest,
  strangerWrites,
  show,
  type FuzzAnswer,
  type FuzzRequest,
  type Refusal,
} from '../../src/fuzz.js'
import { signedIn, testEnv } from '../../src/testing.js'
import { CANARIES, createApp, paths, type Person } from './app'
import { existenceShown } from './existence'

// Each placeholder's values: each person's records, a public one and a missing one. Only steps make notes.
const params = {
  project: ['p1', 'g1', 'p2', 'missing'],
  task: ['t1', 't2'],
  note: ['missing'],
  showcase: ['p2', 'p1', 'g1'],
  organization: ['acme', 'globex'],
} as const satisfies Record<string, readonly [string, ...string[]]>

/** The records the seeded database holds, which a path may name. */
const RECORDS = new Set<string>(Object.values(params).flat().filter((value) => value !== 'missing'))

const request = fuzzRequest({
  paths,
  params,
  people: ['ada', 'grace'],
  // A request each of this application's actions accepts, and the fields they read beside the ones every request may carry.
  forms: [
    { method: 'POST', path: paths.projects, fields: ['name=Apollo'] },
    { method: 'PUT', path: paths.project, fields: ['name=Renamed'] },
    { method: 'PATCH', path: paths.project, fields: ['name=Renamed'] },
    { method: 'DELETE', path: paths.project, fields: [] },
    { method: 'POST', path: paths.notes, fields: ['body=Draft'] },
    { method: 'PUT', path: paths.notes, fields: ['note={note}', 'body=Edited'] },
    { method: 'POST', path: paths.signIn, fields: ['email=ada%40example.com', 'password=correct'] },
    { method: 'POST', path: paths.orders, fields: ['address[city]=Oslo', 'lines[0][sku]=a', 'lines[0][quantity]=2'] },
  ],
  fields: ['name=', 'name=%20', 'visibility=public'],
  query: ['redirect=/projects/g1', 'visibility=public', 'name=x'],
})

const WRITE_STATEMENT = /^\s*(insert|update|delete)\b/i
const realmChanges = realmGuard()

const envFor = (person: Person | null) =>
  person === null ? testEnv({ ENVIRONMENT: 'production' }) : testEnv(signedIn({ id: person }), { ENVIRONMENT: 'production' })

/** How many generated requests were answered, how many below 400, and how many of those wrote. */
const reached = { cases: 0, answered: 0, accepted: 0, wrote: 0 }

/** The page /after-sign-in names, when it names one off this site. */
function offSite(sent: FuzzRequest<Person>, answer: FuzzAnswer): string[] {
  if (sent.path !== paths.afterSignIn || answer.response.status !== 200 || sent.method.toUpperCase() === 'HEAD') return []

  const url: unknown = Reflect.get(JSON.parse(answer.text) as object, 'url')

  return typeof url === 'string' && new URL(url, 'http://localhost').origin === 'http://localhost' ? [] : [`sent a signed-in visitor on to ${show(url)}`]
}

async function send(sent: FuzzRequest<Person>): Promise<Refusal> {
  const { app, statements, observed, rows } = createApp()
  const before = rows()

  reached.cases += 1

  const answer = await sendFuzzRequest(app, sent, envFor(sent.person))

  if (answer === undefined) return undefined

  const after = rows()
  const status = answer.response.status
  const writes = statements.filter((statement) => WRITE_STATEMENT.test(statement))
  const defects = observed.filter((event) => event.kind === 'defect').length
  const madePublic = after.filter((row) => before.some((was) => was.id === row.id && was.visibility !== row.visibility))

  reached.answered += 1
  if (status < 400) reached.accepted += 1
  if (status < 400 && writes.length > 0) reached.wrote += 1

  const broken = [
    ...brokenPromises(sent, answer),
    ...leaks(sent, answer, CANARIES),
    ...strangerWrites(sent, { before, after }, { id: (row) => row.id, owner: (row) => row.user_id }),
    ...madePublic.map((row) => `${sent.person ?? 'a visitor'} made ${row.id} ${row.visibility}`),
    ...(status >= 400 && writes.length > 0 ? [`answered ${status} after writing: ${writes.join('; ')}`] : []),
    ...(defects > 0 ? [`made ${defects} defects`] : []),
    ...offSite(sent, answer),
    ...(await existenceShown(sent, answer, (segment) => RECORDS.has(segment), (twin) => sendFuzzRequest(createApp().app, twin, envFor(sent.person)))),
    ...[realmChanges()].filter((change) => change !== undefined),
  ]

  return broken.length === 0 ? undefined : `${sent.method} ${sent.path}${sent.query === '' ? '' : `?${sent.query}`}: ${broken.join('; ')}`
}

describe('any request', () => {
  test('gets an answer that keeps the framework’s rules, and most reach their actions', async () => {
    await fuzz(request, send, { runs: 2000 })

    // A replay runs one case; a full run must have reached the actions.
    if (reached.cases < 100) return

    expect({ ...reached, acceptedShare: Math.round((100 * reached.accepted) / reached.answered) }).toMatchObject({
      answered: reached.cases,
      acceptedShare: expect.any(Number),
    })
    expect(reached.accepted / reached.answered).toBeGreaterThan(0.25)
    expect(reached.wrote).toBeGreaterThan(reached.answered / 20)
  }, fuzzTimeout)
})
