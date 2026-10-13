/**
 * `@popcomputer/web/endpoint`: JSON endpoints, each declared once as a
 * contract, with its method, path, input, success and failures.
 *
 * The declarations live in a module that imports only `effect`, the
 * validators and the application's paths, so a React bundle or another
 * client can import them. Everything else derives from them: the action
 * receives its input decoded and returns the success value, the route takes
 * its method and path from the contract, a client or a test calls it with
 * typed input and reads a typed result, and `openApi` describes them all.
 *
 * @example
 * // src/endpoints.ts
 * export const endpoints = {
 *   listPlaces: endpoint.get(paths.places, { query: PlaceFilter, success: PlaceList }),
 *   createPlace: endpoint.post(paths.places, {
 *     body: NewPlace,
 *     success: Place,
 *     status: 201,
 *     errors: { 409: PlaceExists },
 *   }),
 * }
 *
 * // src/actions/places.ts
 * export const createPlace = action(endpoints.createPlace, ({ body }) =>
 *   Effect.gen(function* () { ... return place })
 * )
 *
 * // src/routes.ts
 * routes.endpoint(createPlace)
 *
 * // a test or a React component
 * const result = await call(endpoints.createPlace, { body: { name: 'Café' } })
 */

import { Option, Schema as S } from 'effect'
import { ErrorResponse, type ErrorResponseBody } from './effect/error-response.js'
import type { PathParamName, PathTarget } from './paths.js'
import type { AuthUser } from './effect/services.js'

export { openApi, type JsonValue, type OpenApiInfo } from './openapi.js'

/** The methods an endpoint answers. */
export type EndpointMethod = 'get' | 'post' | 'put' | 'patch' | 'delete'

/** A schema an endpoint declares: one that decodes and encodes with no services. */
export type EndpointSchema = S.Codec<unknown, unknown, never, never>

/**
 * A failure an endpoint declares: a tagged schema, such as a
 * `Schema.TaggedErrorClass`, so the action fails with it and a client tells it
 * apart by its `_tag`.
 */
export type EndpointErrorSchema = S.Codec<{ readonly _tag: string }, unknown, never, never>

/** What an endpoint takes and answers. */
export interface EndpointSpec {
  /** One line for the API's reference: what the endpoint does. */
  readonly summary?: string
  /**
   * Whether the endpoint needs a signed-in user: the action runs only for
   * one, which it receives as `auth`, and anyone else is answered 401 before
   * the input is read. The API's description lists the 401 and the security
   * schemes `openApi` is given.
   */
  readonly auth?: boolean
  /** The query string's parameters, which the action receives as `query`. */
  readonly query?: EndpointSchema
  /** The request body, JSON or a form, which the action receives as `body`. */
  readonly body?: EndpointSchema
  /** Request headers the endpoint reads, by lowercase name, which the action receives as `headers`. */
  readonly headers?: EndpointSchema
  /**
   * The body of a success, which the action returns and the response encodes
   * through its JSON form: only the fields it declares leave the server.
   * Without one, a success has no body.
   */
  readonly success?: EndpointSchema
  /** The status of a success: 200 by default, or 204 without `success`. */
  readonly status?: number
  /**
   * The failures the action may fail with, by the status each answers. Each
   * is answered with the JSON error envelope, whose `tag` is the failure's
   * `_tag` and whose `body` holds its fields.
   */
  readonly errors?: { readonly [status: number]: EndpointErrorSchema | ReadonlyArray<EndpointErrorSchema> }
}

/** An endpoint's contract: its method, its path from the application's paths, and its spec. */
export interface Endpoint<
  Method extends EndpointMethod = EndpointMethod,
  Path extends string = string,
  Spec extends EndpointSpec = EndpointSpec
> {
  readonly method: Method
  readonly path: Path
  readonly spec: Spec
}

type Simplify<T> = { readonly [Key in keyof T]: T[Key] } & {}

type TypeOf<Schema> = Schema extends { readonly Type: infer A } ? A : never

type ErrorSchemaOf<Errors> = {
  readonly [Status in keyof Errors]: Errors[Status] extends ReadonlyArray<infer One> ? One : Errors[Status]
}[keyof Errors]

/** The input an endpoint's action receives: its path's parameters, the signed-in user it requires, and the query, body and headers it declares. */
export type EndpointInput<Ep extends Endpoint> = Simplify<
  { readonly params: { readonly [Name in PathParamName<Ep['path']>]: string } } &
  (Ep['spec'] extends { readonly auth: true } ? { readonly auth: AuthUser } : unknown) &
  (Ep['spec'] extends { readonly query: infer Query } ? { readonly query: TypeOf<Query> } : unknown) &
  (Ep['spec'] extends { readonly body: infer Body } ? { readonly body: TypeOf<Body> } : unknown) &
  (Ep['spec'] extends { readonly headers: infer Headers } ? { readonly headers: TypeOf<Headers> } : unknown)
>

