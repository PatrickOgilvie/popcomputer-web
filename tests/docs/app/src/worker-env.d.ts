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
