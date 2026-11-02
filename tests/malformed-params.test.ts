/**
 * A path parameter its binding's column cannot hold names no record: the
 * framework's 404 answers it, the page or the JSON envelope, before any
 * guard or the action runs, on any stack.
 */

import { describe, expect, test } from 'bun:test'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { setupWeb } from '../src/setup.js'
import { effectRoutes } from '../src/effect/routing.js'
import { routeBinding } from '../src/effect/binding.js'

const projects = sqliteTable('projects', { id: integer('id').primaryKey(), name: text('name').notNull() })
const schema = { projects }
const bindings = { project: routeBinding(projects, { public: true }) }

describe('a malformed path parameter', () => {
  test("on a stack composed by hand, answers the framework's 404, not Hono's plain one, and runs no action", async () => {
    const app = new Hono()
    let ran = false

    effectRoutes(app, { schema, bindings }).get('/projects/{project}', Effect.sync(() => {
      ran = true

      return new Response('found')
    }))

    const res = await app.request('/projects/not-a-number', { headers: { Accept: 'application/json' } })

    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toContain('application/json')
    expect(await res.json()).toMatchObject({ code: expect.stringContaining('NOT_FOUND') })
    expect(ran).toBe(false)
  })

  test("in setupWeb, answers the same 404 page as a path no route answers", async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page), schema, bindings })
    routes.get('/projects/{project}', Effect.succeed(new Response('found')))

    const inertia = { headers: { 'X-Inertia': 'true', 'X-Inertia-Version': '1' } }
    const malformed = await app.request('/projects/not-a-number', inertia)
    const missing = await app.request('/nowhere', inertia)

    // The page each answers, but for its url.
    const ErrorPage = S.Struct({ component: S.String, props: S.Record(S.String, S.Unknown) })
    const pageOf = async (res: Response) => S.decodeUnknownSync(ErrorPage)(await res.json())

    expect(malformed.status).toBe(404)
    expect(await pageOf(malformed)).toEqual(await pageOf(missing))
  })
})
