/**
 * The Worker tests/page-cache-workerd.test.ts runs in workerd: one
 * application with the sign-in limits on D1, one that builds its database
 * from a Hyperdrive binding and one with neither, chosen by the request's
 * `X-App` header. The bindings are Cloudflare's own, which differ from any
 * double in the way a page's cache turns on: they are class instances.
 */

import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Effect } from 'effect'
import { Hono, type ExecutionContext } from 'hono'
import { action } from '../../src/effect/action.js'
import { betterAuthHandler } from '../../src/effect/auth.js'
import { dbQuery } from '../../src/effect/database.js'
import { render } from '../../src/effect/responses.js'
import { BindingsService } from '../../src/effect/services.js'
import { setupWeb } from '../../src/setup.js'

interface Bindings {
  readonly ENVIRONMENT: string
  readonly DB: Parameters<typeof drizzle>[0]
  readonly KV: { get(key: string): Promise<string | null> }
  readonly HYPERDRIVE: { readonly connectionString: string }
  readonly SIGN_IN_LIMITER: { limit(options: { readonly key: string }): Promise<{ readonly success: boolean }> }
  readonly RPC: { greeting(): Promise<string> }
}

const rateLimit = sqliteTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: integer('last_request').notNull(),
})

const auth = betterAuth({
  database: memoryAdapter({ user: [], session: [], account: [], verification: [], rateLimit: [] }),
  baseURL: 'http://app.test',
  secret: 'page-cache-workerd-test-secret-with-enough-entropy-0123',
  emailAndPassword: { enabled: true },
  rateLimit: { enabled: true, storage: 'memory' },
  logger: { disabled: true },
})

// SAFETY: Miniflare gives this Worker these bindings, which no registration declares here.
const bindings = BindingsService as unknown as Effect.Effect<Bindings>

const pages = [
  ['/about', action(render('About'))],
  ['/looks', action(Effect.flatMap(bindings, (env) => render('Looks', { canLimit: env.SIGN_IN_LIMITER.limit instanceof Function, canRead: typeof env.KV.get })))],
  ['/limited', action(Effect.flatMap(bindings, (env) => Effect.flatMap(Effect.promise(() => env.SIGN_IN_LIMITER.limit({ key: 'page' })), (outcome) => render('Limited', outcome))))],
  ['/kv', action(Effect.flatMap(bindings, (env) => Effect.flatMap(Effect.promise(() => env.KV.get('greeting')), (greeting) => render('Stored', { greeting }))))],
  ['/rpc', action(Effect.flatMap(bindings, (env) => Effect.flatMap(Effect.promise(() => env.RPC.greeting()), (greeting) => render('Remote', { greeting }))))],
] as const

const renderHtml = (page: unknown) => `<html>${JSON.stringify(page)}</html>`

function limitsApp(): Hono {
  const app = new Hono<{ Bindings: Bindings }>()
  const { routes } = setupWeb(app, {
    version: 'limits',
    render: renderHtml,
    database: (c) => drizzle(c.env.DB),
    auth: { client: () => auth, signInLimits: { limiter: 'SIGN_IN_LIMITER', table: rateLimit } },
  })

  for (const [path, page] of pages) routes.get(path, page)
  // SAFETY: this application's database is Drizzle's on D1, which no registration declares here.
  const selectOne = dbQuery((db) => (db as unknown as ReturnType<typeof drizzle>).all<{ readonly one: number }>(sql`select 1 as one`))

  routes.get('/d1', action(Effect.flatMap(selectOne, (rows) => render('Rows', { rows: [...rows] }))))
  routes.all('/api/auth/*', betterAuthHandler({ settable: [] }))

  return app as unknown as Hono
}

function hyperdriveApp(): Hono {
  const app = new Hono<{ Bindings: Bindings }>()
  const { routes } = setupWeb(app, {
    version: 'hyperdrive',
    render: renderHtml,
    database: (c) => ({ url: c.env.HYPERDRIVE.connectionString }),
  })

  for (const [path, page] of pages) routes.get(path, page)

  return app as unknown as Hono
}

function plainApp(): Hono {
  const app = new Hono<{ Bindings: Bindings }>()
  const { routes } = setupWeb(app, { version: 'plain', render: renderHtml })

  for (const [path, page] of pages) routes.get(path, page)

  return app as unknown as Hono
}

const apps: Record<string, Hono> = { limits: limitsApp(), hyperdrive: hyperdriveApp(), plain: plainApp() }

export default {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    return (apps[request.headers.get('X-App') ?? 'plain'] ?? apps.plain).fetch(request, env, ctx)
  },
}
