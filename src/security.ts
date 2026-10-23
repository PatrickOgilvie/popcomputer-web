/** Security middleware for @popcomputer/web applications. */

import type { Context, MiddlewareHandler, Env } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

/**
 * HTTP methods that mutate state and are therefore CSRF-relevant.
 */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * HTTP authentication's schemes, whose credentials a browser caches for an
 * origin and attaches to its requests by itself, another site's form posts
 * included.
 */
const BROWSER_AUTHORIZATION = /^\s*(basic|digest|negotiate|ntlm)\b/i

/**
 * Configuration for {@link verifyOrigin}.
 */
export interface VerifyOriginConfig {
  /**
   * Additional origins to allow beyond the request's own origin.
   * Pass exact origin strings (e.g. `https://app.example.com`,
   * `journeymannative://`) or a predicate for full control.
   *
   * The request's own origin (scheme + host of `c.req.url`) is always allowed
   * when {@link VerifyOriginConfig.allowSameOrigin} is true (the default).
   */
  allowedOrigins?: string[] | ((origin: string) => boolean)

  /**
   * Allow requests whose `Origin` matches the request's own origin.
   * @default true
   */
  allowSameOrigin?: boolean

  /**
   * Methods to guard. Defaults to the unsafe methods (POST/PUT/PATCH/DELETE).
   */
  methods?: string[]

  /**
   * Reject requests that carry no `Origin` and no usable `Referer`.
   *
   * Browsers reliably send `Origin` on cross-origin state-changing requests,
   * but native apps, server-to-server callers, and some same-origin requests
   * may omit it. Leaving this `false` (the default) follows the OWASP
   * "verify Origin when present" pattern: header-less requests are allowed so
   * non-browser clients keep working, while any *present* Origin must match.
   * Set to `true` for a strict browser-only surface.
   *
   * @default false
   */
  requireOrigin?: boolean

  /**
   * Response status for a rejected request.
   * @default 403
   */
  status?: number
}

function originAllowed(
  origin: string,
  requestOrigin: string,
  config: VerifyOriginConfig
): boolean {
  if ((config.allowSameOrigin ?? true) && origin === requestOrigin) {
    return true
  }

  const allowed = config.allowedOrigins

  if (!allowed) return false

  if (allowed instanceof Function) return allowed(origin)

  return allowed.includes(origin)
}

/**
 * Derive an origin (scheme + host) from a URL string, or `null` if unparseable.
 */
