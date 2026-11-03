/**
 * Request bodies read within a size limit
 *
 * Parsing a body holds it in memory several times over (its bytes, the
 * parsed form and its files), in the isolate every request shares, so the
 * framework reads one only up to a limit: setupWeb's `bodyLimit`, which an
 * action that takes uploads raises with validateRequest's. What it does not
 * read, the rest of a refused body or one nothing read, it drops before the
 * answer.
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
    await discardBody(request)

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

/**
 * Read a request's body to its end, dropping it. One another reader holds or
 * has read is left to it, and one declaring more than DISCARD_LIMIT is not
 * read: it would be cut off part way anyway.
 */
async function discardBody(request: Request): Promise<void> {
  if (request.body === null || request.bodyUsed || request.body.locked) return
  if (Number(request.headers.get('Content-Length') ?? 0) > DISCARD_LIMIT) return

  await discard(request.body.getReader(), 0)
}

/** Response bodies that stream as they are read, and so may read their request's body as they go. */
const streamingBodies = new WeakSet<ReadableStream<Uint8Array>>()

/** Leave the request's body to a response body that streams as it is read: `discardUnreadBody` reads it no more. */
export function streamsAsRead(body: ReadableStream<Uint8Array>): void {
  streamingBodies.add(body)
}

/**
 * Read a request's body nothing read to its end, and drop it, before
 * `response` answers it, as readBody does a refused one's: an answer that
 * never reads the body, such as a 404 or a redirect to sign in, otherwise
 * comes while the client is still sending it.
 *
 * A body something read is left alone, and so is one a streamed response may
 * still read as it goes: the request's own body sent back, or a body
 * `file()` streams.
 */
export async function discardUnreadBody(request: Request, response: Response): Promise<void> {
  const body = response.body

  if (body !== null && (body === request.body || streamingBodies.has(body))) return

  await discardBody(request)
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
