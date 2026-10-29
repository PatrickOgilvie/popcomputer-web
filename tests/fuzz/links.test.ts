/**
 * Every URL the framework builds from a visitor's or a record's text must
 * stay on its route and on this site, as a browser resolves it. Generated
 * values find again run-1's placeholders filled with `..`, `.` or nothing
 * (C17), 1.5.0's `href` throwing for a stored `..` (run-2 F16), and run-1's
 * same-origin Referer whose path begins `//` (N9). The browser's own
 * resolution, `new URL`, is the oracle. Two cases the properties found on
 * 1.6.0 are kept as tests of their own.
 */
import { describe, expect, test } from 'bun:test'
import { Arbitrary, Schema as S } from 'effect'
import { sameOriginReferer } from '../../src/effect/referer'
import { href } from '../../src/paths'
import { as, asJson, createApp } from '../security/app'
import { anyText, oneOf, pick, property, show, textOf } from './property'

const ORIGIN = 'https://app.test'

/** Whether a browser on this site, given `target` as a Location, stays on it at a path that names no other host. */
function staysOnSite(target: string, page = `${ORIGIN}/form`): string | undefined {
  if (!URL.canParse(target, page)) return `${show(target)} is no URL a browser can follow`

  const resolved = new URL(target, page)

  if (resolved.origin !== new URL(page).origin) return `${show(target)} resolves to ${resolved.origin}`
  if (resolved.pathname.startsWith('//')) return `${show(target)} resolves to the path ${resolved.pathname}`

  return undefined
}

/** Pieces a crafted path is made of: slashes either way, dot segments, encodings and control characters. */
const PATH_PIECES = ['/', 'a', '//', '\\', '.', '..', 'evil.test', '%2f', '%5c', '%2e', '?', '#', '@', ':', '\t', '\n', ' ', '\u0000'] as const

describe('href', () => {
  const VALUES = ['p1', '', '.', '..', '/', '\\', '%2e', '.%2e', '..%2f', '?', '#', ' ', 'é', '%', '{x}', '\u0000'] as const
  const value = oneOf<string | number | undefined>(pick(VALUES), anyText, pick([0, 7, -1]), Arbitrary.Constant(undefined))
  const template = Arbitrary.map(
    Arbitrary.array(pick(['projects', '{x}', '{y}', '{z:slug}', 'a-b']), { minLength: 1, maxLength: 4 }),
    (segments) => `/${segments.join('/')}`
  )

  // SAFETY: the template is generated, so its parameters cannot be typed
  // from it; href's runtime takes any record of values.
  const build = href as (path: string, params: Readonly<Record<string, string | number | undefined>>) => string

  property(
    'fills each placeholder with one segment of its route, or leaves it unfilled',
    Arbitrary.all([template, Arbitrary.all({ x: value, y: value, z: value })]),
    ([path, params]) => {
      let built: string

      try {
        built = build(path, params)
      } catch (error) {
        return `threw ${String(error)}`
      }

      const resolved = new URL(built, `${ORIGIN}/`)

      if (resolved.origin !== ORIGIN) return `${built} leaves the site`

      const segments = resolved.pathname.split('/').slice(1).map(decodeURIComponent)
      const expected = path.split('/').slice(1).map((segment) => {
        const name = /^\{([^}:]+)/.exec(segment)?.[1]

        if (name === undefined) return segment

        const given = new Map(Object.entries(params)).get(name)
        let encoded = ''

        try {
          encoded = given === undefined ? '' : encodeURIComponent(String(given))
        } catch {
          // A lone surrogate, which no URL can carry: the placeholder stays.
        }

        return encoded === '' || encoded === '.' || encoded === '..' ? `{${name}}` : String(given)
      })

      return show(segments) === show(expected)
        ? undefined
        : `${path} with ${show(params)} built ${built}, a browser's path ${resolved.pathname}`
    }
  )

  test('leaves a placeholder unfilled for text with a lone surrogate, which a JSON body can store', () => {
    expect(href('/orgs/{organization}', { organization: '\ud800' })).toBe('/orgs/{organization}')
  })
})

describe('sameOriginReferer', () => {
  const referer = oneOf(
    Arbitrary.map(
      Arbitrary.all([
        pick(['https://', 'http://', 'HTTPS://', 'https:/', 'https:\\\\', '//']),
        pick(['', 'user@', 'app.test@', 'evil.test@']),
        pick(['app.test', 'evil.test', 'APP.TEST', 'app.test.', 'app.test:443', 'app.test:8443', 'app.test\\evil.test']),
        textOf(PATH_PIECES, 6),
      ]),
      (parts) => parts.join('')
    ),
    anyText
  )

  property('returns only a path a browser keeps on this site', referer, (value) => {
    const previous = sameOriginReferer(value, `${ORIGIN}/form`)

    if (previous === undefined) return undefined
    if (!previous.startsWith('/')) return `${show(previous)} is not a path`

    return staysOnSite(previous)
  }, { runs: 1000 })
})

describe('intendedUrl', () => {
  // The security fixture's /after-sign-in answers intendedUrl('/home') as JSON.
  const { app } = createApp()
  const Answer = S.Struct({ url: S.String })

  const intendedFor = async (redirect: string): Promise<string> => {
    const res = await app.request(`/after-sign-in?${new URLSearchParams({ redirect })}`, asJson(), as('ada'))

    return S.decodeUnknownSync(Answer)(await res.json()).url
  }

  property('returns the fallback or a path a browser keeps on this site', textOf(PATH_PIECES, 8), async (redirect) => {
    const target = await intendedFor(redirect)

    return target === '/home' ? undefined : staysOnSite(target, 'http://localhost/sign-in')
  }, { runs: 1000 })

  test('refuses a path whose dot segments resolve to one beginning //', async () => {
    expect(await intendedFor('/%2e//evil.test')).toBe('/home')
  })
})
