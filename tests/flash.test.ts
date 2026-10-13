/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Flash Tests
 *
 * A failed form submission goes back to the form, whose next render shows the
 * field errors; `flash(key, value)` reaches the next page's Inertia `flash`.
 * Both travel in a cookie that the next visit reads and clears.
 */

import { describe, expect, test } from 'bun:test'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { flash, redirect, render } from '../src/effect/responses.js'
import { positiveInt, requiredString } from '../src/effect/schema.js'
import { validateRequest } from '../src/effect/validation.js'
import { ValidationError } from '../src/effect/errors.js'

const CreateProject = S.Struct({ name: requiredString })

function createApp() {
  const app = new Hono()
  const { routes } = setupWeb(app, {
    version: '1',
    render: (page) => JSON.stringify(page),
    errors: { component: 'Error' },
  })

  routes
    .get('/projects/new', action(render('Projects/New', { title: 'New project' })))
    .get('/projects', action(render('Projects/Index')))
    .post('/projects', action(Effect.gen(function* () {
      const input = yield* validateRequest(CreateProject)
      yield* flash('success', `Created ${input.name}.`)

      return yield* redirect('/projects')
    })))
    .post('/notes', action(Effect.gen(function* () {
      yield* flash('saved', true)

      return yield* render('Notes/Show')
    })))
    .post('/claims/1/submit', action(Effect.fail(new ValidationError({
      errors: { 'items.0.amount': 'The items add up to more than the claim.' },
      redirectTo: '/claims/1/items',
    }))))
    .get('/claims/1/items', action(render('Claims/Items')))
    .post('/sessions', action(Effect.gen(function* () {
      yield* flash('success', 'Signed in.')

      return new Response(null, {
        status: 303,
        headers: { Location: '/projects', 'Set-Cookie': 'session=s1; Path=/; HttpOnly' },
      })
    })))
    .get('/search', action(Effect.gen(function* () {
      const query = yield* validateRequest(S.Struct({ page: positiveInt }))

      return yield* render('Search', { page: query.page })
    })))

  return app
}

const page = { 'X-Inertia': 'true', 'X-Inertia-Version': '1' }

const submit = (app: Hono, body: object, headers: Record<string, string> = {}) =>
  app.request('/projects', {
    method: 'POST',
    headers: { ...page, 'Content-Type': 'application/json', Referer: 'http://localhost/projects/new', ...headers },
    body: JSON.stringify(body),
  })

/** The `name=value` pair a browser sends back for the response's flash cookie. */
const flashCookie = (res: Response) =>
  res.headers.getSetCookie().find((cookie) => cookie.includes('popweb-flash'))?.split(';')[0] ?? ''

describe('a failed form submission', () => {
  test('goes back to the form, whose next render shows the errors once', async () => {
    const app = createApp()
    const failed = await submit(app, { name: '' })

    expect(failed.status).toBe(303)
    expect(failed.headers.get('Location')).toBe('/projects/new')
    expect(failed.headers.getSetCookie()[0]).toMatch(/^popweb-flash=.+; Max-Age=60; Path=\/; HttpOnly; SameSite=Lax$/)

    const form = await app.request('/projects/new', { headers: { ...page, Cookie: flashCookie(failed) } })
    const formPage = await form.json()

    expect(formPage.props.title).toBe('New project')
    expect(Object.keys(formPage.props.errors)).toEqual(['name'])
    expect(form.headers.getSetCookie()[0]).toMatch(/^popweb-flash=; Max-Age=0/)

    const again = await app.request('/projects/new', { headers: page })
    expect((await again.json()).props.errors).toEqual({})
  })

  test('goes to the page the errors belong on when the failure names one', async () => {
    const app = createApp()
    const failed = await app.request('/claims/1/submit', {
      method: 'POST',
      headers: { ...page, Referer: 'http://localhost/claims/1/review' },
    })
    const items = await app.request('/claims/1/items', { headers: { ...page, Cookie: flashCookie(failed) } })

    expect(failed.headers.get('Location')).toBe('/claims/1/items')
    expect((await items.json()).props.errors).toEqual({ 'items.0.amount': 'The items add up to more than the claim.' })
  })

  test('nests the errors under the error bag the form names', async () => {
    const app = createApp()
    const failed = await submit(app, { name: '' }, { 'X-Inertia-Error-Bag': 'createProject' })
    const form = await app.request('/projects/new', { headers: { ...page, Cookie: flashCookie(failed) } })

    expect(Object.keys((await form.json()).props.errors.createProject)).toEqual(['name'])
  })

  test('goes to the home page when the referring page is on another site', async () => {
    const failed = await submit(createApp(), { name: '' }, { Referer: 'https://elsewhere.example/form' })

    expect(failed.headers.get('Location')).toBe('/')
  })

  test('leaves the errors for the visit when Inertia prefetches the page', async () => {
    const app = createApp()
    const cookie = flashCookie(await submit(app, { name: '' }))

    const prefetch = await app.request('/projects/new', { headers: { ...page, Purpose: 'prefetch', Cookie: cookie } })
    const visit = await app.request('/projects/new', { headers: { ...page, Cookie: cookie } })

    expect((await prefetch.json()).props.errors).toEqual({})
    expect(prefetch.headers.getSetCookie()).toEqual([])
    expect(Object.keys((await visit.json()).props.errors)).toEqual(['name'])
  })

  test('uses a __Host- cookie over HTTPS, which subdomains cannot set', async () => {
    const app = createApp()
    const failed = await app.request('https://example.com/projects', {
      method: 'POST',
      headers: { ...page, 'Content-Type': 'application/json', Referer: 'https://example.com/projects/new' },
      body: JSON.stringify({ name: '' }),
    })

    expect(failed.headers.getSetCookie()[0]).toMatch(/^__Host-popweb-flash=.+; Path=\/; HttpOnly; Secure; SameSite=Lax$/)
  })
})

describe('flash', () => {
  test('reaches the page the redirect renders', async () => {
    const app = createApp()
    const created = await submit(app, { name: 'Apollo' })
    const index = await app.request('/projects', { headers: { ...page, Cookie: flashCookie(created) } })

    expect(created.headers.get('Location')).toBe('/projects')
    expect((await index.json()).flash).toEqual({ success: 'Created Apollo.' })
  })

  test('reaches the next page when the response sets its own cookies', async () => {
    const res = await createApp().request('/sessions', { method: 'POST', headers: page })
    const cookies = res.headers.getSetCookie()

    expect(cookies).toContain('session=s1; Path=/; HttpOnly')
    expect(cookies.some((cookie) => cookie.startsWith('popweb-flash='))).toBe(true)
  })

  test('reaches the page the same request renders, without a cookie', async () => {
    const res = await createApp().request('/notes', { method: 'POST', headers: page })

    expect((await res.json()).flash).toEqual({ saved: true })
    expect(res.headers.getSetCookie()).toEqual([])
  })

  test('ignores a cookie the server did not write', async () => {
    const res = await createApp().request('/projects', {
      headers: { ...page, Cookie: 'popweb-flash=bm90LWpzb24' },
    })
    const body = await res.json()

    expect(body.props.errors).toEqual({})
    expect(body.flash).toEqual({})
  })
})

describe('invalid query parameters on a page visit', () => {
  test('render the error page with 422', async () => {
    const res = await createApp().request('/search?page=first', { headers: page })

    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ component: 'Error', props: { status: 422 } })
  })
})
