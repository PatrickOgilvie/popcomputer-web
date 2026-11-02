// The subset of Cloudflare's KVNamespace docs/setup.md's Bindings type names.
// Applications get the full type from @cloudflare/workers-types or `wrangler types`.
interface KVNamespace {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>
    list_complete: boolean
    cursor?: string
  }>
}

// Cloudflare's Workers Rate Limiting binding, as `ratelimits` in wrangler.jsonc declares it.
interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

// Cloudflare's Queues producer binding, as `queues.producers` in wrangler.jsonc declares it.
interface Queue<Body = unknown> {
  metrics(): Promise<{ backlogCount: number; backlogBytes: number; oldestMessageTimestamp?: Date }>
  send(message: Body, options?: { contentType?: 'text' | 'bytes' | 'json' | 'v8'; delaySeconds?: number }): Promise<unknown>
  sendBatch(
    messages: Iterable<{ body: Body; contentType?: 'text' | 'bytes' | 'json' | 'v8'; delaySeconds?: number }>,
    options?: { delaySeconds?: number }
  ): Promise<unknown>
}
