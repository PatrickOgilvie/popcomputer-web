/**
 * Who is asking: a closed set, so a lookup that failed or never ran reads as
 * neither a guest nor a member. A page clears Inertia's history only for a
 * guest, and is someone's own only for a member.
 *
 * A route that must answer whoever is asking, as sign-out must when the
 * session cannot be read, says so with {@link forAnyVisitor}.
 */
import { Data } from 'effect'
import type { Context, Env, MiddlewareHandler } from 'hono'
import { matchedRoutes } from 'hono/route'
import type { AuthUser } from './effect/services.js'

export type Visitor = Data.TaggedEnum<{
  /** Nothing has looked: the lookup has not run, or the application has none. */
  Unread: {}
  /** The lookup found no session. */
  Guest: {}
  /** The lookup found this session, or a layer gives the action this user. */
  Member: { readonly user: AuthUser }
  /** The lookup ran and could not say: the store is down, or the session does not decode. */
  Unknown: {}
}>

export const Visitor = Data.taggedEnum<Visitor>()

const forAnyVisitorActions = new WeakSet<object>()
const forAnyVisitorHandlers = new WeakSet<object>()

/** Mark an action that runs whoever is asking, even when the session lookup failed. */
export function forAnyVisitor<A extends object>(action: A): A {
  forAnyVisitorActions.add(action)

  return action
}

/** Whether this action runs whoever is asking. */
export const isForAnyVisitor = (action: object): boolean => forAnyVisitorActions.has(action)

/** Record a route's handler as one that runs whoever is asking. */
export function handlerForAnyVisitor<E extends Env>(handler: MiddlewareHandler<E>): MiddlewareHandler<E> {
  forAnyVisitorHandlers.add(handler)

  return handler
}

/** Whether the route this request matched runs whoever is asking. */
export function answersAnyVisitor<E extends Env>(c: Context<E>): boolean {
  return matchedRoutes(c).some((route) => forAnyVisitorHandlers.has(route.handler))
}
