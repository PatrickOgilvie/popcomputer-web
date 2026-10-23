/**
 * Where a request asks to be sent: the page to return to after signing in,
 * and the page a failed form goes back to.
 *
 * Precedents: Better Auth CVE-2025-27143, GHSA-vp58-j275-797x and
 * CVE-2025-53535 (`//evil.com`, wildcards and `startsWith` passed its
 * trusted-origin check), Koa CVE-2025-62595 (`back()` read `//evil.com` as
 * a path), Express CVE-2024-29041 (an encoded Location defeated allowlists),
 * Phoenix CVE-2017-1000163 (`/\nexample.com`), Nuxt CVE-2024-34343 and React
 * Router CVE-2026-22029 (`javascript:` targets).
 */

import { describe, expect, test } from 'bun:test'
import { as, asJson, createApp } from './app'

/** Whether a URL, resolved as a browser resolves a Location, stays on the application's origin. */
const staysHome = (url: string) => new URL(url, 'http://localhost/after-sign-in').origin === 'http://localhost' && !/^\s*javascript:/i.test(url)

describe('the page to return to after signing in', () => {
  test('is never another site, whatever the redirect parameter says', async () => {
    const { app } = createApp()
    const left: string[] = []

    for (const target of [
      '//evil.test',
      '/\\evil.test',
      '\\\\evil.test',
      '/\t/evil.test',
      '/\n/evil.test',
      ' //evil.test',
      'https://evil.test',
      'https:evil.test',
      'https://localhost@evil.test',
      'http://localhost.evil.test/',
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      '/%2F%2Fevil.test',
      '/%5Cevil.test',
      '/./\\evil.test',
    ]) {
      const res = await app.request(`/after-sign-in?redirect=${encodeURIComponent(target)}`, asJson(), as('ada'))
      const { url } = await res.json() as { url: string }

      if (!staysHome(url)) left.push(`${target} -> ${url}`)
    }

    expect(left).toEqual([])
  })

  test('is the path a same-site Referer asked for, and never one another site asked for', async () => {
    const { app } = createApp()
    const from = async (referer: string) =>
      ((await (await app.request('/after-sign-in', asJson({ headers: { Referer: referer } }), as('ada'))).json()) as { url: string }).url

    expect(await from('http://localhost/login?redirect=%2Fprojects%2Fp1')).toBe('/projects/p1')
    expect(await from('https://evil.test/login?redirect=%2Fprojects%2Fp1')).toBe('/home')
    expect(await from('http://localhost/login?redirect=%2F%2Fevil.test')).toBe('/home')
  })
})

describe('the page a form goes back to', () => {
  test("is the Referer only when it is the application's own", async () => {
    const { app } = createApp()
    const back = async (referer: string) =>
      (await app.request('http://localhost/go-back', { method: 'POST', headers: { Referer: referer, Origin: 'http://localhost' } }, as('ada'))).headers.get('Location') ?? ''

    expect(await back('http://localhost/projects/p1')).toEndWith('/projects/p1')

    for (const referer of ['https://evil.test/x', '//evil.test/x', 'http://localhost.evil.test/x', 'http://localhost@evil.test/x', 'javascript:alert(1)']) {
      expect({ referer, staysHome: staysHome(await back(referer)) }).toEqual({ referer, staysHome: true })
    }
  })
})

describe('a redirect to a URL a form names', () => {
  // As a browser reads a scheme: case, a leading space and a tab inside it make no difference.
  const scripts = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>alert(1)</script>']
  const post = (app: ReturnType<typeof createApp>['app'], path: string, next: string, inertia: boolean) =>
    app.request(`http://localhost${path}`, {
      method: 'POST',
      headers: { Origin: 'http://localhost', ...(inertia ? { 'X-Inertia': 'true', 'X-Inertia-Version': '1' } : {}) },
      body: new URLSearchParams({ next }),
    }, as('ada'))

  test('never names a javascript: or data: URL, which an Inertia visit would run on the page', async () => {
    const { app } = createApp()
    const answered: string[] = []

    for (const path of ['/continue', '/continue-now']) {
      for (const next of scripts) {
        for (const inertia of [true, false]) {
          const res = await post(app, path, next, inertia)
          const location = res.headers.get('X-Inertia-Location') ?? res.headers.get('Location')

          if (res.status !== 500 || location !== null) answered.push(`${path} ${JSON.stringify(next)} inertia=${inertia} -> ${res.status} ${location}`)
        }
      }
    }

    expect(answered).toEqual([])
  })

  test('to another site still sends an Inertia visit there with 409 and X-Inertia-Location', async () => {
    const { app } = createApp()

    for (const path of ['/continue', '/continue-now']) {
      const visit = await post(app, path, 'https://pay.example/session/1', true)
      const plain = await post(app, path, 'https://pay.example/session/1', false)

      expect({ path, status: visit.status, location: visit.headers.get('X-Inertia-Location') })
        .toEqual({ path, status: 409, location: 'https://pay.example/session/1' })
      expect({ path, status: plain.status, location: plain.headers.get('Location') })
        .toEqual({ path, status: 303, location: 'https://pay.example/session/1' })
    }
  })
})
