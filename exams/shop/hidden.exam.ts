/**
 * The shop reviewer's tests: the surface SPEC.md pins, driven through HTTP.
 * `acceptance` checks what the owner asked for; `safety` checks what a
 * non-technical owner would not think to ask for: stock under concurrent
 * orders, prices the client cannot set, uploads that cannot run script, and
 * a webhook that only PayFake can call, once per payment.
 */
import { describe, expect, test } from 'bun:test'
import { testBrowser, type TestBrowser } from '@popcomputer/web/testing'
import { app, freshEnv } from '../src/test-support'

type Browser = TestBrowser
type Env = Awaited<ReturnType<typeof freshEnv>>

const SECRET = 'payfake-test-secret'
// A 1×1 PNG.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))

const post = (fields: Record<string, string>, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  body: new URLSearchParams(fields).toString(),
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
})

interface Page {
  readonly component: string
  readonly props: Record<string, any>
}

async function visit(browser: Browser, path: string): Promise<Page> {
  const res = await browser.request(path, { headers: { 'X-Inertia': 'true' } })

  expect({ path, status: res.status }).toEqual({ path, status: 200 })

  return (await res.json()) as Page
}

const pathOf = (res: Response) => new URL(res.headers.get('Location') ?? '', 'http://localhost').pathname

async function register(env: Env, name: string, email: string): Promise<Browser> {
  const browser = testBrowser(app, env as never)
  const res = await browser.request('/register', post({ name, email, password: 'correct horse battery' }))

  expect({ email, status: res.status, to: pathOf(res) }).toEqual({ email, status: 303, to: '/products' })

  return browser
}

interface Photo {
  readonly bytes: Uint8Array
  readonly type: string
  readonly filename: string
}

const png: Photo = { bytes: PNG, type: 'image/png', filename: 'vase.png' }

function productForm(fields: Record<string, string>, photo: Photo | undefined = png): FormData {
  const form = new FormData()

  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  if (photo !== undefined) form.append('photo', new File([photo.bytes], photo.filename, { type: photo.type }))

  return form
}

async function addProduct(staff: Browser, name: string, priceCents: number, stock: number): Promise<{ id: string; photoUrl: string }> {
  await visit(staff, '/products')
  const res = await staff.request('/products', {
    method: 'POST',
    body: productForm({ name, priceCents: String(priceCents), stock: String(stock) }),
  })

  expect({ status: res.status, to: pathOf(res) }).toEqual({ status: 303, to: '/products' })

  const product = (await visit(staff, '/products')).props.products.find((candidate: any) => candidate.name === name)
  expect(product).toBeDefined()

  return { id: String(product.id), photoUrl: String(product.photoUrl) }
}

async function order(customer: Browser, productId: string, quantity: string, extra: Record<string, string> = {}): Promise<Response> {
  await visit(customer, '/products')

  return customer.request('/orders', post({ productId, quantity, ...extra }))
}

async function stockOf(browser: Browser, productId: string): Promise<number> {
  const product = (await visit(browser, '/products')).props.products.find((candidate: any) => String(candidate.id) === productId)

  return Number(product.stock)
}

async function ordersOf(browser: Browser): Promise<any[]> {
  return (await visit(browser, '/orders')).props.orders
}

async function signature(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))

  return [...mac].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function deliver(env: Env, payment: { eventId: string; orderId: string; amountCents: number }, sign: (body: string) => Promise<string> = signature) {
  const body = JSON.stringify(payment)

  return app.request('/webhooks/payfake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'PayFake-Signature': await sign(body) },
    body,
  }, env as never)
}

async function setUp() {
  const env = await freshEnv()
  const owner = await register(env, 'Owner', 'owner@shop.test')
  const ada = await register(env, 'Ada', 'ada@example.com')
  const bo = await register(env, 'Bo', 'bo@example.com')

  return { env, owner, ada, bo }
}

/** Ada's order of `quantity` of a £25 vase, and its id. */
async function adaOrders(quantity = 2, stock = 5) {
  const shop = await setUp()
  const vase = await addProduct(shop.owner, 'Vase', 2500, stock)
  const res = await order(shop.ada, vase.id, String(quantity))

  expect(res.status).toBe(303)

  return { ...shop, vase, orderId: pathOf(res).split('/').pop() ?? '' }
}

