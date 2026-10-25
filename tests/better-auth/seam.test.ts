/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * The seam between the framework and Better Auth, driven through an
 * application written as docs/ says: every documented call, and the
 * plugins applications reach for. These tests gate every Better Auth upgrade:
 * the peer range names only versions they passed against.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { getSchema } from 'better-auth/db'
import { eq, sql } from 'drizzle-orm'
import { Redacted, Schema as S } from 'effect'
import { testBrowser, testEnv } from '../../src/testing.js'
import { betterAuthSession } from '../../src/auth.js'
import { isLimitedPath } from '../../src/effect/sign-in-limits.js'
import { tableSchema } from '../../src/schema.js'
import { acme, createAuth, createDatabase, newOutbox, schema, SECRET, type CreateAuthOptions } from './fixture.js'
import { app } from './app.js'

const repoRoot = join(import.meta.dir, '..', '..')

beforeEach(() => acme.install())
afterEach(() => acme.restore())
const SESSION = 'better-auth.session_token'

function setup(session?: CreateAuthOptions['session']) {
  const db = createDatabase()
  const outbox = newOutbox()
  const env = testEnv({ OUTBOX: outbox, SESSION: session, APP_URL: 'http://localhost' }, { database: db })
  const browser = () => testBrowser(app, env)

  /** Press the button on the page of the link Better Auth last emailed to prove `email`. */
  const verifyEmail = (client: Browser, email: string) =>
    client.request('/verify-email', form({ token: outbox.verifications.filter((sent) => sent.email === email).at(-1)?.token ?? '' }))

  /** A member, as the template makes one: sign up, prove the address by its emailed link, and sign in. */
  const join = async (client: Browser, email: string, name?: string) => {
    await signUp(client, email, name)
    await verifyEmail(client, email)

    return signIn(client, email)
  }

  return { db, outbox, env, browser, verifyEmail, join }
}

type Browser = ReturnType<typeof testBrowser>

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

describe('sign-in limits', () => {
  test("every endpoint of Better Auth's and the plugins' that checks a password is limited per client address", () => {
    const auth = createAuth({ db: createDatabase(), outbox: newOutbox() })
    // An admin's create-user sets a new user's password; it checks none.
    const setsPassword = new Set(['/admin/create-user'])
    const unlimited = Object.values(auth.api).flatMap((endpoint: object) => {
      const path: unknown = Reflect.get(endpoint, 'path')
      const options: unknown = Reflect.get(endpoint, 'options')
      const body: unknown = options instanceof Object ? Reflect.get(options, 'body') : undefined
      // The endpoint's body schema, a zod object, lists its fields as its `shape`.
      const fields: unknown = body instanceof Object ? Reflect.get(body, 'shape') : undefined
      const checksPassword = fields instanceof Object && (Object.hasOwn(fields, 'password') || Object.hasOwn(fields, 'currentPassword'))

      return typeof path === 'string' && checksPassword && !setsPassword.has(path) && !isLimitedPath(path) ? [path] : []
    })

    expect(unlimited).toEqual([])
  })
})

