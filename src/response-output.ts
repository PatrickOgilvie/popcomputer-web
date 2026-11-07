/**
 * What a response carries beside its body, queued while the request runs,
 * and finishing the response with it, once.
 *
 * An action queues application cookies (`cookie(...)`) and headers
 * (`responseHeader`), the session lookup queues the cookies Better Auth set
 * renewing or ending the session, and `web()` holds the flash. A route
 * finishes its own response before its cache policy reads it, so the policy
 * sees every cookie the response will carry; `web()` finishes any other
 * response, such as a plain Hono handler's or Better Auth's.
 */

import type { Context, Env } from 'hono'
import { openWebContext } from './request-context.js'
import { setCookieName } from './session-cookies.js'
import { HEADERS } from './types.js'
import { webUrl } from './locations.js'
import { setupOf } from './web-setup.js'

/** Queue an application cookie, a whole Set-Cookie value, for the response. */
export function queueCookie<E extends Env>(c: Context<E>, setCookie: string): void {
  const context = openWebContext(c)

  context.responseCookies = [...(context.responseCookies ?? []), setCookie]
}

/** Queue the cookies the session lookup set, renewing the session or ending one revoked. */
export function queueSessionLookupCookies<E extends Env>(c: Context<E>, cookies: readonly string[]): void {
  const context = openWebContext(c)

  context.sessionLookupCookies = [...(context.sessionLookupCookies ?? []), ...cookies]
}

/** Queue a header for the response, appended to any it already has. */
export function queueHeader<E extends Env>(c: Context<E>, name: string, value: string): void {
  const context = openWebContext(c)

  context.responseHeaders = [...(context.responseHeaders ?? []), [name, value]]
}

/**
 * Set by a page on the response that carries it, and taken off by
 * {@link finishResponse}, so the flash cookie and the history's clear move on
 * the page the request answered with, not on one an action rendered and dropped.
 */
export const PAGE_MARK = 'x-popweb-page'

/** The mark of a page that clears Inertia's history. */
export const CLEARING_PAGE = 'clears'

/** The mark of any other page. */
export const SHOWN_PAGE = 'shown'

/** The cookies the session lookup set, which tell a page whether the session it found had ended. */
export function sessionLookupCookies<E extends Env>(c: Context<E>): readonly string[] {
  return openWebContext(c).sessionLookupCookies ?? []
}

/** Whether this response sets something of the recipient's own: a cookie, or Better Auth's bearer token. */
export function setsRecipientState(response: Response): boolean {
  return response.headers.getSetCookie().length > 0 || response.headers.has('set-auth-token')
}

/**
 * The response with everything the request queued, once: a second call, as
 * `web()` makes after a route has finished its response, returns it as it
 * is. In order:
 *
 * - an Inertia visit's redirect is one it can follow: a 302 after a form is
 *   a 303, and one to another site is a 409 that names it, each keeping the
 *   response's cookies;
 * - an answer that ends the session, as signing out does, or starts
 *   another, as signing in does, has the next page clear the history the
 *   previous session's pages wrote, unless a page this request rendered
 *   already cleared it;
 * - the flash cookie, the application's cookies, the session lookup's that
 *   the response does not set itself (a sign-in's new session outlives the
 *   old one's renewal), and the queued headers.
 */
export function finishResponse<E extends Env>(c: Context<E>, response: Response): Response {
  const output = outputOf(c)

  if (output.finished) return response

  output.finished = true

  const context = openWebContext(c)
  const followed = followableRedirect(c, response)
  const appCookies = context.responseCookies ?? []
  const lookupCookies = context.sessionLookupCookies ?? []
  const added = context.responseHeaders ?? []
  const flash = context.flash
  const pageMark = followed.headers.get(PAGE_MARK)

  if (flash !== undefined && pageMark !== CLEARING_PAGE) {
    const own = [...followed.headers.getSetCookie(), ...appCookies]
    const ownNames = new Set(own.map(setCookieName))
    const answered = [
      ...own,
      ...lookupCookies.filter((cookie) => !ownNames.has(setCookieName(cookie))),
      ...added.filter(([name]) => name.toLowerCase() === 'set-cookie').map(([, value]) => value),
    ]
    const session = setupOf(c).sessionCookies

    if (session.endsSession(answered) || session.startsSession(answered, c.req.header('Cookie'))) flash.clearHistory()
  }

  const flashCookie = flash?.cookie(pageMark === null
    ? { page: false, status: followed.status }
    : { page: true, cleared: pageMark === CLEARING_PAGE })
  const cookies = [...(flashCookie === undefined ? [] : [flashCookie]), ...appCookies]
  const setNames = new Set([...followed.headers.getSetCookie(), ...cookies].map(setCookieName))
  const lookups = lookupCookies.filter((cookie) => !setNames.has(setCookieName(cookie)))

  if (pageMark === null && cookies.length === 0 && lookups.length === 0 && added.length === 0) return followed

  const headers = new Headers(followed.headers)

  headers.delete(PAGE_MARK)

  for (const cookie of [...cookies, ...lookups]) headers.append('Set-Cookie', cookie)
  for (const [name, value] of added) headers.append(name, value)

  return new Response(followed.body, { status: followed.status, statusText: followed.statusText, headers })
}

/** Whether the request's response has been finished. */
export function isFinished<E extends Env>(c: Context<E>): boolean {
  return outputOf(c).finished
}

function outputOf<E extends Env>(c: Context<E>): { finished: boolean } {
  const context = openWebContext(c)

  context.output ??= { finished: false }

  return context.output
}

/**
 * The redirect an Inertia visit can follow, with the response's cookies: a
 * 302 after a form is a 303, as Inertia follows with GET, and one to another
 * site, which a visit cannot reach, is a 409 naming it, which Inertia loads
 * as a full page. The redirect's cookies, such as an OAuth state, stay on it.
 */
function followableRedirect<E extends Env>(c: Context<E>, response: Response): Response {
  if (c.req.header(HEADERS.INERTIA) !== 'true') return response

  const elsewhere = otherSiteLocation(response, c.req.url)

  if (elsewhere !== undefined) return redirectWith(response, 409, { [HEADERS.LOCATION]: elsewhere })

  const location = response.headers.get('Location')

  if (response.status === 302 && location && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
    return redirectWith(response, 303, { Location: location })
  }

  return response
}

/** A bodiless answer of `status` with these headers, Vary on X-Inertia, and the response's cookies. */
function redirectWith(response: Response, status: number, location: Readonly<Record<string, string>>): Response {
  const headers = new Headers({ ...location, Vary: HEADERS.INERTIA })

  for (const cookie of response.headers.getSetCookie()) headers.append('Set-Cookie', cookie)

  return new Response(null, { status, headers })
}

/**
 * The redirect's location when it leads to another site than the request's,
 * which an Inertia visit cannot follow. Only a web page qualifies: Inertia
 * assigns the location to `window.location.href`, which would run a
 * `javascript:` URL on the application's page, though no browser follows one
 * from a redirect.
 */
function otherSiteLocation(response: Response, requestUrl: string): string | undefined {
  const location = response.status >= 300 && response.status < 400 ? response.headers.get('Location') : null

  if (location === null) return undefined

  const target = webUrl(location, requestUrl)

  return target !== undefined && target.origin !== webUrl(requestUrl)?.origin ? target.href : undefined
}
