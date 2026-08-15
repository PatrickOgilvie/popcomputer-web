/**
 * Better Auth failure boundary.
 *
 * Better Auth server API calls fail in three shapes: thrown `APIError`
 * values, resolved HTTP error `Response`s (returned instead of thrown when a
 * `Request` is passed), and `{ status, response }` envelopes. This module
 * classifies those unknown boundary values and translates them into
 * Honertia's typed errors so `betterAuthFormAction` never has to inspect raw
 * Better Auth output.
 */

import { Effect, Schema as S } from 'effect'
import {
  AuthRateLimitError,
  AuthRedirect,
  HttpError,
  ValidationError,
} from './errors.js'

const BETTER_CALL_API_ERROR_HEADERS = Symbol.for('better-call:api-error-headers')

type BetterAuthBoundaryProperty =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | object

/** Result types returned by supported Better Auth server API call modes. */
export type BetterAuthActionResult =
  | Response
  | Headers
  | {
      readonly headers?: Headers | HeadersInit
      readonly response?: unknown
      readonly status?: number
    }

/**
 * A normalized Better Auth request rejection passed to form error mappers.
 *
 * `body` and `cause` remain unknown boundary values. Most applications should
 * only need the normalized `status`, `code`, and `message` fields.
 */
export interface BetterAuthActionError {
  readonly status: number | undefined
  readonly code: string | undefined
  readonly message: string
  readonly body: unknown
  readonly cause: unknown
  /** Verified Better Auth response headers accumulated before rejection. */
  readonly headers: Headers
  /** Cookies Better Auth accumulated before rejecting the request. */
  readonly setCookies: readonly string[]
}

export type BetterAuthBoundaryFailure =
  | {
      readonly _tag: 'BetterAuthRedirected'
      readonly status: number
      readonly cause: unknown
      readonly headers: Headers
      readonly setCookies: readonly string[]
    }
  | {
      readonly _tag: 'BetterAuthRequestRejected'
      readonly error: BetterAuthActionError
      readonly headers: Headers
      readonly setCookies: readonly string[]
    }
  | {
      readonly _tag: 'BetterAuthRateLimited'
      readonly retryAfterSeconds: number | undefined
      readonly cause: unknown
      readonly headers: Headers
      readonly setCookies: readonly string[]
    }
  | {
      readonly _tag: 'BetterAuthServiceFailed'
      readonly status: number
      readonly cause: unknown
      readonly headers: Headers
      readonly setCookies: readonly string[]
    }

interface BetterAuthFailureHints {
  readonly source: 'exception' | 'result'
  readonly status?: number
  readonly body?: unknown
}

/**
 * Inspect a resolved Better Auth server API result without changing its
 * successful type. Better Auth may resolve error Responses/status envelopes
 * instead of rejecting when a Request is supplied.
 */
export function inspectBetterAuthActionResult<A>(
  result: A
): Effect.Effect<A, BetterAuthBoundaryFailure> {
  if (result instanceof Response && result.status >= 400) {
    return Effect.promise(() => readBetterAuthResponseBody(result)).pipe(
      Effect.flatMap((body) =>
        Effect.fail(
          classifyBetterAuthFailure(result, {
            source: 'result',
            status: result.status,
            body,
          })
        )
      )
    )
  }

  if (!(result instanceof Response) && !(result instanceof Headers)) {
    const status = parseHttpStatus(getBoundaryProperty(result, 'status'))
    const isHttpEnvelope =
      hasBoundaryProperty(result, 'response') ||
      hasBoundaryProperty(result, 'headers')
    if (isHttpEnvelope && status !== undefined && status >= 400) {
      return Effect.fail(
        classifyBetterAuthFailure(result, {
          source: 'result',
          status,
          body: getBoundaryProperty(result, 'response'),
        })
      )
    }
  }

  return Effect.succeed(result)
}

/**
 * Run one Better Auth server API call in Effect, classifying both rejected
 * promises and resolved HTTP error results at the dependency boundary.
 */
export function runBetterAuthApiCall<A>(
  call: () => Promise<A>,
  options: { readonly inspectResult?: boolean } = {}
): Effect.Effect<A, BetterAuthBoundaryFailure> {
  const result = Effect.tryPromise({
    try: call,
    catch: (cause) => classifyBetterAuthFailure(cause),
  })
  return options.inspectResult === false
    ? result
    : result.pipe(Effect.flatMap(inspectBetterAuthActionResult))
}

type BetterAuthServer = {
  readonly api: object
  readonly handler: (request: Request) => Response | Promise<Response>
}