describe('signing up, in and out', () => {
  test('a form signs a visitor up, its emailed link proves the address, and the password then signs them in', async () => {
    const { browser, outbox, verifyEmail } = setup()
    const visitor = browser()

    const signedUp = await signUp(visitor, 'ada@example.com')

    expect(signedUp.status).toBe(303)
    expect(signedUp.headers.get('Location')).toBe('/check-email')
    expect(setsSession(signedUp)).toBe(false)
    expect(outbox.verifications).toMatchObject([{ email: 'ada@example.com' }])

    const early = await visitor.request('/sign-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: 'ada@example.com', password: 'correct horse battery' }),
    })

    expect(early.status).toBe(422)
    expect((await early.json()).errors).toEqual({ email: 'Email not verified' })

    const verified = await verifyEmail(visitor, 'ada@example.com')

    expect(verified.headers.get('Location')).toBe('/sign-in')
    expect(setsSession(verified)).toBe(false)
    expect((await me(visitor)).status).toBe(401)

    const signedIn = await signIn(visitor, 'ada@example.com')

    expect(signedIn.headers.get('Location')).toBe('/dashboard')
    expect(setsSession(signedIn)).toBe(true)
    expect((await me(visitor)).body).toMatchObject({ email: 'ada@example.com', timeZone: 'Europe/London', activeOrganizationId: null })
  })

  test("Better Auth's API refuses the user fields the application lets visitors set only on its own forms", async () => {
    const { browser, join } = setup()
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
    await join(member, 'ada@example.com')
    const updated = await api('/update-user', { timeZone: 'Mars/Olympus' }, member)

    expect(updated.status).toBe(400)
    expect((await me(member)).body).toMatchObject({ timeZone: 'Europe/London' })
    expect((await api('/update-user', { name: 'Ada King' }, member)).status).toBe(200)
  })

  test("the same fields are refused however the request spells its path or its body's type", async () => {
    const { browser } = setup()
    const tried: Array<{ readonly path: string; readonly type: string; readonly status: number }> = []
    const variants: ReadonlyArray<readonly [string, string]> = [
      ['/sign-up/email', 'Application/JSON'],
      ['/sign-up/email', 'application/json; charset=utf-8'],
      ['/sign-up/email', 'text/plain'],
      ['//sign-up/email', 'application/json'],
      ['/sign-up//email', 'application/json'],
      ['/sign-up/email/', 'application/json'],
    ]

    for (const [index, [path, type]] of variants.entries()) {
      const res = await browser().request(`/api/auth${path}`, {
        method: 'POST',
        headers: { 'Content-Type': type, Origin: 'http://localhost' },
        body: JSON.stringify({ name: 'Eve', email: `eve${index}@example.com`, password: 'correct horse battery', timeZone: 'Mars/Olympus' }),
      })

      tried.push({ path, type, status: res.status })
    }

    // Each is refused before Better Auth writes the user, or by Better Auth, which finds no such endpoint.
    expect(tried.filter((attempt) => attempt.status < 400)).toEqual([])
  })

  // Better Auth reads JSON only for a type that starts application/ and ends
  // json, and a form for any type naming one; String#trim also removes a
  // leading U+00A0, U+000B or U+000C, which Headers keep.
  test.each([
    'x/application/json+json;a=b, application/x-www-form-urlencoded',
    ' application/json; a=application/x-www-form-urlencoded',
    '\u000bapplication/json; a=application/x-www-form-urlencoded',
    '\u000capplication/json; a=application/x-www-form-urlencoded',
  ])('a body whose type Better Auth would read as a form, though it reads as JSON another way, is refused (%j)', async (type) => {
    const { browser, db } = setup()
    const signUp = { name: 'Eve', email: 'eve@example.com', password: 'correct horse battery' }
    // As JSON it sets no timeZone; as a form it does.
    const body = JSON.stringify({ ...signUp, p: `&${new URLSearchParams({ ...signUp, timeZone: 'Mars/Olympus' })}&` })

    const res = await browser().request('/api/auth/sign-up/email', { method: 'POST', headers: { 'Content-Type': type, Origin: 'http://localhost' }, body })

    expect(res.status).toBe(415)
    expect(await db.select().from(schema.user)).toEqual([])
  })

  test("a wrong password is refused with Better Auth's message on the email field", async () => {
    const { browser, join } = setup()
    await join(browser(), 'ada@example.com')
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
    const { browser, db, join } = setup()
    const visitor = browser()
    await join(visitor, 'ada@example.com')

    const res = await visitor.request('/sign-out', { method: 'POST' })

    expect(res.status).toBe(303)
    expect(visitor.cookies.has(SESSION)).toBe(false)
    expect(db.select().from(schema.session).all()).toEqual([])
    expect((await me(visitor)).status).toBe(401)
  })

  test('signing out of a Better Auth loaded on first use ends the session in the database too', async () => {
    const { db, outbox, browser, join } = setup()
    const visitor = browser()
    await join(visitor, 'ada@example.com')
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
    const { browser, join } = setup({ updateAge: 0 })
    const visitor = browser()
    await join(visitor, 'ada@example.com')

    const { res } = await me(visitor)

    expect(res.status).toBe(200)
    expect(setsSession(res)).toBe(true)
  })

  test('a session revoked elsewhere is signed out, and its cookie cleared', async () => {
    const { browser, db, join } = setup()
    const visitor = browser()
    await join(visitor, 'ada@example.com')
    db.delete(schema.session).run()

    const { status } = await me(visitor)

    expect(status).toBe(401)
    expect(visitor.cookies.has(SESSION)).toBe(false)
  })

  test('signing in again after the session was revoked elsewhere keeps the new session', async () => {
    const { browser, db, join } = setup()
    const visitor = browser()
    await join(visitor, 'ada@example.com')
    db.delete(schema.session).run()

    const res = await signIn(visitor, 'ada@example.com')

    expect(res.status).toBe(303)
    expect((await me(visitor)).body).toMatchObject({ email: 'ada@example.com' })
  })

  test("signing in through Better Auth's API after the session was revoked elsewhere keeps the new session", async () => {
    const { browser, db, join } = setup()
    const visitor = browser()
    await join(visitor, 'ada@example.com')
    db.delete(schema.session).run()

    const res = await visitor.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
      body: JSON.stringify({ email: 'ada@example.com', password: 'correct horse battery' }),
    })

    expect(res.status).toBe(200)
    expect((await me(visitor)).body).toMatchObject({ email: 'ada@example.com' })
  })

  test("signing in as someone else through Better Auth's API while the session is being extended keeps the new session", async () => {
    // updateAge 0: every request extends the session, as one a day old does.
    const { browser, join } = setup({ updateAge: 0 })
    await join(browser(), 'grace@example.com', 'Grace Hopper')
    const visitor = browser()
    await join(visitor, 'ada@example.com')

    await visitor.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
      body: JSON.stringify({ email: 'grace@example.com', password: 'correct horse battery' }),
    })

    expect((await me(visitor)).body).toMatchObject({ email: 'grace@example.com' })
  })
})

