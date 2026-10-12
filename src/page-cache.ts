/**
 * Default edge page cache.
 *
 * Pages that depend only on their URL and the deployed code are cached in
 * Cloudflare's Cache API (`caches.default`) and served from it until the next
 * deploy, without running database, auth or rendering work. A page becomes
 * dynamic, and renders on every request, as soon as producing it reads
 * anything request-specific:
 *
 * - a Cloudflare binding on `c.env` (D1, KV, R2, Durable Objects, service
 *   bindings, AI, Hyperdrive…), which covers database reads however they are
 *   made;
 * - request headers through `RequestService`, or request state through
 *   `RequestStateService`;
 * - a route model binding (`{project}` placeholders).
 *
 * Signed-in requests, requests carrying app cookies or `Authorization`,
 * partial reloads, stale Inertia versions, and development never touch the
 * cache. Cached pages are keyed by deploy, so a deploy never serves pages
 * rendered by the previous build, and browsers always revalidate them.
 */

import type { Context, Env, MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import {
  BROWSER_PAGE_CACHE_CONTROL,
  hasSessionCookie,
  isPageResponse,
  isPartialReloadRequest,
} from './effect/response-cache.js'
import { openHonertiaContext } from './request-context.js'
import { HEADERS } from './types.js'

/** Response header reporting what the page cache did: HIT, MISS, DYNAMIC or BYPASS. */
export const PAGE_CACHE_HEADER = 'X-Popweb-Cache'

/** Cache-Control for signed-in responses that set none: no cache may keep them. */
const PRIVATE_CACHE_CONTROL = 'no-store'

/**
 * Binding that identifies the deployed Worker version, from Wrangler's
 * `"version_metadata": { "binding": "CF_VERSION_METADATA" }`. With it, cached
 * pages live until the next deploy; without it, they are keyed by the asset
 * version and expire after a few minutes, so server-only changes still appear.
 */
export const VERSION_METADATA_BINDING = 'CF_VERSION_METADATA'

/** How long a cached page lives when the deploy is known. Deploys replace it sooner. */
const DEPLOY_KEYED_TTL_SECONDS = 86_400

/** How long a cached page lives when only the asset version is known. */
const ASSET_KEYED_TTL_SECONDS = 300

/**
 * Cookies that analytics, consent and Cloudflare tools set and pages do not
 * read. Any other cookie may personalize a page, so it bypasses the cache.
 */
const IGNORED_COOKIE_PREFIXES = [
  '_ga',
  '_gid',
  '_gat',
  '_gcl_',
  '_fbp',
  '_fbc',
  '_hj',
  '_pk_',
  'ph_',
  'ajs_',
  'mp_',
  '__cf_bm',
  '_cfuvid',
  'cf_clearance',
  '__cflb',
]

/** The subset of Cloudflare's Cache API the page cache uses. */
export interface PageCacheStore {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

/** Per-request page-cache state, kept on the request context. */
export interface PageCacheState {
  readonly key: Request
  readonly ttl: number
  /** Set when producing the page read a binding, a header or request state. */
  dynamic: boolean
  /** Set by the route handler when the route allows default caching. */
  routeAllowsDefault: boolean
}

export interface PageCacheOptions {
  /** The Inertia asset version, as passed to setupWeb. */
  readonly version: string | (() => string)
  /** A custom session cookie name, as passed to setupWeb's auth config. */
  readonly sessionCookie?: string
  /** The cache to use. Defaults to `caches.default` when the runtime has one. */
  readonly store?: PageCacheStore
}

/**
 * Record that the current page read request-specific data, so it must not be
 * cached. A no-op outside the page cache.
 */
export function markPageDynamic<E extends Env>(c: Context<E>): void {
  const state = openHonertiaContext(c).pageCache

  if (state) {
    state.dynamic = true
  }
}

/**
 * Record that the route handling this request allows default page caching.
 * Effect routes call this; plain Hono handlers never do, so they are never
 * cached by default.
 */
export function allowDefaultPageCache<E extends Env>(c: Context<E>): void {
  const state = openHonertiaContext(c).pageCache

  if (state) {
    state.routeAllowsDefault = true
  }
}

/**
 * Middleware that serves cached static pages and stores new ones. setupWeb
 * installs it by default; lower-level compositions add it before
 * webServices() so database and auth setup is skipped on a hit.
 */
export function pageCache<E extends Env>(options: PageCacheOptions): MiddlewareHandler<E> {
  // oxlint-disable-next-line effecttsgo/async-function -- Hono middleware and the Cache API use native next()/Response promises.
  return createMiddleware<E>(async (c, next) => {
    if (hasPrivateRequest(c, options.sessionCookie)) {
      await next()
      markPrivate(c)
      markResponse(c, 'BYPASS')

      return
    }

    const store = options.store ?? defaultPageCacheStore()

    if (!store || isDevelopment(c) || c.req.method !== 'GET') {
      await next()

      return
    }

    const version = options.version instanceof Function ? options.version() : options.version

    if (!isCacheableRequest(c, version)) {
      await next()
      markResponse(c, 'BYPASS')

      return
    }

    const deploy = deployIdentity(c, version)
    const state: PageCacheState = {
      key: cacheKey(c, deploy.id),
      ttl: deploy.ttl,
      dynamic: false,
      routeAllowsDefault: false,
    }

    const cached = await matchQuietly(store, state.key)

    if (cached) {
      return servedFromCache(cached)
    }

    openHonertiaContext(c).pageCache = state
    // Downstream code sees bindings that report reads, so a page that queries
    // D1 or KV, or calls a Durable Object or service, renders dynamically.
    // oxlint-disable-next-line no-param-reassign -- The page cache swaps in an observed env for the rest of this request.
    c.env = trackBindings(c.env, () => {
      state.dynamic = true
    })

    await next()

    if (!shouldStore(c, state)) {
      if (state.routeAllowsDefault && isPageResponse(c.res.headers)) {
        markResponse(c, 'DYNAMIC')
      }

      return
    }

    // oxlint-disable-next-line no-param-reassign -- Hono middleware replaces c.res to apply the framework's response policy.
    c.res = storeWhenComplete(c, store, state)
  })
}

/**
 * Return the response with a body that records itself as it streams. Once
 * the client has read all of it, every middleware has run, so the final
 * headers decide: the page is stored only if nothing outside the framework
 * marked it private, uncacheable or cookie-setting.
 */
function storeWhenComplete<E extends Env>(
  c: Context<E>,
  store: PageCacheStore,
  state: PageCacheState
): Response {
  const response = withBrowserPolicy(c.res, 'MISS')
  const source = response.body

  if (source === null) {
    return response
  }

  const reader = source.getReader()
  const chunks: Uint8Array[] = []
  let settle = () => {}
  waitUntil(c, new Promise<void>((resolve) => {
    settle = resolve
  }))

  const finish = (complete: boolean) => {
    const final = c.res

    if (!complete || !finalHeadersAllowStore(final.headers)) {
      settle()

      return
    }

    store
      .put(state.key, storedCopy(new Response(concatenate(chunks), final), state.ttl))
      .catch(() => {})
      .finally(settle)
  }

  const body = new ReadableStream<Uint8Array>({
    // oxlint-disable-next-line effecttsgo/async-function -- ReadableStream sources are promise-based.
    async pull(controller) {
      const { done, value } = await reader.read()

      if (done) {
        controller.close()
        finish(true)

        return
      }

      chunks.push(value)
      controller.enqueue(value)
    },
    cancel(reason) {
      finish(false)

      return reader.cancel(reason)
    },
  })

  return new Response(body, response)
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const body = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0))
  let offset = 0

  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  return body
}

