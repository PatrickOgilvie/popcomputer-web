/**
 * Effect Action Composables
 *
 * Composable helpers for building Effect-based request handlers.
 * Actions are fully opt-in - yield* only what you need.
 */

import type { Effect } from 'effect'
import type { Redirect } from './errors.js'

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
 *     return yield* redirect(`/projects/${project.id}`)
 *   })
 * )
 */
export function action<R, E>(
  handler: Effect.Effect<Response | Redirect, E, R>
): Effect.Effect<Response | Redirect, E, R> {
  return handler
}
