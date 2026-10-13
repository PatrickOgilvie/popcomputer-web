/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/Cache API fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Default edge page cache.
 *
 * Static pages are served from the Cache API until the next deploy. A page
 * that reads a binding, a request header, request state or a route model
 * binding renders fresh, as do signed-in requests, requests with app cookies,
 * partial reloads, stale Inertia versions and development.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { Hono, type MiddlewareHandler } from 'hono'
import { setupWeb } from '../src/setup.js'
import { effectRoutes } from '../src/effect/routing.js'
import { render } from '../src/effect/responses.js'
import { DatabaseService, RequestService, RequestStateService } from '../src/effect/services.js'
import { PAGE_CACHE_HEADER, trackBindings, type PageCacheStore } from '../src/page-cache.js'
import { signedIn, testEnv } from '../src/testing.js'
import type { WebDeclaration } from '../src/effect/register.js'

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

/** A stand-in for a D1 binding: a class instance whose methods need `this`. */
class FakeD1 {
  queries = 0

  prepare(sql: string) {
    this.queries += 1

    return { sql }
  }
}

/** The Worker bindings the app reads. */
type PageCacheEnv = {
  Bindings: {
    readonly DB: FakeD1
  }
}

/** The database client the app builds from its D1 binding. */
interface PageCacheDatabase {
  readonly projects: () => { readonly sql: string }
}

declare module '../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{
      database: PageCacheDatabase
    }>
  }
}

let cache: MemoryCache

beforeEach(() => {
  cache = new MemoryCache()
  Reflect.set(globalThis, 'caches', { default: cache })
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'caches')
})

interface AppOptions {
  readonly pageCache?: boolean
  readonly version?: string
  /** Middleware registered before setupWeb, as an app's own outer middleware. */
  readonly outer?: MiddlewareHandler
}

const createApp = (options: AppOptions = {}) => {
  const app = new Hono<PageCacheEnv>()
  const renders = new Map<string, number>()
  const count = (name: string) => Effect.sync(() => renders.set(name, (renders.get(name) ?? 0) + 1))

  if (options.outer) {
    app.use('*', options.outer)
  }

  setupWeb(app, {
    version: options.version ?? '1.0.0',
    render: (page) => `<html>${JSON.stringify(page)}</html>`,
    database: (c) => {
      // Building a client from a binding is not a read; querying it is.
      const d1 = c.env.DB

      return { projects: () => d1.prepare('select * from projects') }
    },
    pageCache: options.pageCache,
  })

  const routes = effectRoutes(app)

  routes.get('/', Effect.andThen(count('home'), render('Home', { title: 'Hello' })))
  routes.get(
    '/projects',
    Effect.gen(function* () {
      yield* count('projects')
      const db = yield* DatabaseService
      db.projects()

      return yield* render('Projects/Index')
    })
  )
  routes.get(
    '/greeting',
    Effect.gen(function* () {
      yield* count('greeting')
      const request = yield* RequestService

      return yield* render('Greeting', { language: request.header('Accept-Language') ?? 'en' })
    })
  )
  routes.get(
    '/state',
    Effect.gen(function* () {
      yield* count('state')
      const state = yield* RequestStateService

      return yield* render('State', { theme: state.get<string>('theme') ?? 'light' })
    })
  )
  routes.get('/fresh', Effect.andThen(count('fresh'), render('Fresh')), { cache: false })
  routes.get('/projects/{project}', Effect.andThen(count('bound'), render('Projects/Show')))
  routes.get(
    '/welcome',
    Effect.andThen(
      count('welcome'),
      Effect.succeed(
        new Response('<html>welcome</html>', {
          headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'seen=1' },
        })
      )
    )
  )
  routes.get('/api/ping', Effect.andThen(count('ping'), Effect.succeed(Response.json({ ok: true }))))

  return { app, renders }
}

const production = (extra: object = {}) => ({ ENVIRONMENT: 'production', DB: new FakeD1(), ...extra })

const inertia = (version = '1.0.0'): RequestInit => ({
  headers: { 'X-Inertia': 'true', 'X-Inertia-Version': version },
})

/**
 * Request a page and read its body, as a browser would. A page is stored
 * once its body has streamed, after every middleware has run.
 */
async function get(app: Hono<PageCacheEnv>, path: string, init: RequestInit, env: object) {
  const res = await app.request(path, init, env)
  const body = await res.text()
  await cache.settled()

  return { res, status: res.headers.get(PAGE_CACHE_HEADER), body }
}

