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
import { Effect, Exit, Schema as S } from 'effect'
import { action } from '../../src/effect/action.js'
import { parseBindings } from '../../src/effect/binding.js'
import { alpha, alphaDash, alphaNum, email, ip, isoDate, isoDateTime, jsonString, macAddress, nullableEmail, singleMediaType, url, uuid } from '../../src/effect/schema.js'
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
    // A domain of dots whose match fails at its end, which retried every dot
    // against the rest of the value; the "labels" case above matches.
    ['email, dotted domain that fails', email, `a@${'.'.repeat(long)}@`],
    ['email, dotted domain with a space', email, `a@${'.'.repeat(long)} x`],
    ['nullableEmail, dotted domain that fails', nullableEmail, `a@${'.'.repeat(long)}@`],
    ['nullableEmail, dotted domain with a space', nullableEmail, `a@${'.'.repeat(long)} x`],
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

describe('the email validators', () => {
  // The patterns before they were made linear: each answer must stay as it was.
  const before = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
  const beforeNullable = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

  const valid = (schema: typeof email | typeof nullableEmail, value: string) =>
    Exit.isSuccess(S.decodeUnknownExit(schema)(value))

  // Every string up to `length` characters over `alphabet`.
  const strings = (alphabet: ReadonlyArray<string>, length: number): string[] => {
    const all = ['']
    let layer = ['']

    for (let size = 1; size <= length; size++) {
      layer = layer.flatMap((prefix) => alphabet.map((character) => prefix + character))
      all.push(...layer)
    }

    return all
  }

  test('answer as the quadratic patterns did on every short string over the characters that matter', () => {
    const differ: string[] = []

    // The dot, the at sign and a space decide the pattern, so the strings that
    // exercise it all are the ones over them and an ordinary character.
    for (const value of strings(['a', '.', '@', ' '], 8)) {
      const trimmed = value.trim().toLowerCase()

      if (valid(email, value) !== before.test(trimmed)) differ.push(`email ${JSON.stringify(value)}`)
      if (trimmed !== '' && valid(nullableEmail, value) !== beforeNullable.test(trimmed)) differ.push(`nullableEmail ${JSON.stringify(value)}`)
    }

    // Characters outside one UTF-16 unit, and a space that is not ' '.
    for (const value of strings(['a', '.', '@', '\u{1F600}', '\u00a0'], 5)) {
      const trimmed = value.trim().toLowerCase()

      if (valid(email, value) !== before.test(trimmed)) differ.push(`email ${JSON.stringify(value)}`)
      if (trimmed !== '' && valid(nullableEmail, value) !== beforeNullable.test(trimmed)) differ.push(`nullableEmail ${JSON.stringify(value)}`)
    }

    expect(differ).toEqual([])
  })

  test('still accept and refuse the addresses they did', () => {
    for (const address of ['a@b.c', ' A@B.CO ', 'first.last@sub.example.com', 'a@b..c', 'a@b.c.', 'a@b.\u{1F600}']) {
      expect({ address, email: valid(email, address), nullableEmail: valid(nullableEmail, address) }).toEqual({ address, email: true, nullableEmail: true })
    }

    for (const address of ['a', 'a@', '@b.c', 'a@b', 'a@b.', 'a@.', 'a@.b', 'a b@c.d', 'a@b c.d', 'a@@b.c', 'a@b@c.d']) {
      expect({ address, email: valid(email, address), nullableEmail: valid(nullableEmail, address) }).toEqual({ address, email: false, nullableEmail: false })
    }
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
