/**
 * Why a response may not be shared, recorded while the request runs, and
 * read by each cache that would share it: the default page cache, which
 * answers before any middleware or guard runs, and a route's own `cache`
 * option, which keeps a response for a fixed time behind them.
 *
 * Each reason keeps the response out of the caches it names, and no other:
 * a guard keeps a page out of the page cache, which would answer before the
 * guard decides, but a route's own option is that route's decision.
 */

import type { Context, Env } from 'hono'
import { openWebContext } from './request-context.js'

/** Why a response depends on what a cache's key does not hold. */
export type PrivacyReason =
  /** It read a header, the raw request or request state, or an application said so with `markPageDynamic`. */
  | 'request'
  /**
   * setupWeb's database factory or the application's own middleware read a
   * header. A route's own `cache` option keeps nothing; the default page
   * cache, which `pageCache: true` turns on behind that middleware, keeps
   * its pages.
   */
  | 'setup'
  /** An access check ran, a guard or prefix middleware, which a page cached before it would skip. */
  | 'guard'
  /**
   * It read data: a binding, or the database. The page cache keeps nothing;
   * a route's own `cache` option keeps data reads for its fixed time.
   */
  | 'data'
  /** The page went to a signed-in visitor: no cache keeps it. */
  | 'signed-in'

/** A cache that would share a response between visitors. */
export type SharedCache = 'page' | 'route'

const KEEPS_OUT = {
  request: new Set<SharedCache>(['page', 'route']),
  setup: new Set<SharedCache>(['route']),
  guard: new Set<SharedCache>(['page']),
  data: new Set<SharedCache>(['page']),
  'signed-in': new Set<SharedCache>(['page', 'route']),
} satisfies Readonly<Record<PrivacyReason, ReadonlySet<SharedCache>>>

/** Record why the request's response may not be shared. */
export function recordPrivacy<E extends Env>(c: Context<E>, reason: PrivacyReason): void {
  const context = openWebContext(c)

  context.privacy = new Set([...(context.privacy ?? []), reason])

  // The flags this recorder replaced, still set for code that read them.
  if (KEEPS_OUT[reason].has('route')) context.readRequestState = true
  if (reason === 'signed-in') context.signedIn = true
}

/** Whether a recorded reason keeps the request's response out of this cache. */
export function keptFrom<E extends Env>(c: Context<E>, cache: SharedCache): boolean {
  return [...(openWebContext(c).privacy ?? [])].some((reason) => KEEPS_OUT[reason].has(cache))
}

/** Whether a page this request rendered went to a signed-in visitor. */
export function renderedSignedIn<E extends Env>(c: Context<E>): boolean {
  return openWebContext(c).privacy?.has('signed-in') === true
}
