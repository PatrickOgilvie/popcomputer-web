/**
 * Fuzzing an application: properties checked on inputs Effect generates
 * (`effect/Arbitrary`), requests generated from the application's declared
 * paths, and the rules every answer from the framework keeps.
 *
 * Each piece stands alone, so an application's own fuzz tests build on
 * them: `fuzz` checks any property, `fuzzRequest` generates hostile
 * requests to the application's routes, `sendFuzzRequest` sends one, and
 * `brokenPromises`, `leaks`, `strangerWrites` and `refusedWrites` say how an
 * answer broke a rule. A property returns why it refused an input, or
 * nothing when it holds.
 *
 * Each property runs a few hundred cases from a fixed seed, so a commit gate
 * is repeatable. `FUZZ_RUNS` sets the number of cases, `FUZZ_SEED=random`
 * picks a seed per run, and a failure prints the shrunk input, why the
 * property refused it, and a replay token for `FUZZ_REPLAY`, which runs that
 * case again.
 *
 * @example
 * ```ts
 * test('any request keeps the rules', () => fuzz(requests, async (sent) => {
 *   const answer = await sendFuzzRequest(app, sent, envFor(sent.person))
 *
 *   return answer === undefined ? [] : brokenPromises(sent, answer)
 * }), fuzzTimeout)
 * ```
 */
import { Arbitrary, Effect, Predicate, Schema as S, type SchemaAST } from 'effect'
import type { PathParamName } from './paths.js'
import type { TestApp, TestBindings } from './testing.js'

const configuredRuns = process.env.FUZZ_RUNS === undefined ? undefined : Number(process.env.FUZZ_RUNS)
// `random` picks a seed per run; the replay token a failure prints records it.
const seed = process.env.FUZZ_SEED === 'random' ? Date.now() : process.env.FUZZ_SEED ?? 'popweb'
const replay = process.env.FUZZ_REPLAY

/** Why a property refused an input, as one reason or a list of broken rules; undefined or an empty list when it holds. */
export type Refusal = string | ReadonlyArray<string> | undefined

export interface FuzzOptions {
  /** Cases to run, for a property whose cases are slow; `FUZZ_RUNS` overrides it. Default 300. */
  readonly runs?: number
}

/**
 * A test's time limit for `fuzz`: a minute for the cases a commit gate runs,
 * an hour when `FUZZ_RUNS` asks for more.
 */
export const fuzzTimeout = configuredRuns === undefined ? 60_000 : 3_600_000

/**
 * Check `holds` on generated inputs. Resolves when every case holds, and
 * rejects with the shrunk input, why `holds` refused it and a replay token
 * otherwise. Run it as a test of any runner:
 * `test(name, () => fuzz(arbitrary, holds), fuzzTimeout)`.
 */
export async function fuzz<A>(
  arbitrary: Arbitrary.Arbitrary<A>,
  holds: (value: A) => Refusal | Promise<Refusal>,
  options: FuzzOptions = {}
): Promise<void> {
  const reasonFor = async (value: A): Promise<string | undefined> => reasonOf(await holds(value))
  const result = await Effect.runPromise(
    Arbitrary.checkEffect(arbitrary, (value) => Effect.promise(async () => (await reasonFor(value)) === undefined), {
      runs: configuredRuns ?? options.runs ?? 300,
      seed,
      replay,
    })
  )

  if (result._tag === 'Passed') return

  const refusal = result._tag === 'Falsified' ? await reasonFor(result.shrunkInput) : undefined

  throw new Error([Arbitrary.formatCheckFailure(result), refusal && `Refused: ${refusal}`].filter(Boolean).join('\n'))
}

function reasonOf(refusal: Refusal): string | undefined {
  if (refusal === undefined || Predicate.isString(refusal)) return refusal

  return refusal.length === 0 ? undefined : refusal.join('; ')
}

