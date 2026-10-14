/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * The seam between the framework and Better Auth, driven through an
 * application written as the README says: every documented call, and the
 * plugins applications reach for. These tests gate every Better Auth upgrade:
 * the peer range names only versions they passed against.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSchema } from 'better-auth/db'
import { eq } from 'drizzle-orm'
import { Redacted, Schema as S } from 'effect'
import { testBrowser, testEnv } from '../../src/testing.js'
import { betterAuthSession } from '../../src/auth.js'
import { tableSchema } from '../../src/schema.js'
import { acme, createAuth, createDatabase, newOutbox, schema, type CreateAuthOptions } from './fixture.js'
import { app } from './app.js'

const repoRoot = join(import.meta.dir, '..', '..')

beforeEach(() => acme.install())
afterEach(() => acme.restore())
const SESSION = 'better-auth.session_token'

function setup(session?: CreateAuthOptions['session']) {
  const db = createDatabase()
  const outbox = newOutbox()
  const env = testEnv({ OUTBOX: outbox, SESSION: session }, { database: db })

  return { db, outbox, env, browser: () => testBrowser(app, env) }
}

type Browser = ReturnType<ReturnType<typeof setup>['browser']>

const form = (body: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
})

const signUp = (browser: Browser, email: string, name = 'Ada Lovelace') =>
  browser.request('/sign-up', form({ name, email, password: 'correct horse battery', timeZone: 'Europe/London' }))

const signIn = (browser: Browser, email: string, password = 'correct horse battery') =>
  browser.request('/sign-in', form({ email, password }))

const me = async (browser: Browser) => {
  const res = await browser.request('/me', { headers: { Accept: 'application/json' } })

  return { status: res.status, body: res.status === 200 ? await res.json() : undefined, res }
}

