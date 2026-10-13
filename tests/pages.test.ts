/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Page Registry Tests
 *
 * Registered pages type `render` and `WebPage` from one Effect Schema per
 * page, and `render` encodes props as JSON through it.
 */

import { describe, expect, test } from 'bun:test'
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { jsonOrRender, render } from '../src/effect/responses.js'
import type { PagePropsFor, WebPage } from '../src/react.js'
import { readPage } from '../src/testing.js'
import { coercedNumber, nullable, nullableDate, nullableString } from '../src/effect/schema.js'
import type { WebDeclaration } from '../src/effect/register.js'

const Project = S.Struct({ id: S.String, name: S.String, createdAt: S.Date })

// A query's filters, declared once from validators, are also the page's props.
const Filters = S.Struct({ from: nullableDate, minTasks: nullable(coercedNumber), search: nullableString })

const pages = {
  'Projects/Show': S.Struct({ project: Project, canEdit: S.Boolean }),
  'Projects/Search': S.Struct({ filters: Filters }),
  'Projects/Index': S.Struct({ projects: S.Array(Project), total: S.Number }),
  Dashboard: S.Struct({}),
}

declare module '../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{
      pages: typeof pages
    }>
  }
}

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const expectType = <T extends true>(): T | undefined => undefined

const apollo = { id: 'p1', name: 'Apollo', createdAt: new Date(Date.UTC(2026, 0, 2)) }

function createApp() {
  const app = new Hono()
  const { routes } = setupWeb(app, {
    version: '1',
    render: (page) => JSON.stringify(page),
    pages,
    errors: { component: 'Error' },
  })

  routes
    .get('/projects/p1', action(render('Projects/Show', { project: apollo, canEdit: true })))
    .get('/projects', action(jsonOrRender('Projects/Index', { projects: [apollo], total: 1 })))
    .get('/dashboard', action(render('Dashboard')))
    .get('/search', action(render('Projects/Search', {
      filters: { from: new Date(Date.UTC(2026, 0, 2)), minTasks: 3, search: null },
    })))
    // Only reachable by bypassing the types: a value outside the schema.
    .get('/broken', action(render('Projects/Show', {
      project: { ...apollo, createdAt: new Date(Number.NaN) },
      canEdit: false,
    })))

  return app
}

const page = { 'X-Inertia': 'true', 'X-Inertia-Version': '1' }

describe('render with registered pages', () => {
  test('encodes props as JSON through the page schema', async () => {
    const res = await createApp().request('/projects/p1', { headers: page })

    expect(await res.json()).toMatchObject({
      component: 'Projects/Show',
      props: { project: { id: 'p1', createdAt: '2026-01-02T00:00:00.000Z' }, canEdit: true },
    })
  })

  test('encodes props from their type, so a schema of validators serves as props', async () => {
    const res = await createApp().request('/search', { headers: page })

    expect((await res.json()).props.filters).toEqual({ from: '2026-01-02T00:00:00.000Z', minTasks: 3, search: null })
  })

  test('takes no props for a page whose schema needs none', async () => {
    const res = await createApp().request('/dashboard', { headers: page })

    expect((await res.json()).component).toBe('Dashboard')
  })

  test('is a defect naming the page when props do not encode', async () => {
    const res = await createApp().request('/broken', { headers: { Accept: 'application/json' } })

    expect(res.status).toBe(500)
  })

  test('accepts only registered pages and their props', () => {
    // @ts-expect-error 'Projects/Missing' is not a registered page
    render('Projects/Missing', {})
    // @ts-expect-error canEdit is required
    render('Projects/Show', { project: apollo })
    // @ts-expect-error a page with props needs them
    render('Projects/Show')
    // @ts-expect-error createdAt is a Date on the server
    render('Projects/Show', { project: { ...apollo, createdAt: '2026-01-02' }, canEdit: true })

    expect(true).toBe(true)
  })
})

describe('jsonOrRender with registered pages', () => {
  test('answers JSON clients with the encoded props, varying on Accept', async () => {
    const res = await createApp().request('/projects', { headers: { Accept: 'application/json' } })

    expect(res.headers.get('Vary')).toContain('Accept')
    expect(await res.json()).toEqual({
      projects: [{ id: 'p1', name: 'Apollo', createdAt: '2026-01-02T00:00:00.000Z' }],
      total: 1,
    })
  })

  test('renders the page for a visit, varying on Accept', async () => {
    const res = await createApp().request('/projects', { headers: page })

    expect(res.headers.get('Vary')).toContain('Accept')
    expect((await res.json()).props.total).toBe(1)
  })
})

describe('WebPage', () => {
  test('types a component with the JSON form of its page props', () => {
    type ShowProps = Parameters<WebPage<'Projects/Show'>>[0]

    expectType<Equals<ShowProps['project'], { readonly id: string; readonly name: string; readonly createdAt: string }>>()
    expectType<Equals<ShowProps['canEdit'], boolean>>()
    expectType<Equals<PagePropsFor<'Projects/Index'>['projects'], ReadonlyArray<ShowProps['project']>>>()

    const Show: WebPage<'Projects/Show'> = ({ project, errors }) => `${project.name} ${Object.keys(errors).length}`

    expect(Show({ project: { id: 'p1', name: 'Apollo', createdAt: '2026-01-02' }, canEdit: true, auth: { user: null }, errors: {} })).toBe('Apollo 0')
  })
})

describe('readPage', () => {
  test('reads a rendered page typed by the registry', async () => {
    const show = await readPage(await createApp().request('/projects/p1', { headers: page }), 'Projects/Show')
    const createdAt: string = show.props.project.createdAt

    expect(createdAt).toBe('2026-01-02T00:00:00.000Z')
    expect(show.props.canEdit).toBe(true)
  })

  test('rejects a response that rendered another page', async () => {
    const res = await createApp().request('/dashboard', { headers: page })

    await expect(readPage(res, 'Projects/Show')).rejects.toThrow("rendered 'Dashboard'")
  })

  test('rejects a response that is not a page', async () => {
    const res = await createApp().request('/projects/p1')

    await expect(readPage(res, 'Projects/Show')).rejects.toThrow('X-Inertia: true')
  })
})