/** One of `values`, shrinking toward the first. */
export function pick<const Values extends readonly [SchemaAST.LiteralValue, ...SchemaAST.LiteralValue[]]>(
  values: Values
): Arbitrary.Arbitrary<Values[number]> {
  return Arbitrary.schema(S.Literals(values), { shrink: (value) => values.slice(0, values.indexOf(value)) })
}

/** A value from one of `arbitraries`, shrinking toward the first. */
export function oneOf<A>(...arbitraries: readonly [Arbitrary.Arbitrary<A>, ...Arbitrary.Arbitrary<A>[]]): Arbitrary.Arbitrary<A> {
  const [, ...rest] = arbitraries

  return Arbitrary.flatMap(pick([0, ...rest.map((_, index) => index + 1)]), (index) => arbitraries[index])
}

/** One of the values, each as often as its weight says, shrinking toward the first. */
export function weighted<A>(...choices: readonly [readonly [A, number], ...(readonly [A, number])[]]): Arbitrary.Arbitrary<A> {
  const [first, ...rest] = choices.flatMap(([value, weight]) => Array.from({ length: weight }, () => Arbitrary.Constant(value)))

  return first === undefined ? Arbitrary.Constant(choices[0][0]) : oneOf(first, ...rest)
}

/** Text made of the given pieces, up to `maxPieces` of them. */
export function textOf(pieces: readonly [string, ...string[]], maxPieces = 8): Arbitrary.Arbitrary<string> {
  return Arbitrary.map(Arbitrary.array(pick(pieces), { maxLength: maxPieces }), (chosen) => chosen.join(''))
}

/** Any string, as Effect generates `Schema.String`. */
export const anyText: Arbitrary.Arbitrary<string> = Arbitrary.schema(S.String)