/** The value an endpoint's action returns on success: its `success` schema's type, or nothing. */
export type EndpointSuccess<Ep extends Endpoint> = Ep['spec'] extends { readonly success: infer Success }
  ? TypeOf<Success>
  : void

/** The failures an endpoint declares, as its action fails with them. */
export type EndpointError<Ep extends Endpoint> = Ep['spec'] extends { readonly errors: infer Errors }
  ? TypeOf<ErrorSchemaOf<Errors>>
  : never

/** A GET or DELETE carries no body. */
interface NoBody {
  readonly body?: never
}

function declare<const Method extends EndpointMethod>(method: Method) {
  return <const Path extends string, const Spec extends EndpointSpec>(
    path: Path & PathTarget<Path>,
    spec: Spec
  ): Endpoint<Method, Path, Spec> => ({ method, path, spec })
}

function declareBodiless<const Method extends 'get' | 'delete'>(method: Method) {
  return <const Path extends string, const Spec extends EndpointSpec & NoBody = Record<never, never>>(
    path: Path & PathTarget<Path>,
    // SAFETY: without a spec, Spec is its default, the empty spec.
    spec: Spec = {} as Spec
  ): Endpoint<Method, Path, Spec> => ({ method, path, spec })
}

/**
 * Declare a JSON endpoint on one of the application's paths.
 *
 * @example
 * export const endpoints = {
 *   showPlace: endpoint.get(paths.place, { success: Place }),
 *   updatePlace: endpoint.patch(paths.place, { body: PlaceChanges, success: Place }),
 *   deletePlace: endpoint.delete(paths.place),
 * }
 */
export const endpoint = {
  get: declareBodiless('get'),
  post: declare('post'),
  put: declare('put'),
  patch: declare('patch'),
  delete: declareBodiless('delete'),
}

/**
 * A failure the endpoint does not declare, such as invalid input (`422`,
 * with each field's message in `errors`), a missing record or a refused
 * sign-in: the JSON error envelope, tagged so it narrows beside the declared
 * failures.
 */
export interface EndpointFailure extends ErrorResponseBody {
  readonly _tag: 'EndpointFailure'
}

/** What calling an endpoint answered: its success value, or a failure. */
export type CallResult<Ep extends Endpoint> =
  | {
      readonly ok: true
      readonly status: number
      readonly value: EndpointSuccess<Ep>
      readonly response: Response
    }
  | {
      readonly ok: false
      readonly status: number
      readonly error: EndpointError<Ep> | EndpointFailure
      readonly response: Response
    }

/** The input a call sends, in the types the action receives. */
export type CallInput<Ep extends Endpoint> = Simplify<
  ([PathParamName<Ep['path']>] extends [never]
    ? unknown
    : { readonly params: { readonly [Name in PathParamName<Ep['path']>]: string | number } }) &
  (Ep['spec'] extends { readonly query: infer Query } ? { readonly query: TypeOf<Query> } : unknown) &
  (Ep['spec'] extends { readonly body: infer Body } ? { readonly body: TypeOf<Body> } : unknown) &
  (Ep['spec'] extends { readonly headers: infer Headers } ? { readonly headers: TypeOf<Headers> } : unknown)
>

/** How a call is sent. */
export interface CallOptions {
  /**
   * What sends the request: the global `fetch` by default. A test sends it
   * through the application: `(request) => app.request(request, undefined, env)`.
   */
  readonly fetch?: (request: Request) => Response | Promise<Response>
  /** The origin the path is resolved against: the page's own in a browser, otherwise `http://localhost`. */
  readonly baseUrl?: string
  /** Headers the request carries besides those the endpoint declares, such as an API key's `Authorization`. */
  readonly headers?: HeadersInit
}

type CallArguments<Ep extends Endpoint> = {} extends CallInput<Ep>
  ? [input?: CallInput<Ep>, options?: CallOptions]
  : [input: CallInput<Ep>, options?: CallOptions]

/** An endpoint's spec, as the functions here read it whatever its declared type. */
function specOf(ep: Endpoint): EndpointSpec {
  return ep.spec
}

/**
 * A value as the request carries it, encoded through the schema's JSON form
 * without its checks: the server checks the input and answers each invalid
 * field, so a form shows the server's messages.
 */
