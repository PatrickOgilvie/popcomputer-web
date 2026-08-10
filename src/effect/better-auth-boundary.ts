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

import { Effect } from 'effect'
import { AuthRateLimitError, HttpError, ValidationError } from './errors.js'

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
}

export type BetterAuthBoundaryFailure =
  | {
      readonly _tag: 'BetterAuthRequestRejected'
      readonly error: BetterAuthActionError
    }
  | {
      readonly _tag: 'BetterAuthRateLimited'
      readonly retryAfterSeconds: number | undefined
      readonly cause: unknown
    }
  | {
      readonly _tag: 'BetterAuthServiceFailed'
      readonly status: number
      readonly cause: unknown
    }

interface BetterAuthFailureHints {
  readonly source: 'exception' | 'result'
  readonly status?: number
  readonly body?: unknown
}

export function inspectBetterAuthActionResult(
  result: BetterAuthActionResult
): Effect.Effect<BetterAuthActionResult, BetterAuthBoundaryFailure> {
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
    const status = parseHttpStatus(result.status)
    if (status !== undefined && status >= 400) {
      return Effect.fail(
        classifyBetterAuthFailure(result, {
          source: 'result',
          status,
          body: result.response,
        })
      )
    }
  }

  return Effect.succeed(result)
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
    hints.source === 'result' ||
    (cause instanceof Error && cause.name === 'APIError')

  if (!isVerifiedBetterAuthFailure || status === undefined) {
    return {
      _tag: 'BetterAuthServiceFailed',
      status: status !== undefined && status >= 500 ? status : 502,
      cause,
    }
  }

  if (status === 429) {
    return {
      _tag: 'BetterAuthRateLimited',
      retryAfterSeconds: firstRetryAfterSeconds(
        getBoundaryHeader(cause, 'X-Retry-After'),
        getBoundaryHeader(cause, 'Retry-After'),
        getBoundaryHeader(nestedResponse, 'X-Retry-After'),
        getBoundaryHeader(nestedResponse, 'Retry-After'),
        getBoundaryProperty(body, 'retryAfter')
      ),
      cause,
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
      },
    }
  }

  return {
    _tag: 'BetterAuthServiceFailed',
    status: status !== undefined && status >= 500 ? status : 502,
    cause,
  }
}

export function toHonertiaAuthError(
  failure: BetterAuthBoundaryFailure,
  component: string,
  errorMapper: ((error: BetterAuthActionError) => Record<string, string>) | undefined
): ValidationError | AuthRateLimitError | HttpError {
  switch (failure._tag) {
    case 'BetterAuthRequestRejected':
      return new ValidationError({
        errors: (errorMapper ?? defaultAuthErrorMapper)(failure.error),
        component,
      })
    case 'BetterAuthRateLimited':
      return new AuthRateLimitError({
        retryAfterSeconds: failure.retryAfterSeconds,
        cause: failure.cause,
      })
    case 'BetterAuthServiceFailed':
      return new HttpError({
        status: failure.status,
        message: 'Authentication service failed.',
        cause: failure.cause,
      })
  }
}

async function readBetterAuthResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.toLowerCase()
  if (!contentType?.includes('json')) return undefined

  try {
    return await response.clone().json()
  } catch {
    return undefined
  }
}

function getBoundaryProperty(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined
  }
  return Reflect.get(value, key)
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') return value
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
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      return value
    }

    if (typeof value === 'string' && /^\d+$/.test(value)) {
      const seconds = Number(value)
      if (Number.isSafeInteger(seconds)) return seconds
    }
  }

  return undefined
}

function getBoundaryHeader(value: unknown, name: string): string | undefined {
  const headers = getBoundaryProperty(value, 'headers')
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined
  }

  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (
        Array.isArray(entry) &&
        entry.length >= 2 &&
        typeof entry[0] === 'string' &&
        entry[0].toLowerCase() === name.toLowerCase() &&
        typeof entry[1] === 'string'
      ) {
        return entry[1]
      }
    }

    return undefined
  }

  if (headers === null || typeof headers !== 'object') {
    return undefined
  }

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== name.toLowerCase()) continue
    const header = Reflect.get(headers, key)
    if (typeof header === 'string') return header
  }

  return undefined
}

function parseHttpStatus(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  if (value < 100 || value > 599) return undefined
  return value
}

function defaultAuthErrorMapper(error: BetterAuthActionError): Record<string, string> {
  return { form: error.message }
}
