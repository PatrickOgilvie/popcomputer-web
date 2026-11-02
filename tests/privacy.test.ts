/**
 * Why a response may not be shared, as each cache reads it: the default page
 * cache, a route's own `cache` option, and the default Cache-Control.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { render } from '../src/effect/responses.js'
import { PAGE_CACHE_HEADER, type PageCacheStore } from '../src/page-cache.js'
import { keptFrom, recordPrivacy, type PrivacyReason } from '../src/privacy.js'
import { signedIn } from '../src/testing.js'

describe('each reason', () => {
  const kept: ReadonlyArray<readonly [PrivacyReason, { readonly page: boolean; readonly route: boolean }]> = [
    // A header, the raw request or request state: no cache key holds them.
    ['request', { page: true, route: true }],
    // setupWeb's database factory or the application's middleware: pageCache: true keeps pages behind that middleware.
    ['setup', { page: false, route: true }],
    // A guard, which a cached page would skip; a route's own option is its decision.
    ['guard', { page: true, route: false }],
    // A binding or the database: a route's own option keeps data reads for its time.
    ['data', { page: true, route: false }],
    ['signed-in', { page: true, route: true }],
  ]

  test.each(kept)('%s keeps the response out of the caches it names', async (reason, expected) => {
    const app = new Hono()
    let seen: { page: boolean; route: boolean } | undefined
    app.get('/', (c) => {
      recordPrivacy(c, reason)
      seen = { page: keptFrom(c, 'page'), route: keptFrom(c, 'route') }

      return c.body(null, 204)
    })

    await app.request('/')

    expect(seen).toEqual(expected)
  })
})

/** An in-memory stand-in for caches.default. */
class MemoryCache implements PageCacheStore {
  readonly entries = new Map<string, Response>()
  private readonly pending: Promise<void>[] = []

  async match(request: Request): Promise<Response | undefined> {
    return this.entries.get(request.url)?.clone()
  }

  put(request: Request, response: Response): Promise<void> {
    const stored = response.arrayBuffer().then((body) => {
      this.entries.set(request.url, new Response(body, response))
    })
    this.pending.push(stored)

    return stored
  }

  async settled(): Promise<void> {
    await Promise.all(this.pending)
  }
}

describe('the page cache', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'caches')
  })

  test("keeps no page rendered to a visitor a route's own layer signs in, as an API key's layer does", async () => {
    const cache = new MemoryCache()
    Reflect.set(globalThis, 'caches', { default: cache })
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })
    routes.provide(signedIn({ id: 'user-1' })).get('/dashboard', action(render('Dashboard')))

    // A page is stored once its body has streamed, as a browser reads it.
    const visit = async () => {
      const res = await app.request('/dashboard', {}, { ENVIRONMENT: 'production' })
      await res.text()
      await cache.settled()

      return res.headers.get(PAGE_CACHE_HEADER)
    }

    expect(await visit()).not.toBe('HIT')
    expect(await visit()).not.toBe('HIT')
    expect(cache.entries.size).toBe(0)
  })
})
