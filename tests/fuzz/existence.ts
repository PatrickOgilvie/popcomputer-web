/**
 * The rule both request properties check: a request refused with a 401, 403
 * or 404 answers exactly as the same request does with each record it names
 * swapped, one at a time, for a missing one, so a refusal never tells
 * whether someone else's record exists.
 */
import { show, type FuzzAnswer, type FuzzRequest } from '../../src/fuzz.js'

/** A query or the body's fields with each value that is `name` swapped for `missing`. */
function swapped(pieces: ReadonlyArray<string>, name: string): string[] {
  return pieces.map((piece) => (piece.endsWith(`=${name}`) ? `${piece.slice(0, -name.length)}missing` : piece))
}

/**
 * How a refusal differs from the one the same request gets with each record
 * it names swapped, one at a time, for a missing one, wherever the request
 * names it (its path, a query value, a field): in its status, or in its body
 * once the swapped name is read alike. Swapping the path alone would send a
 * route parameter and a field that disagree, a conflict validation refuses
 * whatever the database holds. `exists` says whether a path segment names a
 * record, and `sendTwin` sends the swapped request in the state the refused
 * one met.
 */
export async function existenceShown<Person extends string>(
  sent: FuzzRequest<Person>,
  answer: FuzzAnswer,
  exists: (segment: string) => boolean,
  sendTwin: (twin: FuzzRequest<Person>) => Promise<FuzzAnswer | undefined>
): Promise<string[]> {
  const status = answer.response.status

  if (status !== 401 && status !== 403 && status !== 404) return []

  const segments = sent.path.split('/')
  const shown: string[] = []

  for (const [index, segment] of segments.entries()) {
    if (!exists(segment)) continue

    const body = sent.body.as === 'none' || sent.body.as === 'text' ? sent.body : { ...sent.body, fields: swapped(sent.body.fields, segment) }
    const missing = await sendTwin({
      ...sent,
      path: segments.map((each, at) => (at === index ? 'missing' : each)).join('/'),
      query: swapped(sent.query.split('&'), segment).join('&'),
      body,
    })
    // Both names read alike, wherever the page echoes the URL, and so does the moment an error envelope names.
    const alike = (text: string) => text.replaceAll(segment, '{record}').replaceAll('missing', '{record}').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '{time}')

    if (missing === undefined) continue
    if (missing.response.status !== status || alike(missing.text) !== alike(answer.text)) {
      shown.push(`refused ${segment} with ${status} ${show(answer.text.slice(0, 60))}, but a missing record with ${missing.response.status} ${show(missing.text.slice(0, 60))}`)
    }
  }

  return shown
}
