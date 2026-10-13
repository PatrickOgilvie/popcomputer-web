/**
 * The page a request came from, for redirects that go back to it.
 */

/** The path and query of a same-origin Referer, or undefined for any other. */
export function sameOriginReferer(referer: string | undefined, requestUrl: string): string | undefined {
  if (!referer) return undefined

  try {
    const previous = new URL(referer)

    return previous.origin === new URL(requestUrl).origin ? `${previous.pathname}${previous.search}` : undefined
  } catch {
    return undefined
  }
}
