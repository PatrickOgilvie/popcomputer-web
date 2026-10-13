/**
 * Better Auth failure boundary.
 *
 * The framework sends every call through Better Auth's request handler, whose
 * answer is a Response: an error status, a redirect, or a thrown failure of
 * the handler itself. This module classifies those boundary values and
 * translates them into the package's typed errors, so actions never inspect
 * raw Better Auth output.
 */

import { Data, Effect, Match, Schema as S } from 'effect'
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

const BetterAuthBoundaryFailure = Data.taggedEnum<BetterAuthBoundaryFailure>()

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
  if (result instanceof Response && result.status >= 300 && result.status < 400) {
    return Effect.fail(classifyBetterAuthRedirect(result))
  }

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
    return BetterAuthBoundaryFailure.BetterAuthServiceFailed({
      status: status !== undefined && status >= 500 ? status : 502,
      cause,
      headers,
      setCookies
    })
  }

  if (status >= 300 && status < 400) {
    return BetterAuthBoundaryFailure.BetterAuthRedirected({
      status,
      cause,
      headers,
      setCookies
    })
  }

  if (status === 429) {
    return BetterAuthBoundaryFailure.BetterAuthRateLimited({
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
      setCookies
    })
  }

  if (status >= 400 && status < 500) {
    return BetterAuthBoundaryFailure.BetterAuthRequestRejected({
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
      setCookies
    })
  }

  return BetterAuthBoundaryFailure.BetterAuthServiceFailed({
    status: status !== undefined && status >= 500 ? status : 502,
    cause,
    headers,
    setCookies
  })
}

/**
 * A redirect Better Auth's handler answered. Some endpoints report a failure
 * by redirecting with `?error=CODE`, as a used magic link does: that is a
 * rejection, carrying only the redirect's cookies, so the action can show it.
 * Any other redirect is where Better Auth sends the browser next.
 */
function classifyBetterAuthRedirect(response: Response): BetterAuthBoundaryFailure {
  const headers = collectBetterAuthHeaders(response, undefined)
  const setCookies = readSetCookies(headers)
  const target = parseLocation(response.headers.get('Location'))
  const code = target?.searchParams.get('error') ?? null

  if (code === null || code === '') {
    return BetterAuthBoundaryFailure.BetterAuthRedirected({ status: response.status, cause: response, headers, setCookies })
  }

  const cookies = new Headers()
  for (const cookie of setCookies) cookies.append('set-cookie', cookie)

  return BetterAuthBoundaryFailure.BetterAuthRequestRejected({
    error: {
      status: response.status,
      code,
      message: target?.searchParams.get('error_description') || describeErrorCode(code),
      body: undefined,
      cause: response,
      headers: cookies,
      setCookies,
    },
    headers: cookies,
    setCookies,
  })
}

function parseLocation(location: string | null): URL | undefined {
  if (location === null) return undefined

  try {
    return new URL(location, 'http://localhost')
  } catch {
    return undefined
  }
}

/** Better Auth's error code as a sentence: `INVALID_TOKEN` reads "Invalid token". */
function describeErrorCode(code: string): string {
  const words = code.replaceAll('_', ' ').toLowerCase()

  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

export function toAuthActionError(
  failure: BetterAuthBoundaryFailure,
  errorMapper: ((error: BetterAuthActionError) => Record<string, string>) | undefined
): AuthRedirect | ValidationError | AuthRateLimitError | HttpError {
  return Match.value(failure).pipe(Match.tagsExhaustive({
    BetterAuthRedirected: (failure) =>
      new AuthRedirect({
        status: failure.status,
        headers: new Headers(failure.headers),
      }),
    BetterAuthRequestRejected: (failure) =>
      new ValidationError({
        errors: (errorMapper ?? defaultAuthErrorMapper)(failure.error),
        headers: new Headers(failure.headers),
      }),
    BetterAuthRateLimited: (failure) =>
      new AuthRateLimitError({
        retryAfterSeconds: failure.retryAfterSeconds,
        cause: failure.cause,
        headers: new Headers(failure.headers),
      }),
    BetterAuthServiceFailed: (failure) =>
      new HttpError({
        status: failure.status,
        message: 'Authentication service failed.',
        cause: failure.cause,
        headers: new Headers(failure.headers),
      }),
  }))
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

// oxlint-disable-next-line effecttsgo/async-function -- The Better Auth response adapter consumes the native Fetch body Promise and treats an unreadable body as unavailable error metadata.
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
    if (S.is(S.Finite)(value) && Number.isSafeInteger(value) && value >= 0) {
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
  if (!S.is(S.Finite)(value) || !Number.isInteger(value)) return undefined

  if (value < 100 || value > 599) return undefined

  return value
}

interface AuthFieldErrors {
  [field: string]: string
}

function defaultAuthErrorMapper(error: BetterAuthActionError): AuthFieldErrors {
  return { form: error.message }
}
