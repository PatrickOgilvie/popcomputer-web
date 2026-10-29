/**
 * Generated requests to a whole application, through setupWeb as a Worker
 * serves them: any method, path, query, body, Content-Type and headers a
 * browser, an API client or an attacker sends, from a visitor, ada or grace.
 * Whatever arrives, each answer keeps the rules the framework promises:
 *
 * - no request makes a defect or a 500, or changes the realm's built-ins;
 * - a refused request (4xx) writes nothing;
 * - no one but its owner sees, renames or deletes a private record, and no
 *   request moves a record to another owner or makes it public;
 * - a write another site's page sends, by its Origin or else its Referer,
 *   is refused with a 403 and writes nothing, unless it carries an
 *   Authorization scheme no browser attaches by itself, such as Bearer
 *   (src/security.ts's originRefusal, tests/security/cross-site.test.ts);
 * - a signed-in answer, or one that sets a cookie, is never kept by a shared
 *   cache (docs/page-cache.md);
 * - a JSON client gets every failure in the JSON envelope, and a 401 rather
 *   than a redirect to sign in (docs/json.md);
 * - an Inertia visit that changes something is redirected with a 303, which
 *   Inertia's protocol requires so the browser follows it with a GET.
 */
import { describe } from 'bun:test'
import { Arbitrary, Schema as S } from 'effect'
import { signedIn, testEnv } from '../../src/testing.js'
import { CANARIES, createApp, type Person, type ProjectRow } from './app'
import { oneOf, pick, property, show, textOf, type Refusal } from './property'
import { realmGuard } from './realm'

const PATHS = [
  '/projects/p1',
  '/projects/g1',
  '/projects/p2',
  '/projects/missing',
  '/projects',
  '/projects/p1/tasks/t1',
  '/projects/g1/tasks/t2',
  '/projects/p1/tasks/t2',
  '/showcase/p2',
  '/showcase/p1',
  '/showcase/g1',
  '/orgs/acme',
  '/orgs/globex',
  '/sign-in',
  '/search',
  '/orders',
  '/after-sign-in',
  '/',
] as const

/** A path spelled another way: encoded, doubled slashes, dot segments, other case. */
const craftedPath = Arbitrary.map(
  textOf(['/projects', '/', 'p1', 'g1', '%67%31', '%2f', '..', '.', '//', ';', '/tasks/', 't2', '/PROJECTS', '%2e%2e', '\\', '/orgs/', 'globex'], 6),
  (path) => (path.startsWith('/') ? path : `/${path}`)
)

const QUERY = textOf(
  ['q=a', 'page=2', 'redirect=/projects/g1', 'redirect=//evil.test', 'redirect=/%2e//evil.test', 'tags[]=x', 'tags[0]=y', 'project=g1', 'id=g1', 'userId=grace', 'user_id=grace', 'visibility=public', '_method=DELETE', '__proto__[x]=1', 'toString[a]=1', 'name=x', '&', '='],
  4
)

const FIELDS = [
  'name=Renamed',
  'name=',
  'name=%20',
  'name[]=a',
  'userId=grace',
  'user_id=grace',
  'id=g1',
  'visibility=public',
  'project=g1',
  '_method=DELETE',
  'email=ada%40example.com',
  'password=guess',
  'address[city]=Oslo',
  'lines[0][sku]=a',
  'lines[0][quantity]=2',
  'lines[9999][sku]=b',
  '__proto__[polluted]=1',
  'constructor[prototype][x]=1',
] as const

/** A body in each shape a client sends: a form, JSON of the same fields, multipart, or text no parser reads. */
const body = oneOf<BodyInit | undefined>(
  Arbitrary.Constant(undefined),
  Arbitrary.map(Arbitrary.array(pick(FIELDS), { maxLength: 5 }), (fields) => fields.join('&')),
  Arbitrary.map(Arbitrary.array(pick(FIELDS), { maxLength: 5 }), (fields) =>
    JSON.stringify(Object.fromEntries(new URLSearchParams(fields.join('&'))))
  ),
  Arbitrary.map(Arbitrary.array(pick(FIELDS), { maxLength: 5 }), (fields) => {
    const form = new FormData()

    for (const [key, value] of new URLSearchParams(fields.join('&'))) form.append(key, value)

    return form
  }),
  pick(['{"name":', '{"name":["a"]}', '{"name":{"a":1}}', '{"name":5}', '[]', 'null', 'name', '\u0000'])
)

