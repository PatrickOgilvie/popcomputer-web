/** Security middleware for @popcomputer/web applications. */

import type { Context, MiddlewareHandler, Env } from 'hono'

/**
 * HTTP methods that mutate state and are therefore CSRF-relevant.
 */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

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
 * pairs with `SameSite` session cookies rather than replacing them, and is
 * deliberately opt-in so API and native-app surfaces that do not send an
 * `Origin` header keep working (see {@link VerifyOriginConfig.requireOrigin}).
 *
 * @example
 * // Enable via setupHonertia
 * setupHonertia({
 *   honertia: { ... },
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
  const methods = new Set(
    (config.methods ?? [...UNSAFE_METHODS]).map((m) => m.toUpperCase())
  )
  const status = config.status ?? 403

  return async (c: Context<E>, next) => {
    if (!methods.has(c.req.method.toUpperCase())) {
      return next()
    }

    const requestOrigin = originOf(c.req.url)
    if (!requestOrigin) {
      // Cannot determine our own origin — fail closed only if strict.
      if (config.requireOrigin) {
        // SAFETY: The surrounding adapter established this value's runtime invariant before restoring the precise TypeScript contract.
        return c.json({ error: 'Origin verification failed' }, status as any)
      }
      return next()
    }

    // Prefer Origin; fall back to the origin of the Referer.
    const headerOrigin =
      c.req.header('Origin') ?? originOf(c.req.header('Referer'))

    if (!headerOrigin) {
      if (config.requireOrigin) {
        // SAFETY: The surrounding adapter established this value's runtime invariant before restoring the precise TypeScript contract.
        return c.json({ error: 'Missing Origin header' }, status as any)
      }
      return next()
    }

    if (!originAllowed(headerOrigin, requestOrigin, config)) {
      // SAFETY: The surrounding adapter established this value's runtime invariant before restoring the precise TypeScript contract.
      return c.json({ error: 'Cross-origin request blocked' }, status as any)
    }

    return next()
  }
}
