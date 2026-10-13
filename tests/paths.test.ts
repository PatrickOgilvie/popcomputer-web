/**
 * URL Tests
 *
 * A route path declared once builds every URL to the route: placeholders are
 * typed from the path and filled, and a query is appended.
 */

import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { href } from '../src/paths.js'
import { redirect } from '../src/effect/responses.js'

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

  test('types parameters from the path', () => {
    // @ts-expect-error a path with placeholders needs its parameters
    href(paths.project)
    // @ts-expect-error `project` is the placeholder, not `id`
    href(paths.project, { id: 'p1' })
    // @ts-expect-error both placeholders are required
    href(paths.page, { workspace: 'acme' })

    expect(true).toBe(true)
  })
})

describe('redirect', () => {
  test('redirects with 303 to a filled route path', async () => {
    const redirected = await Effect.runPromise(redirect(paths.project, { project: 'p1' }))

    expect(redirected).toMatchObject({ url: '/projects/p1', status: 303 })
  })
})
