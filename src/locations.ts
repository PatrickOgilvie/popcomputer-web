/**
 * Where a URL the framework builds, validates or answers with may lead.
 */

// A browser runs a `javascript:` URL it navigates to, and shows a `data:`
// one as a page: only these schemes lead to a web page. The scheme is read
// the way a browser reads it, so case, leading control characters and tabs
// inside it make no difference.
const WEB_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:'])

/**
 * The URL a value names, resolved against `base` when given, when it leads
 * to a web page: an `http:` or `https:` URL, or a path on the base's site.
 */
export function webUrl(value: string, base?: string): URL | undefined {
  try {
    const url = new URL(value, base)

    return WEB_PROTOCOLS.has(url.protocol) ? url : undefined
  } catch {
    return undefined
  }
}
