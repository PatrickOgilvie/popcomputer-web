/**
 * What production shows and trusts: an error's detail on its page, a
 * request that tries to turn development on, the client address limits are
 * kept by, validators an attacker can make slow, and the releases of the
 * libraries the package composes.
 *
 * Precedents: Laravel CVE-2021-3129 and CVE-2024-52301 (debug mode reachable,
 * or set from the request), Rails CVE-2019-5420 (a development secret in
 * production), Better Auth CVE-2026-45364 and Hono CVE-2026-27700 (rate
 * limits keyed on X-Forwarded-For), Zod CVE-2023-4316, Valibot
 * CVE-2025-66020 and path-to-regexp CVE-2024-45296 (regular expressions with
 * exponential backtracking), Drizzle CVE-2026-39356 and Hono's 2026
 * advisories (fixed in the releases the peer ranges now start at).
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { Effect, Schema as S } from 'effect'
import { action } from '../../src/effect/action.js'
import { parseBindings } from '../../src/effect/binding.js'
import { alpha, alphaDash, alphaNum, email, ip, isoDate, isoDateTime, jsonString, macAddress, singleMediaType, url, uuid } from '../../src/effect/schema.js'
import { clientAddress } from '../../src/effect/sign-in-limits.js'
import { setupWeb } from '../../src/setup.js'

const secret = 'hunter2-secret postgres://admin:hunter2@db.internal:5432/app'

const createApp = () => {
  const app = new Hono()
  const { routes } = setupWeb(app, { version: '1', render: (page) => JSON.stringify(page) })

  routes.get('/boom', action(Effect.die(new Error(`Connection failed: ${secret}`))))

  return app
}

describe('an error in production', () => {
  test("shows neither its message, its cause nor its stack, to a browser or a JSON client", async () => {
    const app = createApp()

    // Development shows it, so its absence below is production's doing.
    expect(await (await app.request('/boom', { headers: { Accept: 'application/json' } }, { ENVIRONMENT: 'development' })).text()).toContain('hunter2')

    for (const accept of ['text/html', 'application/json']) {
      for (const env of [{ ENVIRONMENT: 'production' }, {}]) {
        const res = await app.request('/boom', { headers: { Accept: accept } }, env)
        const body = await res.text()

        expect({ accept, env, status: res.status, leaks: /hunter2|postgres:|db\.internal|\n\s+at /.test(body) })
          .toEqual({ accept, env, status: 500, leaks: false })
      }
    }
  })

  test('stays production whatever the request says about it', async () => {
    const app = createApp()

    for (const [path, headers] of [
      ['/boom?debug=1&ENVIRONMENT=development&env=development', {}],
      ['/boom', { 'X-Debug': '1', 'X-Environment': 'development', Cookie: 'ENVIRONMENT=development; debug=1' }],
      ['/boom', { Host: 'localhost:5173', 'X-Forwarded-Host': 'localhost', Origin: 'http://localhost:5173' }],
    ] as const) {
      const body = await (await app.request(path, { headers: { Accept: 'application/json', ...headers } }, { ENVIRONMENT: 'production' })).text()

      expect({ path, headers, leaks: body.includes('hunter2') }).toEqual({ path, headers, leaks: false })
    }
  })
})

describe('the address sign-in limits are kept by', () => {
  test("is Cloudflare's, never one the client writes", () => {
    expect(clientAddress(new Headers({ 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '198.51.100.1' }))).toBe('203.0.113.7')
    expect(clientAddress(new Headers({ 'X-Forwarded-For': '198.51.100.1' }))).toBe('unknown')
    expect(clientAddress(new Headers({ 'X-Real-IP': '198.51.100.1', Forwarded: 'for=198.51.100.1' }))).toBe('unknown')
  })
})

describe('a validator given a long, hostile value', () => {
  // Inputs that make a backtracking pattern take exponential time.
  const long = 20_000
  const cases: ReadonlyArray<readonly [string, S.Top, string]> = [
    ['email, local part', email, `${'a'.repeat(long)}@`],
    ['email, labels', email, `a@${'a.'.repeat(long / 2)}`],
    ['email, dashes', email, `a@${'a-'.repeat(long / 2)}!`],
    ['url', url, `http://${'a'.repeat(long)}:x`],
    ['alpha', alpha, `${'a'.repeat(long)}1`],
    ['alphaDash', alphaDash, `${'a-'.repeat(long / 2)}!`],
    ['alphaNum', alphaNum, `${'a1'.repeat(long / 2)}!`],
    ['ip', ip, `${'1.'.repeat(long / 2)}x`],
    ['macAddress', macAddress, `${'aa:'.repeat(long / 3)}zz`],
    ['isoDate', isoDate, `${'1'.repeat(long)}-`],
    ['isoDateTime', isoDateTime, `2026-01-01T${'1'.repeat(long)}`],
    ['uuid', uuid, `${'a'.repeat(long)}-`],
    ['jsonString', jsonString, '['.repeat(long)],
  ]

  test('answers in milliseconds', async () => {
    const slow: string[] = []

    for (const [name, schema, value] of cases) {
      const started = performance.now()
      await Effect.runPromiseExit(S.decodeUnknownEffect(schema as S.Codec<unknown, unknown, never, never>)(value))
      const took = performance.now() - started

      if (took > 50) slow.push(`${name}: ${Math.round(took)} ms`)
    }

    expect(slow).toEqual([])
  })

  test("a media type and a route's path are read in milliseconds too", () => {
    const started = performance.now()

    singleMediaType(`image/png${'; a=b'.repeat(long / 5)};`)
    singleMediaType(`image/png;${' '.repeat(long)}x`)
    parseBindings(`/${'{a}/'.repeat(long / 4)}`)

    expect(performance.now() - started).toBeLessThan(50)
  })
})

describe('the libraries the package composes', () => {
  const manifest: { peerDependencies: Record<string, string> } = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8'))

  test('start at the first releases with the security fixes for the parts it uses', () => {
    const floors: ReadonlyArray<readonly [string, string, string]> = [
      // Cookie attributes (CVE-2026-29086, CVE-2026-47675), body parsing (CVE-2026-56763, CVE-2026-84364).
      ['hono', '4.13.4', '4.13.5'],
      // Quoting in sql.identifier() and .as() (CVE-2026-39356).
      ['drizzle-orm', '0.45.1', '0.45.2'],
      // OAuth state accepted as a magic link token (GHSA-965c-763c-88jm).
      ['better-auth', '1.7.6', '1.7.7'],
    ]

    for (const [name, vulnerable, fixed] of floors) {
      const range = manifest.peerDependencies[name]

      expect({ name, range, allowsVulnerable: Bun.semver.satisfies(vulnerable, range), allowsFixed: Bun.semver.satisfies(fixed, range) })
        .toEqual({ name, range, allowsVulnerable: false, allowsFixed: true })
    }
  })
})
