/**
 * Reads a message as any caller does, from a file in a folder named
 * miniflare that is not Miniflare's own module: `testD1` tells it at once
 * that none has landed.
 */
import { createRequire } from 'node:module'

const threads: { receiveMessageOnPort(port: unknown): { readonly message: unknown } | undefined } = createRequire(import.meta.url)('node:worker_threads')

export function plainRead(port: unknown): unknown {
  // Not a tail call, so this file's frame calls the read.
  const message = threads.receiveMessageOnPort(port)?.message

  return message
}