/** A value as JSON with every character outside printable ASCII escaped, so U+00A0 never reads as a space. */
export function show<A>(value: A): string {
  return (JSON.stringify(value) ?? String(value)).replace(
    /[^\x20-\x7e]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

/** The objects every request in a realm shares, by name. */
const INTRINSICS: ReadonlyArray<readonly [string, object]> = [
  ['Object', Object],
  ['Function', Function],
  ['Array', Array],
  ['String', String],
  ['Number', Number],
  ['Boolean', Boolean],
  ['Symbol', Symbol],
  ['Object.prototype', Object.prototype],
  ['Function.prototype', Function.prototype],
  ['Array.prototype', Array.prototype],
  ['String.prototype', String.prototype],
]

/**
 * A check that a call left the realm's shared built-ins as they were, for
 * code that reads names a visitor chose, such as nested form fields: a
 * value written onto `Object.prototype` reaches every later request in the
 * isolate. It records the own keys of each shared intrinsic, and of each
 * object hanging from one; the function it returns names what was added
 * since and takes it away again, since a change left in place would fail
 * every later case and shrinking could not find the input that made it.
 */
export function realmGuard(): () => string | undefined {
  const shared = new Map<object, string>()

  for (const [name, root] of INTRINSICS) {
    shared.set(root, name)

    for (const key of Reflect.ownKeys(root)) {
      const value: unknown = Object.getOwnPropertyDescriptor(root, key)?.value

      if (Predicate.isObjectKeyword(value) && !shared.has(value)) shared.set(value, `${name}.${String(key)}`)
    }
  }

  const before = [...shared].map(([object, name]) => ({ object, name, keys: new Set(Reflect.ownKeys(object)) }))

  return () => {
    const added: string[] = []

    for (const { object, name, keys } of before) {
      for (const key of Reflect.ownKeys(object)) {
        if (keys.has(key)) continue

        added.push(`${name}.${String(key)}`)
        Reflect.deleteProperty(object, key)
      }
    }

    return added.length === 0 ? undefined : `wrote ${added.join(', ')} on the realm's built-ins`
  }
}

/** A request body in one of the shapes a client sends, its fields as `name=value` pairs. */
export type FuzzBody =
  | { readonly as: 'none' }
  | { readonly as: 'form' | 'json' | 'multipart'; readonly fields: ReadonlyArray<string> }
  | { readonly as: 'text'; readonly text: string }

/** A generated request, from one of the application's people or, as `null`, a signed-out visitor. */
export interface FuzzRequest<Person extends string = string> {
  readonly person: Person | null
  readonly method: string
  readonly path: string
  readonly query: string
  /** Headers by lowercase name; an empty value sends none. */
  readonly headers: Readonly<Record<string, string>>
  readonly body: FuzzBody
}

type Values = readonly [string, ...string[]]

/** A request one of the application's actions accepts: its method, its declared path, and fields that pass its validation. */
export interface FuzzForm<Path extends string = string> {
  readonly method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly path: Path
  /** The fields, as `name=value`. */
  readonly fields: ReadonlyArray<string>
}

export interface FuzzRequestOptions<Paths extends Readonly<Record<string, string>>, Person extends string> {
  /** The application's declared paths, the object `src/paths.ts` exports. */
  readonly paths: Paths
  /**
   * The values to try in each placeholder: each person's records, a public
   * one and a missing one, so requests reach records their sender may and
   * may not load.
   */
  readonly params: { readonly [Name in PathParamName<Paths[keyof Paths]>]: Values }
  /** The people who send requests, besides a signed-out visitor: the ids the test signs in. */
  readonly people: readonly [Person, ...Person[]]
  /**
   * The application's forms, each as a request its action accepts, so
   * generated writes reach the code behind validation, from each person, to
   * each record, with fields added.
   */
  readonly forms?: ReadonlyArray<FuzzForm<Paths[keyof Paths]>>
  /** Fields the application's actions read, as `name=value`, beside the ones every request may carry. */
  readonly fields?: ReadonlyArray<string>
  /** Query parameters the application reads, as `name=value`, likewise. */
  readonly query?: ReadonlyArray<string>
  /** The site's origin. Default `http://localhost`, the origin `app.request` gives a path. */
  readonly origin?: string
}

/** Methods by how often a client sends them, with spellings a router may read apart. */
const METHODS: readonly [readonly [string, number], ...(readonly [string, number])[]] = [
  ['GET', 4], ['POST', 2], ['PUT', 2], ['PATCH', 1], ['DELETE', 2], ['HEAD', 1], ['OPTIONS', 1], ['post', 1], ['patch', 1], ['delete', 1],
]

/** Path spellings a router, a decoder or a cache may read another way. */
const PATH_PIECES = ['/', '//', '..', '.', '%2f', '%2e%2e', ';', '\\'] as const

/** Query parameters any application may be sent: redirects off the site, nested keys, names of built-ins. */
const QUERY_PIECES = ['q=a', 'page=2', 'redirect=//evil.test', 'redirect=/%2e//evil.test', 'tags[]=x', 'tags[0]=y', '_method=DELETE', '__proto__[x]=1', 'toString[a]=1', '&', '='] as const

/** Fields any form may be sent: a method override, nesting, names of built-ins, credentials. */
const FIELD_PIECES = ['_method=DELETE', 'name[]=a', 'email=ada%40example.com', 'password=guess', 'lines[9999][sku]=b', '__proto__[polluted]=1', 'constructor[prototype][x]=1'] as const

/** Bodies no form encodes: JSON cut short, values of the wrong type, a NUL. */
const RAW_BODIES = ['{"name":', '{"name":["a"]}', '{"name":{"a":1}}', '{"name":5}', '[]', 'null', 'name', '\u0000'] as const

/** The Content-Type that names the body's shape; multipart's comes with its boundary from the body itself. */
const MATCHING_TYPE = {
  none: '',
  form: 'application/x-www-form-urlencoded',
  json: 'application/json',
  multipart: '',
  text: 'text/plain',
} satisfies Readonly<Record<FuzzBody['as'], string>>

/** The Content-Type header's stand-in for the type that names the body's shape. */
const MATCHING = '(matching)'

const placeholder = /\{([^}:]+)(?::[^}]+)?\}/g

