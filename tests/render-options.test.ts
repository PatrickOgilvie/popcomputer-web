/* oxlint-disable effecttsgo/async-function -- Test entrypoints call app.request, a native Promise contract. */
/**
 * `render` without a page registry: a page answers with the status its
 * action gives, takes props of any declared shape, interfaces included,
 * whose values JSON carries, and says how the client keeps it in history.
 */

import { describe, expect, test } from 'bun:test'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { render } from '../src/effect/responses.js'
import { signedIn, testEnv } from '../src/testing.js'
import type { HistoryConfig } from '../src/types.js'

/** A clause of a contract, as a domain model declares it: an interface, recursive. */
interface Clause {
  readonly heading: string
  readonly signedAt: Date | null
  readonly clauses: ReadonlyArray<Clause>
}

const contract: Clause = {
  heading: 'Agreement',
  signedAt: new Date(Date.UTC(2026, 9, 14)),
  clauses: [{ heading: 'Term', signedAt: null, clauses: [] }],
}

function createApp() {
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => `<html>${JSON.stringify(page)}</html>` })

  routes
    .get('/signing/unknown', action(render('Signing/LinkInvalid', {}, { status: 404 })))
    .get('/contract', action(render('Contracts/Show', { contract })))

  return app
}

describe('a page rendered with a status', () => {
  test('answers a visit with that status', async () => {
    const res = await createApp().request('/signing/unknown')

    expect(res.status).toBe(404)
    expect(await res.text()).toContain('"component":"Signing/LinkInvalid"')
  })

  test('answers an Inertia visit with that status and the page object', async () => {
    const res = await createApp().request('/signing/unknown', { headers: { 'X-Inertia': 'true', 'X-Inertia-Version': '1' } })

    expect(res.status).toBe(404)
    expect((await res.json()).component).toBe('Signing/LinkInvalid')
  })
})

test('a page takes props an interface declares, and answers 200 unless given a status', async () => {
  const res = await createApp().request('/contract', { headers: { 'X-Inertia': 'true', 'X-Inertia-Version': '1' } })

  expect(res.status).toBe(200)
  expect((await res.json()).props.contract).toEqual({
    heading: 'Agreement',
    signedAt: '2026-10-14T00:00:00.000Z',
    clauses: [{ heading: 'Term', signedAt: null, clauses: [] }],
  })
})

describe("a page's history", () => {
  const inertia = { headers: { 'X-Inertia': 'true', 'X-Inertia-Version': '1' } }

  const historyApp = (history?: HistoryConfig) => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page), history })

    routes
      .get('/account', action(render('Account/Show')))
      .get('/recovery', action(render('Account/Recovery', {}, { encryptHistory: true, clearHistory: true })))
      .get('/public', action(render('Public/Show', {}, { encryptHistory: false })))

    return app
  }

  const PageHistory = S.Struct({ encryptHistory: S.optional(S.Boolean), clearHistory: S.optional(S.Boolean) })
  const member = () => testEnv(signedIn({ id: 'user-1' }))

  const historyOf = async (app: Hono, path: string, env?: ReturnType<typeof member>) =>
    S.decodeUnknownSync(PageHistory)(await (await app.request(path, inertia, env)).json())

  test('is encrypted for a signed-in request, and not for a guest, unless setupWeb says otherwise', async () => {
    expect(await historyOf(historyApp(), '/account', member())).toEqual({ encryptHistory: true, clearHistory: undefined })
    expect(await historyOf(historyApp(), '/account')).toEqual({ encryptHistory: undefined, clearHistory: undefined })
    expect(await historyOf(historyApp({ encrypt: true }), '/account')).toEqual({ encryptHistory: true, clearHistory: undefined })
    expect(await historyOf(historyApp({ encrypt: false }), '/account', member())).toEqual({ encryptHistory: undefined, clearHistory: undefined })
  })

  test("follows render's own options over the default", async () => {
    expect(await historyOf(historyApp({ encrypt: false }), '/recovery')).toEqual({ encryptHistory: true, clearHistory: true })
    expect(await historyOf(historyApp(), '/public', member())).toEqual({ encryptHistory: false, clearHistory: undefined })
  })

  test('is in the HTML document of a first visit too', async () => {
    const res = await historyApp().request('/account', {}, member())

    expect(await res.text()).toContain('"encryptHistory":true')
  })
})

// Checked by `bun run test:types`, never run: without a registry, props take what JSON carries, and a status is a response's.
export function renderTakesJsonShapedProps() {
  render('Contracts/Show', { contract })
  // @ts-expect-error a function is not a value JSON carries
  render('Contracts/Show', { onSign: () => undefined })
  // @ts-expect-error a nested function neither
  render('Contracts/Show', { contract: { heading: 'Agreement', format: (date: Date) => date.toISOString() } })
  // @ts-expect-error a status is a number a response can carry
  render('Signing/LinkInvalid', {}, { status: 'missing' })
  render('Account/Recovery', {}, { encryptHistory: true, clearHistory: true })
  // @ts-expect-error history options are booleans
  render('Account/Recovery', {}, { encryptHistory: 'yes' })

  return Effect.void
}
