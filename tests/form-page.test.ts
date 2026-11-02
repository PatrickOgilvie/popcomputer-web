/* oxlint-disable effecttsgo/async-function -- Test entrypoints call app.request, a native Promise contract. */
/**
 * A failed form goes back to the page it is on: the request's same-origin
 * Referer, else the page its action's `form(Schema, { page })` or its route's
 * `form` option names, else its own path when a page is registered there,
 * else `/`. A test that posts without visiting the page first sends no
 * Referer.
 */

import { describe, expect, test } from 'bun:test'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action, form } from '../src/effect/action.js'
import { RequireAuthLayer } from '../src/effect/auth.js'
import { redirect, render } from '../src/effect/responses.js'
import { requiredString } from '../src/effect/schema.js'
import { validateRequest } from '../src/effect/validation.js'

const paths = {
  home: '/',
  slots: '/slots',
  bookSlot: '/slots/{slot}/book',
  studio: '/studios/{studio}',
  briefs: '/studios/{studio}/briefs',
  feedback: '/feedback',
  reserve: '/slots/{slot}/reserve',
  pitch: '/studios/{studio}/pitch',
  review: '/studios/{studio}/review',
} as const

const Title = S.Struct({ title: requiredString })

/** An action whose form declares the page it is on. */
const onPage = (page?: string) => action(form(Title, { page }), () => redirect(paths.home))

const save = action(Effect.gen(function* () {
  yield* validateRequest(S.Struct({ title: requiredString }))

  return yield* redirect(paths.home)
}))

function createApp() {
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page), paths })

  routes
    .get(paths.slots, action(render('Slots/Index')))
    .post(paths.slots, save)
    .post(paths.bookSlot, save, { form: paths.slots })
    .post(paths.briefs, save, { form: paths.studio })
    .post(paths.feedback, save)
    .post(paths.reserve, onPage(paths.slots))
    .post(paths.pitch, onPage(paths.studio))
  routes.provide(RequireAuthLayer).post(paths.review, onPage(paths.studio))

  return { app, routes }
}

const post = (headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: 'title=',
})

const back = async (path: string, init = post()) => (await createApp().app.request(path, init)).headers.get('Location')

describe("a failed form without a Referer", () => {
  test('goes back to its own path when a page is registered there', async () => {
    expect(await back('/slots')).toBe('/slots')
  })

  test('goes back to the page its route names, with the placeholders the request filled', async () => {
    expect(await back('/slots/s1/book')).toBe('/slots')
    expect(await back('/studios/north%20west/briefs')).toBe('/studios/north%20west')
  })

  test('goes home when its route names no page and none is registered at its path', async () => {
    expect(await back('/feedback')).toBe('/')
  })

  test("goes back to the same-origin Referer when the request names one", async () => {
    expect(await back('/slots/s1/book', post({ Referer: 'http://localhost/slots?day=monday' }))).toBe('/slots?day=monday')
  })
})

describe("a form that declares its page with form(Schema, { page })", () => {
  test('goes back to that page, its placeholders filled from the route, when the request names none', async () => {
    expect(await back('/slots/s1/reserve')).toBe('/slots')
    expect(await back('/studios/north%20west/pitch')).toBe('/studios/north%20west')
  })

  test('goes back to a same-site Referer before it', async () => {
    expect(await back('/slots/s1/reserve', post({ Referer: 'http://localhost/slots?day=monday' }))).toBe('/slots?day=monday')
  })

  test('sends a signed-out visitor to sign in, to come back to that page', async () => {
    expect(await back('/studios/s1/review')).toBe(`/login?redirect=${encodeURIComponent('/studios/s1')}`)
  })

  test("is the route table's form", () => {
    const rows = createApp().routes.toJson()

    expect(rows.find((row) => row.method === 'post' && row.path === paths.reserve)?.form).toBe(paths.slots)
  })

  test('is refused at startup on a route whose path cannot fill it, that gives it twice, or that a form never posts to', () => {
    const routes = () => setupWeb(new Hono(), { version: '1', render: (page) => JSON.stringify(page), paths }).routes

    expect(() => routes().post(paths.feedback, onPage(paths.studio))).toThrow("whose {studio} its own path does not name")
    expect(() => routes().post(paths.reserve, onPage(paths.slots), { form: paths.slots })).toThrow('gives its form\'s page twice')
    expect(() => routes().get(paths.slots, onPage(paths.slots))).toThrow('is a page visit')
    expect(() => routes().jsonApi().post(paths.feedback, onPage(paths.slots))).toThrow('answers JSON')
    expect(() => routes().post(paths.reserve, onPage())).not.toThrow()
  })
})

// Checked by `bun run test:types`, never run: a form's page is a declared path its route's placeholders fill.
export function formPageIsDeclared() {
  const { routes } = setupWeb(new Hono(), { version: '1', render: (page) => JSON.stringify(page), paths })

  routes.post(paths.briefs, save, { form: paths.studio })
  // @ts-expect-error '/elsewhere' is not one of the declared paths
  routes.post(paths.feedback, save, { form: '/elsewhere' })
  // @ts-expect-error /feedback has no {studio} to fill the studio page's placeholder
  routes.post(paths.feedback, save, { form: paths.studio })
}
