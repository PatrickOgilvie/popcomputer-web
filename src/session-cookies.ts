/**
 * Which cookies hold a visitor's session, decided once for every place that
 * asks: the cache policies, the session lookup, Inertia's history clear and
 * sign-out.
 *
 * A session cookie is one of Better Auth's, under any cookie prefix, or a
 * name the application registers with `auth.sessionCookie`, each also under
 * the `__Secure-` and `__Host-` prefixes a browser enforces. Its token cookie
 * is Better Auth's `session_token`, or a registered name: the one a sign-in
 * sets and a sign-out expires.
 *
 * Names are read from the header as they are, whatever their values, so a
 * value a cookie parser would refuse never hides a session from a cache.
 * Other cookies (analytics, consent, bot management) are no session's: they
 * personalize nothing, and counting them would keep almost every browser's
 * pages out of shared caches. An application that signs people in with a
 * cookie of its own registers its name, or keeps the `cache` option off its
 * signed-in routes.
 */

/** The prefixes a browser enforces on a cookie's name, which name no other cookie. */
const BROWSER_PREFIX = /^__(?:Secure|Host)-/

/** Better Auth's default cookie prefix: every cookie under it is the session's. */
const BETTER_AUTH_PREFIX = 'better-auth.'

/** The cookies Better Auth names after its prefix, whatever the prefix is, that carry the session. */
const BETTER_AUTH_SESSION_COOKIES = ['session_token', 'session_data', 'account_data', 'dont_remember'] as const

/** The cookies sign-out expires when Better Auth's answer expires none, in place of names the application gives. */
const DEFAULT_SIGN_OUT_COOKIES = BETTER_AUTH_SESSION_COOKIES.map((cookie) => `${BETTER_AUTH_PREFIX}${cookie}`)

/** A session token cookie as a response leaves it: its value, unless it expires it. */
export interface SessionTokenState {
  readonly value: string
  readonly expired: boolean
}

/** The session cookies of one application: Better Auth's, and the names it registers. */
export interface SessionCookies {
  /** Whether a cookie of this name holds the session, or data about it. */
  readonly isSession: (name: string) => boolean
  /** Whether a cookie of this name is the session's token. */
  readonly isToken: (name: string) => boolean
  /** Whether a Cookie header sends any session cookie. */
  readonly sentIn: (cookieHeader: string | undefined) => boolean
  /** Whether a Cookie header sends a session token cookie. */
  readonly tokenSentIn: (cookieHeader: string | undefined) => boolean
  /** Whether these Set-Cookie headers, applied in order, leave a session token cookie expired. */
  readonly endsSession: (setCookies: readonly string[]) => boolean
  /**
   * Whether these Set-Cookie headers leave a session token cookie holding
   * another value than the request sent: a new session, as signing in
   * starts, not the same one renewed.
   */
  readonly startsSession: (setCookies: readonly string[], cookieHeader: string | undefined) => boolean
  /**
   * The cookies sign-out expires when Better Auth's answer expires none: the
   * names given, or Better Auth's default ones, and every session cookie the
   * request sent, each without its browser prefix.
   */
  readonly toExpireOnSignOut: (cookieHeader: string | undefined, names?: readonly string[]) => readonly string[]
}

/** The session cookies of an application that registers `registered`, such as `auth.sessionCookie`. */
export function sessionCookies(registered: readonly string[] = []): SessionCookies {
  const names = new Set(registered.map(withoutBrowserPrefix))

  const isToken = (name: string): boolean => {
    const bare = withoutBrowserPrefix(name)

    return bare.endsWith('.session_token') || names.has(bare)
  }

  const isSession = (name: string): boolean => {
    const bare = withoutBrowserPrefix(name)

    return bare.startsWith(BETTER_AUTH_PREFIX) ||
      BETTER_AUTH_SESSION_COOKIES.some((cookie) => bare.endsWith(`.${cookie}`)) ||
      names.has(bare)
  }

  /** The session token cookies these Set-Cookie headers leave, applied in order, by name. */
  const tokenStates = (setCookies: readonly string[]): ReadonlyMap<string, SessionTokenState> => {
    const states = new Map<string, SessionTokenState>()

    for (const setCookie of setCookies) {
      const name = setCookieName(setCookie)

      if (!isToken(name)) continue

      const [pair = '', ...attributes] = setCookie.split(';')
      const value = pair.slice(pair.indexOf('=') + 1).trim()

      states.set(name, { value, expired: value === '' || attributes.some(expiresTheCookie) })
    }

    return states
  }

  return {
    isSession,
    isToken,
    sentIn: (cookieHeader) => cookieNames(cookieHeader).some(isSession),
    tokenSentIn: (cookieHeader) => cookieNames(cookieHeader).some(isToken),
    endsSession: (setCookies) => [...tokenStates(setCookies).values()].some((state) => state.expired),
    startsSession: (setCookies, cookieHeader) => {
      const sent = new Map<string, string>()

      for (const pair of (cookieHeader ?? '').split(';')) {
        const separator = pair.indexOf('=')

        if (separator > 0) sent.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim())
      }

      return [...tokenStates(setCookies)].some(([name, state]) => !state.expired && sent.get(name) !== state.value)
    },
    toExpireOnSignOut: (cookieHeader, given) => [...new Set([
      ...(given !== undefined && given.length > 0 ? given : DEFAULT_SIGN_OUT_COOKIES),
      ...cookieNames(cookieHeader).filter(isSession).map(withoutBrowserPrefix),
    ])],
  }
}

/** Every cookie name a Cookie header sends, in order, whatever its value. */
export function cookieNames(cookieHeader: string | undefined): readonly string[] {
  if (!cookieHeader) return []

  return cookieHeader
    .split(';')
    .map((part) => part.split('=', 1)[0].trim())
    .filter((name) => name.length > 0)
}

/** A Set-Cookie header's cookie name. */
export function setCookieName(setCookie: string): string {
  return setCookie.slice(0, setCookie.indexOf('=')).trim()
}

function withoutBrowserPrefix(name: string): string {
  return name.replace(BROWSER_PREFIX, '')
}

/** Whether a Set-Cookie attribute expires the cookie: a Max-Age of 0 or less, or an Expires already past. */
function expiresTheCookie(attribute: string): boolean {
  if (/^\s*max-age\s*=\s*(?:0|-\d+)\s*$/i.test(attribute)) return true

  const expires = /^\s*expires\s*=(.*)$/i.exec(attribute)?.[1]

  return expires !== undefined && Date.parse(expires) <= Date.now()
}
