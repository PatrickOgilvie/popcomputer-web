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

  // A URL drops '.', and the segment before '..', and an empty first segment
  // makes the path //host: a label named '..' would reach its project's route.
  test("throws for a value that would not be one path segment: '', '.' or '..'", () => {
    for (const value of ['', '.', '..']) {
      expect(() => href(paths.project, { project: value })).toThrow("cannot take")
      expect(() => href('/{owner}/{repo}', { owner: value, repo: 'evil.example' })).toThrow('not be one path segment')
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