/**
 * Effect-returning mirror of a Better Auth instance's plugin-aware API.
 *
 * Known, accepted TypeScript limitation: Better Auth's generic conditional
 * overloads for `asResponse`, `returnHeaders`, and `returnStatus` can collapse
 * when mirrored through a mapped type. Use `raw.api` when a call site's
 * inferred return mode is not retained precisely.
 */
export type BetterAuthEffectApi<Api> = {
  readonly [K in keyof Api]: Api[K] extends (
    ...args: infer Args
  ) => Promise<infer Result>
    ? (...args: Args) => Effect.Effect<Result, BetterAuthBoundaryFailure>
    : never
}

interface BetterAuthApiProxy {
  readonly __betterAuthApiProxy?: never
}

function restoreBetterAuthEffectApi<Api>(api: BetterAuthApiProxy): BetterAuthEffectApi<Api> {
  // SAFETY: effectifyBetterAuth creates one wrapper per reflected API endpoint with matching arguments and success values.
  return api as BetterAuthEffectApi<Api>
}

/**
 * Effect-native façade over a concrete Better Auth server instance.
 *
 * Calls with `asResponse: true` preserve Better Auth's raw response semantics,
 * including 4xx/5xx responses in the success channel. Other resolved HTTP
 * failures are normalized into `BetterAuthBoundaryFailure`.
 *
 * The raw instance remains available as an explicit escape hatch for call
 * forms whose conditional overloads cannot be preserved by TypeScript.
 */
export interface BetterAuthEffectClient<Auth extends BetterAuthServer> {
  readonly raw: Auth
  readonly api: BetterAuthEffectApi<Auth['api']>
  readonly fetch: (
    request: Request
  ) => Effect.Effect<Response, HttpError>
}

/**
 * Effectify a Better Auth server instance once while retaining plugin-added
 * endpoint parameter and success types.
 *
 * An explicit `asResponse: true` keeps raw HTTP responses, including error
 * statuses, in the success channel. Other Better Auth protocol failures enter
 * the typed failure channel.
 */
export function effectifyBetterAuth<Auth extends BetterAuthServer>(
  auth: Auth
): BetterAuthEffectClient<Auth> {
  const wrappers = new Map<PropertyKey, unknown>()
  const readEndpoint = (
    key: PropertyKey
  ): ((...args: unknown[]) => BetterAuthBoundaryProperty) | undefined => {
    if (!S.is(S.String)(key) || key === 'then') return undefined
    const endpoint = Object.getOwnPropertyDescriptor(auth.api, key)?.value
    if (!(endpoint instanceof Function)) return undefined

    // SAFETY: runtime reflection established callability. The wrapper owns
    // classification; the exported mapped type restores each endpoint's
    // concrete arguments and success value.
    return endpoint as (...args: unknown[]) => BetterAuthBoundaryProperty
  }
  const api = new Proxy<BetterAuthApiProxy>({}, {
    get: (_target, key) => {
      const existing = wrappers.get(key)
      if (existing !== undefined) return existing

      const endpoint = readEndpoint(key)
      if (!endpoint) return undefined

      const wrapper = (...args: unknown[]) =>
        runBetterAuthApiCall(
          () => Promise.resolve(endpoint.apply(auth.api, args)),
          { inspectResult: !requestsRawBetterAuthResponse(args) }
        )
      wrappers.set(key, wrapper)
      return wrapper
    },
    has: (_target, key) => readEndpoint(key) !== undefined,
    ownKeys: () => Reflect.ownKeys(auth.api).filter(
      (key) => readEndpoint(key) !== undefined
    ),
    getOwnPropertyDescriptor: (_target, key) =>
      readEndpoint(key) === undefined
        ? undefined
        : { configurable: true, enumerable: true },
  })

  return {
    raw: auth,
    api: restoreBetterAuthEffectApi<Auth['api']>(api),
    fetch: (request) =>
      Effect.tryPromise({
        try: () => Promise.resolve(auth.handler(request)),
        catch: (cause) =>
          new HttpError({
            status: 502,
            message: 'Authentication service failed.',
            cause,
          }),
      }),
  }
}

function requestsRawBetterAuthResponse(args: readonly unknown[]): boolean {
  const options = args.at(-1)
  return getBoundaryProperty(options, 'asResponse') === true
}

