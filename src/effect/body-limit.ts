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

/**
 * The most bytes of a refused body read and dropped before the refusal is
 * answered: 100 MiB, at least the most Cloudflare's Free and Pro plans let a
 * request body have, so there the platform refuses a larger body before the
 * Worker runs. Past it, the rest is cancelled.
 */
const DISCARD_LIMIT = 100 * 1024 * 1024

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
 *
 * A refused body is read to its end and dropped before BodyTooLarge, as a
 * server reads what a client still sends after its answer: a client still
 * sending when the answer comes loses the connection, and a proxy in front,
 * as portless is before Vite's dev server, answers 502 or never finishes.
 * The request's own body is the one read, so no clone holds its chunks.
 */
export async function readBody(request: Request, limit: number, { copy = false } = {}): Promise<ArrayBuffer> {
  if (!(limit >= 0)) throw new RangeError(`A body limit is a number of bytes, not ${String(limit)}.`)

  // Before a clone, which starts pulling the body to share it.
  const declared = Number(request.headers.get('Content-Length') ?? 0)

  if (declared > limit) {
    // A body past the most that is dropped would be cut off part way anyway.
    if (declared <= DISCARD_LIMIT) await discardBody(request)

    throw new BodyTooLarge({ limit })
  }

  const stream = (copy ? request.clone() : request).body

  if (stream === null) return new ArrayBuffer(0)

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0

  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    size += chunk.value.byteLength

    if (size > limit) {
      if (copy) {
        // The request's own body holds every chunk its clone reads; it is
        // read instead, from the chunks it holds.
        reader.cancel().catch(() => undefined)
        await discardBody(request)
      } else {
        await discard(reader, size)
      }

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

/** Read a refused request's body to its end, dropping it; one another reader holds is left to it. */
async function discardBody(request: Request): Promise<void> {
  if (request.body !== null && !request.body.locked) await discard(request.body.getReader(), 0)
}

/**
 * Read a body's remaining chunks and drop them, after `read` bytes of it, and
 * cancel the rest once more than DISCARD_LIMIT bytes of it have been read.
 */
async function discard(reader: ReadableStreamDefaultReader<Uint8Array>, read: number): Promise<void> {
  let size = read

  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      size += chunk.value.byteLength

      if (size > DISCARD_LIMIT) {
        reader.cancel().catch(() => undefined)

        return
      }
    }
  } catch {
    // A body that fails part way has nothing left to wait for.
  }
}

/**
 * A size as people read it, in the decimal units `maxBytes` and `bodyLimit`
 * are written in, `10_000_000` as `10 MB`; rounded down to a tenth, so the
 * size a message names is one its limit accepts.
 */
export function formatBytes(bytes: number): string {
  const units: ReadonlyArray<readonly [string, number]> = [['MB', 1_000_000], ['KB', 1000]]

  for (const [unit, size] of units) {
    if (bytes >= size) return `${Math.floor(bytes / (size / 10)) / 10} ${unit}`
  }

  return `${bytes} bytes`
}