// Starlette CVE-2024-47874 and CVE-2026-54283, Hono CVE-2026-44456, SvelteKit CVE-2026-40073:
// Better Auth reads whole every body it is handed.
describe("a body over setupWeb's bodyLimit sent to Better Auth's API", () => {
  const MiB = 1024 * 1024

  /** A JSON body of over `size` bytes, streamed to `path` in chunks, counting the bytes the server pulls. */
  const sendStreamed = (path: string, size: number, { declared = false } = {}) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ email: 'ada@example.com', password: 'x'.repeat(size) }))
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= bytes.byteLength) return controller.close()

        const next = bytes.subarray(pulled, pulled + 64 * 1024)
        pulled += next.byteLength
        controller.enqueue(next)
      },
    }, { highWaterMark: 0 })
    const headers = new Headers({ Accept: 'application/json', 'Content-Type': 'application/json', Origin: 'http://localhost' })

    if (declared) headers.set('Content-Length', String(bytes.byteLength))

    // A streamed body needs `duplex`, which the DOM's RequestInit does not name.
    const init: RequestInit & { readonly duplex: 'half' } = { method: 'POST', duplex: 'half', headers, body }

    return { res: app.request(new Request(`http://localhost${path}`, init), undefined, setup().env), pulled: () => pulled }
  }

  test('to the password sign-in, streamed without a length, is refused with 413 before more than the limit is read', async () => {
    const { res, pulled } = sendStreamed('/api/auth/sign-in/email', 8 * MiB)

    expect((await res).status).toBe(413)
    expect(pulled()).toBeLessThan(MiB + 256 * 1024)
  })

  test('to an endpoint whose body Better Auth alone reads is refused the same way', async () => {
    const { res, pulled } = sendStreamed('/api/auth/send-verification-email', 8 * MiB)

    expect((await res).status).toBe(413)
    expect(pulled()).toBeLessThan(MiB + 256 * 1024)
  })

  test('with a declared Content-Length over the limit, is refused before a byte is read', async () => {
    const { res, pulled } = sendStreamed('/api/auth/sign-in/email', 2 * MiB, { declared: true })

    expect({ status: (await res).status, pulled: pulled() }).toEqual({ status: 413, pulled: 0 })
  })
})