/** The path's placeholder names, in order. */
function placeholdersOf(path: string): string[] {
  return [...path.matchAll(placeholder)].map((match) => match[1])
}

/** A value with its first character percent-encoded, which decodes to the same value. */
function encodedFirst(value: string): string {
  return `%${value.charCodeAt(0).toString(16).padStart(2, '0')}${value.slice(1)}`
}

/** The values, without repeats, as a list `pick` and `textOf` take: never empty. */
function nonEmpty(values: ReadonlyArray<string>, fallback: string): readonly [string, ...string[]] {
  const [first = fallback, ...rest] = [...new Set(values)]

  return [first, ...rest]
}

/** A list of fixed pieces with the ones a person's id, a parameter's values and the application's own fields add. */
function pieces(fixed: readonly [string, ...string[]], added: readonly string[]): readonly [string, ...string[]] {
  return nonEmpty([...fixed, ...added], fixed[0])
}

/** Where a request goes, and the fields of the form it fills, if any. */
interface Target {
  readonly method: string
  readonly path: string
  readonly form: ReadonlyArray<string>
}

/**
 * Requests to the application's routes, as a browser, an API client or an
 * attacker sends them: any method, each declared path with each of its
 * placeholders' values, the same paths spelled another way, each form with
 * fields added, queries, bodies in every shape, and headers from this site
 * and others, from each person and a signed-out visitor. Most requests are
 * ones a browser on the site would send, so they reach their actions; the
 * rest test the refusals. Wrap or map the generator for more.
 */
