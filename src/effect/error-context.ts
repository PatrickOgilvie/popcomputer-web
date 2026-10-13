/**
 * Error context capture
 *
 * Records the route and request an error happened in, without sensitive
 * headers, for structured errors.
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
 * Extract safe headers from a request.
 */
function extractSafeHeaders(headers: Headers): SafeHeaders {
  const result: SafeHeaders = {}

  for (const key of SAFE_HEADERS) {
    const value = headers.get(key)

    if (value) {
      result[key] = value
    }
  }

  return result
}

/**
 * Capture the route (method, path pattern, params) and request (URL, safe
 * headers) an error happened in. Authorization, Cookie and other sensitive
 * headers are left out.
 */
export function captureErrorContext<E extends Env>(c: HonoContext<E>): ErrorContext {
  const params: Record<string, string> = {}

  for (const [name, value] of Object.entries(c.req.param())) {
    if (value !== undefined) params[name] = value
  }

  return {
    route: {
      method: c.req.method,
      path: routePath(c) || c.req.path,
      params,
    },
    request: {
      url: c.req.url,
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
