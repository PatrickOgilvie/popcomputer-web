/**
 * Requests that try to reach a guarded record by another spelling of its
 * path, or by a header that tells a framework something about the request.
 *
 * Precedents: Hono CVE-2026-29045 and CVE-2026-39407 (the router and a guard
 * decoded `%2F` and `//` differently), Nuxt CVE-2026-53721 (route rules
 * matched case-sensitively, the router did not), Next.js CVE-2025-29927
 * (`x-middleware-subrequest` skipped middleware), React Router CVE-2025-43865
 * (a client header replaced loader data), Koa CVE-2026-27959 and Fastify
 * CVE-2026-3635 (Host and X-Forwarded-Host trusted).
 */

import { describe, expect, test } from 'bun:test'
import { as, asJson, createApp } from './app'

/** Whether a response hands over Ada's private project. */
const leaks = async (res: Response) => res.status === 200 && (await res.text()).includes('Private plans')

describe('another spelling of a guarded path', () => {
  const projectPaths = [
    '/projects/p1',
    '/Projects/p1',
    '/PROJECTS/p1',
    '/projects/p1/',
    '//projects/p1',
    '/projects//p1',
    '/projects;x/p1',
    '/projects%2Fp1',
    '/%70rojects/p1',
    '/projects/./p1',
    '/projects/x/../p1',
    '/projects/%70%31',
    '/projects/p1%0A',
    '/projects/p1%00',
    '/projects/p1?project=p2',
  ]

  test('never serves an owned record to another member or a visitor', async () => {
    const { app } = createApp()
    const leaked: string[] = []

    // The record is there for its owner, so a refusal below is the guard's.
    expect(await leaks(await app.request('/projects/p1', asJson(), as('ada')))).toBe(true)

    for (const path of projectPaths) {
      for (const who of ['grace', undefined]) {
        if (await leaks(await app.request(path, asJson(), as(who)))) leaked.push(`${who ?? 'visitor'} ${path}`)
      }
    }

    expect(leaked).toEqual([])
  })

  test("never serves a guarded organization to a stranger, through the guard's prefix or around it", async () => {
    const { app } = createApp()
    const through: string[] = []

    expect((await app.request('/orgs/acme', asJson(), as('ada'))).status).toBe(200)

    for (const path of ['/orgs/acme', '/ORGS/acme', '//orgs/acme', '/orgs/acme/', '/%6Frgs/acme', '/orgs/%61cme', '/orgs;x/acme']) {
      for (const who of ['grace', undefined]) {
        const res = await app.request(path, asJson(), as(who))

        if (res.status === 200) through.push(`${who ?? 'visitor'} ${path}`)
      }
    }

    expect(through).toEqual([])
  })

  test("a child under its owner's record is never another member's, however its ids are spelled", async () => {
    const { app } = createApp()

    for (const path of ['/projects/p1/tasks/t1', '/projects/p2/tasks/t1', '/projects/p1/tasks/%74%31', '//projects/p1/tasks/t1']) {
      expect({ path, status: (await app.request(path, asJson(), as('grace'))).status }).not.toEqual({ path, status: 200 })
    }
  })
})

describe('headers a client may send about the request', () => {
  const reserved: Readonly<Record<string, string>> = {
    'X-Inertia': 'true',
    'X-Inertia-Version': 'another-version',
    'X-Inertia-Partial-Component': 'Projects/Show',
    'X-Inertia-Partial-Data': 'project',
    'X-Inertia-Partial-Except': 'nothing',
    'x-middleware-subrequest': 'middleware:middleware:middleware:middleware:middleware',
    'X-HTTP-Method-Override': 'GET',
    'X-Method-Override': 'GET',
    'X-Original-URL': '/showcase/p2',
    'X-Rewrite-URL': '/showcase/p2',
    'X-Forwarded-Host': 'evil.test',
    'X-Forwarded-Proto': 'http',
    Forwarded: 'host=evil.test',
  }

  test('none of them lets a visitor or another member load an owned record', async () => {
    const { app } = createApp()
    const leaked: string[] = []

    expect(await leaks(await app.request('/projects/p1', asJson(), as('ada')))).toBe(true)

    for (const [name, value] of Object.entries(reserved)) {
      for (const who of ['grace', undefined]) {
        if (await leaks(await app.request('/projects/p1', asJson({ headers: { [name]: value } }), as(who)))) {
          leaked.push(`${who ?? 'visitor'} ${name}`)
        }
      }
    }

    expect(leaked).toEqual([])
  })

  test('none of them makes a shared cache keep a response it would not keep', async () => {
    const { app } = createApp()
    const stored: string[] = []

    for (const [name, value] of Object.entries(reserved)) {
      const res = await app.request('/projects/p1', asJson({ headers: { [name]: value } }), as('ada'))

      if (/public/.test(res.headers.get('Cache-Control') ?? '')) stored.push(name)
    }

    expect(stored).toEqual([])
  })

  test('a method override in a header or a field changes nothing another member may not change', async () => {
    const { app, row } = createApp()
    const before = row('p1')

    // A real PUT by another member changes nothing either.
    expect((await app.request('/projects/p1', asJson({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Taken' }) }), as('grace'))).status).toBe(404)

    const overrides: ReadonlyArray<RequestInit> = [
      { method: 'POST', headers: { 'X-HTTP-Method-Override': 'PUT', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Taken' }) },
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '_method=PUT&name=Taken' },
    ]

    for (const init of overrides) {
      await app.request('/projects/p1', asJson(init), as('grace'))
    }

    expect(row('p1')).toEqual(before)
  })

  test('a redirect never names the host a header gives', async () => {
    const { app } = createApp()

    const forwarded: ReadonlyArray<Record<string, string>> = [{ 'X-Forwarded-Host': 'evil.test' }, { Forwarded: 'host=evil.test' }, { 'X-Original-URL': '//evil.test/' }]

    for (const headers of forwarded) {
      const res = await app.request('/home', { headers }, as('ada'))

      expect(res.headers.get('Location') ?? '').not.toContain('evil.test')
    }
  })
})
