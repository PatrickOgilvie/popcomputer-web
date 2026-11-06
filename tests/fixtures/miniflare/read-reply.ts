/**
 * Reads a reply as Miniflare's proxy reads one: through the module's own
 * `receiveMessageOnPort`, from a file in a folder named miniflare, which is
 * the only caller `testD1` waits for.
 */
import { createRequire } from 'node:module'

const threads: { receiveMessageOnPort(port: unknown): { readonly message: unknown } | undefined } = createRequire(import.meta.url)('node:worker_threads')

export function readReply(port: unknown): unknown {
  // Read as Miniflare reads it. Returned directly, this would be a tail call, and leave no frame of this file.
  const message = threads.receiveMessageOnPort(port)?.message

  return message
}