export function fuzzRequest<const Paths extends Readonly<Record<string, string>>, const Person extends string>(
  options: FuzzRequestOptions<Paths, Person>
): Arbitrary.Arbitrary<FuzzRequest<Person>> {
  const origin = options.origin ?? 'http://localhost'
  const templates = nonEmpty(Object.values(options.paths), '/')
  const params: Readonly<Record<string, Values>> = options.params
  const valuesOf = (name: string): Values => (Object.hasOwn(params, name) ? params[name] : ['x'])
  const paramValues = Object.keys(params).flatMap((name) => params[name])

  /** The template with each placeholder filled by one of its values. */
  const filled = (template: string): Arbitrary.Arbitrary<string> =>
    Arbitrary.map(
      Arbitrary.all(Object.fromEntries(placeholdersOf(template).map((name) => [name, pick(valuesOf(name))]))),
      (values: Readonly<Record<string, string>>) => template.replace(placeholder, (_match, name: string) => encodeURIComponent(values[name] ?? 'x'))
    )

  const method = weighted(...METHODS)
  const declared = Arbitrary.flatMap(pick(templates), (template) =>
    Arbitrary.map(Arbitrary.all({ method, path: filled(template) }), (target): Target => ({ ...target, form: [] }))
  )

  const segments = templates.flatMap((template) => template.split('/').filter((segment) => segment !== '' && !segment.startsWith('{')).map((segment) => `/${segment}`))
  const craftedPath = Arbitrary.map(
    textOf(pieces(PATH_PIECES, [...segments, ...segments.map((segment) => segment.toUpperCase()), ...paramValues, ...paramValues.map(encodedFirst)]), 6),
    (path) => (path.startsWith('/') ? path : `/${path}`)
  )
  const crafted = Arbitrary.map(Arbitrary.all({ method, path: craftedPath }), (target): Target => ({ ...target, form: [] }))

  const [firstForm, ...otherForms] = options.forms ?? []
  const forms = firstForm === undefined
    ? undefined
    : Arbitrary.flatMap(oneOf(Arbitrary.Constant(firstForm), ...otherForms.map((form) => Arbitrary.Constant(form))), (form) =>
        Arbitrary.map(filled(form.path), (path): Target => ({ method: form.method, path, form: form.fields }))
      )
  const target = forms === undefined ? oneOf(declared, declared, declared, crafted) : oneOf(declared, forms, forms, declared, crafted)

  const asFields = [
    ...Object.keys(params).flatMap((name) => params[name].flatMap((value) => [`${name}=${value}`, `id=${value}`])),
    ...options.people.flatMap((person) => [`userId=${person}`, `user_id=${person}`]),
  ]
  const added = Arbitrary.array(pick(pieces(FIELD_PIECES, [...asFields, ...(options.fields ?? [])])), { maxLength: 3 })
  const encoding = oneOf<FuzzBody['as']>(
    Arbitrary.Constant('form'),
    Arbitrary.Constant('json'),
    Arbitrary.Constant('multipart'),
    Arbitrary.Constant('none'),
    Arbitrary.Constant('text')
  )

  const host = URL.canParse(origin) ? new URL(origin).host : 'localhost'
  const otherScheme = origin.startsWith('https:') ? origin.replace('https:', 'http:') : origin.replace('http:', 'https:')
  const firstPath = templates[0].replace(placeholder, (_match, name: string) => valuesOf(name)[0])
  // Each header mostly as a browser on this site sends it, and otherwise each way that tests a refusal.
  const headers = Arbitrary.all({
    accept: weighted(['', 2], ['application/json', 2], ['text/html', 1], ['*/*', 1], ['text/html,application/xhtml+xml', 1], ['application/json, text/html', 1]),
    'content-type': weighted([MATCHING, 6], ['', 1], ['application/x-www-form-urlencoded', 1], ['application/json', 1], ['multipart/form-data; boundary=x', 1], ['text/plain', 1], [' application/json', 1], ['APPLICATION/JSON', 1]),
    origin: weighted(['', 3], [origin, 3], ['https://evil.test', 1], ['null', 1], [`http://${host}.evil.test`, 1], [otherScheme, 1]),
    referer: weighted(['', 3], [`${origin}${firstPath}`, 3], ['https://evil.test/x', 1], [`${origin}//evil.test/`, 1]),
    'x-inertia': pick(['', 'true']),
    'x-inertia-version': weighted(['', 3], ['1', 1], ['stale', 1]),
    'x-http-method-override': weighted(['', 4], ['DELETE', 1], ['PUT', 1]),
    authorization: weighted(['', 4], ['Bearer x', 1], ['Basic eDp4', 1]),
    'user-agent': pick(['', 'curl/8.0']),
    'sec-fetch-site': weighted(['', 3], ['same-origin', 1], ['cross-site', 1]),
    cookie: weighted(['', 4], ['session=x', 1], ['better-auth.session_token=forged', 1]),
  })

  const person = oneOf<Person | null>(Arbitrary.Constant(null), ...options.people.map((each) => Arbitrary.Constant(each)))

  return Arbitrary.map(
    Arbitrary.all({
      person,
      target,
      query: textOf(pieces(QUERY_PIECES, [...asFields, ...(options.query ?? [])]), 4),
      headers,
      encoding,
      added,
      text: pick(RAW_BODIES),
    }),
    (parts): FuzzRequest<Person> => {
      const fields = [...parts.target.form, ...parts.added]
      const body: FuzzBody = parts.encoding === 'none' ? { as: 'none' } : parts.encoding === 'text' ? { as: 'text', text: parts.text } : { as: parts.encoding, fields }
      const contentType = parts.headers['content-type'] === MATCHING ? MATCHING_TYPE[parts.encoding] : parts.headers['content-type']

      return {
        person: parts.person,
        method: parts.target.method,
        path: parts.target.path,
        query: parts.query,
        headers: { ...parts.headers, 'content-type': contentType },
        body,
      }
    }
  )
}

/** The fields' entries, as a form encodes them. */
function entriesOf(fields: ReadonlyArray<string>): Array<[string, string]> {
  return [...new URLSearchParams(fields.join('&'))]
}

function bodyInit(body: FuzzBody): BodyInit | undefined {
  switch (body.as) {
    case 'none':
      return undefined
    case 'form':
      return body.fields.join('&')
    case 'json':
      return JSON.stringify(Object.fromEntries(entriesOf(body.fields)))
    case 'multipart': {
      const form = new FormData()

      for (const [key, value] of entriesOf(body.fields)) form.append(key, value)

      return form
    }
    case 'text':
      return body.text
  }
}

