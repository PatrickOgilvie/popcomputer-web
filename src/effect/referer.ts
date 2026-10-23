/**
 * The page a request came from, for redirects that go back to it.
 */

/**
 * The path and query of a same-origin Referer, or undefined for any other.
 * A page's path may begin with `//`, as `http://app//evil.test/x`'s does,
 * and as a Location that path names another host, so such a Referer is
 * undefined too, as `intendedUrl` refuses it.
 */
export function sameOriginReferer(referer: string | undefined, requestUrl: string): string | undefined {
  if (!referer) return undefined

  try {
    const previous = new URL(referer)

    if (previous.origin !== new URL(requestUrl).origin || previous.pathname.startsWith('//')) return undefined

    return `${previous.pathname}${previous.search}`
  } catch {
    return undefined
  }
}
