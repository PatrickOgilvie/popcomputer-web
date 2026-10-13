/**
 * The JSON body every failure answers a JSON client with, declared once as an
 * Effect Schema: the boundary writes it, a test reads it with `readError`, and
 * a client decodes it with the same schema. It imports only `effect`, so a
 * client bundles nothing else with it.
 */

import { Schema as S } from 'effect'

const FixSuggestion = S.Struct({
  description: S.String,
  code: S.optionalKey(S.String),
})

const ErrorContext = S.Struct({
  route: S.optionalKey(S.Struct({
    method: S.String,
    path: S.String,
    params: S.Record(S.String, S.String),
  })),
  request: S.optionalKey(S.Struct({
    url: S.String,
    headers: S.Record(S.String, S.optional(S.String)),
  })),
})

/**
 * The envelope of a failure, whatever its status: `errors` for a failed
 * form, `body` for an `HttpError` that carries one. Development adds
 * `context` and `fixes`.
 *
 * @example
 * const failure = S.decodeUnknownSync(ErrorResponse)(await res.json())
 * if (failure.httpStatus === 429) retryAfter(res.headers.get('Retry-After'))
 */
export const ErrorResponse = S.Struct({
  code: S.String,
  tag: S.String,
  category: S.Literals([
    'validation',
    'auth',
    'resource',
    'configuration',
    'http',
    'database',
    'routing',
    'service',
    'internal',
  ]),
  title: S.String,
  message: S.String,
  httpStatus: S.Number,
  timestamp: S.String,
  requestId: S.optionalKey(S.String),
  context: S.optionalKey(ErrorContext),
  fixes: S.optionalKey(S.Array(FixSuggestion)),
  /** Each invalid field's message, as a form's page receives them as `errors`. */
  errors: S.optionalKey(S.Record(S.String, S.String)),
  validation: S.optionalKey(S.Unknown),
  body: S.optionalKey(S.Unknown),
})

/** The JSON body of a failure, as `ErrorResponse` decodes it. */
export type ErrorResponseBody = typeof ErrorResponse.Type

/**
 * The envelope of a failure whose `body` an action declared with
 * `httpError(status, message, Body, value)`, decoded through its JSON form.
 *
 * @example
 * const failure = S.decodeUnknownSync(errorResponseWith(InsufficientStock))(await res.json())
 * failure.body.lines
 */
export function errorResponseWith<A, I>(body: S.Codec<A, I, never, never>) {
  return S.Struct({ ...ErrorResponse.fields, body: S.toCodecJson(body) })
}