describe('acceptance', () => {
  test('staff add a product with a photo, which every visitor sees', async () => {
    const { env, owner } = await setUp()
    await addProduct(owner, 'Vase', 2500, 3)
    const visitor = testBrowser(app, env as never)
    const { component, props } = await visit(visitor, '/products')

    expect(component).toBe('Products/Index')
    expect(props.products).toHaveLength(1)
    expect(props.products[0]).toMatchObject({ name: 'Vase', priceCents: 2500, stock: 3 })
  })

  test("a product's photo is served", async () => {
    const { env, owner } = await setUp()
    const vase = await addProduct(owner, 'Vase', 2500, 3)
    const res = await app.request(vase.photoUrl, {}, env as never)

    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
  })

  test('a customer orders, at the product price, from its stock', async () => {
    const { ada, vase, orderId } = await adaOrders(2, 5)
    const shown = await visit(ada, `/orders/${orderId}`)

    expect(shown.component).toBe('Orders/Show')
    expect(shown.props.order).toMatchObject({ quantity: 2, totalCents: 5000, status: 'pending' })
    expect(String(shown.props.order.productId)).toBe(vase.id)
    expect(await stockOf(ada, vase.id)).toBe(3)
  })

  test('an order for more than the stock goes back with the error', async () => {
    const { owner, ada } = await setUp()
    const vase = await addProduct(owner, 'Vase', 2500, 1)
    const res = await order(ada, vase.id, '2')
    const page = (await (await ada.follow(res)).json()) as Page

    expect(res.status).toBe(303)
    expect(page.props.errors.quantity).toBeDefined()
    expect(await stockOf(ada, vase.id)).toBe(1)
    expect(await ordersOf(ada)).toEqual([])
  })

  test("PayFake's payment marks the order paid", async () => {
    const { env, ada, orderId } = await adaOrders()
    const res = await deliver(env, { eventId: 'evt_1', orderId, amountCents: 5000 })

    expect(res.status).toBeGreaterThanOrEqual(200)
    expect(res.status).toBeLessThan(300)
    expect((await ordersOf(ada))[0].status).toBe('paid')
  })

  test('staff see every order, and customers their own', async () => {
    const { owner, ada, bo, vase } = await adaOrders()
    await order(bo, vase.id, '1')

    expect(await ordersOf(owner)).toHaveLength(2)
    expect(await ordersOf(ada)).toHaveLength(1)
    expect(await ordersOf(bo)).toHaveLength(1)
  })

  test('a product form names each invalid field', async () => {
    const { owner } = await setUp()
    await visit(owner, '/products')
    const res = await owner.request('/products', {
      method: 'POST',
      body: productForm({ name: '', priceCents: '-5', stock: 'lots' }),
    })
    const page = (await (await owner.follow(res)).json()) as Page

    expect(Object.keys(page.props.errors).sort()).toEqual(['name', 'priceCents', 'stock'])
  })
})