export function classifyBetterAuthFailure(
  cause: unknown,
  hints: BetterAuthFailureHints = { source: 'exception' }
): BetterAuthBoundaryFailure {
  const nestedResponse = getBoundaryProperty(cause, 'response')
  const nestedBody = getBoundaryProperty(cause, 'body')
  const body = hints.body ?? nestedBody ?? getBoundaryProperty(nestedResponse, 'body')
  const status = firstHttpStatus(
    hints.status,
    getBoundaryProperty(cause, 'statusCode'),
    getBoundaryProperty(cause, 'status'),
    getBoundaryProperty(nestedResponse, 'statusCode'),
    getBoundaryProperty(nestedResponse, 'status')
  )
  const code = firstString(
    getBoundaryProperty(body, 'code'),
    getBoundaryProperty(nestedResponse, 'code'),
    getBoundaryProperty(cause, 'code')
  )
  const message = firstString(
    getBoundaryProperty(body, 'message'),
    getBoundaryProperty(nestedResponse, 'message'),
    getBoundaryProperty(cause, 'message')
  )

  // Resolved responses/status envelopes are Better Auth protocol results. A
  // thrown value is only trusted as a request rejection when the error itself
  // carries Better Auth's APIError identity and a valid status. Arbitrary
  // dependency errors may also expose `message`, `code`, or `status` fields;
  // treating those as form validation would send their raw text to
  // production clients.
  const isVerifiedBetterAuthFailure =
    hints.source === 'result' || isBetterAuthApiErrorLike(cause)
  const headers = isVerifiedBetterAuthFailure
    ? collectBetterAuthHeaders(cause, nestedResponse)
    : new Headers()
  const setCookies = readSetCookies(headers)

  if (!isVerifiedBetterAuthFailure || status === undefined) {
    return {
      _tag: 'BetterAuthServiceFailed',
      status: status !== undefined && status >= 500 ? status : 502,
      cause,
      headers,
      setCookies,
    }
  }

  if (status >= 300 && status < 400) {
    return {
      _tag: 'BetterAuthRedirected',
      status,
      cause,
      headers,
      setCookies,
    }
  }

  if (status === 429) {
    return {
      _tag: 'BetterAuthRateLimited',
      retryAfterSeconds: firstRetryAfterSeconds(
        headers.get('X-Retry-After'),
        headers.get('Retry-After'),
        getBoundaryHeader(cause, 'X-Retry-After'),
        getBoundaryHeader(cause, 'Retry-After'),
        getBoundaryHeader(nestedResponse, 'X-Retry-After'),
        getBoundaryHeader(nestedResponse, 'Retry-After'),
        getBoundaryProperty(body, 'retryAfter')
      ),
      cause,
      headers,
      setCookies,
    }
  }

  if (status >= 400 && status < 500) {
    return {
      _tag: 'BetterAuthRequestRejected',
      error: {
        status,
        code,
        message: message ?? 'Unable to complete request. Please try again.',
        body,
        cause,
        headers,
        setCookies,
      },
      headers,
      setCookies,
    }
  }

  return {
    _tag: 'BetterAuthServiceFailed',
    status: status !== undefined && status >= 500 ? status : 502,
    cause,
    headers,
    setCookies,
  }
}

export function toHonertiaAuthError(
  failure: BetterAuthBoundaryFailure,
  component: string,
  errorMapper: ((error: BetterAuthActionError) => Record<string, string>) | undefined
): AuthRedirect | ValidationError | AuthRateLimitError | HttpError {
  switch (failure._tag) {
    case 'BetterAuthRedirected':
      return new AuthRedirect({
        status: failure.status,
        headers: new Headers(failure.headers),
      })
    case 'BetterAuthRequestRejected':
      return new ValidationError({
        errors: (errorMapper ?? defaultAuthErrorMapper)(failure.error),
        component,
        headers: new Headers(failure.headers),
      })
    case 'BetterAuthRateLimited':
      return new AuthRateLimitError({
        retryAfterSeconds: failure.retryAfterSeconds,
        cause: failure.cause,
        headers: new Headers(failure.headers),
      })
    case 'BetterAuthServiceFailed':
      return new HttpError({
        status: failure.status,
        message: 'Authentication service failed.',
        cause: failure.cause,
        headers: new Headers(failure.headers),
      })
  }
}

function collectBetterAuthHeaders<NestedResponse>(
  cause: unknown,
  nestedResponse: NestedResponse
): Headers {
  const merged = new Headers()
  const cookies = new Set<string>()

  for (const candidate of [
    cause instanceof Response ? cause.headers : getBoundaryProperty(cause, 'headers'),
    nestedResponse instanceof Response
      ? nestedResponse.headers
      : getBoundaryProperty(nestedResponse, 'headers'),
    getHiddenBetterCallHeaders(cause),
  ]) {
    const headers = coerceBoundaryHeaders(candidate)
    if (!headers) continue

    headers.forEach((value, name) => {
      if (name.toLowerCase() !== 'set-cookie') merged.set(name, value)
    })
    for (const cookie of readSetCookies(headers)) {
      cookies.add(cookie)
    }
  }

  for (const cookie of cookies) {
    merged.append('set-cookie', cookie)
  }

  return merged
}