function originOf(url: string | undefined | null): string | null {
  if (!url) return null

  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * Middleware that verifies the `Origin` (falling back to `Referer`) of
 * state-changing requests against an allowlist.
 *
 * This is defense-in-depth against CSRF for cookie-authenticated routes. It
 * pairs with `SameSite` session cookies rather than replacing them. setupWeb
 * installs it by default; requests without an `Origin` header, such as API
 * and native-app calls, keep working (see {@link VerifyOriginConfig.requireOrigin}).
 *
 * @example
 * // Enable via setupWeb
 * setupWeb(app, {
 *   version,
 *   render,
 *   security: {
 *     verifyOrigin: { allowedOrigins: ['journeymannative://'] },
 *   },
 * })
 *
 * @example
 * // Or wire manually
 * app.use('*', verifyOrigin({ allowedOrigins: ['https://app.example.com'] }))
 */
export function verifyOrigin<E extends Env>(
  config: VerifyOriginConfig = {}
): MiddlewareHandler<E> {
  const status = config.status ?? 403

  // oxlint-disable-next-line effecttsgo/async-function -- Hono middleware and renderer contracts use native next()/Response promises; typed Effect work stays inside that request boundary.
  return async (c: Context<E>, next) => {
    const refused = originRefusal(c, config)

    if (refused === undefined) return next()

    // SAFETY: The surrounding adapter established this value's runtime invariant before restoring the precise TypeScript contract.
    return c.json({ error: refused }, status as ContentfulStatusCode)
  }
}

/**
 * Why a request fails origin verification, or undefined when it passes: a
 * state-changing request whose `Origin` (or `Referer`) names an origin the
 * configuration does not allow. A request with an `Authorization` header
 * passes when its scheme is one a browser never attaches by itself, such as
 * `Bearer`, so another site cannot forge it. HTTP authentication's own
 * schemes (`Basic`, `Digest`, `Negotiate`, `NTLM`) are checked like a
 * cookie: a browser resends the credentials it cached for the origin, as
 * behind a Basic-auth staging gate, with a form another site posts.
 */
export function originRefusal<E extends Env>(c: Context<E>, config: VerifyOriginConfig = {}): string | undefined {
  const methods = new Set(
    (config.methods ?? [...UNSAFE_METHODS]).map((m) => m.toUpperCase())
  )

  if (!methods.has(c.req.method.toUpperCase())) return undefined

  const authorization = c.req.header('Authorization')

  if (authorization !== undefined && !BROWSER_AUTHORIZATION.test(authorization)) return undefined

  const requestOrigin = originOf(c.req.url)

  if (!requestOrigin) {
    // Cannot determine our own origin: fail closed only if strict.
    return config.requireOrigin ? 'Origin verification failed.' : undefined
  }

  // Prefer Origin; fall back to the origin of the Referer.
  const headerOrigin = c.req.header('Origin') ?? originOf(c.req.header('Referer'))

  if (!headerOrigin) {
    return config.requireOrigin ? 'The request has no Origin header.' : undefined
  }

  return originAllowed(headerOrigin, requestOrigin, config)
    ? undefined
    : 'This request came from another site, which may not change anything here.'
}

/** Which pages may frame the application's own: none, or only its own. */
export interface SecurityHeadersConfig {
  /**
   * `'none'` (the default) lets no page frame the application, so another
   * site cannot show it under a decoy to trick a visitor into clicking;
   * `'same-origin'` lets the application frame its own pages.
   */
  readonly frames?: 'none' | 'same-origin'
}

/**
 * Headers every response gets unless it sets its own: `nosniff`, a
 * `Referrer-Policy` that still names the page a same-site form came from,
 * which a failed form goes back to, and framing refused as `frames` says.
 */
export function securityHeaders<E extends Env>(config: SecurityHeadersConfig = {}): MiddlewareHandler<E> {
  const sameOrigin = config.frames === 'same-origin'
  const defaults: ReadonlyArray<readonly [string, string]> = [
    ['X-Content-Type-Options', 'nosniff'],
    ['Referrer-Policy', 'strict-origin-when-cross-origin'],
    ['X-Frame-Options', sameOrigin ? 'SAMEORIGIN' : 'DENY'],
  ]
  const frameAncestors = sameOrigin ? "frame-ancestors 'self'" : "frame-ancestors 'none'"

  // oxlint-disable-next-line effecttsgo/async-function -- Hono middleware uses native next() promises.
  return async (c, next) => {
    await next()

    const missing = defaults.filter(([name]) => !c.res.headers.has(name))
    const policy = c.res.headers.get('Content-Security-Policy')
    const addFrames = policy === null || !/frame-ancestors/i.test(policy)

    if (missing.length === 0 && !addFrames) return

    const result = new Response(c.res.body, c.res)

    for (const [name, value] of missing) result.headers.set(name, value)
    if (addFrames) result.headers.set('Content-Security-Policy', policy === null ? frameAncestors : `${policy}; ${frameAncestors}`)

    // Hono's setter copies the old response's headers onto the new one,
    // which would undo a changed policy: clear it first.
    // oxlint-disable-next-line no-param-reassign -- Hono middleware replaces c.res to apply the framework's response policy.
    c.res = undefined
    // oxlint-disable-next-line no-param-reassign -- as above.
    c.res = result
  }
}
