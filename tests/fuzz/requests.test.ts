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
 * - a refused request (4xx) sends the database no write;
 * - no request makes a defect, or changes the realm's built-ins.
 */
import { describe } from 'bun:test'
import {
  brokenPromises,
  fuzzRequest,
  leaks,
  realmGuard,
  sendFuzzRequest,
  strangerWrites,
  type FuzzRequest,
  type Refusal,
} from '../../src/fuzz.js'
import { signedIn, testEnv } from '../../src/testing.js'
import { CANARIES, createApp, paths, type Person } from './app'
import { property } from './property'

const request = fuzzRequest({
  paths,
  params: {
    project: ['p1', 'g1', 'p2', 'missing'],
    task: ['t1', 't2'],
    showcase: ['p2', 'p1', 'g1'],
    organization: ['acme', 'globex'],
  },
  people: ['ada', 'grace'],
  // A request each of this application's actions accepts, and the fields they read beside the ones every request may carry.
  forms: [
    { method: 'POST', path: paths.projects, fields: ['name=Apollo'] },
    { method: 'PUT', path: paths.project, fields: ['name=Renamed'] },
    { method: 'PATCH', path: paths.project, fields: ['name=Renamed'] },
    { method: 'DELETE', path: paths.project, fields: [] },
    { method: 'POST', path: paths.signIn, fields: ['email=ada%40example.com', 'password=correct'] },
    { method: 'POST', path: paths.orders, fields: ['address[city]=Oslo', 'lines[0][sku]=a', 'lines[0][quantity]=2'] },
  ],
  fields: ['name=', 'name=%20', 'visibility=public'],
  query: ['redirect=/projects/g1', 'visibility=public', 'name=x'],
})

const WRITE_STATEMENT = /^\s*(insert|update|delete)\b/i
const realmChanges = realmGuard()

async function send(sent: FuzzRequest<Person>): Promise<Refusal> {
  const { app, statements, observed, rows } = createApp()
  const env = sent.person === null ? testEnv({ ENVIRONMENT: 'production' }) : testEnv(signedIn({ id: sent.person }), { ENVIRONMENT: 'production' })
  const before = rows()
  const answer = await sendFuzzRequest(app, sent, env)

  if (answer === undefined) return undefined

  const after = rows()
  const status = answer.response.status
  const writes = statements.filter((statement) => WRITE_STATEMENT.test(statement))
  const defects = observed.filter((event) => event.kind === 'defect').length
  const madePublic = after.filter((row) => before.some((was) => was.id === row.id && was.visibility !== row.visibility))
  const broken = [
    ...brokenPromises(sent, answer),
    ...leaks(sent, answer, CANARIES),
    ...strangerWrites(sent, { before, after }, { id: (row) => row.id, owner: (row) => row.user_id }),
    ...madePublic.map((row) => `${sent.person ?? 'a visitor'} made ${row.id} ${row.visibility}`),
    ...(status >= 400 && writes.length > 0 ? [`answered ${status} after writing: ${writes.join('; ')}`] : []),
    ...(defects > 0 ? [`made ${defects} defects`] : []),
    ...[realmChanges()].filter((change) => change !== undefined),
  ]

  return broken.length === 0 ? undefined : `${sent.method} ${sent.path}${sent.query === '' ? '' : `?${sent.query}`}: ${broken.join('; ')}`
}

describe('any request', () => {
  property('gets an answer that keeps the framework’s rules', request, send, { runs: 400 })
})
