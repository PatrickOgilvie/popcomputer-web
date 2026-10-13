/**
 * The finance reviewer's tests: the surface SPEC.md pins, driven through
 * HTTP. `acceptance` checks what the team asked for; `safety` checks what a
 * non-technical team would not think to ask for.
 */
import { describe, expect, test } from 'bun:test'
import { testBrowser, type TestBrowser } from '@popcomputer/web/testing'
import { app, freshEnv } from '../src/test-support'

type Env = Awaited<ReturnType<typeof freshEnv>>

interface Person {
  readonly browser: TestBrowser
  readonly id: string
}

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' }

const send = (person: Person, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  person.browser.request(path, {
    method,
    headers: { ...JSON_HEADERS, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

async function signUp(env: Env, name: string, email: string): Promise<Person> {
  const browser = testBrowser(app, env as never)
  const res = await browser.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, email, password: 'correct horse battery' }),
  })
  const body: any = await res.json()

  expect({ email, status: res.status }).toEqual({ email, status: 200 })

  return { browser, id: String(body.user.id) }
}

const lunch = { amountCents: 1250, currency: 'GBP', description: 'Client lunch', spentOn: '2026-10-01' }

async function log(person: Person, expense: object = lunch, headers: Record<string, string> = {}): Promise<any> {
  const res = await send(person, 'POST', '/api/expenses', expense, headers)

  expect(res.status).toBe(201)

  return res.json()
}

async function list(person: Person): Promise<any[]> {
  const res = await send(person, 'GET', '/api/expenses')

  expect(res.status).toBe(200)

  return ((await res.json()) as any).data
}

async function setUp() {
  const env = await freshEnv()
  const ada = await signUp(env, 'Ada', 'ada@acme.test')
  const bo = await signUp(env, 'Bo', 'bo@acme.test')
  const jo = await signUp(env, 'Jo', 'manager.jo@acme.test')
  const eve = await signUp(env, 'Eve', 'manager.eve@globex.test')

  return { env, ada, bo, jo, eve }
}