describe('one-time codes that make the user on a first sign-in', () => {
  /** The fields a request to Better Auth's API sends as JSON. */
  type ApiBody = Readonly<Record<string, string>>

  const api = (client: Browser, path: string, body: ApiBody) =>
    client.request(`/api/auth${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
      body: JSON.stringify(body),
    })

  test("an emailed code's sign-in refuses the user fields visitors may set only on the application's forms", async () => {
    const { browser, db, outbox } = setup()
    const visitor = browser()

    expect((await api(visitor, '/email-otp/send-verification-otp', { email: 'eve@example.com', type: 'sign-in' })).status).toBe(200)
    const code = outbox.codes.find((sent) => sent.to === 'eve@example.com')?.code ?? ''

    const refused = await api(visitor, '/sign-in/email-otp', { email: 'eve@example.com', otp: code, timeZone: 'Mars/Olympus' })

    expect(refused.status).toBe(400)
    expect((await refused.json()).message).toContain('timeZone')
    expect(setsSession(refused)).toBe(false)
    expect(await db.select().from(schema.user).where(eq(schema.user.email, 'eve@example.com'))).toEqual([])

    // Refused before Better Auth read it, so the code still signs in without the field.
    const signedIn = await api(visitor, '/sign-in/email-otp', { email: 'eve@example.com', otp: code })

    expect(signedIn.status).toBe(200)
    expect(setsSession(signedIn)).toBe(true)
    expect(await db.select({ timeZone: schema.user.timeZone }).from(schema.user).where(eq(schema.user.email, 'eve@example.com')))
      .toEqual([{ timeZone: null }])
  })

  test("a texted code's verification refuses the user fields visitors may set only on the application's forms", async () => {
    const { browser, db, outbox } = setup()
    const visitor = browser()
    const phone = '+15550000001'

    expect((await api(visitor, '/phone-number/send-otp', { phoneNumber: phone })).status).toBe(200)
    const code = outbox.codes.find((sent) => sent.to === phone)?.code ?? ''

    const refused = await api(visitor, '/phone-number/verify', { phoneNumber: phone, code, timeZone: 'Mars/Olympus' })

    expect(refused.status).toBe(400)
    expect((await refused.json()).message).toContain('timeZone')
    expect(setsSession(refused)).toBe(false)
    expect(await db.select().from(schema.user).where(eq(schema.user.phoneNumber, phone))).toEqual([])

    const verified = await api(visitor, '/phone-number/verify', { phoneNumber: phone, code })

    expect(verified.status).toBe(200)
    expect(setsSession(verified)).toBe(true)
    expect(await db.select({ timeZone: schema.user.timeZone }).from(schema.user).where(eq(schema.user.phoneNumber, phone)))
      .toEqual([{ timeZone: null }])
  })

  test('a code sent in a body the framework cannot read is refused, though Better Auth would read it as JSON', async () => {
    const { browser, db, outbox } = setup()
    const visitor = browser()
    const phone = '+15550000002'
    // Better Auth reads any type that starts application/json as JSON; the framework reads only JSON's own.
    const sent = (path: string, body: ApiBody) => visitor.request(`/api/auth${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json-seq', Origin: 'http://localhost' },
      body: JSON.stringify(body),
    })

    await api(visitor, '/email-otp/send-verification-otp', { email: 'eve@example.com', type: 'sign-in' })
    await api(visitor, '/phone-number/send-otp', { phoneNumber: phone })
    const codeTo = (to: string) => outbox.codes.find((code) => code.to === to)?.code ?? ''

    const emailed = await sent('/sign-in/email-otp', { email: 'eve@example.com', otp: codeTo('eve@example.com'), timeZone: 'Mars/Olympus' })
    const texted = await sent('/phone-number/verify', { phoneNumber: phone, code: codeTo(phone), timeZone: 'Mars/Olympus' })

    expect([emailed.status, texted.status]).toEqual([415, 415])
    expect(await db.select().from(schema.user)).toEqual([])
  })
})

