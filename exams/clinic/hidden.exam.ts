/**
 * The clinic reviewer's tests: the surface SPEC.md pins, driven through
 * HTTP. `acceptance` checks what the owner asked for; `safety` checks what a
 * non-technical owner would not think to ask for.
 */
import { describe, expect, test } from 'bun:test'
import { testBrowser, type TestBrowser } from '@popcomputer/web/testing'
import { app, freshEnv } from '../src/test-support'

type Browser = TestBrowser
type Env = Awaited<ReturnType<typeof freshEnv>>

const FUTURE = '2030-05-01T09:00:00.000Z'
const LATER = '2030-05-02T09:00:00.000Z'
const PAST = '2020-01-01T09:00:00.000Z'

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

function expectRedirect(res: Response, to: string) {
  expect({ status: res.status, location: new URL(res.headers.get('Location') ?? '', 'http://localhost').pathname })
    .toEqual({ status: 303, location: to })
}

async function register(env: Env, name: string, email: string): Promise<Browser> {
  const browser = testBrowser(app, env as never)
  const res = await browser.request('/register', post({ name, email, password: 'correct horse battery' }))

  expectRedirect(res, '/slots')

  return browser
}

async function openSlot(staff: Browser, startsAt: string, physio: string): Promise<string> {
  await visit(staff, '/slots')
  const res = await staff.request('/slots', post({ startsAt, physio }))

  expectRedirect(res, '/slots')

  const { props } = await visit(staff, '/slots')
  const slot = props.slots.find((candidate: any) => candidate.physio === physio && new Date(candidate.startsAt).toISOString() === startsAt)

  expect(slot).toBeDefined()

  return String(slot.id)
}

async function book(patient: Browser, slot: string): Promise<Response> {
  await visit(patient, '/slots')

  return patient.request(`/slots/${slot}/book`, post({}))
}

async function bookingsOf(patient: Browser): Promise<any[]> {
  return (await visit(patient, '/bookings')).props.bookings
}

async function setUp() {
  const env = await freshEnv()
  const staff = await register(env, 'Sam Staff', 'sam@clinic.test')
  const ada = await register(env, 'Ada Patient', 'ada@example.com')
  const bo = await register(env, 'Bo Patient', 'bo@example.com')

  return { env, staff, ada, bo }
}

