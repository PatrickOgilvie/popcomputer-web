/**
 * Requests whose size alone costs the isolate that serves every request: a
 * body read whole before anything could refuse it, and a list of thousands
 * of invalid items, each kept, observed and answered as an error of its own.
 *
 * Precedents: Starlette CVE-2024-47874 and CVE-2026-54283, Hono
 * CVE-2026-44456 and SvelteKit CVE-2026-40073 (bodies parsed without a
 * limit); Laravel's validator and Zod report every invalid item; a Worker's
 * isolate shares its memory among the requests it serves.
 */

import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { Effect, Layer, Schema as S } from 'effect'
import { action } from '../../src/effect/action.js'
import { EffectErrorObserverService, type EffectErrorEvent } from '../../src/effect/error-observer.js'
import { json } from '../../src/effect/responses.js'
import { coercedNumber, maxItems, minItems, upload } from '../../src/effect/schema.js'
import { validateRequest } from '../../src/effect/validation.js'
import { setupWeb } from '../../src/setup.js'
import { testEnv } from '../../src/testing.js'

const Line = S.Struct({ amount: coercedNumber })
const Order = S.Struct({ items: maxItems(Line, 50) })
const Lines = S.Struct({ lines: S.Array(Line) })
const Pair = S.Struct({ items: minItems(Line, 2) })
const Ok = S.Struct({ ok: S.Boolean })

function createApp(observed: EffectErrorEvent[] = []) {
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) }).services({
    app: Layer.succeed(EffectErrorObserverService, EffectErrorObserverService.of({
      observe: (event) => Effect.sync(() => void observed.push(event)),
    })),
  })
  const accept = (schema: S.Codec<unknown, unknown>) => action(Effect.gen(function* () {
    yield* validateRequest(schema)

    return yield* json(Ok, { ok: true })
  }))

  routes.post('/orders', accept(Order)).post('/lines', accept(Lines)).post('/pairs', accept(Pair))

  return app
}

/** A body of one list, its items' fields as a form sends them. */
type ListBody = Readonly<Partial<Record<'items' | 'lines', ReadonlyArray<Readonly<Record<string, string>>>>>>

const post = (app: Hono, path: string, body: ListBody) => app.request(path, {
  method: 'POST',
  headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}, testEnv({ ENVIRONMENT: 'production' }))

/** `count` items, none with an amount. */
const empty = (count: number) => Array.from({ length: count }, () => ({}))

describe('a list longer than its maxItems', () => {
  test("is refused with the limit's message alone, however many of its items are invalid", async () => {
    const app = createApp()
    const stopped = 'This request sends more than 1000 values, so validation stopped at its first invalid field.'

    for (const [count, errors] of [
      [51, { items: 'Must have at most 50 items' }],
      [16_000, { items: 'Must have at most 50 items', form: stopped }],
    ] as const) {
      const res = await post(app, '/orders', { items: empty(count) })

      expect({ count, status: res.status, errors: (await res.json()).errors }).toEqual({ count, status: 422, errors })
    }
  })

  test('within the limit still reports each invalid item', async () => {
    const res = await post(createApp(), '/orders', { items: [{ amount: '1' }, {}, { amount: 'x' }] })

    expect((await res.json()).errors).toEqual({ 'items.1.amount': 'This field is required', 'items.2.amount': 'Expected a number' })
  })

  test("and a list shorter than its minItems is refused with that limit's message", async () => {
    const res = await post(createApp(), '/pairs', { items: empty(1) })

    expect((await res.json()).errors).toEqual({ items: 'Must have at least 2 items' })
  })
})

describe('a list of hundreds of invalid items', () => {
  test('lists at most 100 fields and says more were invalid, in the 422 and to the error observer', async () => {
    const observed: EffectErrorEvent[] = []
    const res = await post(createApp(observed), '/lines', { lines: empty(400) })
    const body = await res.json()
    const fields = Object.keys(body.errors)

    expect(res.status).toBe(422)
    expect(fields).toHaveLength(101)
    expect(fields.slice(0, 2)).toEqual(['lines.0.amount', 'lines.1.amount'])
    expect(body.errors.form).toBe('More than 100 fields are invalid; the first 100 are listed.')
    expect(Object.keys(observed[0].structured?.validation?.fields ?? {})).toEqual(fields)
    expect(observed[0].structured?.message.length).toBeLessThan(3_000)
  })
})

