/**
 * Writes another site's page makes with the visitor's cookies: every body
 * type a page can send without a preflight, the odd spellings parsers
 * disagree about, `Origin: null`, and every method that changes something.
 *
 * Precedents: Hono CVE-2024-48913 and CVE-2024-43787 (no Content-Type, and
 * a case-sensitive one, passed its CSRF check), FastAPI CVE-2021-32677 (JSON
 * read from text/plain), SvelteKit CVE-2023-29003 and CVE-2023-29008
 * (text/plain, then text/plaiN), Next.js CVE-2026-27978 (`Origin: null`
 * treated as no Origin), React Router CVE-2026-53663 (PUT, PATCH and DELETE
 * unchecked).
 */

import { describe, expect, test } from 'bun:test'
import { as, createApp } from './app'

const crossSite = ['https://evil.test', 'null', 'http://localhost.evil.test', 'https://localhost']
const types = [
  undefined,
  'application/x-www-form-urlencoded',
  'APPLICATION/X-WWW-FORM-URLENCODED',
  'multipart/form-data; boundary=x',
  'text/plain',
  'text/plaiN',
  'application/json',
  ' application/json',
  'application/json\tx',
]

describe('a write from another site', () => {
  test('is refused for every body type and spelling, and writes nothing', async () => {
    const { app, sqlite } = createApp()
    const count = () => sqlite.query('SELECT count(*) AS n FROM projects').get()
    const before = count()
    const accepted: string[] = []

    for (const origin of crossSite) {
      for (const type of types) {
        const headers: Record<string, string> = { Origin: origin }
        if (type !== undefined) headers['Content-Type'] = type

        const res = await app.request('/projects', { method: 'POST', headers, body: type?.toLowerCase().includes('json') ? '{"name":"Planted"}' : 'name=Planted' }, as('ada'))

        if (res.status !== 403) accepted.push(`${origin} ${type ?? '(none)'} ${res.status}`)
      }
    }

    expect(accepted).toEqual([])
    expect(count()).toEqual(before)
  })

  test('is refused for every method that changes something, before its route is looked up', async () => {
    const { app } = createApp()

    // Lowercase as a client may send them: the Fetch standard uppercases all but PATCH.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'put', 'patch', 'delete']) {
      const res = await app.request('/projects/p1', { method, headers: { Origin: 'https://evil.test' } }, as('ada'))

      expect({ method, status: res.status }).toEqual({ method, status: 403 })
    }
  })

  test("is refused when only its Referer names the other site", async () => {
    const { app } = createApp()
    const res = await app.request('/projects', {
      method: 'POST',
      headers: { Referer: 'https://evil.test/form', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'name=Planted',
    }, as('ada'))

    expect(res.status).toBe(403)
  })

  test('from the application itself goes through', async () => {
    const { app } = createApp()
    const res = await app.request('http://localhost/projects', {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{"name":"Mine"}',
    }, as('ada'))

    expect(res.status).toBe(200)
  })
})
