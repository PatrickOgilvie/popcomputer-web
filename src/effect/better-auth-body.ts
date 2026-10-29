/**
 * The body Better Auth will read from a request, read the way Better Auth
 * reads it, for the checks betterAuthHandler makes before forwarding it.
 */

/**
 * The test Better Auth's body parser (better-call's `getBody`) reads JSON by:
 * the whole lowercased header against this pattern, anchored only at its
 * start. Failing it, `getBody` reads a form from any header that names
 * `application/x-www-form-urlencoded` or `multipart/form-data` anywhere.
 */
const BETTER_CALL_JSON = /^application\/([a-z0-9.+-]*\+)?json/

/** A JSON media type: `application/json`, or a `+json` type. */
const JSON_MEDIA_TYPE = /^application\/([a-z0-9.+-]*\+)?json$/

/** Whether a character is the whitespace HTTP allows around a header's parts. */
const isHttpSpace = (character: string): boolean => character === ' ' || character === '\t'

/** A header part without the space and tab around it, and nothing else trimmed. */
function trimHttpSpace(part: string): string {
  let start = 0
  let end = part.length

  while (start < end && isHttpSpace(part[start])) start += 1
  while (end > start && isHttpSpace(part[end - 1])) end -= 1

  return part.slice(start, end)
}

/**
 * A JSON or form body, read from a copy exactly as Better Auth will read it:
 * the same lowercased header, tested in `getBody`'s order. None for a body
 * that does not parse, or for a header whose media type, with only the space
 * and tab HTTP allows around it removed, is not plainly JSON or a form. That
 * refuses a type led by U+00A0, U+000B or U+000C, which `String#trim` would
 * remove and `getBody` keeps, so two parsers could read it two ways.
 */
export async function bodyOf(request: Request): Promise<{ readonly body: unknown } | undefined> {
  const header = (request.headers.get('content-type') ?? '').toLowerCase()
  const media = trimHttpSpace(header.split(';', 1)[0])

  if (!JSON_MEDIA_TYPE.test(media) && media !== 'application/x-www-form-urlencoded' && media !== 'multipart/form-data') {
    return undefined
  }

  try {
    if (BETTER_CALL_JSON.test(header)) return { body: await request.clone().json() }
    if (header.includes('application/x-www-form-urlencoded') || header.includes('multipart/form-data')) {
      return { body: Object.fromEntries(await request.clone().formData()) }
    }
  } catch {
    // A body that does not parse as its type says.
  }

  return undefined
}
