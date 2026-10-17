/**
 * Request input that tries to set what the form does not declare, to reach
 * Object.prototype, or to swap the record the path names for another.
 *
 * Precedents: Laravel CVE-2020-24941 (`foo->bar` keys set a guarded JSON
 * column) and GHSA-44pg-c29v-hp6r (`users.name` stripped to `name`), Rails
 * CVE-2020-8164 (permitted params returned unfiltered), TypeORM
 * CVE-2025-60542 (`city[role]=admin` set a column), qs CVE-2022-24999 and
 * Hono CVE-2026-56763 (`__proto__` keys in parsed bodies), Fastify
 * CVE-2026-84504 (a body key replaced the validated body), Next.js
 * CVE-2026-44574 (a query parameter changed the param the page received).
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { as, asJson, createApp } from './app'

const polluted = () => Reflect.get({}, 'polluted') !== undefined || Reflect.get(Object.prototype, 'polluted') !== undefined

afterEach(() => {
  Reflect.deleteProperty(Object.prototype, 'polluted')
})

describe('fields the form does not declare', () => {
  test("never set a record's owner, id or visibility, however the key is spelled", async () => {
    const { app, sqlite } = createApp()
    const bodies = [
      JSON.stringify({ name: 'Mine', userId: 'grace', id: 'p1', visibility: 'public' }),
      JSON.stringify({ name: 'Mine', 'projects.userId': 'grace', user_id: 'grace', 'userId->x': 'grace', 'visibility[]': 'public' }),
      JSON.stringify({ name: 'Mine', project: { userId: 'grace' }, data: { userId: 'grace' }, value: { name: 'Swapped' } }),
    ]

    for (const body of bodies) {
      const res = await app.request('/projects', asJson({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), as('ada'))
      const { id } = await res.json() as { id: string }

      expect(sqlite.query('SELECT user_id, visibility, name FROM projects WHERE id = ?').get(id)).toEqual({ user_id: 'ada', visibility: 'private', name: 'Mine' })
    }

    expect(sqlite.query("SELECT name FROM projects WHERE id = 'p1'").get()).toEqual({ name: 'Private plans' })
  })

  test('an array or an object where the form takes a string is refused', async () => {
    const { app } = createApp()

    for (const name of [['Mine', 'Yours'], { toString: 'Mine' }, 42, true, null]) {
      const res = await app.request('/projects', asJson({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }), as('ada'))

      expect({ name, status: res.status }).toEqual({ name, status: 422 })
    }
  })
})

describe('keys that name the prototype', () => {
  test('never reach Object.prototype from JSON, a form, multipart or the query', async () => {
    const { app } = createApp()
    const form = new FormData()
    form.append('name', 'Mine')
    form.append('__proto__[polluted]', 'yes')
    form.append('constructor[prototype][polluted]', 'yes')

    const requests: ReadonlyArray<readonly [string, RequestInit]> = [
      ['/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Mine","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}' }],
      ['/projects', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=Mine&__proto__[polluted]=yes&__proto__.polluted=yes&constructor[prototype][polluted]=yes' }],
      ['/projects', { method: 'POST', body: form }],
      ['/projects?__proto__[polluted]=yes&constructor[prototype][polluted]=yes&__proto__.polluted=yes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Mine"}' }],
    ]

    for (const [path, init] of requests) {
      await app.request(path, asJson(init), as('ada'))

      expect({ path, polluted: polluted() }).toEqual({ path, polluted: false })
    }
  })
})

describe('the record the path names', () => {
  test('is not swapped by a body or query value of the same name', async () => {
    const { app, row } = createApp()
    const before = row('p2')

    for (const [path, body] of [
      ['/projects/p1', { name: 'Renamed', project: 'p2' }],
      ['/projects/p1?project=p2', { name: 'Renamed' }],
      ['/projects/p1?project=p2&project=p1', { name: 'Renamed' }],
    ] as const) {
      await app.request(path, asJson({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), as('ada'))
    }

    expect(row('p2')).toEqual(before)
  })
})
