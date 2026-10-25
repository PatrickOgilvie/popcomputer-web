/**
 * URL Tests
 *
 * A route path declared once builds every URL to the route: placeholders are
 * typed from the path and filled, and a query is appended.
 */

import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { Hono } from 'hono'
import { href } from '../src/paths.js'
import { setupWeb } from '../src/setup.js'
import { action } from '../src/effect/action.js'
import { json, redirect } from '../src/effect/responses.js'

const paths = {
  projects: '/projects',
  project: '/projects/{project}',
  page: '/w/{workspace:slug}/pages/{page:slug}',
} as const

describe('href', () => {
  test('fills placeholders, including those naming a lookup column', () => {
    expect(href(paths.project, { project: 'p1' })).toBe('/projects/p1')
    expect(href(paths.page, { workspace: 'acme', page: 'intro' })).toBe('/w/acme/pages/intro')
  })

  test('encodes parameter values and appends a query, leaving out empty values', () => {
    expect(href(paths.project, { project: 'a b/c' })).toBe('/projects/a%20b%2Fc')
    expect(href(paths.projects, {}, { page: 2, q: 'launch day', archived: undefined })).toBe('/projects?page=2&q=launch+day')
  })

  test('takes no parameters for a path without placeholders', () => {
    expect(href(paths.projects)).toBe('/projects')
  })

  // A URL drops '.', and the segment before '..', and an empty first segment
  // makes the path //host: a label named '..' would reach its project's route.
  // A URL reads '%2e' as a dot too, so no escape keeps such a value.
  test("leaves a value that would not be one path segment unfilled: '', '.' or '..', so the URL stays on its route and site", () => {
    for (const value of ['', '.', '..']) {
      const link = href(paths.project, { project: value })
      const elsewhere = href('/{owner}/{repo}', { owner: value, repo: 'evil.example' })

      expect([link, elsewhere]).toEqual(['/projects/{project}', '/{owner}/evil.example'])
      expect(new URL(link, 'https://app.example/projects/p1').href).toBe('https://app.example/projects/%7Bproject%7D')
      expect(new URL(elsewhere, 'https://app.example/').href).toBe('https://app.example/%7Bowner%7D/evil.example')
    }

    // Escaped dots stay one segment, since href encodes the '%' too.
    expect(href(paths.project, { project: '%2e%2e' })).toBe('/projects/%252e%252e')
    expect(href(paths.project, { project: '...' })).toBe('/projects/...')
    expect(href(paths.project, { project: 0 })).toBe('/projects/0')
  })
})

// Checked by `bun run test:types`, never run: href types parameters from the path.
export function hrefTypesParameters() {
  // @ts-expect-error a path with placeholders needs its parameters
  href(paths.project)
  // @ts-expect-error `project` is the placeholder, not `id`
  href(paths.project, { id: 'p1' })
  // @ts-expect-error both placeholders are required
  href(paths.page, { workspace: 'acme' })
}

describe('redirect', () => {
  test('redirects with 303 to a filled route path', async () => {
    const redirected = await Effect.runPromise(redirect(paths.project, { project: 'p1' }))

    expect(redirected).toMatchObject({ url: '/projects/p1', status: 303 })
  })
})

// An organization's slug is stored as its admin sets it, and Better Auth's
// plugin takes '..'. Pages and jobs list every organization a visitor or a
// tenant has, so one slug must not take them down for everyone else.
describe('a stored value that cannot be one path segment', () => {
  const organizations = [{ name: 'Acme', slug: 'acme' }, { name: 'Dots', slug: '..' }, { name: 'Gamma', slug: 'gamma' }]
  const links = () => organizations.map((organization) => `${organization.name} ${href('/orgs/{organization:slug}', { organization: organization.slug })}`)
  const listed = ['Acme /orgs/acme', 'Dots /orgs/{organization}', 'Gamma /orgs/gamma']

  test('fails only its own link on a page that lists it', async () => {
    const app = new Hono()
    const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })
    routes.get('/orgs', action(Effect.suspend(() => json(links()))))

    const res = await app.request('/orgs')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(listed)
  })

  test('fails only its own line in a job that lists every tenant', async () => {
    const { routes } = setupWeb(new Hono(), { version: '1', render: (page) => JSON.stringify(page) })
    const sent: string[] = []
    const digest = routes.scheduled(() => Effect.sync(() => sent.push(...links())))

    await digest({ cron: '0 7 * * *', scheduledTime: 0 }, {})

    expect(sent).toEqual(listed)
  })
})