function isBetterAuthApiErrorLike<Value>(value: Value): boolean {
  return value instanceof Error &&
    value.name === 'APIError' &&
    parseHttpStatus(getBoundaryProperty(value, 'statusCode')) !== undefined
}

function getHiddenBetterCallHeaders<Value>(value: Value): BetterAuthBoundaryProperty {
  if (!(value instanceof Object)) {
    return undefined
  }
  return Object.getOwnPropertyDescriptor(value, BETTER_CALL_API_ERROR_HEADERS)?.value
}

function coerceBoundaryHeaders<Value>(value: Value): Headers | undefined {
  if (value instanceof Headers) return value

  if (Array.isArray(value)) {
    try {
      // SAFETY: The Better Auth boundary validated this representation before exposing the narrower adapter contract.
      return new Headers(value as HeadersInit)
    } catch {
      return undefined
    }
  }

  if (!(value instanceof Object)) return undefined

  try {
    // SAFETY: The Better Auth boundary validated this representation before exposing the narrower adapter contract.
    return new Headers(value as HeadersInit)
  } catch {
    return undefined
  }
}

function readSetCookies(headers: Headers): readonly string[] {
  // SAFETY: The Better Auth boundary validated this representation before exposing the narrower adapter contract.
  const headersWithCookies = headers as Headers & {
    getSetCookie?: () => string[]
  }
  if (headersWithCookies.getSetCookie instanceof Function) {
    return headersWithCookies.getSetCookie()
  }

  const combined = headers.get('set-cookie')
  if (!combined) return []

  return combined
    .split(/,(?=[^;]+?=)/g)
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.length > 0)
}

async function readBetterAuthResponseBody(
  response: Response
): Promise<BetterAuthBoundaryProperty> {
  const contentType = response.headers.get('content-type')?.toLowerCase()
  if (!contentType?.includes('json')) return undefined

  try {
    return await response.clone().json()
  } catch {
    return undefined
  }
}

function getBoundaryProperty<Value>(
  value: Value,
  key: string
): BetterAuthBoundaryProperty {
  if (!(value instanceof Object)) {
    return undefined
  }
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

function hasBoundaryProperty<Value>(value: Value, key: string): boolean {
  if (!(value instanceof Object)) {
    return false
  }

  try {
    return Object.hasOwn(value, key)
  } catch {
    return false
  }
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (S.is(S.String)(value)) return value
  }
  return undefined
}

function firstHttpStatus(...values: readonly unknown[]): number | undefined {
  for (const value of values) {
    const status = parseHttpStatus(value)
    if (status !== undefined) return status
  }
  return undefined
}

function firstRetryAfterSeconds(...values: readonly unknown[]): number | undefined {
  for (const value of values) {
    if (S.is(S.Number)(value) && Number.isSafeInteger(value) && value >= 0) {
      return value
    }

    if (S.is(S.String)(value) && /^\d+$/.test(value)) {
      const seconds = Number(value)
      if (Number.isSafeInteger(seconds)) return seconds
    }
  }

  return undefined
}

function getBoundaryHeader<Value>(value: Value, name: string): string | undefined {
  const headers = getBoundaryProperty(value, 'headers')
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined
  }

  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (
        Array.isArray(entry) &&
        entry.length >= 2 &&
        S.is(S.String)(entry[0]) &&
        entry[0].toLowerCase() === name.toLowerCase() &&
        S.is(S.String)(entry[1])
      ) {
        return entry[1]
      }
    }

    return undefined
  }

  if (!(headers instanceof Object)) {
    return undefined
  }

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== name.toLowerCase()) continue
    const header = Object.getOwnPropertyDescriptor(headers, key)?.value
    if (S.is(S.String)(header)) return header
  }

  return undefined
}

function parseHttpStatus<Value>(value: Value): number | undefined {
  if (!S.is(S.Number)(value) || !Number.isInteger(value)) return undefined
  if (value < 100 || value > 599) return undefined
  return value
}

interface AuthFieldErrors {
  [field: string]: string
}

function defaultAuthErrorMapper(error: BetterAuthActionError): AuthFieldErrors {
  return { form: error.message }
}
