/**
 * A browser's cookies for one site, as RFC 6265 keeps them: each held by its
 * name and path, until its `Max-Age` or `Expires` passes, and sent to the
 * paths its path covers, longest path first. Pure data and functions: the
 * test browser holds a jar and replaces it with each response.
 *
 * @internal
 */

/** A cookie the jar holds. */
export interface HeldCookie {
  readonly name: string
  readonly value: string
  readonly path: string
  /** When it expires, in milliseconds; none for one that lasts the session. */
  readonly expiresAt: number | undefined
  /** When it was first set, which orders cookies of equal paths. */
  readonly createdAt: number
}

/** A jar of cookies, in the order they were first set. */
export type CookieJar = ReadonlyArray<HeldCookie>

/** The path a cookie set with no usable `Path` takes: the directory of the path that set it (§5.1.4). */
function defaultPath(requestPath: string): string {
  if (!requestPath.startsWith('/')) return '/'

  const last = requestPath.lastIndexOf('/')

  return last === 0 ? '/' : requestPath.slice(0, last)
}

/** Whether a cookie's path covers a request's path: equal, or a prefix ending at a `/` (§5.1.4). */
export function pathMatches(cookiePath: string, requestPath: string): boolean {
  return requestPath === cookiePath || (
    requestPath.startsWith(cookiePath) && (cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/')
  )
}

/**
 * When a cookie expires: `Max-Age` seconds from now before `Expires`, so one
 * of zero or less has expired already, and neither for a session cookie
 * (§5.2.1, §5.2.2, §5.3).
 */
function expiryOf(attributes: ReadonlyMap<string, string>, now: number): number | undefined {
  const maxAge = /^-?\d+$/.exec(attributes.get('max-age') ?? '')?.[0]

  if (maxAge !== undefined) return now + Number(maxAge) * 1000

  const at = Date.parse(attributes.get('expires') ?? '')

  return Number.isNaN(at) ? undefined : at
}

/** A cookie's name and value, the first `=` apart: none without one, or with an empty name (§5.2). */
const COOKIE_PAIR = /^\s*([^=]*[^=\s])\s*=(.*)$/

/** An attribute's name and value, the value empty when it has none. */
const COOKIE_ATTRIBUTE = /^\s*([^=]*?)\s*(?:=(.*))?$/

/** A `Set-Cookie` header as its name, value and attributes, lowercased by name; undefined for one with no name. */
function parseSetCookie(header: string): { readonly name: string; readonly value: string; readonly attributes: ReadonlyMap<string, string> } | undefined {
  const [pair = '', ...parts] = header.split(';')
  const [, name, value = ''] = COOKIE_PAIR.exec(pair) ?? []

  if (name === undefined) return undefined

  const attributes = new Map(parts.map((part) => {
    const [, key = '', given = ''] = COOKIE_ATTRIBUTE.exec(part) ?? []

    return [key.toLowerCase(), given.trim()] as const
  }))

  return { name, value: value.trim(), attributes }
}

/**
 * The jar once a response received at `requestPath` at `now` set its
 * cookies: each replaces the one of its name and path, keeping when that one
 * was first set, so one already expired removes it (§5.3).
 */
export function receive(jar: CookieJar, setCookies: ReadonlyArray<string>, requestPath: string, now: number): CookieJar {
  let held = jar

  for (const header of setCookies) {
    const parsed = parseSetCookie(header)

    if (parsed === undefined) continue

    const given = parsed.attributes.get('path')
    const path = given !== undefined && given.startsWith('/') ? given : defaultPath(requestPath)
    const same = held.find((cookie) => cookie.name === parsed.name && cookie.path === path)

    held = [
      ...held.filter((cookie) => cookie !== same),
      { name: parsed.name, value: parsed.value, path, expiresAt: expiryOf(parsed.attributes, now), createdAt: same?.createdAt ?? now },
    ]
  }

  return held
}

/** The cookies the jar still holds at `now`: those not yet expired. */
export function held(jar: CookieJar, now: number): ReadonlyArray<HeldCookie> {
  return jar.filter((cookie) => cookie.expiresAt === undefined || cookie.expiresAt > now)
}

/** The cookies a request to `requestPath` at `now` sends: unexpired, covered by their path, longest path first (§5.4). */
export function sent(jar: CookieJar, requestPath: string, now: number): ReadonlyArray<HeldCookie> {
  return held(jar, now)
    .filter((cookie) => pathMatches(cookie.path, requestPath))
    .sort((a, b) => b.path.length - a.path.length || a.createdAt - b.createdAt)
}
