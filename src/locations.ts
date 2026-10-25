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

/**
 * Whether an encoded placeholder value is one path segment. Encoding keeps a
 * `/` or `?` inside the segment, but three values it leaves as they are still
 * change the path: a URL drops a `.` segment, and the segment before a `..`
 * one (and reads `%2e` as a dot, so escaping cannot help), and an empty first
 * segment makes the path `//host`, another site.
 */
export function isPathSegment(segment: string): boolean {
  return segment !== '' && segment !== '.' && segment !== '..'
}

/**
 * A placeholder's value as one path segment, encoded. A value that is not one
 * throws rather than reach another route or host, for a caller whose failure
 * is its own alone, such as an endpoint's `call`: `href` leaves its
 * placeholder unfilled instead, so one stored value fails only its link.
 */
export function pathSegment(value: string | number, path: string, name: string): string {
  const segment = encodeURIComponent(String(value))

  if (!isPathSegment(segment)) {
    throw new Error(`${path} cannot take ${segment === '' ? 'an empty value' : `'${segment}'`} as its '${name}' parameter: it would not be one path segment.`)
  }

  return segment
}
