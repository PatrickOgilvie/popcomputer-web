/**
 * The default page cache, as a sequence of requests from several browsers:
 * a guest, a guest with an app cookie, and two members, ada and grace, each
 * sending its session cookie as a browser does. Every request goes to two
 * copies of one application, one with the default page cache over an
 * in-memory `caches.default` and one with `pageCache: false`, and the two
 * must answer alike. A cached page that differs from what a fresh render
 * answers has reached a visitor it was not rendered for, or outlived what it
 * shows: run-1's HTML stored under the Inertia key (C6), a guarded page
 * served to a refused visitor (C12, run-2 F11), a database-backed page
 * cached (C24). A gate, opened and closed by a step, stands for what a guard
 * may decide by that no request names, such as the time: its pages, however
 * the guard is composed, admit a cookieless guest while it is open. No page
 * a guard, middleware or sign-in decides for is ever stored.
 */
import { describe } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { eq } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Hono } from 'hono'
import { Arbitrary, Context, Effect, Layer } from 'effect'
import { action } from '../../src/effect/action.js'
import { currentUser, RequireAuthLayer } from '../../src/effect/auth.js'
import { dbMutation, dbQuery } from '../../src/effect/database.js'
import { guard } from '../../src/effect/guard.js'
import { flash, forbidden, redirect, render } from '../../src/effect/responses.js'
import { RequestService } from '../../src/effect/services.js'
import { setupWeb } from '../../src/setup.js'
import { signedIn, testBrowser, testEnv, type TestBrowser } from '../../src/testing.js'
import type { PageCacheStore } from '../../src/page-cache.js'
import { property, show, weighted } from './property'

const counters = sqliteTable('counters', { id: text('id').primaryKey(), value: integer('value').notNull() })

/** An in-memory stand-in for caches.default, keyed as the Cache API keys: by URL. */
class MemoryCache implements PageCacheStore {
  readonly entries = new Map<string, Response>()
  private readonly pending: Promise<void>[] = []

  async match(request: Request): Promise<Response | undefined> {
    return this.entries.get(request.url)?.clone()
  }

  put(request: Request, response: Response): Promise<void> {
    const stored = response.text().then((body) => void this.entries.set(request.url, new Response(body, response)))

    this.pending.push(stored)

    return stored
  }

  async settled(): Promise<void> {
    await Promise.all(this.pending)
  }

  /** Every stored page's body, for a check that none a guard decides for was kept. */
  async bodies(): Promise<string[]> {
    return Promise.all([...this.entries.values()].map((response) => response.clone().text()))
  }
}

class Plan extends Context.Service<Plan, string>()('fuzz/Plan') {}

/** Words only a page some visitors may not see shows. */
const SECRET = 'secret-plan-4b7e'

function createApp(pageCache: boolean) {
  const sqlite = new Database(':memory:')
  sqlite.run('CREATE TABLE counters (id TEXT PRIMARY KEY, value INTEGER NOT NULL)')
  sqlite.run("INSERT INTO counters (id, value) VALUES ('visits', 0)")

  const db = drizzle(sqlite, { schema: { counters } })
  const app = new Hono()
  const { routes } = setupWeb(app, {
    version: '1',
    render: (page) => `<html>${JSON.stringify(page)}</html>`,
    database: () => db,
    pageCache,
  })

  // SAFETY: These tests register no database type; the client is the Drizzle client above.
  const client = <Given>(given: Given): typeof db => given as never
  const secret = (component: string) => action(render(component, { plan: SECRET }))
  // Only ada may see the team's page; anyone else is refused, signed in or not.
  const adaOnly = guard(Effect.flatMap(currentUser, (auth) => auth?.user.id === 'ada' ? Effect.void : forbidden('The team only.')))
  // A gate a guard decides by from what no request names, such as the time:
  // it admits anyone while open, so a guest's page could be stored.
  const gate = { open: true }
  const gated = guard(Effect.suspend(() => (gate.open ? Effect.void : forbidden('The gate is closed.'))))

  routes
    .get('/', action(render('Home', { title: 'Hello' })))
    .get('/counter', action(Effect.gen(function* () {
      const [row] = yield* dbQuery((given) => client(given).select().from(counters).where(eq(counters.id, 'visits')))

      return yield* render('Counter', { value: row?.value ?? 0 })
    })))
    .post('/counter', action(Effect.gen(function* () {
      const [row] = yield* dbQuery((given) => client(given).select().from(counters).where(eq(counters.id, 'visits')))

      yield* dbMutation((given) => client(given).update(counters).set({ value: (row?.value ?? 0) + 1 }).where(eq(counters.id, 'visits')))
      yield* flash('success', 'Counted.')

      return yield* redirect('/counter')
    })))
    .get('/greeting', action(Effect.flatMap(currentUser, (auth) => render('Greeting', { name: auth?.user.id ?? 'guest' }))))
    .get('/lang', action(Effect.flatMap(RequestService, (request) => render('Lang', { lang: request.header('Accept-Language') ?? 'none' }))))
    .post('/gate', action(Effect.suspend(() => {
      gate.open = !gate.open

      return redirect('/')
    })))

  routes.provide(RequireAuthLayer).get('/members', secret('Members'))
  routes.provide(adaOnly).get('/team', secret('Team'))
  routes.provide(Layer.merge(adaOnly, Layer.succeed(Plan, 'pro'))).get('/merged', secret('Merged'))
  // The gate's guard provided alone, merged with another layer, and composed with one first.
  routes.provide(gated).get('/gated', secret('Gated'))
  routes.provide(Layer.merge(gated, Layer.succeed(Plan, 'pro'))).get('/gated-merged', secret('GatedMerged'))
  routes.provide(gated.pipe(Layer.provide(Layer.succeed(Plan, 'pro')))).get('/gated-composed', secret('GatedComposed'))
  routes.prefix('/staff')
    .prefixMiddleware(async (c, next) => {
      if (!gate.open) return c.text('The gate is closed.', 403)
      await next()
    })
    .get('/staff', secret('Staff'))
  routes.prefix('/lounge')
    .prefixMiddleware(async (c, next) => {
      if (!(c.req.header('Cookie') ?? '').includes('vip=1')) return c.text('Members of the lounge only.', 403)
      await next()
    })
    .get('/lounge', secret('Lounge'))

  return app
}

