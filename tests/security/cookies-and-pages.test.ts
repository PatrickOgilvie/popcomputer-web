/**
 * Values the browser keeps and gives back: a signed cookie moved to another
 * name or changed, and page data written into the HTML a visitor's browser
 * parses.
 *
 * Precedents: Laravel GHSA-2ffv-r4r9-r8xr (a cookie's value was valid under
 * another cookie's name), Django CVE-2026-6873 (signing salts collided),
 * Laravel CVE-2018-15133 (a cookie decoded into objects), Inertia PR #3253
 * and inertia-laravel PR #911 (`<!--<script>` in page JSON swallowed the
 * page), SvelteKit CVE-2025-32388 (`</script>` broke out of the boot script).
 */

import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { Effect, Option, Schema as S } from 'effect'
import { action } from '../../src/effect/action.js'
import { cookie } from '../../src/effect/cookies.js'
import { json } from '../../src/effect/responses.js'
import { createTemplate } from '../../src/helpers.js'
import { setupWeb } from '../../src/setup.js'
import type { PageObject } from '../../src/types.js'

describe('a signed cookie', () => {
  const role = cookie('role', S.Literals(['member', 'admin']), { signed: { secret: 'COOKIE_SECRET' } })
  const theme = cookie('theme', S.Literals(['member', 'admin']), { signed: { secret: 'COOKIE_SECRET' } })

  const createApp = () => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

    routes
      .post('/set', action(Effect.andThen(theme.set('admin'), json({ ok: true }))))
      .get('/role', action(Effect.flatMap(role.read, (value) => json({ role: Option.getOrNull(value) }))))

    return app
  }
  const env = { COOKIE_SECRET: 'a-secret-long-enough-to-sign-with-0123456789' }

  test('signed under one name is no value under another', async () => {
    const app = createApp()
    const set = await app.request('/set', { method: 'POST' }, env)
    const signed = /theme=([^;]+)/.exec(set.headers.get('Set-Cookie') ?? '')?.[1] ?? ''

    expect(signed).toContain('.')

    const read = await app.request('/role', { headers: { Cookie: `role=${signed}` } }, env)

    expect(await read.json()).toEqual({ role: null })
  })

  test('changed, or with its signature stripped, is no value', async () => {
    const app = createApp()

    for (const value of ['admin', 'admin.', 'admin.forged', '"admin"', 'admin.' + 'A'.repeat(43)]) {
      const read = await app.request('/role', { headers: { Cookie: `role=${encodeURIComponent(value)}` } }, env)

      expect({ value, read: await read.json() }).toEqual({ value, read: { role: null } })
    }
  })
})

describe('page data in the HTML', () => {
  const template = createTemplate({ title: 'App' })
  const pageWith = (props: PageObject['props']): PageObject => ({ component: 'Home', props, url: '/', version: '1' })
  const payloads = [
    '</script><script>alert(1)</script>',
    '<!--<script>',
    '</SCRIPT><img src=x onerror=alert(1)>',
    '\u2028\u2029',
    '"><img src=x onerror=alert(1)>',
    "'; alert(1); //",
    '<![CDATA[',
  ]

  test('reads back exactly, so no prop closes or comments out the script it is in', () => {
    for (const payload of payloads) {
      const html = template(pageWith({ note: payload, [payload]: payload }))
      const data = /<script data-page="app" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1]

      expect({ payload, read: data === undefined ? undefined : (JSON.parse(data) as PageObject).props }).toEqual({ payload, read: { note: payload, [payload]: payload } })
    }
  })

  test('adds no element: the page has the one script and no other', () => {
    for (const payload of payloads) {
      const html = template(pageWith({ note: payload }))

      expect({ payload, scripts: html.match(/<script\b/gi)?.length, images: html.match(/<img\b/gi)?.length ?? 0 })
        .toEqual({ payload, scripts: template(pageWith({ note: 'plain' })).match(/<script\b/gi)?.length, images: 0 })
    }
  })
})