/** The URL and init of the request `sent` describes. */
function partsOf(sent: FuzzRequest, origin: string) {
  const method = sent.method.toUpperCase()
  const body = method === 'GET' || method === 'HEAD' ? undefined : bodyInit(sent.body)
  const init: RequestInit = { method: sent.method, headers: Object.fromEntries(Object.entries(sent.headers).filter(([, value]) => value !== '')) }

  if (body !== undefined) init.body = body

  return { url: `${origin}${sent.path}${sent.query === '' ? '' : `?${sent.query}`}`, init }
}

/** The request `sent` describes, or nothing when `fetch` itself refuses to make it: it never reaches a Worker. */
export function requestOf(sent: FuzzRequest, origin = 'http://localhost'): Request | undefined {
  const { url, init } = partsOf(sent, origin)

  try {
    return new Request(url, init)
  } catch {
    return undefined
  }
}

/** An answer to a generated request: its response, and the body read once. */
export interface FuzzAnswer {
  readonly response: Response
  readonly text: string
}

/**
 * Send `sent` through the application with `env`, the bindings for its
 * person: `testEnv(signedIn(row), bindings)` for a member, `testEnv(bindings)`
 * for a visitor. Nothing when `fetch` refuses to make the request.
 */
export async function sendFuzzRequest(
  app: TestApp,
  sent: FuzzRequest,
  env: TestBindings,
  origin = 'http://localhost'
): Promise<FuzzAnswer | undefined> {
  if (requestOf(sent, origin) === undefined) return undefined

  const { url, init } = partsOf(sent, origin)
  const response = await app.request(url, init, env)

  return { response, text: await response.text() }
}

export interface PromisesOptions {
  /** The site's origin. Default `http://localhost`. */
  readonly origin?: string
  /** Where a signed-out visitor is sent to sign in: `auth.signInPath`. Default `/login`. */
  readonly signInPath?: string
}

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const Envelope = S.Struct({ code: S.String, tag: S.String, message: S.String, httpStatus: S.Number })

/** The origin a Referer names, or nothing for none. */
function originOf(referer: string): string {
  return URL.canParse(referer) ? new URL(referer).origin : ''
}

/**
 * How an answer breaks the rules the framework keeps for every
 * application, empty when it keeps them all:
 *
 * - no request is answered with a 500 or another server error;
 * - a write another site's page sends, by its Origin or else its Referer,
 *   is refused with a 403, unless it carries an Authorization scheme no
 *   browser attaches by itself, such as Bearer;
 * - an answer to a signed-in person, or one that sets a cookie, is never
 *   kept by a shared cache;
 * - a JSON client gets every failure in the JSON envelope, and is never
 *   sent to sign in;
 * - an Inertia visit that changes something is redirected with a 303.
 */
export function brokenPromises(sent: FuzzRequest, answer: FuzzAnswer, options: PromisesOptions = {}): string[] {
  const broken: string[] = []
  const origin = options.origin ?? 'http://localhost'
  const signInPath = options.signInPath ?? '/login'
  const { response, text } = answer
  const method = sent.method.toUpperCase()
  const header = (name: string) => sent.headers[name] ?? ''

  if (response.status >= 500) broken.push(`answered ${response.status}`)

  const from = header('origin') === '' ? originOf(header('referer')) : header('origin')
  const forgeable = header('authorization') === '' || header('authorization').startsWith('Basic ')

  if (WRITES.has(method) && from !== '' && from !== origin && forgeable && response.status !== 403) {
    broken.push(`a write from ${from} answered ${response.status}, not 403`)
  }

  const cacheControl = response.headers.get('cache-control') ?? ''

  if ((sent.person !== null || response.headers.has('set-cookie')) && (!/no-store|private/.test(cacheControl) || /public|s-maxage/.test(cacheControl))) {
    broken.push(`${sent.person === null ? 'a cookie-setting' : 'a signed-in'} answer has Cache-Control ${show(cacheControl)}`)
  }

  if (header('accept') === 'application/json' && header('x-inertia') !== 'true') {
    if (response.status >= 400 && method !== 'HEAD') {
      const envelope = S.decodeUnknownExit(S.fromJsonString(Envelope))(text)

      if (envelope._tag === 'Failure' || envelope.value.httpStatus !== response.status) {
        broken.push(`a JSON client's ${response.status} came as ${show(text.slice(0, 80))}`)
      }
    }

    const location = response.headers.get('location') ?? ''

    if (response.status >= 300 && response.status < 400 && URL.canParse(location, origin) && new URL(location, origin).pathname === signInPath) {
      broken.push('a JSON client was sent to sign in')
    }
  }

  if (header('x-inertia') === 'true' && ['PUT', 'PATCH', 'DELETE'].includes(method) && response.status >= 300 && response.status < 400 && response.status !== 303 && response.status !== 304) {
    broken.push(`an Inertia ${method} was redirected with ${response.status}`)
  }

  return broken
}