const HEADERS = {
  accept: ['', 'application/json', 'text/html', '*/*', 'text/html,application/xhtml+xml', 'application/json, text/html'],
  'content-type': ['', 'application/x-www-form-urlencoded', 'application/json', 'multipart/form-data; boundary=x', 'text/plain', ' application/json', 'APPLICATION/JSON'],
  origin: ['', 'http://localhost', 'https://evil.test', 'null', 'http://localhost.evil.test', 'https://localhost'],
  referer: ['', 'http://localhost/projects/p1', 'https://evil.test/x', 'http://localhost//evil.test/'],
  'x-inertia': ['', 'true'],
  'x-inertia-version': ['', '1', '2'],
  'x-http-method-override': ['', 'DELETE', 'PUT'],
  authorization: ['', 'Bearer x', 'Basic eDp4'],
  'user-agent': ['', 'curl/8.0'],
  'sec-fetch-site': ['', 'same-origin', 'cross-site'],
  cookie: ['', 'session=x', 'better-auth.session_token=forged'],
} as const

const headers = Arbitrary.all({
  accept: pick(HEADERS.accept),
  'content-type': pick(HEADERS['content-type']),
  origin: pick(HEADERS.origin),
  referer: pick(HEADERS.referer),
  'x-inertia': pick(HEADERS['x-inertia']),
  'x-inertia-version': pick(HEADERS['x-inertia-version']),
  'x-http-method-override': pick(HEADERS['x-http-method-override']),
  authorization: pick(HEADERS.authorization),
  'user-agent': pick(HEADERS['user-agent']),
  'sec-fetch-site': pick(HEADERS['sec-fetch-site']),
  cookie: pick(HEADERS.cookie),
})

const request = Arbitrary.all({
  person: pick(['', 'ada', 'grace']),
  method: pick(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'post', 'patch', 'delete']),
  path: oneOf(pick(PATHS), craftedPath),
  query: QUERY,
  headers,
  body,
})

type GeneratedRequest = typeof request extends Arbitrary.Arbitrary<infer A> ? A : never

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const CROSS_SITE = new Set(['https://evil.test', 'null', 'http://localhost.evil.test', 'https://localhost'])
const WRITE_STATEMENT = /^\s*(insert|update|delete)\b/i
const Envelope = S.Struct({ code: S.String, tag: S.String, message: S.String, httpStatus: S.Number })

/** The origin a Referer names, or nothing for none. */
function originOf(referer: string): string {
  return URL.canParse(referer) ? new URL(referer).origin : ''
}

