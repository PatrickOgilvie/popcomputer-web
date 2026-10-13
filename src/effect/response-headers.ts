/**
 * Headers an action or a guard layer adds to the response the request ends
 * with, whatever it is: a page, JSON, a redirect or an error. An API marks
 * every answer of a deprecated version, or reports a key's rate limit, from
 * the layer that knows it.
 */

import { Context, Effect } from 'effect'

/** The response headers the request has added so far. */
export class ResponseHeaders extends Context.Service<ResponseHeaders, {
  readonly append: (name: string, value: string) => void
}>()('@popcomputer/web/ResponseHeaders') {}

/**
 * Add a header to the response the request ends with, even a failure's.
 *
 * @example
 * yield* responseHeader('Deprecation', 'true')
 * yield* responseHeader('RateLimit-Remaining', String(remaining))
 */
export const responseHeader = (name: string, value: string): Effect.Effect<void, never, ResponseHeaders> =>
  Effect.map(ResponseHeaders, (headers) => headers.append(name, value))
