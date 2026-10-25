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
import { Context, Effect, Layer, Option, Schema as S } from 'effect'
import { Hono, type MiddlewareHandler } from 'hono'
import { setupWeb, webDefaults } from '../src/setup.js'
import { web } from '../src/middleware.js'
import { effectBridge } from '../src/effect/bridge.js'
import { cookie } from '../src/effect/cookies.js'
import { effectRoutes } from '../src/effect/routing.js'
import { forbidden, render } from '../src/effect/responses.js'
import { guard } from '../src/effect/guard.js'
import { responseHeader } from '../src/effect/response-headers.js'
import { DatabaseService, RequestService, RequestStateService } from '../src/effect/services.js'
import { dbQuery } from '../src/effect/database.js'
import { PAGE_CACHE_HEADER, pageCache, trackBindings, trackDatabase, type PageCacheStore } from '../src/page-cache.js'
import { openWebContext, webServices } from '../src/request-context.js'
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
    readonly DATABASE_URL?: string
  }
}

/** The database client the app builds from its D1 binding, or from a connection string. */
interface PageCacheDatabase {
  readonly projects: () => { readonly sql: string }
  /** The names of the projects anyone may see. */
  readonly publicProjects: () => Promise<readonly string[]>
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

      return {
        projects: () => d1.prepare('select * from projects'),
        publicProjects: async () => {
          d1.prepare('select name from projects where public')

          return []
        },
      }
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
    '/visitor',
    Effect.gen(function* () {
      yield* count('visitor')
      const request = yield* RequestService

      return yield* render('Visitor', { address: request.raw().headers.get('CF-Connecting-IP') ?? 'unknown' })
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
  routes.get('/fresh', Effect.andThen(count('fresh'), render('Fresh')), { cache: 'private' })
  routes.get(
    '/stated',
    Effect.gen(function* () {
      yield* count('stated')
      yield* responseHeader('Cache-Control', 'public, max-age=60')

      return yield* render('Stated')
    })
  )
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
  routes.get(
    '/document',
    Effect.andThen(
      count('document'),
      Effect.sync(() => new Response('<html>document</html>', { headers: { 'Content-Type': 'text/html' } }))
    )
  )
  routes.get(
    '/page-object',
    Effect.andThen(
      count('page-object'),
      Effect.sync(
        () =>
          new Response('{"component":"Marked"}', {
            headers: { 'Content-Type': 'application/json', 'X-Inertia': 'true' },
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
    expect((await get(app, '/visitor', { headers: { 'CF-Connecting-IP': '203.0.113.7' } }, env)).status).toBe('DYNAMIC')
    expect((await get(app, '/state', {}, env)).status).toBe('DYNAMIC')
    expect(cache.entries.size).toBe(0)
  })

  test("a page using a request service built from the request's headers renders fresh", async () => {
    class Tenant extends Context.Service<Tenant, { readonly name: string }>()('test/Tenant') {}

    const app = new Hono<PageCacheEnv>()
    const web = setupWeb(app, { version: '1.0.0', render: (page) => `<html>${JSON.stringify(page)}</html>` })
    web.services({ request: (c) => Layer.succeed(Tenant, { name: c.req.header('X-Tenant') ?? 'public' }) })
    effectRoutes<PageCacheEnv, Tenant>(app).get('/report', Effect.gen(function* () {
      const tenant = yield* Tenant

      return yield* render('Report', { tenant: tenant.name })
    }))

    const acme = await get(app, '/report', { headers: { 'X-Tenant': 'acme' } }, production())
    const guest = await get(app, '/report', {}, production())

    expect([acme.status, guest.status]).toEqual(['DYNAMIC', 'DYNAMIC'])
    expect(JSON.parse(guest.body.slice('<html>'.length, -'</html>'.length)).props.tenant).toBe('public')
    expect(cache.entries.size).toBe(0)
  })

  test("routes with cache: 'private' or a route model binding are never stored", async () => {
    const { app } = createApp()
    const env = production()

    const fresh = await get(app, '/fresh', {}, env)

    expect(fresh.status).toBeNull()
    expect(fresh.res.headers.get('Cache-Control')).toBe('private, no-cache')
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

  test('a page whose template reads a request header renders fresh', async () => {
    const app = new Hono<PageCacheEnv>()
    const { routes } = setupWeb(app, {
      version: '1.0.0',
      render: (page, c) => `<html lang="${c?.req.header('Accept-Language')?.startsWith('de') ? 'de' : 'en'}">${JSON.stringify(page)}</html>`,
    })
    routes.get('/welcome', render('Welcome'))

    const german = await get(app, '/welcome', { headers: { 'Accept-Language': 'de-DE' } }, production())
    const english = await get(app, '/welcome', { headers: { 'Accept-Language': 'en-US' } }, production())

    expect([german.status, english.status]).toEqual(['DYNAMIC', 'DYNAMIC'])
    expect(english.body).toContain('lang="en"')
    expect(cache.entries.size).toBe(0)
  })

  test('respects Cache-Control and cookies added by middleware outside setupWeb', async () => {
    const noStore = createApp({
      outer: async (c, next) => {
        await next()
        c.header('Cache-Control', 'no-store')
      },
    })
    await get(noStore.app, '/', {}, production())

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

  test('an X-Inertia value other than true skips the cache and fills neither key', async () => {
    const version = { 'X-Inertia-Version': '1.0.0' }
    // Fetch combines a repeated header into one value, as 'true, true'.
    const repeated = new Headers(version)
    repeated.append('X-Inertia', 'true')
    repeated.append('X-Inertia', 'true')

    const spellings: readonly Headers[] = [
      new Headers({ ...version, 'X-Inertia': '1' }),
      new Headers({ ...version, 'X-Inertia': 'false' }),
      new Headers({ ...version, 'X-Inertia': 'TRUE' }),
      new Headers({ ...version, 'X-Inertia': '' }),
      repeated,
    ]

    for (const headers of spellings) {
      cache.entries.clear()
      const { app } = createApp()
      const env = production()

      // web() answers it with the HTML document, which must not reach the key Inertia visits read.
      const attack = await get(app, '/', { headers }, env)
      expect(attack.status).toBe('BYPASS')
      expect(attack.res.headers.get('Content-Type')).toContain('text/html')
      expect(cache.entries.size).toBe(0)

      const visit = await get(app, '/', inertia(), env)
      expect(visit.status).toBe('MISS')
      expect(visit.res.headers.get('X-Inertia')).toBe('true')
      expect(visit.res.headers.get('Content-Type')).toContain('application/json')
      expect(JSON.parse(visit.body)).toMatchObject({ component: 'Home' })

      const cached = await get(app, '/', inertia(), env)
      expect(cached.status).toBe('HIT')
      expect(cached.res.headers.get('X-Inertia')).toBe('true')
      expect(JSON.parse(cached.body)).toMatchObject({ component: 'Home' })
    }
  })

  test('an X-Inertia value other than true does not replace a stored page object or document', async () => {
    const { app, renders } = createApp()
    const env = production()
    const odd = { headers: { 'X-Inertia': '1', 'X-Inertia-Version': '1.0.0' } }

    await get(app, '/', {}, env)
    await get(app, '/', inertia(), env)

    expect((await get(app, '/', odd, env)).status).toBe('BYPASS')
    expect((await get(app, '/', inertia(), env)).status).toBe('HIT')
    expect((await get(app, '/', {}, env)).status).toBe('HIT')
    expect(renders.get('home')).toBe(3)
  })

  test('a response is stored only under the variant its key names', async () => {
    const { app } = createApp()
    const env = production()

    // An Inertia visit answered with a document, not a page object.
    const document = await get(app, '/document', inertia(), env)
    expect(document.status).toBe('DYNAMIC')

    // A full page load answered with an Inertia-marked page object.
    const pageObject = await get(app, '/page-object', {}, env)
    expect(pageObject.status).toBe('DYNAMIC')
    expect(cache.entries.size).toBe(0)

    // Each is still stored under the variant it is.
    expect((await get(app, '/document', {}, env)).status).toBe('MISS')
    expect((await get(app, '/page-object', inertia(), env)).status).toBe('MISS')
    expect(cache.entries.size).toBe(2)
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

describe('a database reached through a connection string', () => {
  /** A database server the client reaches over the network, with no binding. */
  const server = { projects: [{ name: 'Dummy public project', public: true }] }

  /** Stands in for drizzle(postgres(url)). */
  const clientFor = (url: string): PageCacheDatabase => ({
    projects: () => ({ sql: `select * from projects -- ${url}` }),
    publicProjects: async () => server.projects.filter((project) => project.public).map((project) => project.name),
  })

  const createDatabaseApp = () => {
    const app = new Hono<PageCacheEnv>()
    setupWeb(app, {
      version: '1.0.0',
      render: (page) => `<html>${JSON.stringify(page)}</html>`,
      database: (c) => clientFor(c.env.DATABASE_URL ?? ''),
    })
    const explore = Effect.flatMap(dbQuery((db) => db.publicProjects()), (names) => render('Explore', { names }))

    effectRoutes(app)
      .get('/explore', explore)
      .get('/about', render('About'))
      .get('/api/explore', Effect.map(dbQuery((db) => db.publicProjects()), (names) => Response.json({ names })), { cache: { maxAge: 60 } })

    return app
  }

  const env = () => production({ DATABASE_URL: 'postgres://db.example.com/app', CF_VERSION_METADATA: { id: 'deploy-1' } })

  test('a page that reads it renders fresh, so a record made private leaves it', async () => {
    server.projects[0].public = true
    const app = createDatabaseApp()

    const listed = await get(app, '/explore', {}, env())
    server.projects[0].public = false
    const hidden = await get(app, '/explore', {}, env())

    expect([listed.status, hidden.status]).toEqual(['DYNAMIC', 'DYNAMIC'])
    expect(listed.body).toContain('Dummy public project')
    expect(hidden.body).not.toContain('Dummy public project')
    expect(cache.entries.size).toBe(0)

    // A page that reads no data is still cached.
    expect((await get(app, '/about', {}, env())).status).toBe('MISS')
    expect((await get(app, '/about', {}, env())).status).toBe('HIT')
  })

  test("a route's own cache option still keeps its data reads for a fixed time", async () => {
    server.projects[0].public = true
    const res = await createDatabaseApp().request('/api/explore', {}, env())

    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(await res.json()).toEqual({ names: ['Dummy public project'] })
  })
})

/** A service a guard is composed with. */
class Plan extends Context.Service<Plan, string>()('test/Plan') {}

describe('access checks and the default page cache', () => {
  /** Whom the access checks admit: they decide by what no cache key holds. */
  const gate = { open: true }
  const admitted = { 'CF-Connecting-IP': '198.51.100.1', 'X-Preview-Token': 'preview' }
  const refused = { 'CF-Connecting-IP': '203.0.113.9' }

  const allowlist: MiddlewareHandler = async (c, next) => {
    if (c.req.header('CF-Connecting-IP') !== admitted['CF-Connecting-IP']) return c.text('Forbidden', 403)
    await next()
  }

  const createGuardedApp = (options: { readonly middleware?: MiddlewareHandler[]; readonly pageCache?: boolean } = {}) => {
    const app = new Hono<PageCacheEnv>()
    setupWeb(app, { version: '1.0.0', render: (page) => `<html>${JSON.stringify(page)}</html>`, ...options })
    const routes = effectRoutes(app)
    const secret = render('Internal', { plan: 'the launch date' })

    const gateGuard = guard(Effect.suspend(() => gate.open ? Effect.void : forbidden('Not from here.')))

    routes.provide(gateGuard).get('/guarded', secret)
    // The same guard, composed into another layer before it is provided.
    routes.provide(Layer.merge(gateGuard, Layer.succeed(Plan, 'pro'))).get('/merged', secret)
    routes.provide(gateGuard.pipe(Layer.provide(Layer.succeed(Plan, 'pro')))).get('/composed', secret)
    // Middleware the route builder gives the routes under a prefix.
    routes.prefix('/staff')
      .prefixMiddleware(async (c, next) => {
        if (!gate.open) return c.text('Forbidden', 403)
        await next()
      })
      .get('/staff', secret)
    routes
      .middleware(async (c, next) => {
        if (c.req.header('X-Preview-Token') !== admitted['X-Preview-Token']) return c.text('Forbidden', 403)
        await next()
      })
      .get('/preview', secret)
    routes.get('/internal', secret)

    return app
  }

  const visit = async (app: Hono<PageCacheEnv>, path: string, headers: Record<string, string>) => {
    const { res, status, body } = await get(app, path, { headers }, production({ CF_VERSION_METADATA: { id: 'deploy-1' } }))

    return { code: res.status, cache: status, secret: body.includes('the launch date') }
  }

  test('a refused visitor is refused after an admitted one, never served the cached page', async () => {
    const opens = { admit: () => { gate.open = true }, refuse: () => { gate.open = false } }
    // A check the route knows of when it is registered keeps its pages out of
    // the cache's consideration; one found as it runs makes them dynamic. A
    // refusal that is no page, such as middleware's text, is neither.
    const cases = [
      { path: '/guarded', app: createGuardedApp(), ...opens, found: [null, null] },
      { path: '/merged', app: createGuardedApp(), ...opens, found: ['DYNAMIC', 'DYNAMIC'] },
      { path: '/composed', app: createGuardedApp(), ...opens, found: ['DYNAMIC', 'DYNAMIC'] },
      { path: '/staff', app: createGuardedApp(), ...opens, found: ['DYNAMIC', null] },
      { path: '/preview', app: createGuardedApp(), admit: () => {}, refuse: () => {}, found: [null, null] },
      { path: '/internal', app: createGuardedApp({ middleware: [allowlist] }), admit: () => {}, refuse: () => {}, found: [null, null] },
    ]

    for (const { path, app, admit, refuse, found } of cases) {
      cache.entries.clear()

      admit()
      const first = await visit(app, path, admitted)
      refuse()
      const second = await visit(app, path, refused)
      gate.open = true

      expect({ path, first, second }).toEqual({
        path,
        first: { code: 200, cache: found[0], secret: true },
        second: { code: 403, cache: found[1], secret: false },
      })
      expect(cache.entries.size).toBe(0)
    }
  })

  test('an application that turns the page cache on behind its middleware keeps it', async () => {
    const app = createGuardedApp({ middleware: [allowlist], pageCache: true })

    expect((await visit(app, '/internal', admitted)).cache).toBe('MISS')
    expect((await visit(app, '/internal', admitted)).cache).toBe('HIT')
  })

  test('a signed-in visit is kept out of every cache when the page cache is off', async () => {
    const app = createGuardedApp({ middleware: [allowlist] })
    const member = await get(app, '/internal', { headers: admitted }, testEnv(signedIn({ id: 'user-1' }), production()))

    expect(member.res.headers.get('Cache-Control')).toBe('no-store')
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

  test('a page whose route states its own policy keeps it, and the page cache does not store it', async () => {
    const { app, renders } = createApp()
    const env = production()

    const first = await get(app, '/stated', {}, env)
    const second = await get(app, '/stated', {}, env)

    expect(first.res.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(second.res.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(renders.get('stated')).toBe(2)
    expect(cache.entries.size).toBe(0)
  })
})

describe('an application composed without setupWeb', () => {
  const cartCookie = cookie('cart', S.String)

  const register = (app: Hono<PageCacheEnv>) => {
    effectRoutes(app)
      .get('/dashboard', render('Dashboard'))
      .get('/clock', render('Clock', { at: 'now' }), { cache: 'private' })
      .get('/cart', Effect.flatMap(cartCookie.read, (cart) => render('Cart', { cart: Option.getOrNull(cart) })))
      .get('/visit', Effect.andThen(cartCookie.set('cart-1'), render('Visit')), { cache: 'private' })
      .post('/cart', Effect.succeed(Response.json({ added: true })))
    app.get('/plain', (c) => c.var.web.render('Home'))

    return app
  }

  const stack = (defaults: boolean) => {
    const app = new Hono<PageCacheEnv>()

    if (defaults) app.use('*', webDefaults())
    app.use('*', web({ version: '1.0.0', render: (page) => `<html>${JSON.stringify(page)}</html>` }))
    app.use('*', effectBridge())

    return register(app)
  }

  const cacheControl = async (app: Hono<PageCacheEnv>, path: string, init: RequestInit = {}, env: object = production()) =>
    (await get(app, path, init, env)).res.headers.get('Cache-Control')

  test('with webDefaults, every response says who may keep it, as under setupWeb', async () => {
    const app = stack(true)

    expect({
      signedIn: await cacheControl(app, '/dashboard', {}, testEnv(signedIn({ id: 'user-1' }), production())),
      private: await cacheControl(app, '/clock'),
      cookie: await cacheControl(app, '/cart', { headers: { Cookie: 'cart=cart-1' } }),
      plain: await cacheControl(app, '/plain'),
    }).toEqual({ signedIn: 'no-store', private: 'private, no-cache', cookie: 'private, no-cache', plain: 'private, no-cache' })
  })

  test('with webDefaults, responses carry the security headers and a cross-site post is refused', async () => {
    const app = stack(true)
    const page = await get(app, '/plain', {}, production())
    const forged = await app.request('/cart', { method: 'POST', headers: { Origin: 'https://evil.example' } }, production())

    expect(page.res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(page.res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(forged.status).toBe(403)
  })

  test("without it, cache: 'private' still says so itself", async () => {
    const app = stack(false)

    expect({
      private: await cacheControl(app, '/clock'),
      signedIn: await cacheControl(app, '/clock', {}, testEnv(signedIn({ id: 'user-1' }), production())),
      setsCookie: await cacheControl(app, '/visit'),
    }).toEqual({ private: 'private, no-cache', signedIn: 'no-store', setsCookie: 'no-store' })
  })

  /** The stack docs/lower-level.md showed before webDefaults: web, webServices and effectBridge. */
  const documented = (options: { readonly pageCache?: boolean } = {}) => {
    const app = new Hono<PageCacheEnv>()

    app.use('*', web({ version: '1.0.0', render: (page) => `<html>${JSON.stringify(page)}</html>` }))
    if (options.pageCache === true) app.use('*', pageCache({ version: '1.0.0' }))
    app.use('*', webServices<PageCacheEnv>((c) => ({
      db: { projects: () => c.env.DB.prepare('select * from projects'), publicProjects: async () => [] },
    })))
    app.use('*', effectBridge())

    return register(app)
  }

  test('composed as the docs showed before webDefaults, web() still says who may keep each response', async () => {
    const app = documented()

    expect({
      signedIn: await cacheControl(app, '/dashboard', {}, testEnv(signedIn({ id: 'user-1' }), production())),
      cookie: await cacheControl(app, '/cart', { headers: { Cookie: 'cart=cart-1' } }),
      private: await cacheControl(app, '/clock'),
      plain: await cacheControl(app, '/plain'),
      json: await cacheControl(app, '/cart', { method: 'POST' }),
    }).toEqual({
      signedIn: 'no-store',
      cookie: 'private, no-cache',
      private: 'private, no-cache',
      plain: 'private, no-cache',
      json: 'private, no-cache',
    })
  })

  test('composed so with the page cache, a static page is still cached, and a signed-in one is not', async () => {
    const app = documented({ pageCache: true })

    // testEnv signs in without a session cookie, so before the page is cached.
    const signedInPage = await get(app, '/dashboard', {}, testEnv(signedIn({ id: 'user-1' }), production()))
    const first = await get(app, '/dashboard', {}, production())
    const second = await get(app, '/dashboard', {}, production())

    expect([first.status, second.status]).toEqual(['MISS', 'HIT'])
    expect(second.res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate')
    expect(signedInPage.res.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('under setupWeb, web() leaves the policy to privateByDefault', () => {
  test('pages keep the headers setupWeb gives them, and a static page is still cached', async () => {
    const { app } = createApp()
    const env = production()

    // testEnv signs in without a session cookie, so before the page is cached.
    const signedInPage = await get(app, '/', {}, testEnv(signedIn({ id: 'user-1' }), env))
    const first = await get(app, '/', {}, env)
    const second = await get(app, '/', {}, env)

    expect({
      first: [first.status, first.res.headers.get('Cache-Control')],
      second: [second.status, second.res.headers.get('Cache-Control')],
      database: (await get(app, '/projects', {}, env)).res.headers.get('Cache-Control'),
      signedIn: signedInPage.res.headers.get('Cache-Control'),
      stated: (await get(app, '/stated', {}, env)).res.headers.get('Cache-Control'),
    }).toEqual({
      first: ['MISS', 'public, max-age=0, must-revalidate'],
      second: ['HIT', 'public, max-age=0, must-revalidate'],
      database: 'private, no-cache',
      signedIn: 'no-store',
      stated: 'public, max-age=60',
    })
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

describe('trackDatabase', () => {
  test("reports a client's methods and calls to the page cache, and keeps its class", async () => {
    class Client {
      #rows = ['row']
      rows() {
        return this.#rows
      }
    }
    // A client that is itself a function, as postgres.js's `sql` is.
    const sql = Object.assign((strings: TemplateStringsArray, ..._values: unknown[]) => strings.join('?'), { end: () => 'ended' })
    const app = new Hono()

    app.get('/', (c) => {
      const marks: boolean[] = []
      const read = <A>(use: () => A): A => {
        const state = { key: new Request('http://localhost/'), variant: 'html', ttl: 60, dynamic: false, routeAllowsDefault: true } as const
        openWebContext(c).pageCache = { ...state }
        const value = use()
        marks.push(openWebContext(c).pageCache?.dynamic === true)

        return value
      }
      const client = trackDatabase(c, new Client())
      const tag = trackDatabase(c, sql)

      return c.json({
        values: [read(() => client.rows()), read(() => tag`select ${1}`), read(() => tag.end())],
        marks,
        isClient: client instanceof Client && client.constructor === Client,
      })
    })

    const res = await app.request('/')

    expect(await res.json()).toEqual({ values: [['row'], 'select ?', 'ended'], marks: [true, true, true], isClient: true })
  })
})
