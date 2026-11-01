/**
 * Whether the application runs in development: one decision, which
 * setupWeb's `errors.envKey` and `errors.devValue` name, for the error
 * page's details, the page cache and a route's developer warnings.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { Context, Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { render } from '../src/effect/responses.js'
import { declaresEnvironment, isDevelopment } from '../src/development.js'
import { PAGE_CACHE_HEADER, type PageCacheStore } from '../src/page-cache.js'

/** A request's context with these bindings. */
const requestWith = (env: Readonly<Record<string, string>> | undefined) => new Context(new Request('http://localhost/'), { env })

describe('isDevelopment', () => {
  test('reads ENVIRONMENT or NODE_ENV for development, unless setupWeb names another binding and value', () => {
    expect(isDevelopment(requestWith({ ENVIRONMENT: 'development' }))).toBe(true)
    expect(isDevelopment(requestWith({ NODE_ENV: 'development' }))).toBe(true)
    expect(isDevelopment(requestWith({ ENVIRONMENT: 'production' }))).toBe(false)
    // Every Pages deployment sets it, production included.
    expect(isDevelopment(requestWith({ CF_PAGES_BRANCH: 'preview' }))).toBe(false)
    expect(isDevelopment(requestWith(undefined))).toBe(false)

    const local = { envKey: 'APP_ENV', devValue: 'local' }

    expect(isDevelopment(requestWith({ APP_ENV: 'local' }), local)).toBe(true)
    expect(isDevelopment(requestWith({ APP_ENV: 'development' }), local)).toBe(false)
    // Another key replaces ENVIRONMENT, NODE_ENV's stand-in, too.
    expect(isDevelopment(requestWith({ NODE_ENV: 'local' }), local)).toBe(false)
    expect(isDevelopment(requestWith({ ENVIRONMENT: 'development' }), local)).toBe(false)
  })

  test('says whether the bindings name an environment at all', () => {
    expect(declaresEnvironment(requestWith({}))).toBe(false)
    expect(declaresEnvironment(requestWith({ NODE_ENV: 'production' }))).toBe(true)
    expect(declaresEnvironment(requestWith({ APP_ENV: 'local' }), { envKey: 'APP_ENV' })).toBe(true)
    expect(declaresEnvironment(requestWith({ ENVIRONMENT: 'local' }), { envKey: 'APP_ENV' })).toBe(false)
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

  /** Every store the cache was asked for, done. */
  async settled(): Promise<void> {
    await Promise.all(this.pending)
  }
}

describe('the page cache', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'caches')
  })

  test("keeps nothing while setupWeb's errors.envKey says development", async () => {
    const cache = new MemoryCache()
    Reflect.set(globalThis, 'caches', { default: cache })

    const app = new Hono()
    const { routes } = setupWeb(app, {
      version: '1',
      render: (page) => JSON.stringify(page),
      errors: { envKey: 'APP_ENV', devValue: 'local' },
    })
    routes.get('/', action(render('Home')))

    // A page is stored once its body has streamed, as a browser reads it.
    const visit = async (env: Readonly<Record<string, string>>) => {
      const res = await app.request('/', {}, env)
      await res.text()
      await cache.settled()

      return res.headers.get(PAGE_CACHE_HEADER)
    }

    expect(await visit({ APP_ENV: 'local' })).toBeNull()
    expect(await visit({ APP_ENV: 'local' })).toBeNull()
    expect(cache.entries.size).toBe(0)

    expect(await visit({ APP_ENV: 'production' })).toBe('MISS')
    expect(await visit({ APP_ENV: 'production' })).toBe('HIT')
  })
})
