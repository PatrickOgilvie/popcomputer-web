/**
 * Responses kept for others: a shared cache that stores what one visitor's
 * request produced, and requests running at once in one isolate that see
 * each other's user or record.
 *
 * Precedents: Nuxt CVE-2026-71316 (payloads cached by path alone, served
 * before middleware), Next.js CVE-2025-49005 and CVE-2025-57752 (variants
 * cached under one key), Django CVE-2026-48588 and CVE-2026-35193 (a
 * response that set a cookie, or varied on Authorization, was cached), Hono
 * CVE-2026-44457 (Vary: Cookie ignored), this framework's own 1.3.0 (a
 * response an API key in its own header signed in was stored publicly),
 * Hono CVE-2023-50710 (concurrent requests shared route params), Effect
 * CVE-2026-32887 and hono/jsx CVE-2026-59896 (request context read across
 * an await).
 */

import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { Effect, Option, Schema as S } from 'effect'
import { action } from '../../src/effect/action.js'
import { bound, routeBinding } from '../../src/effect/binding.js'
import { cookie } from '../../src/effect/cookies.js'
import { json } from '../../src/effect/responses.js'
import { setupWeb } from '../../src/setup.js'
import { as, asJson, createApp, projects, user } from './app'

const stored = (res: Response) => /public/.test(res.headers.get('Cache-Control') ?? '') || /public/.test(res.headers.get('Cloudflare-CDN-Cache-Control') ?? '')

describe('a cached route', () => {
  test("is kept for a visitor's request, and varies on the Inertia variant and cookies", async () => {
    const { app } = createApp()
    const res = await app.request('/showcase/p2', asJson(), as())

    expect(stored(res)).toBe(true)
    expect(res.headers.get('Vary')).toContain('Cookie')
    expect(res.headers.get('Vary')).toContain('X-Inertia')
  })

  test('keeps nothing a signed-in, authorized, partial or failed request produced', async () => {
    const { app } = createApp()
    const kept: string[] = []

    const requests: ReadonlyArray<readonly [string, string, RequestInit, ReturnType<typeof as>]> = [
      ['signed in', '/showcase/p2', asJson(), as('ada')],
      ['Authorization', '/showcase/p2', asJson({ headers: { Authorization: 'Bearer key' } }), as()],
      ['partial reload', '/showcase/p2', asJson({ headers: { 'X-Inertia': 'true', 'X-Inertia-Partial-Data': 'project', 'X-Inertia-Partial-Component': 'Showcase' } }), as()],
      ['not found', '/showcase/p1', asJson(), as()],
      ['written to', '/showcase/p2', asJson({ method: 'POST' }), as()],
    ]

    for (const [name, path, init, env] of requests) {
      if (stored(await app.request(path, init, env))) kept.push(name)
    }

    expect(kept).toEqual([])
  })

  test('keeps nothing whose producing read a header, a cookie or request state', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })
    const theme = cookie('theme', S.String)

    routes.get('/themed', action(Effect.flatMap(theme.read, (value) => json({ theme: Option.getOrNull(value) }))), { cache: { maxAge: 60 } })

    const res = await app.request('/themed', { headers: { Cookie: 'theme=dark' } })

    expect(stored(res)).toBe(false)
  })

  test('cannot be registered on a route whose record depends on the visitor', () => {
    const { routes } = setupWeb(new Hono(), {
      version: '1',
      render: (page) => JSON.stringify(page),
      schema: { user, projects },
      bindings: { project: routeBinding(projects, { ownedBy: 'userId' }), showcase: routeBinding(projects, { publicWhen: { visibility: 'public' } }) },
    })

    expect(() => routes.get('/p/{project}', action(Effect.flatMap(bound('project'), (project) => json(project))), { cache: { maxAge: 60 } }))
      .toThrow('depends on the visitor')
    expect(() => routes.get('/s/{showcase}', action(Effect.flatMap(bound('showcase'), (project) => json(project))), { cache: { maxAge: 60 } }))
      .not.toThrow()
  })
})

describe('requests at once in one isolate', () => {
  test('each sees only its own user and its own record, across awaits', async () => {
    const { app } = createApp()
    const runs = Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? 'ada' : 'grace'))

    const answers = await Promise.all(runs.map(async (viewer) => {
      const res = await app.request('/slow/p1', asJson(), as(viewer))

      return { viewer, status: res.status, body: res.status === 200 ? await res.json() : undefined }
    }))

    for (const answer of answers) {
      expect(answer).toEqual(answer.viewer === 'ada'
        ? { viewer: 'ada', status: 200, body: { viewer: 'ada', owner: 'ada' } }
        : { viewer: 'grace', status: 404, body: undefined })
    }
  })
})