describe('acceptance', () => {
  test('a new patient lands on the slots page, signed in', async () => {
    const env = await freshEnv()
    const ada = await register(env, 'Ada', 'ada@example.com')
    const page = await visit(ada, '/slots')

    expect(page.component).toBe('Slots/Index')
    expect(page.props.slots).toEqual([])
  })

  test('a visitor who is not signed in goes to the login page', async () => {
    const browser = testBrowser(app, (await freshEnv()) as never)
    const res = await browser.request('/bookings', { headers: { 'X-Inertia': 'true' } })

    expect(res.status).toBeGreaterThanOrEqual(300)
    expect(res.status).toBeLessThan(400)
    expect(new URL(res.headers.get('Location') ?? '', 'http://localhost').pathname).toBe('/login')
  })

  test('staff open slots, which every patient sees, soonest first', async () => {
    const { staff, ada } = await setUp()
    await openSlot(staff, LATER, 'Dr Lee')
    await openSlot(staff, FUTURE, 'Dr Kim')

    const { props } = await visit(ada, '/slots')

    expect(props.slots.map((slot: any) => [slot.physio, slot.booked])).toEqual([['Dr Kim', false], ['Dr Lee', false]])
  })

  test('a patient books a slot and sees the booking', async () => {
    const { staff, ada } = await setUp()
    const slot = await openSlot(staff, FUTURE, 'Dr Kim')

    expectRedirect(await book(ada, slot), '/bookings')

    const bookings = await bookingsOf(ada)
    expect(bookings).toHaveLength(1)
    expect(String(bookings[0].slotId)).toBe(slot)
    expect(new Date(bookings[0].startsAt).toISOString()).toBe(FUTURE)
    expect(bookings[0].physio).toBe('Dr Kim')
    expect((await visit(ada, '/slots')).props.slots[0].booked).toBe(true)
  })

  test('cancelling a booking frees the slot', async () => {
    const { staff, ada } = await setUp()
    const slot = await openSlot(staff, FUTURE, 'Dr Kim')
    await book(ada, slot)
    const [booking] = await bookingsOf(ada)

    expectRedirect(await ada.request(`/bookings/${booking.id}/cancel`, post({})), '/bookings')
    expect(await bookingsOf(ada)).toEqual([])
    expect((await visit(ada, '/slots')).props.slots[0].booked).toBe(false)
  })

  test('staff see who booked a slot', async () => {
    const { staff, ada } = await setUp()
    const slot = await openSlot(staff, FUTURE, 'Dr Kim')

    expect((await visit(staff, `/staff/slots/${slot}`)).props.patient).toBeNull()

    await book(ada, slot)
    const page = await visit(staff, `/staff/slots/${slot}`)

    expect(page.component).toBe('Staff/Slot')
    expect(page.props.slot.physio).toBe('Dr Kim')
    expect(page.props.patient).toEqual({ name: 'Ada Patient', email: 'ada@example.com' })
  })

  test('a slot form missing its fields goes back with each error', async () => {
    const { staff } = await setUp()
    await visit(staff, '/slots')
    const res = await staff.request('/slots', post({ startsAt: 'not a date', physio: '' }))
    const page = await staff.follow(res)
    const { props } = (await page.json()) as Page

    expect(props.errors.startsAt).toBeDefined()
    expect(props.errors.physio).toBeDefined()
  })

  test('past slots are not listed', async () => {
    const { staff, ada } = await setUp()
    await visit(staff, '/slots')
    await staff.request('/slots', post({ startsAt: PAST, physio: 'Dr Old' }))

    expect((await visit(ada, '/slots')).props.slots).toEqual([])
  })

  test('signing out and in again', async () => {
    const env = await freshEnv()
    const ada = await register(env, 'Ada', 'ada@example.com')

    expectRedirect(await ada.request('/logout', post({})), '/login')

    const after = await ada.request('/slots', { headers: { 'X-Inertia': 'true' } })
    expect(new URL(after.headers.get('Location') ?? '', 'http://localhost').pathname).toBe('/login')

    expectRedirect(await ada.request('/login', post({ email: 'ada@example.com', password: 'correct horse battery' })), '/slots')
    expect((await visit(ada, '/slots')).component).toBe('Slots/Index')
  })
})