function encodeJson(schema: EndpointSchema, value: unknown, what: string): unknown {
  try {
    return S.encodeUnknownSync(S.toCodecJson(schema), { disableChecks: true })(value)
  } catch (cause) {
    throw new Error(`The ${what} does not match the endpoint's schema: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** A query string's parameters from an encoded value: lists as `key[]`, objects as `key[field]`. */
function appendQuery(search: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return

  if (Array.isArray(value)) {
    for (const item of value) appendQuery(search, `${key}[]`, item)
    return
  }

  if (typeof value === 'object') {
    for (const [field, item] of Object.entries(value)) appendQuery(search, `${key}[${field}]`, item)
    return
  }

  search.append(key, String(value))
}

function fillPath(path: string, params: Readonly<Record<string, string | number>>): string {
  return path.replace(/\{([^}:]+)(?::[^}]+)?\}/g, (_placeholder, name: string) => {
    const value = Object.hasOwn(params, name) ? params[name] : undefined

    if (value === undefined) throw new Error(`The call to ${path} lacks its '${name}' parameter.`)

    return encodeURIComponent(String(value))
  })
}

function defaultBaseUrl(): string {
  const location: unknown = Reflect.get(globalThis, 'location')
  const origin: unknown = typeof location === 'object' && location !== null ? Reflect.get(location, 'origin') : undefined

  return typeof origin === 'string' && origin !== 'null' ? origin : 'http://localhost'
}

/**
 * The request that calls an endpoint: its method, its path filled with the
 * parameters, the query and headers encoded, and the body as JSON.
 */
export function endpointRequest<Ep extends Endpoint>(ep: Ep, ...[input, options]: CallArguments<Ep>): Request {
  const spec = specOf(ep)
  const given: Readonly<Record<string, unknown>> = input ?? {}
  const params: unknown = given.params
  const url = new URL(
    fillPath(ep.path, typeof params === 'object' && params !== null ? Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])) : {}),
    options?.baseUrl ?? defaultBaseUrl()
  )

  if (spec.query !== undefined) {
    const query = encodeJson(spec.query, given.query, 'query')

    if (typeof query === 'object' && query !== null) {
      for (const [key, value] of Object.entries(query)) appendQuery(url.searchParams, key, value)
    }
  }

  const headers = new Headers(options?.headers)
  headers.set('Accept', 'application/json')

  if (spec.headers !== undefined) {
    const declared = encodeJson(spec.headers, given.headers, 'headers')

    if (typeof declared === 'object' && declared !== null) {
      for (const [name, value] of Object.entries(declared)) {
        if (value !== undefined && value !== null) headers.set(name, String(value))
      }
    }
  }

  let body: string | undefined

  if (spec.body !== undefined) {
    body = JSON.stringify(encodeJson(spec.body, given.body, 'body'))
    headers.set('Content-Type', 'application/json')
  }

  return new Request(url, { method: ep.method.toUpperCase(), headers, body })
}

function declaredFailure(spec: EndpointSpec, status: number, body: unknown): { readonly _tag: string } | undefined {
  const declared = spec.errors?.[status]

  if (declared === undefined || body === undefined) return undefined

  for (const schema of Array.isArray(declared) ? declared : [declared]) {
    const failure: EndpointSchema = schema
    const decoded = S.decodeUnknownOption(S.toCodecJson(failure))(body)

    // SAFETY: the failure's schema is tagged, so what it decodes is.
    if (Option.isSome(decoded)) return decoded.value as { readonly _tag: string }
  }

  return undefined
}

/**
 * Read an endpoint's response: its success value decoded with `success`, a
 * declared failure decoded with its schema, or any other failure as an
 * `EndpointFailure`. A body that breaks the contract throws.
 */
export async function readEndpoint<Ep extends Endpoint>(ep: Ep, response: Response): Promise<CallResult<Ep>> {
  const spec = specOf(ep)
  const status = response.status

  if (response.ok) {
    const value = spec.success === undefined || status === 204
      ? undefined
      : S.decodeUnknownSync(S.toCodecJson(spec.success))(await response.clone().json())

    // SAFETY: the value was decoded with the endpoint's success schema, or it declares none.
    return { ok: true, status, value: value as EndpointSuccess<Ep>, response }
  }

  const text = await response.clone().text()
  let envelope: ErrorResponseBody

  try {
    envelope = S.decodeUnknownSync(ErrorResponse)(JSON.parse(text))
  } catch {
    throw new Error(
      `${ep.method.toUpperCase()} ${ep.path} answered ${status} ` +
        `(${response.headers.get('Content-Type') ?? 'no content type'}) without the JSON error envelope: ${text.slice(0, 200)}`
    )
  }

  const declared = declaredFailure(spec, status, envelope.body)
  // SAFETY: a declared failure was decoded with the schema the endpoint declares for its status.
  const error = (declared ?? { ...envelope, _tag: 'EndpointFailure' }) as EndpointError<Ep> | EndpointFailure

  return { ok: false, status, error, response }
}

/**
 * Call an endpoint and read its answer, both typed by its contract.
 *
 * @example
 * const result = await call(endpoints.createPlace, { body: { name: 'Café' } })
 * if (result.ok) visit(result.value.id)
 * else if (result.error._tag === 'PlaceExists') showExisting(result.error.placeId)
 *
 * // In a test, through the application:
 * const send = { fetch: (request: Request) => app.request(request, undefined, env) }
 * const created = await call(endpoints.createPlace, { body }, send)
 */
export async function call<Ep extends Endpoint>(ep: Ep, ...[input, options]: CallArguments<Ep>): Promise<CallResult<Ep>> {
  // SAFETY: the arguments are the ones `call` was given, typed by the same endpoint.
  const request = endpointRequest(ep, ...([input, options] as CallArguments<Ep>))
  const send = options?.fetch ?? ((sent: Request) => fetch(sent))

  return readEndpoint(ep, await send(request))
}