/**
 * Each private text the answer shows, in its body or its headers, to anyone
 * but the person it belongs to: `canaries` gives each person text only their
 * own records hold, such as the name of a private project.
 */
export function leaks<Person extends string>(
  sent: FuzzRequest<Person>,
  answer: FuzzAnswer,
  canaries: Readonly<Record<Person, string | ReadonlyArray<string>>>
): string[] {
  const headers: string[] = []

  answer.response.headers.forEach((value, name) => void headers.push(`${name}: ${value}`))

  const shown = `${answer.text}\n${headers.join('\n')}`
  const owned: ReadonlyArray<readonly [string, string | ReadonlyArray<string>]> = Object.entries(canaries)

  return owned.flatMap(([owner, texts]) =>
    owner === sent.person
      ? []
      : (Predicate.isString(texts) ? [texts] : texts).filter((text) => shown.includes(text)).map((text) => `showed ${owner}'s ${show(text)} to ${sent.person ?? 'a visitor'}`)
  )
}

/** A table's rows before a request and after it. */
export interface RowsChange<Row> {
  readonly before: ReadonlyArray<Row>
  readonly after: ReadonlyArray<Row>
}

/**
 * Each change to the rows that someone other than their owner made: a row
 * deleted or changed by someone else, a row moved to another owner, or a
 * row created for someone other than the sender.
 */
export function strangerWrites<Row>(
  sent: FuzzRequest,
  rows: RowsChange<Row>,
  keys: { readonly id: (row: Row) => string; readonly owner: (row: Row) => string }
): string[] {
  const broken: string[] = []
  const sender = sent.person ?? 'a visitor'

  for (const row of rows.before) {
    const now = rows.after.find((candidate) => keys.id(candidate) === keys.id(row))
    const owner = keys.owner(row)

    if (now === undefined && sent.person !== owner) broken.push(`${sender} deleted ${owner}'s ${keys.id(row)}`)
    if (now !== undefined && keys.owner(now) !== owner) broken.push(`${sender} moved ${owner}'s ${keys.id(row)} to ${keys.owner(now)}`)
    else if (now !== undefined && show(now) !== show(row) && sent.person !== owner) broken.push(`${sender} changed ${owner}'s ${keys.id(row)} to ${show(now)}`)
  }

  for (const row of rows.after) {
    if (!rows.before.some((candidate) => keys.id(candidate) === keys.id(row)) && keys.owner(row) !== sent.person) {
      broken.push(`${sender} created ${show(row)}`)
    }
  }

  return broken
}

/** The change a refused request (4xx) made to the rows, which should be none. */
export function refusedWrites<Row>(answer: FuzzAnswer, rows: RowsChange<Row>): string[] {
  const status = answer.response.status

  return status >= 400 && status < 500 && show(rows.before) !== show(rows.after) ? [`answered ${status} after changing ${show(rows.before)} to ${show(rows.after)}`] : []
}