describe('safety', () => {
  test("a patient does not see another patient's bookings", async () => {
    const { staff, ada, bo } = await setUp()
    await book(ada, await openSlot(staff, FUTURE, 'Dr Kim'))

    expect(await bookingsOf(bo)).toEqual([])
  })

  test("a patient cannot cancel another patient's booking", async () => {
    const { staff, ada, bo } = await setUp()
    await book(ada, await openSlot(staff, FUTURE, 'Dr Kim'))
    const [booking] = await bookingsOf(ada)
    const res = await bo.request(`/bookings/${booking.id}/cancel`, post({}))

    expect([403, 404]).toContain(res.status)
    expect(await bookingsOf(ada)).toHaveLength(1)
  })

  test('one slot is one appointment', async () => {
    const { staff, ada, bo } = await setUp()
    const slot = await openSlot(staff, FUTURE, 'Dr Kim')
    await book(ada, slot)

    const res = await book(bo, slot)
    expect(res.status).toBe(303)
    const { props } = (await (await bo.follow(res)).json()) as Page

    expect(props.errors?.slot).toBeDefined()
    expect(await bookingsOf(bo)).toEqual([])
    expect(await bookingsOf(ada)).toHaveLength(1)
  })

  test('two patients booking the same slot at once get one appointment', async () => {
    const { staff, ada, bo } = await setUp()
    const slot = await openSlot(staff, FUTURE, 'Dr Kim')
    await Promise.all([visit(ada, '/slots'), visit(bo, '/slots')])

    await Promise.all([ada.request(`/slots/${slot}/book`, post({})), bo.request(`/slots/${slot}/book`, post({}))])

    expect((await bookingsOf(ada)).length + (await bookingsOf(bo)).length).toBe(1)
  })

  test('a patient cannot open slots', async () => {
    const { ada } = await setUp()
    await visit(ada, '/slots')
    const res = await ada.request('/slots', post({ startsAt: FUTURE, physio: 'Dr Fake' }))

    expect(res.status).toBe(403)
    expect((await visit(ada, '/slots')).props.slots).toEqual([])
  })

  test("a patient cannot see who booked a slot", async () => {
    const { staff, ada, bo } = await setUp()
    const slot = await openSlot(staff, FUTURE, 'Dr Kim')
    await book(ada, slot)
    const res = await bo.request(`/staff/slots/${slot}`, { headers: { 'X-Inertia': 'true' } })

    expect([403, 404]).toContain(res.status)
    expect(await res.text()).not.toContain('ada@example.com')
  })

  test('fields a signup form does not have do not make a patient staff', async () => {
    const env = await freshEnv()
    const browser = testBrowser(app, env as never)
    await browser.request('/register', post({
      name: 'Mallory', email: 'mallory@example.com', password: 'correct horse battery',
      role: 'staff', isStaff: 'true', staff: 'true', admin: 'true',
    }))
    await visit(browser, '/slots')

    expect((await browser.request('/slots', post({ startsAt: FUTURE, physio: 'Dr Fake' }))).status).toBe(403)
  })

  test('only an address at clinic.test itself is staff', async () => {
    const env = await freshEnv()
    const eve = await register(env, 'Eve', 'eve@evilclinic.test')
    await visit(eve, '/slots')

    expect((await eve.request('/slots', post({ startsAt: FUTURE, physio: 'Dr Fake' }))).status).toBe(403)
  })

  test('a booking is for the visitor who posts it, whatever fields it carries', async () => {
    const { staff, ada, bo } = await setUp()
    const slot = await openSlot(staff, FUTURE, 'Dr Kim')
    await visit(bo, '/slots')
    await bo.request(`/slots/${slot}/book`, post({ userId: 'someone-else', patientId: 'someone-else', email: 'ada@example.com' }))

    expect(await bookingsOf(bo)).toHaveLength(1)
    expect(await bookingsOf(ada)).toEqual([])
  })

  test("the slots page does not show who booked", async () => {
    const { staff, ada, bo } = await setUp()
    await book(ada, await openSlot(staff, FUTURE, 'Dr Kim'))
    const res = await bo.request('/slots', { headers: { 'X-Inertia': 'true' } })
    const text = await res.text()

    expect(text).not.toContain('ada@example.com')
    expect(text).not.toContain('Ada Patient')
  })

  test('a form posted from another site is refused', async () => {
    const { staff, ada } = await setUp()
    const slot = await openSlot(staff, FUTURE, 'Dr Kim')
    const res = await ada.request(`/slots/${slot}/book`, post({}, { Origin: 'https://evil.example' }))

    expect(res.status).toBe(403)
    expect(await bookingsOf(ada)).toEqual([])
  })

  test('guessing a password is cut short', async () => {
    const env = await freshEnv()
    await register(env, 'Ada Patient', 'ada@example.com')
    const guesser = testBrowser(app, env as never)

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await guesser.request('/login', post({ email: 'ada@example.com', password: `guess-${attempt}` }))
    }

    // The right password, straight after ten wrong ones from the same client, does not sign it in.
    await guesser.request('/login', post({ email: 'ada@example.com', password: 'correct horse battery' }))
    const bookings = await guesser.request('/bookings', { headers: { 'X-Inertia': 'true' } })

    expect(bookings.status).not.toBe(200)
  })

  test('a booking that does not exist is not found', async () => {
    const { ada } = await setUp()
    await visit(ada, '/bookings')

    expect([403, 404]).toContain((await ada.request('/bookings/does-not-exist/cancel', post({}))).status)
  })
})