describe('default page cache', () => {
  test('serves a static page from the cache until the next deploy', async () => {
    const { app, renders } = createApp()
    const env = production()

    const first = await get(app, '/', {}, env)
    expect(first.res.status).toBe(200)
    expect(first.status).toBe('MISS')
    // Browsers revalidate: the page names this deploy's assets.
    expect(first.res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate')

    const second = await get(app, '/', {}, env)
    expect(second.status).toBe('HIT')
    expect(second.res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate')
    expect(second.res.headers.get('Vary')).toBe('X-Inertia')
    expect(second.body).toBe(first.body)
    expect(renders.get('home')).toBe(1)
  })

  test('stores the Inertia page object separately from the HTML document', async () => {
    const { app, renders } = createApp()
    const env = production()

    await get(app, '/', {}, env)

    const json = await get(app, '/', inertia(), env)
    expect(json.status).toBe('MISS')
    expect(JSON.parse(json.body)).toMatchObject({ component: 'Home' })

    const cachedJson = await get(app, '/', inertia(), env)
    expect(cachedJson.status).toBe('HIT')
    expect(JSON.parse(cachedJson.body)).toMatchObject({ component: 'Home' })
    expect(renders.get('home')).toBe(2)
  })

  test('a new deploy starts from an empty cache', async () => {
    const { app, renders } = createApp()
    const deploy = (id: string) => production({ CF_VERSION_METADATA: { id } })

    await get(app, '/', {}, deploy('version-a'))
    expect((await get(app, '/', {}, deploy('version-a'))).status).toBe('HIT')
    expect((await get(app, '/', {}, deploy('version-b'))).status).toBe('MISS')
    expect(renders.get('home')).toBe(2)
  })

  test('without version metadata, new client assets start from an empty cache', async () => {
    await get(createApp({ version: 'assets-1' }).app, '/', {}, production())

    const after = await get(createApp({ version: 'assets-2' }).app, '/', {}, production())
    expect(after.status).toBe('MISS')
  })

  test('a page that queries a binding renders fresh', async () => {
    const { app, renders } = createApp()
    const env = production()

    const first = await get(app, '/projects', {}, env)
    expect(first.res.status).toBe(200)
    expect(first.status).toBe('DYNAMIC')
    expect(first.res.headers.get('Cache-Control')).toBe('private, no-cache')

    await get(app, '/projects', {}, env)
    expect(renders.get('projects')).toBe(2)
    // The query reached the real binding through the tracking proxy.
    expect(env.DB.queries).toBe(2)
    expect(cache.entries.size).toBe(0)
  })

  test('a page that reads request headers or request state renders fresh', async () => {
    const { app } = createApp()
    const env = production()

    expect((await get(app, '/greeting', { headers: { 'Accept-Language': 'fr' } }, env)).status).toBe('DYNAMIC')
    expect((await get(app, '/state', {}, env)).status).toBe('DYNAMIC')
    expect(cache.entries.size).toBe(0)
  })

  test('routes with cache: false or a route model binding are never stored', async () => {
    const { app } = createApp()
    const env = production()

    expect((await get(app, '/fresh', {}, env)).status).toBeNull()
    expect((await get(app, '/projects/42', {}, env)).status).toBeNull()
    expect(cache.entries.size).toBe(0)
  })

  test('responses that set cookies or are not pages are never stored', async () => {
    const { app } = createApp()
    const env = production()

    const welcome = await get(app, '/welcome', {}, env)
    expect(welcome.res.headers.get('Set-Cookie')).toBe('seen=1')
    const ping = await get(app, '/api/ping', {}, env)
    expect(JSON.parse(ping.body)).toEqual({ ok: true })
    expect(cache.entries.size).toBe(0)
  })

  test('respects Cache-Control and cookies added by middleware outside setupWeb', async () => {
    const noStore = createApp({
      outer: async (c, next) => {
        await next()
        c.header('Cache-Control', 'no-store')
      },
    })
    const first = await get(noStore.app, '/', {}, production())
    expect(first.res.headers.get('Cache-Control')).toBe('no-store')

    const cookie = createApp({
      outer: async (c, next) => {
        await next()
        c.header('Set-Cookie', 'visitor=1')
      },
    })
    await get(cookie.app, '/', {}, production())

    expect(cache.entries.size).toBe(0)
  })

  test('signed-in requests bypass the cache and are marked no-store', async () => {
    const { app, renders } = createApp()
    const env = production()

    await get(app, '/', {}, env)

    const signedIn = await get(app, '/', { headers: { Cookie: 'better-auth.session_token=abc' } }, env)
    expect(signedIn.status).toBe('BYPASS')
    expect(signedIn.res.headers.get('Cache-Control')).toBe('no-store')

    const authorized = await get(app, '/', { headers: { Authorization: 'Bearer token' } }, env)
    expect(authorized.status).toBe('BYPASS')
    expect(authorized.res.headers.get('Cache-Control')).toBe('no-store')
    expect(renders.get('home')).toBe(3)
  })

  test('app cookies bypass the cache; analytics cookies do not', async () => {
    const { app } = createApp()
    const env = production()

    await get(app, '/', {}, env)

    const appCookie = await get(app, '/', { headers: { Cookie: 'cart=3' } }, env)
    expect(appCookie.status).toBe('BYPASS')
    expect(appCookie.res.headers.get('Cache-Control')).toBe('private, no-cache')

    const analytics = await get(app, '/', { headers: { Cookie: '_ga=GA1.1.1; _ga_ABC=GS1; __cf_bm=x' } }, env)
    expect(analytics.status).toBe('HIT')
  })

  test('partial reloads and stale Inertia versions skip the cache', async () => {
    const { app } = createApp()
    const env = production()

    await get(app, '/', inertia(), env)

    const partial = await get(
      app,
      '/',
      {
        headers: {
          'X-Inertia': 'true',
          'X-Inertia-Version': '1.0.0',
          'X-Inertia-Partial-Component': 'Home',
          'X-Inertia-Partial-Data': 'title',
        },
      },
      env
    )
    expect(partial.status).toBe('BYPASS')

    // web() answers 409 so the stale client reloads with current assets.
    expect((await get(app, '/', inertia('0.9.0'), env)).res.status).toBe(409)
  })

  test('development and pageCache: false never cache', async () => {
    const development = await get(createApp().app, '/', {}, { ENVIRONMENT: 'development', DB: new FakeD1() })
    expect(development.status).toBeNull()

    const disabled = await get(createApp({ pageCache: false }).app, '/', {}, production())
    expect(disabled.status).toBeNull()
    expect(cache.entries.size).toBe(0)
  })

  test('without a Cache API the app renders normally', async () => {
    Reflect.deleteProperty(globalThis, 'caches')

    const res = await get(createApp().app, '/', {}, production())
    expect(res.res.status).toBe(200)
    expect(res.status).toBeNull()
  })
})

describe('testEnv with the page cache', () => {
  test('a test-signed-in visit stays signed in, and its page is not stored', async () => {
    const { app } = createApp()

    const member = await get(app, '/', inertia(), testEnv(signedIn({ id: 'user-1' }), production()))
    const guest = await get(app, '/', inertia(), production())

    expect(JSON.parse(member.body).props.auth.user).toMatchObject({ id: 'user-1' })
    expect(member.status).toBe('BYPASS')
    expect(member.res.headers.get('Cache-Control')).toBe('no-store')
    expect(JSON.parse(guest.body).props.auth.user).toBeNull()
  })
})

describe('a test sign-in', () => {
  test('gets the signed-in policy where no Cache API exists, as a session cookie does', async () => {
    Reflect.deleteProperty(globalThis, 'caches')
    const { app } = createApp()

    const member = await get(app, '/', inertia(), testEnv(signedIn({ id: 'user-1' }), production()))
    const session = await get(app, '/', { headers: { 'X-Inertia': 'true', 'X-Inertia-Version': '1.0.0', Cookie: 'better-auth.session_token=abc' } }, production())

    expect(member.status).toBe('BYPASS')
    expect(member.res.headers.get('Cache-Control')).toBe('no-store')
    expect(session.status).toBe(member.status)
    expect(session.res.headers.get('Cache-Control')).toBe(member.res.headers.get('Cache-Control'))
  })
})

describe('responses without a cache policy', () => {
  test('are private and revalidated, so Workers Cache never shares them', async () => {
    const { app } = createApp({ pageCache: false })
    const env = production()

    const page = await get(app, '/projects', {}, env)
    const api = await get(app, '/api/ping', {}, env)

    expect(page.res.headers.get('Cache-Control')).toBe('private, no-cache')
    expect(api.res.headers.get('Cache-Control')).toBe('private, no-cache')
  })

  test('keep the policy a route states itself', async () => {
    const { app } = createApp()
    const env = production()

    await get(app, '/', {}, env)
    const cached = await get(app, '/', {}, env)

    expect(cached.status).toBe('HIT')
    expect(cached.res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate')
  })
})

describe('trackBindings', () => {
  test('reports binding use and keeps vars, secrets and plain objects as they are', () => {
    let reads = 0
    const d1 = new FakeD1()
    const config = { region: 'eu' }
    const env = trackBindings({ DB: d1, ENVIRONMENT: 'production', CONFIG: config }, () => {
      reads += 1
    })

    expect(env.ENVIRONMENT).toBe('production')
    expect(env.CONFIG).toBe(config)
    expect(reads).toBe(0)

    // Methods run against the real binding.
    expect(env.DB.prepare('select 1')).toEqual({ sql: 'select 1' })
    expect(d1.queries).toBe(1)
    expect(reads).toBeGreaterThan(0)
  })
})