// Effect keeps an issue for each invalid item until the report is built,
// whatever the report then lists: a 1 MiB body of empty items held some
// 170 MiB of one isolate's memory while it validated.
describe('a list of thousands of invalid items', () => {
  const firstOnly = {
    'lines.0.amount': 'This field is required',
    form: 'This request sends more than 1000 values, so validation stopped at its first invalid field.',
  }

  test('stops at the first invalid field and says so, up to a body at the limit', async () => {
    const app = createApp()

    // 349,518 empty items is a JSON body just under 1 MiB.
    for (const count of [2_000, 16_000, 349_518]) {
      const res = await post(app, '/lines', { lines: empty(count) })

      expect({ count, status: res.status, errors: (await res.json()).errors }).toEqual({ count, status: 422, errors: firstOnly })
    }
  })

  test('is answered the same size whatever the count', async () => {
    const app = createApp()
    const sizes = await Promise.all([2_000, 16_000].map(async (count) => (await (await post(app, '/lines', { lines: empty(count) })).text()).length))

    expect(sizes[0]).toBe(sizes[1])
    expect(sizes[1]).toBeLessThan(50_000)
  })

  test('as a form post too', async () => {
    const res = await createApp().request('/lines', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: Array.from({ length: 2_000 }, (_, index) => `lines[${index}][amount]=x`).join('&'),
    }, testEnv({ ENVIRONMENT: 'production' }))

    expect((await res.json()).errors).toEqual({ ...firstOnly, 'lines.0.amount': 'Expected a number' })
  })

  test('still lists each invalid field when the action asks for every error', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })
    routes.post('/lines', action(Effect.gen(function* () {
      yield* validateRequest(Lines, { parseOptions: { errors: 'all' } })

      return yield* json(Ok, { ok: true })
    })))

    expect(Object.keys((await (await post(app, '/lines', { lines: empty(2_000) })).json()).errors)).toHaveLength(101)
  })
})

const MiB = 1024 * 1024
const Note = S.Struct({ text: S.String })
const Cover = S.Struct({ cover: upload({ types: ['image/png'], maxBytes: 1024 }) })
const Receipt = S.Struct({ receipt: upload({ types: ['image/png'], maxBytes: 3 * MiB }) })

function createUploadsApp(bodyLimit?: number) {
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page), bodyLimit })
  const accept = (schema: S.Codec<unknown, unknown>, bodyLimit?: number) => action(Effect.gen(function* () {
    yield* validateRequest(schema, { bodyLimit })

    return yield* json(Ok, { ok: true })
  }))

  routes.post('/notes', accept(Note)).post('/covers', accept(Cover)).post('/receipts', accept(Receipt, 4 * MiB))

  return app
}

/** A body sent in chunks, counting the bytes the server pulls. */
function streamed(bytes: Uint8Array, chunk = 64 * 1024) {
  let pulled = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= bytes.byteLength) return controller.close()

      const next = bytes.subarray(pulled, pulled + chunk)
      pulled += next.byteLength
      controller.enqueue(next)
    },
  }, { highWaterMark: 0 })

  return { body, pulled: () => pulled }
}

/** A multipart form of one PNG of `size` bytes, and its Content-Type. */
async function multipart(field: string, size: number) {
  const png = new Uint8Array(size)
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const form = new FormData()
  form.set(field, new File([png], 'image.png', { type: 'image/png' }))
  const encoded = new Response(form)

  return { type: encoded.headers.get('Content-Type') ?? '', bytes: new Uint8Array(await encoded.arrayBuffer()) }
}

const send = (app: Hono, path: string, init: RequestInit) => {
  // A streamed body needs `duplex`, which the DOM's RequestInit does not name.
  const streaming: RequestInit & { readonly duplex: 'half' } = { method: 'POST', duplex: 'half', ...init }

  return app.request(new Request(`http://localhost${path}`, streaming), undefined, testEnv({ ENVIRONMENT: 'production' }))
}