describe('two-factor', () => {
  test('a member with two-factor on is asked for a code, which signs them in', async () => {
    const { browser, join } = setup()
    const member = browser()
    await join(member, 'ada@example.com')
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

describe('emailed links', () => {
  test("name the application's declared origin, whatever host and scheme the request reached", async () => {
    const { browser, outbox } = setup()
    // A host the Worker answers that the application does not name, such as
    // a custom hostname a tenant's DNS points at it.
    const res = await browser().request('https://attacker.example/magic-link', {
      ...form({ email: 'ada@example.com' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://attacker.example' },
    })

    expect(res.status).toBe(303)
    expect(outbox.magicLinks.map((sent) => new URL(sent.url).origin)).toEqual(['http://localhost'])
  })
})

describe("an account registered with someone else's address", () => {
  test("a two-factor challenge its registrant holds does not sign in once the address's owner signs in by a link", async () => {
    const { browser, outbox } = setup()
    // Mallory registers the address before its owner does, and enrols two-factor if she can.
    const attacker = browser()
    await signUp(attacker, 'victim@example.com', 'Mallory')
    const enrolled = await attacker.request('/two-factor/enable', form({ password: 'correct horse battery' }))
    const backupCodes: ReadonlyArray<string> = enrolled.status === 200 ? (await enrolled.json()).backupCodes : []
    // She holds a challenge from a password sign-in.
    const challenger = browser()
    await signIn(challenger, 'victim@example.com')

    const victim = browser()
    await victim.request('/magic-link', form({ email: 'victim@example.com' }))
    await victim.request(`/magic-link/verify?token=${outbox.magicLinks.at(-1)?.token}`)
    await challenger.request('/two-factor', form({ code: backupCodes[0] ?? 'no-code' }))

    expect((await me(victim)).body).toMatchObject({ email: 'victim@example.com' })
    expect({ attacker: (await me(attacker)).status, challenger: (await me(challenger)).status }).toEqual({ attacker: 401, challenger: 401 })
  })

  test("a password sign-in its registrant started does not sign in once the address's owner signs in by a link", async () => {
    const { browser, outbox } = setup()
    const attacker = browser()
    await signUp(attacker, 'victim@example.com', 'Mallory')
    const victim = browser()
    await victim.request('/magic-link', form({ email: 'victim@example.com' }))

    // The owner's link lands while Mallory's password sign-ins are hashing.
    const racers = [browser(), browser(), browser()]
    const racing = Promise.all(racers.map((racer) => signIn(racer, 'victim@example.com')))
    await victim.request(`/magic-link/verify?token=${outbox.magicLinks.at(-1)?.token}`)
    await racing
    const retried = browser()
    await signIn(retried, 'victim@example.com')

    expect((await me(victim)).body).toMatchObject({ email: 'victim@example.com' })
    expect(await Promise.all([attacker, ...racers, retried].map(async (client) => (await me(client)).status))).toEqual([401, 401, 401, 401, 401])
  })

  test("a fetch of the emailed link, as a mail scanner makes, proves nothing: only its page's button does", async () => {
    const { browser, db, outbox } = setup()
    await signUp(browser(), 'victim@example.com', 'Mallory')
    const token = outbox.verifications.at(-1)?.token ?? ''
    const proven = () => db.select({ emailVerified: schema.user.emailVerified }).from(schema.user).where(eq(schema.user.email, 'victim@example.com')).get()
    const scanner = browser()

    const fetched = await scanner.request(`/verify-email?token=${token}`)
    const checked = await scanner.request(`/verify-email?token=${token}`, { method: 'HEAD' })

    expect([fetched.status, checked.status]).toEqual([200, 200])
    expect(proven()).toEqual({ emailVerified: false })

    // Mallory's password still signs no one in.
    const early = await browser().request('/sign-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: 'victim@example.com', password: 'correct horse battery' }),
    })

    expect((await early.json()).errors).toEqual({ email: 'Email not verified' })

    const confirmed = await browser().request('/verify-email', form({ token }))

    expect(confirmed.headers.get('Location')).toBe('/sign-in')
    expect(proven()).toEqual({ emailVerified: true })
  })

  test("a phone number its registrant sends with the sign-up is refused, so no texted code signs in to the owner's account", async () => {
    const { browser, db, outbox } = setup()
    const phone = '+15550009999'
    const api = (client: Browser, path: string, body: Readonly<Record<string, string>>) =>
      client.request(`/api/auth${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
        body: JSON.stringify(body),
      })
    // The phone-number plugin's field, unlike the application's own, has no `input: false`, so Better Auth would store it.
    const signedUp = await api(browser(), '/sign-up/email', { name: 'Mallory', email: 'victim@example.com', password: 'correct horse battery', phoneNumber: phone })

    expect(signedUp.status).toBe(400)
    expect((await signedUp.json()).message).toContain('phoneNumber')
    expect(await db.select().from(schema.user).where(eq(schema.user.email, 'victim@example.com'))).toEqual([])

    const victim = browser()
    await victim.request('/magic-link', form({ email: 'victim@example.com' }))
    await victim.request(`/magic-link/verify?token=${outbox.magicLinks.at(-1)?.token}`)
    // Mallory's texted code, once the owner holds the address, makes a user of its own.
    const later = browser()
    await api(later, '/phone-number/send-otp', { phoneNumber: phone })
    const verified = await api(later, '/phone-number/verify', { phoneNumber: phone, code: outbox.codes.filter((sent) => sent.to === phone).at(-1)?.code ?? '' })

    expect(verified.status).toBe(200)
    expect((await me(victim)).body).toMatchObject({ email: 'victim@example.com' })
    expect((await me(later)).body?.id).not.toBe((await me(victim)).body?.id)
  })
})

describe('a link that moves an account to a new address', () => {
  /** Follow the link through the application's page, or through Better Auth's own endpoint. */
  const doors = {
    page: (client: Browser, token: string) => client.request('/verify-email', form({ token })),
    api: (client: Browser, token: string) => client.request(`/api/auth/verify-email?token=${token}`),
  }

  for (const [door, follow] of Object.entries(doors)) {
    test(`signs in no one who follows it through the ${door}, and moves the account only in the browser of the account that asked`, async () => {
      const { browser, db, outbox, join } = setup()
      const mallory = browser()
      await join(mallory, 'mallory@example.com', 'Mallory')
      const asked = await mallory.request('/api/auth/change-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
        body: JSON.stringify({ newEmail: 'victim@example.com' }),
      })
      const token = outbox.verifications.filter((sent) => sent.email === 'victim@example.com').at(-1)?.token ?? ''
      const users = () => db.select({ email: schema.user.email, emailVerified: schema.user.emailVerified }).from(schema.user).all()
      const sessions = () => db.select().from(schema.session).all().length

      expect(asked.status).toBe(200)

      // The address's holder follows the link Better Auth sent there.
      const follower = browser()
      const followed = await follow(follower, token)

      expect(setsSession(followed)).toBe(false)
      expect((await me(follower)).status).toBe(401)
      expect(users()).toEqual([{ email: 'mallory@example.com', emailVerified: true }])
      expect(sessions()).toBe(1)

      // Mallory, in the browser she asked from, completes the move in the session she has.
      await follow(mallory, token)

      expect(users()).toEqual([{ email: 'victim@example.com', emailVerified: true }])
      expect(sessions()).toBe(1)
    })
  }
})

describe('upgrading from 1.4', () => {
  /** The SQL step UPGRADING.md's 1.4-to-1.5 section gives, as an application copies it. */
  const upgradeStep = () => {
    const upgrading = readFileSync(join(repoRoot, 'UPGRADING.md'), 'utf8')
    const section = upgrading.slice(upgrading.indexOf('## From 1.4 to 1.5'), upgrading.indexOf('## Tooling after the upgrade'))

    return /```sql\n([\s\S]*?)\n\s*```/.exec(section)?.[1]?.trim()
  }

  test("UPGRADING.md's step ends the sessions 1.4's template gave registrations nobody proved, and keeps proven members'", async () => {
    const { browser, db, join } = setup()
    // 1.4's template, on the same tables and secret: a sign-up was signed in at once, proving nothing.
    const legacy = betterAuth({
      database: drizzleAdapter(db, { provider: 'sqlite', schema }),
      baseURL: 'http://localhost',
      secret: SECRET,
      emailAndPassword: { enabled: true },
      logger: { disabled: true },
    })
    const signedUp = await legacy.handler(new Request('http://localhost/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Mallory', email: 'victim@example.com', password: 'correct horse battery' }),
    }))
    const registrant = browser()
    registrant.setCookie(SESSION, signedUp.headers.getSetCookie().find((cookie) => cookie.startsWith(`${SESSION}=`))?.split(';')[0]?.slice(SESSION.length + 1) ?? '')
    const member = browser()
    await join(member, 'ada@example.com')

    // Upgraded, the session still signs Mallory in on the address she never proved.
    expect((await me(registrant)).body).toMatchObject({ email: 'victim@example.com' })

    const step = upgradeStep()

    expect(step).toBeString()
    db.run(sql.raw(step ?? ''))

    expect((await me(registrant)).status).toBe(401)
    expect((await me(member)).body).toMatchObject({ email: 'ada@example.com' })
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
    const { browser, outbox, join } = setup()
    const owner = browser()
    const invitee = browser()
    await join(owner, 'owner@example.com', 'Owner')
    await join(invitee, 'invitee@example.com', 'Invitee')

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
    const { browser, join } = setup()
    await join(browser(), 'ada@example.com')

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
    const { browser, db, join } = setup()
    const admin = browser()
    await join(admin, 'admin@example.com', 'Admin')
    await join(browser(), 'banned@example.com', 'Banned')
    await join(browser(), 'member@example.com', 'Member')
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
