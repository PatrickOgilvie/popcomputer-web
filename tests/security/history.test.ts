/* oxlint-disable effecttsgo/async-function -- Test entrypoints drive the application through native Promise contracts. */
/**
 * What a signed-out browser keeps: Inertia stores each page's props in the
 * tab's history, and Back shows them again without asking the server. A
 * signed-in user's pages are encrypted there, with a key the tab forgets
 * when the next page after the session ends clears the history, so the next
 * person at the browser cannot page back through them.
 *
 * Precedent: Inertia 2's history encryption, which Laravel turns on with
 * `inertia.history.encrypt` and clears with `Inertia::clearHistory()` on
 * sign-out; without both, Back after sign-out re-renders the previous
 * user's page from history.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Schema as S } from 'effect'
import { testBrowser, testEnv } from '../../src/testing.js'
import { app } from '../better-auth/app.js'
import { acme, createDatabase, newOutbox, schema } from '../better-auth/fixture.js'

beforeEach(() => acme.install())
afterEach(() => acme.restore())

const inertia = { 'X-Inertia': 'true', 'X-Inertia-Version': '1' }

const form = (body: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
})

/** A member, signed in in their own browser: signed up, their address proven, and signed in. */
async function member() {
  const db = createDatabase()
  const outbox = newOutbox()
  const browser = testBrowser(app, testEnv({ OUTBOX: outbox, APP_URL: 'http://localhost' }, { database: db }))
  const credentials = { email: 'ada@example.com', password: 'correct horse battery' }

  await browser.request('/sign-up', form({ name: 'Ada Lovelace', timeZone: 'Europe/London', ...credentials }))
  await browser.request(`/verify-email?token=${outbox.verifications.at(-1)?.token}`)
  await browser.request('/sign-in', form(credentials))

  return { browser, db }
}

/** A page object's component, and how the client keeps it in its history. */
const PageHistory = S.Struct({
  component: S.String,
  encryptHistory: S.optional(S.Boolean),
  clearHistory: S.optional(S.Boolean),
})

const historyOf = async (res: Response) => S.decodeUnknownSync(PageHistory)(await res.json())

const visit = (browser: ReturnType<typeof testBrowser>, path: string) => browser.request(path, { headers: inertia })

describe("a signed-in user's pages in the browser's history", () => {
  test('are encrypted, and a guest page is not', async () => {
    const { browser } = await member()

    expect(await historyOf(await visit(browser, '/dashboard'))).toEqual({
      component: 'Dashboard',
      encryptHistory: true,
      clearHistory: undefined,
    })

    const guest = testBrowser(app, testEnv({ OUTBOX: newOutbox() }, { database: createDatabase() }))

    expect(await historyOf(await visit(guest, '/'))).toEqual({ component: 'Home' })
  })

  test('are cleared by the page signing out leads to, once, and the server refuses them after', async () => {
    const { browser } = await member()
    await visit(browser, '/dashboard')

    const signedOut = await browser.request('/sign-out', { method: 'POST', headers: inertia })

    expect(signedOut.status).toBe(303)
    expect(await historyOf(await browser.follow(signedOut))).toEqual({
      component: 'Home',
      encryptHistory: undefined,
      clearHistory: true,
    })
    expect(await historyOf(await visit(browser, '/'))).toEqual({ component: 'Home' })

    const again = await visit(browser, '/dashboard')

    expect(again.status).toBe(303)
    expect(again.headers.get('Location')).toStartWith('/sign-in')
  })

  test("are cleared after signing out through Better Auth's client, whose answer is not a page", async () => {
    const { browser } = await member()

    const signedOut = await browser.request('/api/auth/sign-out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
      body: '{}',
    })

    expect(signedOut.status).toBe(200)
    expect(await historyOf(await visit(browser, '/'))).toEqual({ component: 'Home', clearHistory: true })
  })

  test('are cleared by the first page after the session was revoked elsewhere', async () => {
    const { browser, db } = await member()
    await visit(browser, '/dashboard')
    db.delete(schema.session).run()

    expect(await historyOf(await visit(browser, '/'))).toEqual({ component: 'Home', clearHistory: true })
  })
})