/** The final response still carries the page cache's own policy and no cookie. */
function finalHeadersAllowStore(headers: Headers): boolean {
  return (
    headers.get('Cache-Control') === BROWSER_PAGE_CACHE_CONTROL &&
    !headers.has('Set-Cookie')
  )
}

function defaultPageCacheStore(): PageCacheStore | undefined {
  const storage: unknown = Reflect.get(globalThis, 'caches')
  const store: unknown = storage instanceof Object ? Reflect.get(storage, 'default') : undefined

  return isPageCacheStore(store) ? store : undefined
}

function isPageCacheStore(value: unknown): value is PageCacheStore {
  return (
    value instanceof Object &&
    Reflect.get(value, 'match') instanceof Function &&
    Reflect.get(value, 'put') instanceof Function
  )
}

function isDevelopment<E extends Env>(c: Context<E>): boolean {
  const env: object = c.env ?? {}

  return (
    Object.getOwnPropertyDescriptor(env, 'ENVIRONMENT')?.value === 'development' ||
    Object.getOwnPropertyDescriptor(env, 'NODE_ENV')?.value === 'development'
  )
}

/** A request that carries a session or credentials: its response is someone's own. */
function hasPrivateRequest<E extends Env>(c: Context<E>, sessionCookie: string | undefined): boolean {
  return (
    c.req.header('Authorization') !== undefined ||
    hasSessionCookie(c.req.header('Cookie'), sessionCookie ? [sessionCookie] : [])
  )
}

