/**
 * Better Auth failure boundary.
 *
 * The framework sends every call through Better Auth's request handler, which
 * answers with a Response: a success, an error status, or a redirect. A
 * handler that throws has failed itself. This module classifies those answers
 * into the package's typed errors, so actions never inspect raw Better Auth
 * output, and keeps of Better Auth's headers only the ones that mean something
 * to the application's own response: its cookies, and a redirect's Location.
 */

import { Data, Effect, Match, Schema as S } from 'effect'
import {
  AuthRateLimitError,
  AuthRedirect,
  HttpError,
  ValidationError,
} from './errors.js'

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
  /** The cookies Better Auth set while rejecting the request, as headers. */
  readonly headers: Headers
  /** Cookies Better Auth set before rejecting the request. */
  readonly setCookies: readonly string[]
}

type BetterAuthBoundaryFailure =
  | {
      readonly _tag: 'BetterAuthRedirected'
      readonly status: number
      readonly cause: unknown
      readonly headers: Headers
    }
  | {
      readonly _tag: 'BetterAuthRequestRejected'
      readonly error: BetterAuthActionError
    }
  | {
      readonly _tag: 'BetterAuthRateLimited'
      readonly retryAfterSeconds: number | undefined
      readonly cause: unknown
      readonly headers: Headers
    }
  | {
      readonly _tag: 'BetterAuthServiceFailed'
      readonly status: number
      readonly cause: unknown
      readonly headers: Headers
    }

const BetterAuthBoundaryFailure = Data.taggedEnum<BetterAuthBoundaryFailure>()

/**
 * Send a call to Better Auth's handler. A handler that throws has failed
 * itself, whatever it threw, so the failure never shows its message to a
 * visitor.
 */
export function sendToBetterAuth(call: () => Promise<Response>): Effect.Effect<Response, BetterAuthBoundaryFailure> {
  return Effect.tryPromise({
    try: call,
    catch: (cause) => BetterAuthBoundaryFailure.BetterAuthServiceFailed({ status: 502, cause, headers: new Headers() }),
  })
}

/** Classify the handler's answer: a success passes through, and a redirect or error status fails. */
export function inspectBetterAuthResponse(response: Response): Effect.Effect<Response, BetterAuthBoundaryFailure> {
  if (response.status >= 300 && response.status < 400) return Effect.fail(classifyRedirect(response))

  if (response.status >= 400) {
    return Effect.promise(() => readJsonBody(response)).pipe(
      Effect.flatMap((body) => Effect.fail(classifyErrorStatus(response, body)))
    )
  }

  return Effect.succeed(response)
}

/** The cookies a response sets, as headers of their own. */
function cookiesOf(response: Response): Headers {
  const cookies = new Headers()

  for (const cookie of response.headers.getSetCookie()) cookies.append('set-cookie', cookie)

  return cookies
}

/**
 * A redirect Better Auth's handler answered. Some endpoints report a failure
 * by redirecting with `?error=CODE`, as a used magic link does: that is a
 * rejection, carrying only the redirect's cookies, so the action can show it.
 * Any other redirect is where Better Auth sends the browser next.
 */
function classifyRedirect(response: Response): BetterAuthBoundaryFailure {
  const cookies = cookiesOf(response)
  const location = response.headers.get('Location')
  const target = parseLocation(location)
  const code = target?.searchParams.get('error') ?? null

  if (code === null || code === '') {
    const headers = new Headers(cookies)
    if (location !== null) headers.set('Location', location)

    return BetterAuthBoundaryFailure.BetterAuthRedirected({ status: response.status, cause: response, headers })
  }

  return BetterAuthBoundaryFailure.BetterAuthRequestRejected({
    error: {
      status: response.status,
      code,
      message: target?.searchParams.get('error_description') || describeErrorCode(code),
      body: undefined,
      cause: response,
      headers: cookies,
      setCookies: cookies.getSetCookie(),
    },
  })
}

/** An error status Better Auth's handler answered, with the JSON body it sent. */
function classifyErrorStatus(response: Response, body: unknown): BetterAuthBoundaryFailure {
  const cookies = cookiesOf(response)

  if (response.status === 429) {
    return BetterAuthBoundaryFailure.BetterAuthRateLimited({
      retryAfterSeconds: retryAfterSeconds(response.headers.get('X-Retry-After') ?? response.headers.get('Retry-After')),
      cause: response,
      headers: cookies,
    })
  }

  if (response.status >= 500) {
    return BetterAuthBoundaryFailure.BetterAuthServiceFailed({ status: response.status, cause: response, headers: cookies })
  }

  return BetterAuthBoundaryFailure.BetterAuthRequestRejected({
    error: {
      status: response.status,
      code: stringProperty(body, 'code'),
      message: stringProperty(body, 'message') ?? 'Unable to complete request. Please try again.',
      body,
      cause: response,
      headers: cookies,
      setCookies: cookies.getSetCookie(),
    },
  })
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
        headers: new Headers(failure.error.headers),
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

// oxlint-disable-next-line effecttsgo/async-function -- The Better Auth response adapter consumes the native Fetch body Promise and treats an unreadable body as unavailable error metadata.
async function readJsonBody(response: Response): Promise<unknown> {
  if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('json')) return undefined

  try {
    return await response.clone().json()
  } catch {
    return undefined
  }
}

function stringProperty(value: unknown, key: string): string | undefined {
  const property: unknown = value instanceof Object ? Reflect.get(value, key) : undefined

  return S.is(S.String)(property) ? property : undefined
}

/** Seconds to wait, from Better Auth's `X-Retry-After` or a standard `Retry-After` header. */
function retryAfterSeconds(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header)) return undefined

  const seconds = Number(header)

  return Number.isSafeInteger(seconds) ? seconds : undefined
}

function defaultAuthErrorMapper(error: BetterAuthActionError): Record<string, string> {
  return { form: error.message }
}