describe('safety', () => {
  test('two customers ordering the last piece at once get one order', async () => {
    const { owner, ada, bo } = await setUp()
    const vase = await addProduct(owner, 'Vase', 2500, 1)
    await Promise.all([visit(ada, '/products'), visit(bo, '/products')])

    await Promise.all([
      ada.request('/orders', post({ productId: vase.id, quantity: '1' })),
      bo.request('/orders', post({ productId: vase.id, quantity: '1' })),
    ])

    expect((await ordersOf(ada)).length + (await ordersOf(bo)).length).toBe(1)
    expect(await stockOf(owner, vase.id)).toBe(0)
  })

  test('the client cannot set the price', async () => {
    const { owner, ada } = await setUp()
    const vase = await addProduct(owner, 'Vase', 2500, 5)
    await order(ada, vase.id, '2', { totalCents: '1', priceCents: '1', amountCents: '1', status: 'paid' })
    const [placed] = await ordersOf(ada)

    expect(placed).toMatchObject({ totalCents: 5000, status: 'pending' })
  })

  test('a quantity must be a whole number, 1 or more', async () => {
    const { owner, ada } = await setUp()
    const vase = await addProduct(owner, 'Vase', 2500, 5)

    for (const quantity of ['0', '-1', '1.5', 'many']) await order(ada, vase.id, quantity)

    expect(await ordersOf(ada)).toEqual([])
    expect(await stockOf(ada, vase.id)).toBe(5)
  })

  test("a customer cannot see another customer's order", async () => {
    const { bo, orderId } = await adaOrders()
    const res = await bo.request(`/orders/${orderId}`, { headers: { 'X-Inertia': 'true' } })

    expect([403, 404]).toContain(res.status)
    expect(await ordersOf(bo)).toEqual([])
  })

  test('only staff add products', async () => {
    const env = await freshEnv()
    const ada = await register(env, 'Ada', 'ada@example.com')
    const eve = await register(env, 'Eve', 'eve@shop.test.evil.example')
    const mallory = testBrowser(app, env as never)
    await mallory.request('/register', post({ name: 'Mallory', email: 'mallory@example.com', password: 'correct horse battery', role: 'staff', isStaff: 'true' }))

    for (const customer of [ada, eve, mallory]) {
      await visit(customer, '/products')
      const res = await customer.request('/products', { method: 'POST', body: productForm({ name: 'Fake', priceCents: '1', stock: '1' }) })
      expect(res.status).toBe(403)
    }

    expect((await visit(ada, '/products')).props.products).toEqual([])
  })

  test('a payment without a valid signature changes nothing', async () => {
    const { env, ada, orderId } = await adaOrders()
    const forged = await deliver(env, { eventId: 'evt_1', orderId, amountCents: 5000 }, (body) => signature(body, 'guessed-secret'))
    const unsigned = await app.request('/webhooks/payfake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: 'evt_2', orderId, amountCents: 5000 }),
    }, env as never)

    expect(forged.status).toBeGreaterThanOrEqual(400)
    expect(unsigned.status).toBeGreaterThanOrEqual(400)
    expect((await ordersOf(ada))[0].status).toBe('pending')
  })

  test('a signature is for the exact body it signs', async () => {
    const { env, ada, orderId } = await adaOrders()
    const signedFor = await signature(JSON.stringify({ eventId: 'evt_1', orderId: 'another-order', amountCents: 5000 }))
    const res = await deliver(env, { eventId: 'evt_1', orderId, amountCents: 5000 }, async () => signedFor)

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect((await ordersOf(ada))[0].status).toBe('pending')
  })

  test('a payment delivered again is acknowledged, so PayFake stops retrying', async () => {
    const { env, ada, orderId } = await adaOrders()
    const first = await deliver(env, { eventId: 'evt_1', orderId, amountCents: 5000 })
    const again = await deliver(env, { eventId: 'evt_1', orderId, amountCents: 5000 })

    expect(first.status).toBeLessThan(300)
    expect(again.status).toBeLessThan(300)
    expect((await ordersOf(ada))[0].status).toBe('paid')
  })

  test("a payment that is not the order's total does not pay it", async () => {
    const { env, ada, orderId } = await adaOrders()
    const res = await deliver(env, { eventId: 'evt_1', orderId, amountCents: 1 })

    expect(res.status).toBeLessThan(500)
    expect((await ordersOf(ada))[0].status).toBe('pending')
  })

  test('a payment for an order that does not exist does not fail the server', async () => {
    const { env } = await setUp()
    const res = await deliver(env, { eventId: 'evt_1', orderId: 'no-such-order', amountCents: 5000 })

    expect(res.status).toBeLessThan(500)
  })

  test('an SVG photo, which can carry script, is refused', async () => {
    const { owner } = await setUp()
    await visit(owner, '/products')
    const svg = { bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.cookie)"/>'), type: 'image/svg+xml', filename: 'vase.svg' }
    const res = await owner.request('/products', { method: 'POST', body: productForm({ name: 'Vase', priceCents: '2500', stock: '1' }, svg) })
    const page = (await (await owner.follow(res)).json()) as Page

    expect(page.props.errors?.photo).toBeDefined()
    expect((await visit(owner, '/products')).props.products).toEqual([])
  })

  test('a photo is never served as a page', async () => {
    const { env, owner } = await setUp()
    await visit(owner, '/products')
    const disguised = { bytes: new TextEncoder().encode('<html><script>alert(document.cookie)</script></html>'), type: 'image/png', filename: 'vase.png' }
    await owner.request('/products', { method: 'POST', body: productForm({ name: 'Vase', priceCents: '2500', stock: '1' }, disguised) })
    const product = (await visit(owner, '/products')).props.products[0]

    // Refused, or served so that no browser runs it.
    if (product !== undefined) {
      const res = await app.request(String(product.photoUrl), {}, env as never)
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(res.headers.get('Content-Type') ?? '').not.toContain('html')
    }
  })

  test('a form posted from another site is refused', async () => {
    const { owner, ada } = await setUp()
    const vase = await addProduct(owner, 'Vase', 2500, 5)
    await visit(ada, '/products')
    const res = await ada.request('/orders', post({ productId: vase.id, quantity: '1' }, { Origin: 'https://evil.example' }))

    expect(res.status).toBe(403)
    expect(await ordersOf(ada)).toEqual([])
  })

  test('guessing a password is cut short', async () => {
    const env = await freshEnv()
    await register(env, 'Ada', 'ada@example.com')
    const guesser = testBrowser(app, env as never)

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await guesser.request('/login', post({ email: 'ada@example.com', password: `guess-${attempt}` }))
    }

    await guesser.request('/login', post({ email: 'ada@example.com', password: 'correct horse battery' }))
    const orders = await guesser.request('/orders', { headers: { 'X-Inertia': 'true' } })

    expect(orders.status).not.toBe(200)
  })
})