function isCacheableRequest<E extends Env>(c: Context<E>, version: string): boolean {
  if (c.req.header('Upgrade') !== undefined) {
    return false
  }

  if (isPartialReloadRequest((name) => c.req.header(name))) {
    return false
  }

  // A stale Inertia client must reach web(), which answers 409 so the client
  // reloads with the current assets.
  if (
    c.req.header(HEADERS.HONERTIA) !== undefined &&
    c.req.header(HEADERS.VERSION) !== version
  ) {
    return false
  }

  return cookieNames(c.req.header('Cookie')).every((name) =>
    IGNORED_COOKIE_PREFIXES.some((prefix) => name.startsWith(prefix))
  )
}

function cookieNames(header: string | undefined): readonly string[] {
  if (!header) {
    return []
  }

  return header
    .split(';')
    .map((part) => part.split('=', 1)[0].trim())
    .filter((name) => name.length > 0)
}

function deployIdentity<E extends Env>(
  c: Context<E>,
  version: string
): { readonly id: string; readonly ttl: number } {
  const env: object = c.env ?? {}
  const metadata: unknown = Object.getOwnPropertyDescriptor(env, VERSION_METADATA_BINDING)?.value
  const id: unknown = metadata instanceof Object ? Reflect.get(metadata, 'id') : undefined

  if (typeof id === 'string' && id.length > 0) {
    return { id: `deploy-${id}`, ttl: DEPLOY_KEYED_TTL_SECONDS }
  }

  return { id: `assets-${version}`, ttl: ASSET_KEYED_TTL_SECONDS }
}

/**
 * The cache key: the request URL under a prefix naming the deploy and the
 * page variant (HTML document or Inertia page object).
 */
function cacheKey<E extends Env>(c: Context<E>, deploy: string): Request {
  const url = new URL(c.req.url)
  const variant = c.req.header(HEADERS.HONERTIA) === undefined ? 'html' : 'inertia'

  return new Request(
    `${url.origin}/__popweb/page/${encodeURIComponent(deploy)}/${variant}${url.pathname}${url.search}`
  )
}

// oxlint-disable-next-line effecttsgo/async-function -- The Cache API is promise-based; a failed lookup is a miss, never an error.
async function matchQuietly(store: PageCacheStore, key: Request): Promise<Response | undefined> {
  try {
    return await store.match(key)
  } catch {
    return undefined
  }
}

function shouldStore<E extends Env>(c: Context<E>, state: PageCacheState): boolean {
  const response = c.res
  const vary = response.headers.get('Vary')

  return (
    state.routeAllowsDefault &&
    !state.dynamic &&
    openHonertiaContext(c).authUser === undefined &&
    response.status === 200 &&
    isPageResponse(response.headers) &&
    !response.headers.has('Set-Cookie') &&
    !response.headers.has('Cache-Control') &&
    // A page that varies on more than the Inertia variant depends on request
    // headers the key does not include.
    (vary === null ||
      vary.split(',').every((name) => name.trim().toLowerCase() === HEADERS.HONERTIA.toLowerCase()))
  )
}

