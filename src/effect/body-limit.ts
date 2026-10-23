/**
 * Request bodies read within a size limit
 *
 * Parsing a body holds it in memory several times over (its bytes, the
 * parsed form and its files), in the isolate every request shares, so the
 * framework reads one only up to a limit: setupWeb's `bodyLimit`, which an
 * action that takes uploads raises with validateRequest's.
 */

import { Data } from 'effect'

/**
 * The most bytes a request body may have unless setupWeb's `bodyLimit` or
 * validateRequest's says otherwise: 1 MiB, ample for a form or a JSON body.
 */
export const DEFAULT_BODY_LIMIT = 1024 * 1024

/** A request body larger than the limit it was read within. */
export class BodyTooLarge extends Data.TaggedError('BodyTooLarge')<{
  /** The most bytes the body could have had. */
  readonly limit: number
}> {}

/**
 * Read a request's body, refusing one over `limit` bytes with BodyTooLarge:
 * at once when its declared Content-Length passes the limit, and otherwise at
 * the first chunk past it, so at most the limit and one chunk are held.
 * `copy` reads a clone, leaving the request's own body for its next reader.
 */
export async function readBody(request: Request, limit: number, { copy = false } = {}): Promise<ArrayBuffer> {
  if (!(limit >= 0)) throw new RangeError(`A body limit is a number of bytes, not ${String(limit)}.`)

  // Before a clone, which starts pulling the body to share it.
  if (Number(request.headers.get('Content-Length') ?? 0) > limit) throw new BodyTooLarge({ limit })

  const stream = (copy ? request.clone() : request).body

  if (stream === null) return new ArrayBuffer(0)

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0

  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    size += chunk.value.byteLength

    if (size > limit) {
      // The rest is never read; the client's upload ends with the response.
      reader.cancel().catch(() => undefined)

      throw new BodyTooLarge({ limit })
    }

    chunks.push(chunk.value)
  }

  const body = new Uint8Array(size)
  let offset = 0

  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  return body.buffer
}

/** A limit as a person reads it: `1 MB`, `512 KB`. */
export function formatBytes(bytes: number): string {
  const units: ReadonlyArray<readonly [string, number]> = [['MB', 1024 * 1024], ['KB', 1024]]

  for (const [unit, size] of units) {
    if (bytes >= size) return `${Math.round((bytes / size) * 10) / 10} ${unit}`
  }

  return `${bytes} bytes`
}
