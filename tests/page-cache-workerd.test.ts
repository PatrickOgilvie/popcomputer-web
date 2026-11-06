/**
 * The default page cache in Cloudflare's own runtime, workerd, through
 * Miniflare: an application bundled as a Worker, with Cloudflare's own
 * bindings and `caches.default`. The page cache tells a binding from a value
 * by its class, and what it counts as a use is what a binding's class does,
 * so a double answers neither: a test here catches what only the runtime shows.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Miniflare } from 'miniflare'
import { PAGE_CACHE_HEADER } from '../src/page-cache.js'

/** A Worker the application calls over RPC. */
const RPC_WORKER = `
import { WorkerEntrypoint } from 'cloudflare:workers'

export default class extends WorkerEntrypoint {
  greeting() {
    return 'hello'
  }
}
`

let mf: Miniflare | undefined
const out = mkdtempSync(join(tmpdir(), 'popweb-page-cache-workerd-'))

beforeAll(async () => {
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, 'fixtures', 'page-cache-worker.ts')], outdir: out, target: 'browser', format: 'esm', minify: true })

  if (!built.success) throw new AggregateError(built.logs, 'The Worker did not bundle.')

  mf = new Miniflare({
    workers: [
      {
        name: 'app',
        modules: true,
        script: readFileSync(join(out, 'page-cache-worker.js'), 'utf8'),
        compatibilityDate: '2026-07-01',
        compatibilityFlags: ['nodejs_compat'],
        bindings: { ENVIRONMENT: 'production' },
        d1Databases: ['DB'],
        kvNamespaces: ['KV'],
        hyperdrives: { HYPERDRIVE: 'postgres://user:password@127.0.0.1:5999/app' },
        ratelimits: { SIGN_IN_LIMITER: { namespace_id: '1001', simple: { limit: 5, period: 60 } } },
        serviceBindings: { RPC: 'rpc' },
      },
      { name: 'rpc', modules: true, script: RPC_WORKER, compatibilityDate: '2026-07-01' },
    ],
  })
  await mf.ready
}, 60_000)

afterAll(async () => {
  await mf?.dispose()
  rmSync(out, { recursive: true, force: true })
})

/** A request to the app `X-App` names, its body read as a browser's would be, which is when a page is stored. */
async function ask(app: string, path: string, init: { readonly address?: string } = {}) {
  if (mf === undefined) throw new Error('Miniflare did not start.')

  const response = await mf.dispatchFetch(`http://app.test${path}`, {
    headers: { 'X-App': app, 'cf-connecting-ip': init.address ?? '203.0.113.7' },
  })
  const body = await response.text()

  return { status: response.status, cache: response.headers.get(PAGE_CACHE_HEADER), control: response.headers.get('Cache-Control'), body }
}

/** The page cache's answers to a page asked for until it is no longer a miss, since the page is stored after the response. */
async function repeatVisits(app: string, path: string): Promise<ReadonlyArray<string | null>> {
  const answers = [(await ask(app, path)).cache]

  for (let attempt = 0; attempt < 40 && (answers.at(-1) === 'MISS' || answers.length < 2); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    answers.push((await ask(app, path)).cache)
  }

  return answers
}

describe('the default page cache in workerd', () => {
  test.each(['plain', 'limits', 'hyperdrive'])('a page that reads nothing is kept, on the %s application', async (app) => {
    const answers = await repeatVisits(app, '/about')

    expect(answers[0]).toBe('MISS')
    expect(answers.at(-1)).toBe('HIT')
  }, 30_000)

  test.each(['plain', 'limits', 'hyperdrive'])('a page that only looks at a binding is kept, on the %s application', async (app) => {
    const answers = await repeatVisits(app, '/looks')

    expect(answers[0]).toBe('MISS')
    expect(answers.at(-1)).toBe('HIT')
  }, 30_000)

  test.each(['/limited', '/kv', '/rpc'])('a page that calls a binding, %s, renders per request', async (path) => {
    expect(await repeatVisits('plain', path)).toEqual(['DYNAMIC', 'DYNAMIC'])
  }, 30_000)

  test('a page that queries D1 through Drizzle renders per request, and gets its rows', async () => {
    const first = await ask('limits', '/d1')

    expect(first.status).toBe(200)
    expect(first.body).toContain('"one":1')
    expect(await repeatVisits('limits', '/d1')).toEqual(['DYNAMIC', 'DYNAMIC'])
  }, 30_000)

  test('the Rate Limiting binding still limits a sign-in call that reaches it on a request the page cache considers', async () => {
    const answers: number[] = []

    for (let call = 0; call < 7; call += 1) {
      answers.push((await ask('limits', '/api/auth/verify-email?token=wrong', { address: '198.51.100.20' })).status)
    }

    expect(answers.at(-1)).toBe(429)
    expect(answers[0]).not.toBe(429)
  }, 30_000)
})