describe('acceptance', () => {
  test('a person logs an expense', async () => {
    const { ada } = await setUp()
    const expense = await log(ada)

    expect(expense).toMatchObject({ ...lunch, status: 'pending', ownerId: ada.id })
    expect(typeof expense.id).toBe('string')
  })

  test('a person lists and reads their expenses', async () => {
    const { ada } = await setUp()
    const expense = await log(ada)

    expect((await list(ada)).map((item) => item.id)).toEqual([expense.id])

    const res = await send(ada, 'GET', `/api/expenses/${expense.id}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: expense.id, description: 'Client lunch' })
  })

  test("a manager sees the team's expenses and approves one", async () => {
    const { ada, bo, jo } = await setUp()
    const first = await log(ada)
    const second = await log(bo, { ...lunch, description: 'Taxi' })

    expect((await list(jo)).map((item) => item.id).sort()).toEqual([first.id, second.id].sort())

    const res = await send(jo, 'POST', `/api/expenses/${first.id}/approve`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: first.id, status: 'approved' })
    expect((await list(ada))[0].status).toBe('approved')
  })

  test('a manager rejects an expense', async () => {
    const { ada, jo } = await setUp()
    const expense = await log(ada)
    const res = await send(jo, 'POST', `/api/expenses/${expense.id}/reject`)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'rejected' })
  })

  test('invalid input names each field', async () => {
    const { ada } = await setUp()
    const res = await send(ada, 'POST', '/api/expenses', { amountCents: -5, currency: 'BTC', description: '', spentOn: 'yesterday' })
    const body: any = await res.json()

    expect(res.status).toBe(422)
    expect(Object.keys(body.errors).sort()).toEqual(['amountCents', 'currency', 'description', 'spentOn'])
  })

  test('sending the same expense twice with one key logs it once', async () => {
    const { ada } = await setUp()
    const first = await send(ada, 'POST', '/api/expenses', lunch, { 'Idempotency-Key': 'k-1' })
    const again = await send(ada, 'POST', '/api/expenses', lunch, { 'Idempotency-Key': 'k-1' })

    expect(first.status).toBe(201)
    expect([200, 201]).toContain(again.status)
    expect(((await again.json()) as any).id).toBe(((await first.json()) as any).id)
    expect(await list(ada)).toHaveLength(1)
  })

  test('the API is described as OpenAPI', async () => {
    const env = await freshEnv()
    const res = await app.request('/api/openapi.json', {}, env as never)
    const document: any = await res.json()

    expect(res.status).toBe(200)
    expect(String(document.openapi)).toMatch(/^3\./)
    expect(Object.keys(document.paths).map((path) => path.replace(/\{[^}]+\}/g, '{id}')).sort()).toEqual([
      '/api/expenses',
      '/api/expenses/{id}',
      '/api/expenses/{id}/approve',
      '/api/expenses/{id}/reject',
    ])
  })

  test('a request without a session is answered 401 with JSON', async () => {
    const env = await freshEnv()
    const res = await app.request('/api/expenses', { headers: { Accept: 'application/json' } }, env as never)

    expect(res.status).toBe(401)
    expect(res.headers.get('Content-Type')).toContain('application/json')
  })
})

describe('safety', () => {
  test("a person cannot read a colleague's expense", async () => {
    const { ada, bo } = await setUp()
    const expense = await log(ada)

    expect((await send(bo, 'GET', `/api/expenses/${expense.id}`)).status).toBe(404)
    expect(await list(bo)).toEqual([])
  })

  test("another team's manager cannot see or approve an expense", async () => {
    const { ada, eve } = await setUp()
    const expense = await log(ada)

    expect(await list(eve)).toEqual([])
    expect([403, 404]).toContain((await send(eve, 'POST', `/api/expenses/${expense.id}/approve`)).status)
    expect((await list(ada))[0].status).toBe('pending')
  })

  test('a person cannot approve their own expense', async () => {
    const { ada } = await setUp()
    const expense = await log(ada)

    expect([403, 404]).toContain((await send(ada, 'POST', `/api/expenses/${expense.id}/approve`)).status)
    expect((await list(ada))[0].status).toBe('pending')
  })

  test('the client cannot choose the status or the owner', async () => {
    const { ada, bo } = await setUp()
    const res = await send(ada, 'POST', '/api/expenses', { ...lunch, status: 'approved', ownerId: bo.id })
    const expense: any = await res.json()

    expect(res.status).toBe(201)
    expect(expense.status).toBe('pending')
    expect(expense.ownerId).toBe(ada.id)
    expect(await list(bo)).toEqual([])
  })

  test('only a pending expense is decided, once', async () => {
    const { ada, jo } = await setUp()
    const expense = await log(ada)
    const [approve, reject] = await Promise.all([
      send(jo, 'POST', `/api/expenses/${expense.id}/approve`),
      send(jo, 'POST', `/api/expenses/${expense.id}/reject`),
    ])

    expect([approve.status, reject.status].sort()).toEqual([200, 409])

    const decided = (await list(ada))[0].status
    expect(decided).toBe(approve.status === 200 ? 'approved' : 'rejected')
    expect((await send(jo, 'POST', `/api/expenses/${expense.id}/approve`)).status).toBe(409)
  })

  test('a retry sent at the same moment still logs the expense once', async () => {
    const { ada } = await setUp()
    const [first, second] = await Promise.all([
      send(ada, 'POST', '/api/expenses', lunch, { 'Idempotency-Key': 'k-race' }),
      send(ada, 'POST', '/api/expenses', lunch, { 'Idempotency-Key': 'k-race' }),
    ])

    expect(first.status).toBeLessThan(300)
    expect(second.status).toBeLessThan(300)
    expect(await list(ada)).toHaveLength(1)
  })

  test("one person's idempotency key does not return another's expense", async () => {
    const { ada, bo } = await setUp()
    const adas = await log(ada, lunch, { 'Idempotency-Key': 'shared-key' })
    const res = await send(bo, 'POST', '/api/expenses', { ...lunch, description: 'Bo’s taxi' }, { 'Idempotency-Key': 'shared-key' })
    const bos: any = await res.json()

    expect(res.status).toBe(201)
    expect(bos.id).not.toBe(adas.id)
    expect(bos.ownerId).toBe(bo.id)
    expect(JSON.stringify(bos)).not.toContain('Client lunch')
  })

  test('an amount must be a whole number of cents', async () => {
    const { ada } = await setUp()
    const res = await send(ada, 'POST', '/api/expenses', { ...lunch, amountCents: 12.5 })

    expect(res.status).toBe(422)
    expect(await list(ada)).toEqual([])
  })

  test('a request from another site is refused', async () => {
    const { ada } = await setUp()
    const res = await send(ada, 'POST', '/api/expenses', lunch, { Origin: 'https://evil.example' })

    expect(res.status).toBe(403)
    expect(await list(ada)).toEqual([])
  })

  test('responses carry no credentials', async () => {
    const { ada, jo } = await setUp()
    await log(ada)
    const text = JSON.stringify(await list(jo))

    expect(text).not.toMatch(/password|token|session/i)
  })
})
