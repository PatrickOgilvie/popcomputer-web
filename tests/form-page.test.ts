/* oxlint-disable effecttsgo/async-function -- Test entrypoints call app.request, a native Promise contract. */
/**
 * A failed form goes back to the page it is on: the request's same-origin
 * Referer, else the page its route names with `form`, else its own path when
 * a page is registered there, else home. A test that posts without visiting
 * the page first sends no Referer.
 */

import { describe, expect, test } from 'bun:test'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
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
} as const

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

  return app
}

const post = (headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: 'title=',
})

const back = async (path: string, init = post()) => (await createApp().request(path, init)).headers.get('Location')

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

// Checked by `bun run test:types`, never run: a form's page is a declared path its route's placeholders fill.
export function formPageIsDeclared() {
  const { routes } = setupWeb(new Hono(), { version: '1', render: (page) => JSON.stringify(page), paths })

  routes.post(paths.briefs, save, { form: paths.studio })
  // @ts-expect-error '/elsewhere' is not one of the declared paths
  routes.post(paths.feedback, save, { form: '/elsewhere' })
  // @ts-expect-error /feedback has no {studio} to fill the studio page's placeholder
  routes.post(paths.feedback, save, { form: paths.studio })
}