describe('a body over the limit', () => {
  test('streamed without a length, is refused with 413 before more than the limit is read', async () => {
    const { type, bytes } = await multipart('cover', 8 * MiB)
    const { body, pulled } = streamed(bytes)
    const res = await send(createUploadsApp(), '/covers', { headers: { Accept: 'application/json', 'Content-Type': type }, body })

    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({
      code: 'WEB_VAL_007_BODY_TOO_LARGE',
      errors: { form: 'This request is too large: send at most 1 MB.' },
    })
    expect(pulled()).toBeLessThan(MiB + 256 * 1024)
  })

  test('with a declared Content-Length over the limit, is refused before a byte is read', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ text: 'x'.repeat(2 * MiB) }))

    for (const type of ['application/json', 'text/plain', 'application/x-www-form-urlencoded']) {
      const { body, pulled } = streamed(bytes)
      const res = await send(createUploadsApp(), '/notes', {
        headers: { Accept: 'application/json', 'Content-Type': type, 'Content-Length': String(bytes.byteLength) },
        body,
      })

      expect({ type, status: res.status, pulled: pulled() }).toEqual({ type, status: 413, pulled: 0 })
    }
  })

  test('sent as JSON or text without a length is refused too', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ text: 'x'.repeat(2 * MiB) }))

    for (const type of ['application/json', 'text/plain']) {
      const { body, pulled } = streamed(bytes)
      const res = await send(createUploadsApp(), '/notes', { headers: { Accept: 'application/json', 'Content-Type': type }, body })

      expect({ type, status: res.status, withinLimit: pulled() < MiB + 256 * 1024 }).toEqual({ type, status: 413, withinLimit: true })
    }
  })

  test("from a page's form goes back to the form, as a body that does not parse does", async () => {
    const res = await send(createUploadsApp(), '/notes', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'http://localhost/notes/new' },
      body: streamed(new TextEncoder().encode(`text=${'x'.repeat(2 * MiB)}`)).body,
    })

    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/notes/new')
    const flash = /popweb-flash=([^;]+)/.exec(res.headers.get('Set-Cookie') ?? '')?.[1] ?? ''

    expect(JSON.parse(Buffer.from(flash, 'base64url').toString())).toMatchObject({ errors: { form: 'This request is too large: send at most 1 MB.' } })
  })
})

describe('the body limit', () => {
  test("is raised by validateRequest's bodyLimit for an action that takes uploads", async () => {
    const { type, bytes } = await multipart('receipt', 2 * MiB)
    const res = await send(createUploadsApp(), '/receipts', { headers: { Accept: 'application/json', 'Content-Type': type }, body: streamed(bytes).body })

    expect(res.status).toBe(200)
  })

  test("is setupWeb's bodyLimit for every other action", async () => {
    const res = await send(createUploadsApp(1024), '/notes', {
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(2048) }),
    })

    expect(res.status).toBe(413)
    expect((await res.json()).errors.form).toBe('This request is too large: send at most 1 KB.')
  })

  test('that is not a number of bytes is a defect, not a client error', async () => {
    const res = await send(createUploadsApp(Number.NaN), '/notes', {
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    })

    expect(res.status).toBe(500)
  })

  test('leaves a body within it read once, for every validateRequest of the action', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

    routes.post('/notes', action(Effect.gen(function* () {
      const first = yield* validateRequest(Note)
      const second = yield* validateRequest(Note)

      return yield* json(Note, { text: `${first.text} ${second.text}` })
    })))

    for (const type of ['application/json', 'application/x-www-form-urlencoded']) {
      const body = type === 'application/json' ? JSON.stringify({ text: 'hi' }) : 'text=hi'
      const res = await send(app, '/notes', { headers: { Accept: 'application/json', 'Content-Type': type }, body })

      expect({ type, body: await res.json() }).toEqual({ type, body: { text: 'hi hi' } })
    }
  })
})
