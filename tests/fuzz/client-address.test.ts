/**
 * Each request sendFuzzRequest sends comes from a client address of its own,
 * as each testBrowser does, so a per-client limit, such as Better Auth's on
 * signing in, never carries from one case, or one test file, to the next.
 */
import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { sendFuzzRequest, type FuzzRequest } from '../../src/fuzz.js'
import { testEnv } from '../../src/testing.js'

// Not an application: a Worker that answers with the addresses it was sent.
const app = new Hono()
app.get('/who', (c) => c.json({ client: c.req.header('cf-connecting-ip'), forwarded: c.req.header('x-forwarded-for') }))

const request = (headers: Readonly<Record<string, string>> = {}): FuzzRequest => ({ person: null, method: 'GET', path: '/who', query: '', headers, body: { as: 'none' } })

const addressesOf = async (sent: FuzzRequest) => JSON.parse((await sendFuzzRequest(app, sent, testEnv({})))?.text ?? '{}') as { client?: string; forwarded?: string }

test('each request comes from a client address of its own, as Cloudflare and a proxy report it', async () => {
  const [first, second] = [await addressesOf(request()), await addressesOf(request())]

  expect(first.client).toMatch(/^198\.19\.\d+\.\d+$/)
  expect(first.forwarded).toBe(first.client)
  expect(second.client).not.toBe(first.client)
})

test('a request whose headers name its address keeps it', async () => {
  expect(await addressesOf(request({ 'cf-connecting-ip': '203.0.113.7' }))).toEqual({ client: '203.0.113.7' })
})
