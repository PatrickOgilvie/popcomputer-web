/**
 * `readBody`'s limit at its edge: a body of exactly the limit is read whole,
 * whether its length is declared or only streamed, and a byte more is
 * refused, before any is read when the declared length says so.
 */
import { describe, expect, test } from 'bun:test'
import { BodyTooLarge, readBody } from '../../src/effect/body-limit.js'

const LIMIT = 16

/** A request whose body arrives as a stream, with no Content-Length. */
const streamed = (bytes: number) =>
  new Request('http://localhost/', {
    method: 'POST',
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes))
        controller.close()
      },
    }),
  })

/** A request that declares its Content-Length, and sends `bytes`. */
const declared = (length: number, bytes = length) =>
  new Request('http://localhost/', { method: 'POST', headers: { 'Content-Length': String(length) }, body: new Uint8Array(bytes) })

const outcome = (request: Request) =>
  readBody(request, LIMIT).then(
    (body) => body.byteLength,
    (error: unknown) => (error instanceof BodyTooLarge ? 'too large' : error)
  )

describe('readBody', () => {
  test('reads a body of exactly the limit, declared or streamed', async () => {
    expect(await outcome(declared(LIMIT))).toBe(LIMIT)
    expect(await outcome(streamed(LIMIT))).toBe(LIMIT)
  })

  test('refuses a byte more, declared or streamed', async () => {
    expect(await outcome(declared(LIMIT + 1))).toBe('too large')
    expect(await outcome(streamed(LIMIT + 1))).toBe('too large')
  })

  test('refuses a declared length past the limit before reading the body it sends', async () => {
    expect(await outcome(declared(LIMIT + 1, 1))).toBe('too large')
  })
})
