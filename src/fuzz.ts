/**
 * Fuzzing an application: properties checked on inputs Effect generates
 * (`effect/Arbitrary`), requests generated from the application's declared
 * paths, and the rules every answer from the framework keeps.
 *
 * Each piece stands alone, so an application's own fuzz tests build on
 * them: `fuzz` checks any property, `stepsOf` generates sequences of a
 * lifecycle's steps, `fuzzRequest` generates hostile requests to the
 * application's routes, `sendFuzzRequest` sends one, and `brokenPromises`,
 * `leaks`, `strangerWrites` and `refusedWrites` say how an answer broke a
 * rule. A property returns why it refused an input, or
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
import { Arbitrary, Effect, Option, Predicate, Schema as S, type SchemaAST } from 'effect'
import type { PathParamName } from './paths.js'
import type { RouteModelMetadata, RouteRegistry, RouteRow } from './effect/route-registry.js'
import type { EffectErrorEvent } from './effect/error-observer.js'
import { observingEnv } from './effect/test-env.js'
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
  // A property that throws, as an `expect` or the code under test does,
  // refuses its input like any other, so the failure shrinks and replays.
  const reasonFor = async (value: A): Promise<string | undefined> => {
    try {
      return reasonOf(await holds(value))
    } catch (error) {
      return `threw ${error instanceof Error ? `${error.name}: ${error.message}` : show(error)}`
    }
  }
  const result = await Effect.runPromise(
    Arbitrary.checkEffect(arbitrary, (value) => Effect.promise(async () => (await reasonFor(value)) === undefined), {
      runs: configuredRuns ?? options.runs ?? 300,
      seed,
      replay,
    })
  )

  if (result._tag === 'Passed') return

  // A case that holds when run again failed on what the cases before it left, or by chance.
  const refusal = result._tag === 'Falsified'
    ? (await reasonFor(result.shrunkInput)) ?? 'nothing when run again, so the case fails only after the cases before it or by chance, and FUZZ_REPLAY will not reproduce it: start each case from fresh state'
    : undefined

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

export interface StepsOptions {
  /** The most steps a sequence holds. Default 12. */
  readonly maxLength?: number
}

/** The whole numbers from `first` to `last`, as a list `S.Literals` takes. */
function upTo(first: number, last: number): readonly [number, ...number[]] {
  return [first, ...Array.from({ length: Math.max(0, last - first) }, (_, index) => first + index + 1)]
}

/**
 * Whether a slot holds its step. Effect keeps only shrinks its schema could
 * generate, so one slot in 16 holds none, and every other shrinks to none.
 */
const held = Arbitrary.schema(S.Literals(upTo(0, 15)), { shrink: (value) => (value === 0 ? [] : [0]) })

/**
 * Sequences of `step`, for state that lasts between requests: a lifecycle's
 * steps, as `pick(['finish', 'invoice', 'signOff'])`, or a record whose
 * fields are each generated, as `{ act: pick([...]), quantity: pick([...]) }`.
 * Each sequence's length is drawn evenly from none to `maxLength`, so most
 * are long enough to take a lifecycle down a path several steps deep. A
 * failing sequence shrinks by dropping each step it does not need, and then
 * each step toward its first choice.
 */
export function stepsOf<A>(step: Arbitrary.Arbitrary<A>, options?: StepsOptions): Arbitrary.Arbitrary<Array<A>>
export function stepsOf<Fields extends Readonly<Record<string, Arbitrary.Arbitrary<unknown>>>>(
  fields: Fields,
  options?: StepsOptions
): Arbitrary.Arbitrary<Array<{ readonly [Name in keyof Fields]: Fields[Name] extends Arbitrary.Arbitrary<infer A> ? A : never }>>
export function stepsOf(
  step: Arbitrary.Arbitrary<unknown> | Readonly<Record<string, Arbitrary.Arbitrary<unknown>>>,
  options: StepsOptions = {}
): Arbitrary.Arbitrary<Array<unknown>> {
  const maxLength = options.maxLength ?? 12

  if (!Number.isSafeInteger(maxLength) || maxLength < 0) throw new RangeError(`stepsOf: maxLength must be a whole number, not ${maxLength}`)

  const each = Arbitrary.isArbitrary(step) ? step : Arbitrary.all(step)
  const slot = Arbitrary.flatMap(held, (holds) => (holds === 0 ? Arbitrary.Constant<Array<unknown>>([]) : Arbitrary.map(each, (value) => [value])))
  // `Arbitrary.array` grows with the check's size, from none in its first run
  // to ten in its last, whatever its maxLength. The length is drawn here and
  // never shrinks: dropping a slot's step shrinks the sequence instead.
  const length = Arbitrary.schema(S.Literals(upTo(0, maxLength)))

  return Arbitrary.flatMap(length, (count) => Arbitrary.map(Arbitrary.all(Array.from({ length: count }, () => slot)), (slots) => slots.flat()))
}

