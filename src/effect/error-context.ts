/**
 * Error context capture
 *
 * Records the route and request an error happened in, without sensitive
 * headers or the values a URL carries, for structured errors.
 */

import type { Context as HonoContext, Env } from 'hono'
import { routePath } from 'hono/route'
import type { ErrorContext, SafeHeaders } from './error-types.js'

/**
 * Headers that are safe to include in error context.
 * Excludes sensitive headers like Authorization, Cookie, etc.
 */
const SAFE_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'content-length',
  'x-inertia',
  'x-inertia-version',
  'x-requested-with',
  'user-agent',
  'referer',
  'origin',
]

/**
 * Extract safe headers from a request: of the Referer, its origin, since its
 * path and query can carry a token, as a reset page's does.
 */
function extractSafeHeaders(headers: Headers): SafeHeaders {
  const result: SafeHeaders = {}

  for (const key of SAFE_HEADERS) {
    const value = headers.get(key)
    const kept = key === 'referer' && value ? refererOrigin(value) : value

    if (kept) {
      result[key] = kept
    }
  }

  return result
}

/** What the context records in place of a value a URL carries. */
const REDACTED = '[redacted]'

/**
 * The URL as the context records it: its origin, its route's pattern when
 * that names parameters, else its path, and its query's names.
 */
function redactedUrl(url: URL, pattern: string): string {
  const query = [...new Set(url.searchParams.keys())].map((key) => `${encodeURIComponent(key)}=${REDACTED}`).join('&')

  return `${url.origin}${pattern.includes(':') ? pattern : url.pathname}${query === '' ? '' : `?${query}`}`
}

/** A Referer as the context records it: its origin alone. */
function refererOrigin(referer: string): string | undefined {
  try {
    const { origin } = new URL(referer)

    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}

/**
 * Capture the route (method, path pattern, params) and request (URL, safe
 * headers) an error happened in. Authorization, Cookie and other sensitive
 * headers are left out, and so is every value a URL carries, which can be a
 * token, such as a password reset's: the path's parameters, the query's
 * values, and the Referer's path and query. The context reaches the error
 * observer, which feeds an application's telemetry.
 */
export function captureErrorContext<E extends Env>(c: HonoContext<E>): ErrorContext {
  const params: Record<string, string> = {}

  for (const [name, value] of Object.entries(c.req.param())) {
    if (value !== undefined) params[name] = REDACTED
  }

  const path = routePath(c) || c.req.path

  return {
    route: {
      method: c.req.method,
      path,
      params,
    },
    request: {
      url: redactedUrl(new URL(c.req.url), path),
      headers: extractSafeHeaders(c.req.raw.headers),
    },
  }
}

/**
 * Create an empty error context.
 */
export function emptyContext(): ErrorContext {
  return {}
}
