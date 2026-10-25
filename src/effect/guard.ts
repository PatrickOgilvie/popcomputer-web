/**
 * Guards: the layers that decide whether a visitor may go on, provided to the
 * routes they guard. A `guarded: true` binding loads only once a guard that
 * read it has let the visitor in, so a layer that reads a record for some
 * other reason, such as breadcrumbs, never stands in for the one that decides.
 */

import { Context, Effect, Layer, Option, type Scope } from 'effect'

/**
 * Present while a guard decides: the guarded records its decision has read.
 * Only `guard` provides it, so only a guard's reads vouch for a guarded
 * binding, and only once that guard has decided.
 */
export class GuardDecision extends Context.Service<GuardDecision, {
  readonly reads: Set<string>
}>()('@popcomputer/web/GuardDecision') {}

/**
 * The request's guards, which the route provides: every guard starts its
 * decision through it, however the layer it made was composed, and the
 * records a guard read are decided once it lets the visitor in.
 *
 * @internal
 */
export class GuardVerdicts extends Context.Service<GuardVerdicts, {
  /** A guard starts deciding: the page it guards is no shared cache's to keep. */
  readonly start: Effect.Effect<void>
  /** A guard let the visitor in: the guarded records it read are decided. */
  readonly confirm: (reads: ReadonlySet<string>) => Effect.Effect<void>
}>()('@popcomputer/web/GuardVerdicts') {}

/**
 * A guard: a layer that decides whether the visitor may go on, failing to
 * turn them away, as `notFound` for a record they may not see or `forbidden`
 * for one they may see but not change. Provide it to the routes it guards,
 * `routes.provide(guard(...))`, before any layer that reads their records.
 *
 * Give it the Effect that decides, or the service it finds, such as the
 * visitor's membership, and the Effect that finds it, or a layer. A role or
 * permission check reads the membership guard's service: an action states
 * it, `yield* can('members.invite')`, so registering it without the guard is
 * a type error, and a group whose every route needs it is given it as a
 * guard after the membership guard:
 *
 * @example
 * export const RequireMember = guard(CurrentMember, Effect.gen(function* () {
 *   const auth = yield* authorize()
 *   const organization = yield* bound('organization')
 *   const [membership] = yield* dbQuery((db) => db.select().from(memberships).where(and(
 *     eq(memberships.organizationId, organization.id),
 *     eq(memberships.userId, auth.user.id)
 *   )))
 *
 *   if (membership === undefined) return yield* notFound('Organization')
 *
 *   return CurrentMember.of(membership)
 * }))
 *
 * export const can = (permission: Permission) => Effect.gen(function* () {
 *   const member = yield* CurrentMember
 *
 *   if (!permissions[member.role].includes(permission)) return yield* forbidden('Your role does not allow that.')
 *
 *   return member
 * })
 *
 * routes.prefix('/orgs/{organization:slug}').provide(RequireMember)
 *   .get(paths.organization, showOrganization)
 *   .provide(guard(can('projects.delete'))).delete(paths.project, deleteProject)
 */
export function guard<X, E, R>(decide: Effect.Effect<X, E, R>): Layer.Layer<never, E, Exclude<R, Scope.Scope | GuardDecision>>
export function guard<I, S, E, R>(
  service: Context.Key<I, S>,
  find: Effect.Effect<NoInfer<S>, E, R>
): Layer.Layer<I, E, Exclude<R, Scope.Scope | GuardDecision>>
export function guard<ROut, E, RIn>(layer: Layer.Layer<ROut, E, RIn>): Layer.Layer<ROut, E, Exclude<RIn, GuardDecision>>
export function guard(
  first: Effect.Effect<unknown, unknown, unknown> | Layer.Layer<unknown, unknown, unknown> | Context.Key<unknown, unknown>,
  find?: Effect.Effect<unknown, unknown, unknown>
): Layer.Layer<unknown, unknown, unknown> | Layer.Layer<never, unknown, unknown> {
  // SAFETY: The two-argument overload takes a service key and the Effect that finds its value.
  if (find !== undefined) return guardLayer(Layer.effect(first as Context.Key<unknown, unknown>, find))

  if (Layer.isLayer(first)) return guardLayer(first)

  // SAFETY: The one-argument overloads take a layer, handled above, or the Effect that decides.
  return guardLayer(Layer.effectDiscard(first as Effect.Effect<unknown, unknown, unknown>))
}

/** The layers `guard` made. */
const guards = new WeakSet<Layer.Layer<never, unknown, unknown>>()

function guardLayer<ROut, E, RIn>(decide: Layer.Layer<ROut, E, RIn>): Layer.Layer<ROut, E, Exclude<RIn, GuardDecision>> {
  // Each request builds the layer anew, inside whatever layer it was composed
  // into, so the route sees every guard decide, however it was provided.
  const layer = Layer.unwrap(Effect.gen(function* () {
    const verdicts = yield* Effect.serviceOption(GuardVerdicts)
    const decision = GuardDecision.of({ reads: new Set() })

    if (Option.isSome(verdicts)) yield* verdicts.value.start

    return decide.pipe(
      Layer.provide(Layer.succeed(GuardDecision, decision)),
      // A layer built beside the guard, as Layer.merge builds it, reads none
      // of the guarded records until the guard has decided.
      Layer.tap(() => Option.isSome(verdicts) ? verdicts.value.confirm(decision.reads) : Effect.void)
    )
  }))

  guards.add(layer)

  return layer
}

/**
 * Whether `guard` made this layer, as it was provided. The default page cache
 * answers before any layer runs, so it caches no route a guard decides for:
 * the guard may read what no cache key holds, such as the visitor's address
 * or country. A guard composed into another layer is found when it decides,
 * through GuardVerdicts.
 */
export const isGuard = (layer: Layer.Layer<never, unknown, unknown>): boolean => guards.has(layer)

/** The decision of the guard the running Effect is part of, if it is a guard deciding. */
export const currentDecision: Effect.Effect<Option.Option<GuardDecision['Service']>> = Effect.serviceOption(GuardDecision)