const PEOPLE = { guest: undefined, vip: undefined, ada: 'ada', grace: 'grace' } as const

type Person = keyof typeof PEOPLE

/** A browser for each person, at one copy of the application, with the cookies that person's browser holds. */
function browsersFor(app: Hono): Record<Person, TestBrowser> {
  const bindings = { ENVIRONMENT: 'production', CF_VERSION_METADATA: { id: 'deploy-1' } }
  const browsers = Object.fromEntries(Object.entries(PEOPLE).map(([person, id]) => {
    const browser = testBrowser(app, id === undefined ? testEnv(bindings) : testEnv(signedIn({ id }), bindings))

    if (id !== undefined) browser.setCookie('session', id)
    if (person === 'vip') browser.setCookie('vip', '1')

    return [person, browser]
  }))

  // SAFETY: built from PEOPLE's keys, one browser each.
  return browsers as Record<Person, TestBrowser>
}

// Weighted so cookieless guests ask for the same cacheable pages often enough to be served from the cache.
const step = Arbitrary.all({
  person: weighted<Person>(['guest', 6], ['vip', 1], ['ada', 1], ['grace', 1]),
  method: weighted(['GET', 6], ['POST', 2]),
  path: weighted(
    ['/', 4], ['/greeting', 2], ['/gated', 2], ['/gated-merged', 2], ['/gated-composed', 2], ['/staff', 2], ['/gate', 2], ['/team', 1],
    ['/merged', 1], ['/members', 1], ['/lounge', 1], ['/counter', 1], ['/lang', 1], ['/?page=2', 1], ['/missing', 1]
  ),
  inertia: weighted(['', 5], ['true', 3], ['false', 1], ['TRUE', 1]),
  version: weighted(['1', 5], ['', 1], ['0', 1]),
  partial: weighted([false, 8], [true, 1]),
  accept: weighted(['', 6], ['text/html', 1], ['application/json', 1]),
  language: weighted(['', 6], ['en', 1], ['fr', 1]),
  follow: weighted([false, 3], [true, 1]),
  // Repeats the previous step's request, from this step's person: a reload, or another visitor asking for the same page.
  again: weighted([false, 1], [true, 1]),
})

type Step = typeof step extends Arbitrary.Arbitrary<infer A> ? A : never

/** The headers a step sends: each one it gives a value. */
const headersOf = (sent: Step): Headers => {
  const headers = new Headers()

  if (sent.inertia !== '') headers.set('X-Inertia', sent.inertia)
  if (sent.version !== '') headers.set('X-Inertia-Version', sent.version)
  if (sent.partial) {
    headers.set('X-Inertia-Partial-Component', 'Home')
    headers.set('X-Inertia-Partial-Data', 'title')
  }
  if (sent.accept !== '') headers.set('Accept', sent.accept)
  if (sent.language !== '') headers.set('Accept-Language', sent.language)

  return headers
}

/** What a visitor receives, without what differs by request alone: the time an error was answered, the cache's report. */
async function answerOf(res: Response): Promise<string> {
  const body = (await res.text()).replace(/"timestamp":"[^"]*"/g, '"timestamp":""')

  return show({
    status: res.status,
    location: res.headers.get('location'),
    type: res.headers.get('content-type'),
    inertia: res.headers.get('x-inertia'),
    body,
  })
}

async function send(browser: TestBrowser, sent: Step): Promise<Response> {
  const res = await browser.request(sent.path, { method: sent.method, headers: headersOf(sent) })

  return sent.follow && res.status >= 300 && res.status < 400 ? browser.follow(res) : res
}

describe('the default page cache', () => {
  property(
    'answers every request as a fresh render would, and keeps no page a guard decides for',
    Arbitrary.array(step, { minLength: 1, maxLength: 16 }),
    async (steps) => {
      const store = new MemoryCache()

      Reflect.set(globalThis, 'caches', { default: store })

      try {
        const cached = browsersFor(createApp(true))
        const fresh = browsersFor(createApp(false))

        for (const [index, given] of steps.entries()) {
          const previous = index === 0 ? undefined : steps[index - 1]
          const sent = given.again && previous !== undefined ? { ...previous, person: given.person } : given
          const served = await answerOf(await send(cached[sent.person], sent))
          await store.settled()
          const rendered = await answerOf(await send(fresh[sent.person], sent))

          if (served !== rendered) return `step ${index + 1} of ${show(steps)}: the cache answered ${served}, a fresh render ${rendered}`
        }

        const kept = (await store.bodies()).find((body) => body.includes(SECRET))

        return kept === undefined ? undefined : `kept a page only some may see: ${kept.slice(0, 120)}`
      } finally {
        Reflect.deleteProperty(globalThis, 'caches')
      }
    },
    { runs: 150 }
  )
})