/** Every way the answer breaks a rule, empty when it keeps them all. */
function brokenRules(
  sent: GeneratedRequest,
  res: Response,
  text: string,
  writes: readonly string[],
  defects: number,
  before: readonly ProjectRow[],
  after: readonly ProjectRow[]
): string[] {
  const broken: string[] = []
  const method = sent.method.toUpperCase()
  const person = sent.person === '' ? undefined : sent.person
  const shown = `${text}\n${[...res.headers].map(([name, value]) => `${name}: ${value}`).join('\n')}`

  if (res.status >= 500 || defects > 0) broken.push(`answered ${res.status} with ${defects} defects`)
  if (res.status >= 400 && writes.length > 0) broken.push(`answered ${res.status} after writing: ${writes.join('; ')}`)

  for (const [owner, canary] of Object.entries(CANARIES)) {
    if (owner !== person && shown.includes(canary)) broken.push(`showed ${owner}'s private project to ${person ?? 'a visitor'}`)
  }

  for (const row of before) {
    const now = after.find((candidate) => candidate.id === row.id)

    if (now === undefined && person !== row.user_id) broken.push(`${person ?? 'a visitor'} deleted ${row.user_id}'s ${row.id}`)
    if (now !== undefined && now.name !== row.name && person !== row.user_id) broken.push(`${person ?? 'a visitor'} renamed ${row.user_id}'s ${row.id}`)
    if (now !== undefined && (now.user_id !== row.user_id || now.visibility !== row.visibility)) broken.push(`${row.id} became ${show(now)}`)
  }

  for (const row of after) {
    if (!before.some((candidate) => candidate.id === row.id) && row.user_id !== person) broken.push(`${person ?? 'a visitor'} created ${show(row)}`)
  }

  const from = sent.headers.origin === '' ? originOf(sent.headers.referer) : sent.headers.origin
  const forgeable = sent.headers.authorization === '' || sent.headers.authorization.startsWith('Basic ')

  if (WRITES.has(method) && CROSS_SITE.has(from) && forgeable && (res.status !== 403 || writes.length > 0)) {
    broken.push(`a write from ${from} answered ${res.status} after ${writes.length} writes`)
  }

  const cacheControl = res.headers.get('cache-control') ?? ''

  if ((person !== undefined || res.headers.has('set-cookie')) && (!/no-store|private/.test(cacheControl) || /public|s-maxage/.test(cacheControl))) {
    broken.push(`${person === undefined ? 'a cookie-setting' : 'a signed-in'} answer has Cache-Control ${show(cacheControl)}`)
  }

  if (sent.headers.accept === 'application/json' && sent.headers['x-inertia'] !== 'true') {
    if (res.status >= 400 && method !== 'HEAD') {
      const envelope = S.decodeUnknownExit(S.fromJsonString(Envelope))(text)

      if (envelope._tag === 'Failure' || envelope.value.httpStatus !== res.status) broken.push(`a JSON client's ${res.status} came as ${show(text.slice(0, 80))}`)
    }

    if (res.status >= 300 && res.status < 400 && (res.headers.get('location') ?? '').startsWith('/login')) {
      broken.push('a JSON client was sent to sign in')
    }
  }

  if (sent.headers['x-inertia'] === 'true' && ['PUT', 'PATCH', 'DELETE'].includes(method) && res.status >= 300 && res.status < 400 && res.status !== 303 && res.status !== 304) {
    broken.push(`an Inertia ${method} was redirected with ${res.status}`)
  }

  return broken
}

const realmChanges = realmGuard()

async function send(sent: GeneratedRequest): Promise<Refusal> {
  const { app, statements, observed, rows } = createApp()
  const init: RequestInit = { method: sent.method, headers: Object.fromEntries(Object.entries(sent.headers).filter(([, value]) => value !== '')) }
  const method = sent.method.toUpperCase()

  if (method !== 'GET' && method !== 'HEAD' && sent.body !== undefined) init.body = sent.body

  let req: Request

  try {
    req = new Request(`http://localhost${sent.path}${sent.query === '' ? '' : `?${sent.query}`}`, init)
  } catch {
    // A request fetch itself refuses to make never reaches the Worker.
    return undefined
  }

  const env = sent.person === '' ? testEnv({ ENVIRONMENT: 'production' }) : testEnv(signedIn({ id: sent.person satisfies Person }), { ENVIRONMENT: 'production' })
  const before = rows()
  const res = await app.request(req, undefined, env)
  const text = await res.text()
  const writes = statements.filter((statement) => WRITE_STATEMENT.test(statement))
  const defects = observed.filter((event) => event.kind === 'defect').length
  const broken = brokenRules(sent, res, text, writes, defects, before, rows())
  const realm = realmChanges()

  if (realm !== undefined) broken.push(realm)

  return broken.length === 0 ? undefined : `${method} ${sent.path}${sent.query === '' ? '' : `?${sent.query}`}: ${broken.join('; ')}`
}

describe('any request', () => {
  property('gets an answer that keeps the framework’s rules', request, send, { runs: 400 })
})
