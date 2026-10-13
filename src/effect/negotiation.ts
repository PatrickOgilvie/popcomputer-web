/**
 * Whether a request comes from a client that reads JSON rather than pages.
 *
 * An Inertia visit is a page. A client that asks for JSON or sends JSON reads
 * JSON, and one that asks for HTML, as browsers do on every visit and form
 * post, reads pages. A client that asks for neither reads JSON when it sends
 * an `Accept` header, such as `fetch`'s `*\/*`, or authenticates with an
 * `Authorization` header, as API clients do. A request with neither, such as
 * a bare `app.request(path)` in a test, reads pages.
 */
export function wantsJson(header: (name: string) => string | undefined): boolean {
  if (header('X-Inertia') === 'true') return false

  const accept = header('Accept') ?? ''

  if (accept.includes('application/json')) return true
  if ((header('Content-Type') ?? '').includes('application/json')) return true
  if (accept.includes('text/html')) return false

  return accept !== '' || header('Authorization') !== undefined
}