/** The copy kept in the Cache API: fresh for `ttl`, without per-response headers. */
function storedCopy(response: Response, ttl: number): Response {
  const stored = new Response(response.body, response)
  stored.headers.set('Cache-Control', `public, max-age=${ttl}`)
  stored.headers.delete('Vary')
  stored.headers.delete(PAGE_CACHE_HEADER)

  return stored
}

function servedFromCache(cached: Response): Response {
  // The stored copy's Cache-Control is the Cache API's TTL; browsers get the page policy.
  const response = new Response(cached.body, cached)
  response.headers.set('Vary', HEADERS.HONERTIA)

  return withBrowserPolicy(response, 'HIT')
}

/** Browsers revalidate cached pages: a page belongs to the deploy that rendered it. */
function withBrowserPolicy(response: Response, status: 'HIT' | 'MISS'): Response {
  const result = new Response(response.body, response)
  result.headers.set('Cache-Control', BROWSER_PAGE_CACHE_CONTROL)
  result.headers.set(PAGE_CACHE_HEADER, status)

  return result
}

/** Signed-in responses that set no Cache-Control are kept out of every cache. */
function markPrivate<E extends Env>(c: Context<E>): void {
  if (c.res.headers.has('Cache-Control')) {
    return
  }

  const result = new Response(c.res.body, c.res)
  result.headers.set('Cache-Control', PRIVATE_CACHE_CONTROL)
  // oxlint-disable-next-line no-param-reassign -- Hono middleware replaces c.res to apply the framework's response policy.
  c.res = result
}

function markResponse<E extends Env>(c: Context<E>, status: 'DYNAMIC' | 'BYPASS'): void {
  if (!isPageResponse(c.res.headers) || c.res.headers.has(PAGE_CACHE_HEADER)) {
    return
  }

  const result = new Response(c.res.body, c.res)
  result.headers.set(PAGE_CACHE_HEADER, status)
  // oxlint-disable-next-line no-param-reassign -- Hono middleware replaces c.res to apply the framework's response policy.
  c.res = result
}

function waitUntil<E extends Env>(c: Context<E>, work: Promise<void>): void {
  try {
    c.executionCtx.waitUntil(work)
  } catch {
    // No execution context (tests, local tooling): the put settles on its own.
  }
}

/**
 * Copy an env whose bindings report any use through `onRead`. Plain values
 * (vars and secrets) and plain objects are copied unchanged; class instances,
 * which is what Cloudflare bindings are, are wrapped.
 */
export function trackBindings<T>(env: T, onRead: () => void): T {
  if (!(env instanceof Object)) {
    return env
  }

  const tracked: object = Object.create(Object.getPrototypeOf(env))

  for (const key of Reflect.ownKeys(env)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(env, key)

    if (descriptor === undefined) {
      continue
    }

    if ('value' in descriptor && isBinding(descriptor.value)) {
      Reflect.defineProperty(tracked, key, {
        ...descriptor,
        value: trackBinding(descriptor.value, onRead),
      })
    } else {
      Reflect.defineProperty(tracked, key, descriptor)
    }
  }

  // SAFETY: `tracked` copies every own property of `env` onto the same
  // prototype, substituting only behaviour-preserving binding proxies.
  return tracked as T
}

function isBinding(value: unknown): value is object {
  if (!(value instanceof Object) || Array.isArray(value)) {
    return false
  }

  const prototype: unknown = Object.getPrototypeOf(value)

  return prototype !== null && prototype !== Object.prototype && prototype !== Function.prototype
}

function trackBinding<T extends object>(binding: T, onRead: () => void): T {
  return new Proxy(binding, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target)

      if (typeof key === 'symbol' || key === 'then') {
        return value
      }

      const own = Reflect.getOwnPropertyDescriptor(target, key)

      // Proxy invariant: a frozen own property must be returned as is.
      if (own && own.configurable === false && own.writable === false) {
        onRead()

        return value
      }

      onRead()

      // Bindings are host objects whose methods need the real receiver.
      return value instanceof Function ? value.bind(target) : value
    },
  })
}