const setsSession = (res: Response) =>
  res.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION}=`) && !/max-age=0/i.test(cookie))

describe('the Better Auth version', () => {
  test('the installed Better Auth is within the peer range these tests gate', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    const installed = JSON.parse(readFileSync(join(repoRoot, 'node_modules', 'better-auth', 'package.json'), 'utf8')).version

    expect(manifest.devDependencies['better-auth']).toBe(installed)
    expect(Bun.semver.satisfies(installed, manifest.peerDependencies['better-auth'])).toBe(true)
  })
})

describe('tables', () => {
  test("the fixture's tables have every column the plugins' configuration needs", () => {
    const auth = createAuth({ db: createDatabase(), outbox: newOutbox() })
    const needed = getSchema(auth.options)
    const missing: string[] = []

    for (const [model, { fields }] of Object.entries(needed)) {
      const table = Reflect.get(schema, model)
      if (table === undefined) {
        missing.push(model)
        continue
      }

      for (const field of Object.keys(fields)) {
        if (!(field in table)) missing.push(`${model}.${field}`)
      }
    }

    expect(missing).toEqual([])
  })
})

describe('signing up, in and out', () => {
  test('a form signs a visitor up and in, and the session loads on the next request', async () => {
    const { browser } = setup()
    const visitor = browser()

    const res = await signUp(visitor, 'ada@example.com')

    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/dashboard')
    expect(setsSession(res)).toBe(true)
    expect((await me(visitor)).body).toMatchObject({ email: 'ada@example.com', timeZone: 'Europe/London', activeOrganizationId: null })
  })

  test("Better Auth's API refuses the user fields the application lets visitors set only on its own forms", async () => {
    const { browser } = setup()
    const api = (path: string, body: object, client = browser()) =>
      client.request(`/api/auth${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
        body: JSON.stringify(body),
      })

    const signedUp = await api('/sign-up/email', { name: 'Eve', email: 'eve@example.com', password: 'correct horse battery', timeZone: 'Mars/Olympus' })

    expect(signedUp.status).toBe(400)
    expect((await signedUp.json()).message).toContain('timeZone')

    const member = browser()
    await signUp(member, 'ada@example.com')
    const updated = await api('/update-user', { timeZone: 'Mars/Olympus' }, member)

    expect(updated.status).toBe(400)
    expect((await me(member)).body).toMatchObject({ timeZone: 'Europe/London' })
    expect((await api('/update-user', { name: 'Ada King' }, member)).status).toBe(200)
  })

  test("a wrong password is refused with Better Auth's message on the email field", async () => {
    const { browser } = setup()
    await signUp(browser(), 'ada@example.com')
    const visitor = browser()

    const res = await visitor.request('/sign-in', {
      ...form({ email: 'ada@example.com', password: 'wrong password' }),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: 'ada@example.com', password: 'wrong password' }),
    })

    expect(res.status).toBe(422)
    expect((await res.json()).errors).toEqual({ email: 'Invalid email or password' })
  })

  test('signing out ends the session in the database and in the browser', async () => {
    const { browser, db } = setup()
    const visitor = browser()
    await signUp(visitor, 'ada@example.com')

    const res = await visitor.request('/sign-out', { method: 'POST' })

    expect(res.status).toBe(303)
    expect(visitor.cookies.has(SESSION)).toBe(false)
    expect(db.select().from(schema.session).all()).toEqual([])
    expect((await me(visitor)).status).toBe(401)
  })

  test('signing out of a Better Auth loaded on first use ends the session in the database too', async () => {
    const { db, outbox, browser } = setup()
    const visitor = browser()
    await signUp(visitor, 'ada@example.com')
    const lazily = testBrowser(app, testEnv({ OUTBOX: outbox, LAZY: true }, { database: db }))
    lazily.setCookie(SESSION, visitor.cookies.get(SESSION) ?? '')

    const res = await lazily.request('/sign-out', { method: 'POST' })

    expect(res.status).toBe(303)
    // Better Auth's own cookie, which only its sign-out sends.
    expect(res.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION}=`) && /max-age=0/i.test(cookie))).toBe(true)
    expect(db.select().from(schema.session).all()).toEqual([])
  })

  test('a Better Auth loaded on first use says why an endpoint called by name cannot be sent', async () => {
    const lazily = testBrowser(app, testEnv({ OUTBOX: newOutbox(), LAZY: true }, { database: createDatabase() }))

    const res = await signUp(lazily, 'ada@example.com')

    expect(res.status).toBe(500)
    expect(await res.text()).toContain('auth.api.signUpEmail has no path')
  })

  test('a session Better Auth extends sends the browser its renewed cookie', async () => {
    // updateAge 0: every request extends the session, as one a day apart does.
    const { browser } = setup({ updateAge: 0 })
    const visitor = browser()
    await signUp(visitor, 'ada@example.com')

    const { res } = await me(visitor)

    expect(res.status).toBe(200)
    expect(setsSession(res)).toBe(true)
  })

  test('a session revoked elsewhere is signed out, and its cookie cleared', async () => {
    const { browser, db } = setup()
    const visitor = browser()
    await signUp(visitor, 'ada@example.com')
    db.delete(schema.session).run()

    const { status } = await me(visitor)

    expect(status).toBe(401)
    expect(visitor.cookies.has(SESSION)).toBe(false)
  })
})

describe('two-factor', () => {
  test('a member with two-factor on is asked for a code, which signs them in', async () => {
    const { browser } = setup()
    const member = browser()
    await signUp(member, 'ada@example.com')
    const enrolled = await member.request('/two-factor/enable', form({ password: 'correct horse battery' }))
    const { backupCodes } = await enrolled.json()
    await member.request('/sign-out', { method: 'POST' })

    const visitor = browser()
    const asked = await signIn(visitor, 'ada@example.com')

    expect(asked.headers.get('Location')).toBe('/two-factor')
    expect(setsSession(asked)).toBe(false)
    expect((await me(visitor)).status).toBe(401)

    const verified = await visitor.request('/two-factor', form({ code: backupCodes[0] }))

    expect(verified.headers.get('Location')).toBe('/dashboard')
    expect((await me(visitor)).body).toMatchObject({ email: 'ada@example.com' })
  })
})

describe('magic links', () => {
  test('a link signs the visitor in once, and a used link shows that it expired', async () => {
    const { browser, outbox } = setup()
    const visitor = browser()

    await visitor.request('/magic-link', form({ email: 'grace@example.com' }))
    const [link] = outbox.magicLinks

    const first = await visitor.request(`/magic-link/verify?token=${link?.token}`)

    expect(first.status).toBe(303)
    expect(first.headers.get('Location')).toBe('/dashboard')
    expect((await me(visitor)).body).toMatchObject({ email: 'grace@example.com' })

    const again = browser()
    const reused = await again.request(`/magic-link/verify?token=${link?.token}`, { headers: { 'X-Inertia': 'true', 'X-Inertia-Version': '1' } })

    expect(reused.status).toBe(200)
    expect(await reused.json()).toMatchObject({ component: 'Auth/LinkExpired' })
    expect(again.cookies.has(SESSION)).toBe(false)
  })
})

describe('signing in with another provider', () => {
  test('an Inertia visit is sent to the provider as Inertia asks for another site', async () => {
    const { browser } = setup()

    const res = await browser().request('/sign-in/acme', { method: 'POST', headers: { 'X-Inertia': 'true', 'X-Inertia-Version': '1' } })

    expect(res.status).toBe(409)
    expect(res.headers.get('X-Inertia-Location')).toStartWith('https://acme.example/authorize')
  })

  test("the provider's callback signs the visitor in, and their first visit makes the application's own record", async () => {
    const { browser, db } = setup()
    const visitor = browser()

    const started = await visitor.request('/sign-in/acme', { method: 'POST' })

    expect(started.status).toBe(303)

    // The provider refuses the code unless the exchange carries the client's secret and PKCE verifier.
    const callback = await visitor.request(acme.callback(acme.authorization(started), { id: 'acme-1', email: 'grace@acme.example', name: 'Grace Hopper' }))

    expect(callback.headers.get('Location')).toBe('/dashboard')
    expect((await me(visitor)).body).toMatchObject({ email: 'grace@acme.example' })
    expect(db.select().from(schema.profile).all()).toMatchObject([{ displayName: 'Grace Hopper' }])

    await me(visitor)
    expect(db.select().from(schema.profile).all()).toHaveLength(1)
  })
})

describe('decoding the session', () => {
  test("a nullable field Better Auth left unset decodes as null, as its memory adapter and stateless sessions leave it", async () => {
    const decode = S.decodeUnknownPromise(betterAuthSession(tableSchema(schema.user), tableSchema(schema.session)))
    const now = new Date()
    const session = { id: 's', userId: 'u', token: 't', expiresAt: now, createdAt: now, updatedAt: now }
    const user = { id: 'u', name: 'Grace', email: 'grace@acme.example', emailVerified: true, createdAt: now, updatedAt: now }

    const decoded = await decode({ user: { ...user, image: undefined }, session })

    expect(decoded.user.image).toBeNull()
    expect(decoded.user.timeZone).toBeNull()
    expect(decoded.session.activeOrganizationId).toBeNull()
    expect(Redacted.value(decoded.session.token)).toBe('t')
  })
})

describe("Better Auth's session cookie cache", () => {
  test('a member is signed in from the session Better Auth keeps in a cookie', async () => {
    const { browser } = setup({ cookieCache: { enabled: true, maxAge: 300 } })
    const visitor = browser()

    await acme.signIn(visitor, '/sign-in/acme', { id: 'acme-cached', email: 'cached@acme.example', name: 'Cache Member' })

    expect(visitor.cookies.has('better-auth.session_data')).toBe(true)
    expect((await me(visitor)).body).toMatchObject({ email: 'cached@acme.example' })
  })
})

describe('organizations', () => {
  test('a member creates an organization, invites another, who accepts and makes it active', async () => {
    const { browser, outbox } = setup()
    const owner = browser()
    const invitee = browser()
    await signUp(owner, 'owner@example.com', 'Owner')
    await signUp(invitee, 'invitee@example.com', 'Invitee')

    const created = await owner.request('/organizations', form({ name: 'Acme', slug: 'acme' }))
    const location = created.headers.get('Location') ?? ''
    const organizationId = location.split('/').pop() ?? ''

    expect(created.status).toBe(303)
    expect(location).toBe(`/organizations/${organizationId}`)
    expect((await owner.request(location, { headers: { Accept: 'application/json' } })).status).toBe(200)
    expect((await invitee.request(location, { headers: { Accept: 'application/json' } })).status).toBe(404)

    await owner.request(`${location}/invitations`, form({ email: 'invitee@example.com', role: 'member' }))
    const [invitation] = outbox.invitations

    const accepted = await invitee.request(`/invitations/${invitation?.id}/accept`, { method: 'POST' })

    expect(accepted.headers.get('Location')).toBe(location)
    expect((await invitee.request(location, { headers: { 'X-Inertia': 'true', 'X-Inertia-Version': '1' } })).status).toBe(200)

    const activated = await invitee.request(`${location}/activate`, { method: 'POST' })

    expect(activated.headers.get('Location')).toBe('/me')
    expect((await me(invitee)).body).toMatchObject({ activeOrganizationId: organizationId })
  })
})

describe('bearer tokens', () => {
  test("a client signed in through Better Auth's API is signed in by its token", async () => {
    const { browser } = setup()
    await signUp(browser(), 'ada@example.com')

    const signedIn = await browser().request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
      body: JSON.stringify({ email: 'ada@example.com', password: 'correct horse battery' }),
    })
    const token = signedIn.headers.get('set-auth-token')

    expect(token).toBeString()

    const res = await browser().request('/me', { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } })

    expect(res.status).toBe(200)
  })
})

describe('admin', () => {
  test('an admin bans a member, whose sign-in is refused on the form, and impersonates another', async () => {
    const { browser, db } = setup()
    const admin = browser()
    await signUp(admin, 'admin@example.com', 'Admin')
    await signUp(browser(), 'banned@example.com', 'Banned')
    await signUp(browser(), 'member@example.com', 'Member')
    db.update(schema.user).set({ role: 'admin' }).where(eq(schema.user.email, 'admin@example.com')).run()
    const id = (email: string) => db.select().from(schema.user).where(eq(schema.user.email, email)).get()?.id ?? ''

    expect((await me(admin)).body).toMatchObject({ role: 'admin' })

    await admin.request(`/admin/users/${id('banned@example.com')}/ban`, { method: 'POST' })
    const refused = await browser().request('/sign-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: 'banned@example.com', password: 'correct horse battery' }),
    })

    expect(refused.status).toBe(422)
    expect(await refused.json()).toMatchObject({ errors: { email: expect.stringContaining('banned') } })

    const impersonating = await admin.request(`/admin/users/${id('member@example.com')}/impersonate`, { method: 'POST' })

    expect(impersonating.headers.get('Location')).toBe('/me')
    expect((await me(admin)).body).toMatchObject({ email: 'member@example.com', impersonatedBy: id('admin@example.com') })
  })
})
