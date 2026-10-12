// The subset of Cloudflare's KVNamespace the README's Bindings type names.
// Applications get the full type from @cloudflare/workers-types or `wrangler types`.
interface KVNamespace {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}
