/**
 * Effect Action Composables
 *
 * Composable helpers for building Effect-based request handlers.
 * Actions are fully opt-in - yield* only what you need.
 */

import { Effect } from 'effect'
import type { Endpoint, EndpointError, EndpointInput, EndpointSuccess } from '../endpoint.js'
import { endpointAction, type EndpointAction } from './endpoint-action.js'
import type { Redirect, ValidationError } from './errors.js'
import type { RequestService, ResponseFactoryService } from './services.js'

/**
 * Mark an Effect as a route action.
 *
 * Everything an action does is opt-in: it yields the services and helpers it
 * needs and ends every branch with a response helper.
 *
 * @example
 * const createProject = action(
 *   Effect.gen(function* () {
 *     const auth = yield* authorize()
 *     const input = yield* validateRequest(S.Struct({ name: requiredString }))
 *
 *     const [project] = yield* dbMutation((db) =>
 *       db.insert(projects).values({ ...input, userId: auth.user.id }).returning()
 *     )
 *
 *     return yield* redirect(paths.project, { project: project.id })
 *   })
 * )
 */
export function action<R, E>(
  handler: Effect.Effect<Response | Redirect, E, R>
): Effect.Effect<Response | Redirect, E, R>
/**
 * Implement an endpoint declared with `endpoint` from
 * `@popcomputer/web/endpoint`: the handler receives the input it declares,
 * decoded, and returns its success value, which the response encodes. Input
 * that does not decode is answered `422` before the handler runs, and a
 * failure the endpoint declares is answered with its status. Register it with
 * `routes.endpoint(action)`.
 *
 * @example
 * export const createPlace = action(endpoints.createPlace, ({ body }) =>
 *   Effect.gen(function* () {
 *     const auth = yield* authorize()
 *     const [place] = yield* dbMutation((db) =>
 *       db.insert(places).values({ ...body, ownerId: auth.user.id }).returning()
 *     )
 *
 *     return place
 *   })
 * )
 */
export function action<const Ep extends Endpoint, Err, R>(
  endpoint: Ep,
  handler: (input: EndpointInput<Ep>) => Effect.Effect<EndpointSuccess<Ep>, Err, R>
): EndpointAction<Ep, Exclude<Err, EndpointError<Ep>> | ValidationError, R | RequestService | ResponseFactoryService>
export function action(
  first: Effect.Effect<Response | Redirect, unknown, unknown> | Endpoint,
  handler?: (input: never) => Effect.Effect<unknown, unknown, unknown>
): Effect.Effect<Response | Redirect, unknown, unknown> | EndpointAction<Endpoint, unknown, unknown> {
  if (Effect.isEffect(first)) return first
  if (handler === undefined) throw new TypeError('action(endpoint, handler) takes the handler that implements the endpoint.')

  // SAFETY: the overload above typed the handler by this endpoint.
  return endpointAction(first, handler as (input: EndpointInput<Endpoint>) => Effect.Effect<void, unknown, unknown>)
}