/** Text made of the given pieces, up to `maxPieces` of them. */
export function textOf(pieces: readonly [string, ...string[]], maxPieces = 8): Arbitrary.Arbitrary<string> {
  return Arbitrary.map(stepsOf(pick(pieces), { maxLength: maxPieces }), (chosen) => chosen.join(''))
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

/** The application's routes, as the `routes` setupWeb returns hold their table. */
export interface FuzzRoutes {
  readonly getRegistry: () => RouteRegistry
}

export interface FuzzRequestOptions<Paths extends Readonly<Record<string, string>>, Person extends string> {
  /** The application's declared paths, the object `src/paths.ts` exports. */
  readonly paths: Paths
  /**
   * The application's routes, the `routes` setupWeb returns: each route
   * that writes becomes a form, its method and path with fields generated to
   * pass the schema its action declares with `form(Schema)`, so a new
   * action is fuzzed with no line here. `forms` adds what it cannot
   * generate, such as a file, or the fields of an action that reads its
   * input with `validateRequest`.
   */
  readonly routes?: FuzzRoutes
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

/** A form to send: its method, its path, and the fields its action accepts. */
interface FormTarget {
  readonly method: string
  readonly path: string
  readonly fields: Arbitrary.Arbitrary<ReadonlyArray<string>>
}

const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete'])

/**
 * Values a form field's validator is tried against when Effect cannot
 * generate one that passes it, such as an email's or a date's, whose checks
 * it meets only by trial.
 */
const FIELD_SAMPLES = [
  'Apollo', 'ada@example.com', '2030-05-01', '2030-05-01T09:00:00Z', '1', '12', 'on', 'true', 'a-b',
  '6f9619ff-8b86-4d11-b42d-00c04fc964ff', 'correct horse battery',
] as const

/** A form value URL-encoded, with a lone surrogate, which no URL can carry, read as the replacement character. */
function formEncoded(value: string): string {
  try {
    return encodeURIComponent(value)
  } catch {
    return encodeURIComponent(value.replace(/[\uD800-\uDFFF]/g, '\uFFFD'))
  }
}

/** A field's encoded value as the `name=value` pieces a form posts, nested by brackets as browsers name them. */
function pairsOf(name: string, value: unknown): string[] {
  if (value === undefined) return []
  if (value === null) return [`${name}=`]
  if (Array.isArray(value)) return value.flatMap((item: unknown, index) => pairsOf(`${name}[${index}]`, item))
  if (value instanceof Date) return [`${name}=${formEncoded(value.toISOString())}`]
  if (Predicate.isObject(value)) return Object.entries(value).flatMap(([key, item]) => pairsOf(`${name}[${key}]`, item))

  return [`${name}=${formEncoded(String(value))}`]
}

/** A form field's validator, which decodes without services, as the framework's validators do. */
type FieldSchema = S.Codec<unknown, unknown, never, never>

/** A struct schema's fields, each a schema, as a form nests them. */
function structFields(schema: unknown): ReadonlyArray<readonly [string, FieldSchema]> | undefined {
  if (!Predicate.hasProperty(schema, 'fields') || !Predicate.isObject(schema.fields)) return undefined

  // SAFETY: a form's fields decode without services, which validateRequest gives none.
  return Object.entries(schema.fields).flatMap(([name, field]: [string, unknown]) => (S.isSchema(field) ? [[name, field as FieldSchema] as const] : []))
}

/** A list schema's item, as a form numbers its entries. */
function listItem(schema: FieldSchema): FieldSchema | undefined {
  // SAFETY: a list of a form's fields decodes its items without services too.
  return schema.ast._tag === 'Arrays' && Predicate.hasProperty(schema, 'value') && S.isSchema(schema.value) ? schema.value as FieldSchema : undefined
}

/**
 * Encoded values that pass a form field's validator, as the form sends
 * them: a struct's field by field, a list's one to three items, and any
 * other generated from its schema where Effect can and checked as the
 * string a form sends, else one of the samples it accepts, else none,
 * which leaves the field out.
 */
function fieldValues(field: FieldSchema): Arbitrary.Arbitrary<unknown> {
  const fields = structFields(field)

  if (fields !== undefined) return Arbitrary.all(Object.fromEntries(fields.map(([name, each]) => [name, fieldValues(each)])))

  const item = listItem(field)

  if (item !== undefined) {
    return Arbitrary.map(Arbitrary.all({ first: fieldValues(item), rest: stepsOf(fieldValues(item), { maxLength: 2 }) }), ({ first, rest }) => [first, ...rest])
  }

  const samples = FIELD_SAMPLES.filter((sample) => Option.isSome(S.decodeUnknownOption(field)(sample)))
  const [firstSample, ...otherSamples] = samples.map((sample) => Arbitrary.Constant<unknown>(sample))
  const sampled = firstSample === undefined ? Arbitrary.Constant<unknown>(undefined) : oneOf(firstSample, ...otherSamples)

  try {
    const generated = Arbitrary.schema(S.toType(field))

    // A check Effect meets only by trial may exhaust its tries mid-run: try it first.
    Effect.runSync(Arbitrary.sampleEffect(generated, { count: 20, seed: 'popweb' }))

    return Arbitrary.map(generated, (value) => {
      const encoded = Option.getOrUndefined(S.encodeUnknownOption(field)(value))
      const sent = encoded === null || Predicate.isObject(encoded) ? encoded : String(encoded)

      return encoded === undefined || (sent !== null && Option.isNone(S.decodeUnknownOption(field)(sent))) ? samples[0] : encoded
    })
  } catch {
    return sampled
  }
}

/** Fields that pass a form's schema: a struct's, generated field by field, or one member's of a union. */
function fieldsOf(schema: unknown): Arbitrary.Arbitrary<ReadonlyArray<string>> {
  const fields = structFields(schema)

  if (fields !== undefined) {
    return Arbitrary.map(
      Arbitrary.all(Object.fromEntries(fields.map(([name, field]) => [name, fieldValues(field)]))),
      (values: Readonly<Record<string, unknown>>) => Object.entries(values).flatMap(([name, value]) => pairsOf(name, value))
    )
  }

  if (Predicate.hasProperty(schema, 'members') && Array.isArray(schema.members)) {
    const [first, ...others] = schema.members.map((member: unknown) => fieldsOf(member))

    if (first !== undefined) return oneOf(first, ...others)
  }

  return Arbitrary.Constant<ReadonlyArray<string>>([])
}

/** A form for each route that writes, but an endpoint's, whose body its contract declares as JSON. */
function formsOfRoutes(routes: ReadonlyArray<RouteRow>): FormTarget[] {
  return routes
    .filter((route) => WRITE_METHODS.has(route.method) && route.endpoint === undefined)
    .map((route) => ({
      method: route.method.toUpperCase(),
      path: route.routePath,
      fields: route.input === undefined ? Arbitrary.Constant<ReadonlyArray<string>>([]) : fieldsOf(route.input.schema),
    }))
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

/** The headers a generated request may carry, by lowercase name. */
const HEADER_NAMES = ['accept', 'content-type', 'origin', 'referer', 'x-inertia', 'x-inertia-version', 'x-http-method-override', 'authorization', 'user-agent', 'sec-fetch-site', 'cookie'] as const
type HeaderName = (typeof HEADER_NAMES)[number]

/** The parts of a request a generated one may send otherwise than a browser on the site does. */
type Part = 'target' | 'query' | 'body' | 'fields' | HeaderName

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

/**
 * One piece: half the time one of the fixed pieces, which test what any
 * application may be sent, and otherwise one that a person's id, a
 * parameter's values or the application's own fields add, so the fixed ones
 * stay as likely however many the application adds.
 */
function pieceOf(fixed: readonly [string, ...string[]], added: readonly string[]): Arbitrary.Arbitrary<string> {
  const [first, ...rest] = [...new Set(added)].filter((value) => !fixed.includes(value))

  return first === undefined ? pick(fixed) : oneOf(pick(fixed), pick([first, ...rest]))
}

/**
 * A query of up to `maxPieces` of the pieces, each its own parameter, so a
 * piece such as `redirect=//evil.test` reaches the code that reads it. The
 * pieces `&` and `=` still make the odd spellings.
 */
function queryOf(piece: Arbitrary.Arbitrary<string>, maxPieces: number): Arbitrary.Arbitrary<string> {
  return Arbitrary.map(stepsOf(piece, { maxLength: maxPieces }), (chosen) => chosen.join('&'))
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
 * and others, from each person and a signed-out visitor. Three requests in
 * ten are what a browser on the site sends, its pages and its forms, so they
 * reach their actions; four send one part of such a request another way, so
 * a refusal shows the part it refused; the rest send every part any way. A
 * failing request shrinks toward the browser's. Wrap or map the generator
 * for more.
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

  const declaredBy = (method: Arbitrary.Arbitrary<string>) => Arbitrary.flatMap(pick(templates), (template) =>
    Arbitrary.map(Arbitrary.all({ method, path: filled(template) }), (target): Target => ({ ...target, form: [] }))
  )
  const declared = declaredBy(weighted(...METHODS))

  const segments = templates.flatMap((template) => template.split('/').filter((segment) => segment !== '' && !segment.startsWith('{')).map((segment) => `/${segment}`))
  const craftedPath = Arbitrary.map(
    stepsOf(pieceOf(PATH_PIECES, [...segments, ...segments.map((segment) => segment.toUpperCase()), ...paramValues, ...paramValues.map(encodedFirst)]), { maxLength: 6 }),
    (chosen) => (chosen.join('').startsWith('/') ? chosen.join('') : `/${chosen.join('')}`)
  )
  const crafted = Arbitrary.map(Arbitrary.all({ method: weighted(...METHODS), path: craftedPath }), (target): Target => ({ ...target, form: [] }))

  const [firstForm, ...otherForms]: ReadonlyArray<FormTarget> = [
    ...(options.forms ?? []).map((form) => ({ method: form.method, path: form.path, fields: Arbitrary.Constant(form.fields) })),
    ...(options.routes === undefined ? [] : formsOfRoutes(options.routes.getRegistry().all())),
  ]
  const forms = firstForm === undefined
    ? undefined
    : Arbitrary.flatMap(oneOf(Arbitrary.Constant(firstForm), ...otherForms.map((form) => Arbitrary.Constant(form))), (form) =>
        Arbitrary.map(Arbitrary.all({ path: filled(form.path), fields: form.fields }), (target): Target => ({ method: form.method, path: target.path, form: target.fields }))
      )
  const target = forms === undefined ? oneOf(declared, declared, declared, crafted) : oneOf(declared, forms, forms, declared, crafted)

  const asFields = [
    ...Object.keys(params).flatMap((name) => params[name].flatMap((value) => [`${name}=${value}`, `id=${value}`])),
    ...options.people.flatMap((person) => [`userId=${person}`, `user_id=${person}`]),
  ]
  const added = stepsOf(pieceOf(FIELD_PIECES, [...asFields, ...(options.fields ?? [])]), { maxLength: 3 })
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
  // Each header any way that tests a refusal, and as a browser on this site sends it.
  const headers: Arbitrary.Arbitrary<Readonly<Record<HeaderName, string>>> = Arbitrary.all({
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
  const browserHeaders: Arbitrary.Arbitrary<Readonly<Record<HeaderName, string>>> = Arbitrary.all({
    accept: weighted(['', 2], ['text/html,application/xhtml+xml', 2], ['application/json', 2]),
    'content-type': Arbitrary.Constant(MATCHING),
    origin: weighted(['', 1], [origin, 2]),
    referer: weighted(['', 1], [`${origin}${firstPath}`, 2]),
    'x-inertia': pick(['', 'true']),
    'x-inertia-version': Arbitrary.Constant(''),
    'x-http-method-override': Arbitrary.Constant(''),
    authorization: Arbitrary.Constant(''),
    'user-agent': pick(['', 'curl/8.0']),
    'sec-fetch-site': pick(['', 'same-origin']),
    cookie: Arbitrary.Constant(''),
  })

  const person = oneOf<Person | null>(Arbitrary.Constant(null), ...options.people.map((each) => Arbitrary.Constant(each)))
  // The part a request sends another way: what it asks for and sends as often as all its headers together.
  const onePart = weighted<Part>(['target', 3], ['query', 3], ['body', 2], ['fields', 3], ...HEADER_NAMES.map((name) => [name, 1] as const))

  // Every part of a request any way at all, and as a browser on this site
  // sends it: its pages by GET, its forms with their own fields and a body
  // that matches its Content-Type, no added fields and no forged headers.
  const anyWay = Arbitrary.all({
    target,
    query: queryOf(pieceOf(QUERY_PIECES, [...asFields, ...(options.query ?? [])]), 4),
    headers,
    encoding,
    added,
    text: pick(RAW_BODIES),
  })
  const browsed = Arbitrary.all({
    target: forms === undefined ? declaredBy(weighted(['GET', 6], ['HEAD', 1])) : oneOf(forms, declaredBy(weighted(['GET', 6], ['HEAD', 1])), forms),
    query: oneOf(Arbitrary.Constant(''), queryOf(pieceOf(['page=2'], options.query ?? []), 2)),
    headers: browserHeaders,
    encoding: oneOf<FuzzBody['as']>(Arbitrary.Constant('form'), Arbitrary.Constant('json'), Arbitrary.Constant('multipart')),
    added: Arbitrary.Constant<ReadonlyArray<string>>([]),
    text: Arbitrary.Constant(RAW_BODIES[0]),
  })

  return Arbitrary.map(
    // A browser's request, or one with a single part sent another way, so a
    // refusal shows what it refused and most requests reach their actions;
    // else every part any way. A failure shrinks toward a browser's request.
    Arbitrary.all({ person, browsed, anyWay, mode: weighted(['browser', 3], ['one part', 4], ['any', 3]), part: onePart }),
    (parts): FuzzRequest<Person> => {
      const from = (name: Part) => (parts.mode === 'any' || (parts.mode === 'one part' && parts.part === name) ? parts.anyWay : parts.browsed)
      const target = from('target').target
      const { encoding, text } = from('body')
      const sentHeaders = Object.fromEntries(HEADER_NAMES.map((name) => [name, from(name).headers[name]]))
      const fields = [...target.form, ...from('fields').added]
      const body: FuzzBody = encoding === 'none' ? { as: 'none' } : encoding === 'text' ? { as: 'text', text } : { as: encoding, fields }
      const contentType = sentHeaders['content-type'] === MATCHING ? MATCHING_TYPE[encoding] : sentHeaders['content-type']

      return {
        person: parts.person,
        method: target.method,
        path: target.path,
        query: from('query').query,
        headers: { ...sentHeaders, 'content-type': contentType },
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

/** An answer to a generated request: its response, the body read once, and what the error observer saw. */
export interface FuzzAnswer {
  readonly response: Response
  readonly text: string
  /** Each failure and defect the error observer saw while the request ran, its background work's among them. */
  readonly observed: ReadonlyArray<EffectErrorEvent>
}

/**
 * Send `sent` through the application with `env`, the bindings for its
 * person: `testEnv(signedIn(row), bindings)` for a member, `testEnv(bindings)`
 * for a visitor. Nothing when `fetch` refuses to make the request. The answer
 * holds what the error observer saw, which goes there in place of the
 * application's own observer, so `brokenPromises` sees a defect no answer
 * shows, such as one in background work after the action succeeded.
 */
export async function sendFuzzRequest(
  app: TestApp,
  sent: FuzzRequest,
  env: TestBindings,
  origin = 'http://localhost'
): Promise<FuzzAnswer | undefined> {
  if (requestOf(sent, origin) === undefined) return undefined

  const { url, init } = partsOf(sent, origin)
  const { env: observing, observed } = observingEnv(env)
  const response = await app.request(url, init, observing)

  return { response, text: await response.text(), observed }
}

/** An error as the reason a rule broke names it: its message, or the fields a tagged error without one carries. */
function described(error: unknown): string {
  if (!(error instanceof Error)) return show(error)

  const fields = Object.fromEntries(Object.entries(error).filter(([key]) => key !== '_tag'))

  return error.message === '' ? `${error.name} ${show(fields)}` : `${error.name}: ${error.message}`
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
 * Whether a request reads JSON, by the rule docs/json.md states: not an
 * Inertia visit, and it asks for JSON or sends it, or asks for no HTML while
 * it sends an Accept or an Authorization header.
 */
function readsJson(header: (name: string) => string): boolean {
  if (header('x-inertia') === 'true') return false

  const accept = header('accept')

  if (accept.includes('application/json') || header('content-type').includes('application/json')) return true

  return !accept.includes('text/html') && (accept !== '' || header('authorization') !== '')
}

/** Text with each percent-encoding undone, as often as it nests, so `%252f` reads as `/`. */
function decoded(text: string): string {
  let current = text

  for (let round = 0; round < 3; round++) {
    let next: string

    try {
      next = decodeURIComponent(current)
    } catch {
      return current
    }

    if (next === current) return current

    current = next
  }

  return current
}

/**
 * The hosts, other than the site's own, that a request names in any text its
 * sender chose: its path, query, body, Origin and Referer, where `//host` or
 * `\\host` reads as another site.
 */
function namedHosts(sent: FuzzRequest, siteHost: string): Set<string> {
  const body = sent.body.as === 'none' ? [] : sent.body.as === 'text' ? [sent.body.text] : sent.body.fields
  const text = decoded([sent.path, sent.query, sent.headers.origin ?? '', sent.headers.referer ?? '', ...body].join(' '))
  const hosts = new Set<string>()

  for (const match of text.matchAll(/[/\\]{2}([^/\\?#\s&"'=;]+)/g)) {
    const host = URL.canParse(`http://${match[1]}`) ? new URL(`http://${match[1]}`).host : ''

    if (host !== '' && host !== siteHost) hosts.add(host)
  }

  return hosts
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
 * - a JSON client, by docs/json.md's rule, gets every failure in the JSON
 *   envelope, and is never sent to sign in;
 * - an Inertia visit that changes something is redirected with a 303;
 * - no answer sends the visitor to another site the request named, such as
 *   `?redirect=//evil.test`, by its Location or its X-Inertia-Location;
 * - no request makes a defect, in its action, a layer, shared props or its
 *   background work, and no background work fails: `sendFuzzRequest`
 *   records what the error observer sees, which no answer may show.
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

  if (readsJson(header)) {
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

  const siteHost = URL.canParse(origin) ? new URL(origin).host : 'localhost'
  const named = namedHosts(sent, siteHost)

  for (const location of [response.headers.get('location'), response.headers.get('x-inertia-location')]) {
    const target = location !== null && URL.canParse(location, origin) ? new URL(location, origin) : undefined

    if (target !== undefined && named.has(target.host)) broken.push(`sent the visitor to ${target.host}, a site the request named, by ${show(location)}`)
  }

  for (const event of answer.observed) {
    const operation = event.metadata?.operation

    if (event.kind === 'defect') broken.push(`made a defect${Predicate.isString(operation) ? ` in ${operation}` : ''}: ${described(event.error)}`)
    // Background work names its operation; an action's failure the error page answered names none.
    else if (event.handling === 'unhandled' && Predicate.isString(operation)) broken.push(`its background work ${operation} failed: ${described(event.error)}`)
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
/** A row's identity and owner, as strangerWrites reads them. */
export interface RowKeys<Row> {
  readonly id: (row: Row) => string
  readonly owner: (row: Row) => string
}

/** A model whose binding says only its owner may load it. */
const ownedModel = (model: RouteModelMetadata): model is RouteModelMetadata & { readonly access: { readonly ownedBy: string } } =>
  Predicate.hasProperty(model.access, 'ownedBy')

/** A row's value for a column, by its property key or, as a raw query returns it, its snake_case name. */
function columnOf(row: object, key: string): string {
  const value: unknown = Object.getOwnPropertyDescriptor(row, key)?.value ??
    Object.getOwnPropertyDescriptor(row, key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`))?.value

  return String(value)
}

/**
 * The keys `strangerWrites` reads a table's rows by, from the route table: a
 * row's primary key, and the column its binding's `ownedBy` names. A row is
 * read by the column's property key or its snake_case name, so rows a
 * Drizzle select or a raw query returns both work.
 *
 * @example
 * strangerWrites(sent, change, ownership(routes, 'projects'))
 */
export function ownership<Row extends object>(routes: FuzzRoutes, table: string): RowKeys<Row> {
  const model = routes.getRegistry().all().flatMap((route) => route.models).find((each) => each.table === table && ownedModel(each))

  if (model === undefined || !ownedModel(model)) {
    throw new Error(`No binding of ${table} says who owns its rows: give one ownedBy, or pass strangerWrites the row's { id, owner } yourself.`)
  }

  return { id: (row) => columnOf(row, model.primaryKey), owner: (row) => columnOf(row, model.access.ownedBy) }
}

export function refusedWrites<Row>(answer: FuzzAnswer, rows: RowsChange<Row>): string[] {
  const status = answer.response.status

  return status >= 400 && status < 500 && show(rows.before) !== show(rows.after) ? [`answered ${status} after changing ${show(rows.before)} to ${show(rows.after)}`] : []
}
