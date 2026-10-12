/* oxlint-disable effecttsgo/async-function -- Test entrypoints drive native bundler APIs that return Promises. */
/**
 * Workers bundling tests.
 *
 * drizzle-orm is an optional peer. An app bundled the way Wrangler bundles a
 * Worker (esbuild), or with Bun, must build without drizzle-orm installed and
 * must still bundle drizzle-orm when the app installs it. Route binding without
 * it must fail as a configuration error, not a module error.
 *
 * Bundles the built package (dist), so run `bun run build` first; `bun run test` does.
 */

import { describe, test, expect } from 'bun:test'
import { build } from 'esbuild'
// oxlint-disable-next-line effecttsgo/node-builtin-import -- These integration tests lay out a real node_modules tree for the bundler to resolve.
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
// oxlint-disable-next-line effecttsgo/node-builtin-import -- These integration tests lay out a real node_modules tree for the bundler to resolve.
import { tmpdir } from 'node:os'
// oxlint-disable-next-line effecttsgo/node-builtin-import -- These integration tests lay out a real node_modules tree for the bundler to resolve.
import { dirname, join } from 'node:path'

const root = join(import.meta.dir, '..')

// An app with no database: it never registers a route binding.
const appSource = `
import { Effect } from 'effect'
import { Hono } from 'hono'
import * as web from '@popcomputer/web'
import * as effect from '@popcomputer/web/effect'

const app = new Hono()
effect.effectRoutes(app).get('/', Effect.succeed(new Response('ok')), { name: 'home' })

export default { app, web, effect }
`

// Drizzle's table code registers this key; it only appears when drizzle-orm is bundled.
const drizzleMarker = 'drizzle:Columns'
const runtimeImport = /import\(\s*["']drizzle-orm["']\s*\)/

/**
 * Lay out an app outside the repository, so the bundler cannot find the
 * repository's own drizzle-orm by walking up parent directories.
 */
function withApp(
  options: { readonly drizzle: boolean },
  run: (entry: string) => Promise<void>
) {
  const directory = mkdtempSync(join(tmpdir(), 'popweb-workers-bundle-'))
  const modules = join(directory, 'node_modules')
  const pkg = join(modules, '@popcomputer', 'web')

  mkdirSync(pkg, { recursive: true })
  cpSync(join(root, 'package.json'), join(pkg, 'package.json'))
  // Copied, not linked: a link would resolve back into the repository.
  cpSync(join(root, 'dist'), join(pkg, 'dist'), { recursive: true })

  const dependencies = options.drizzle ? ['effect', 'hono', 'drizzle-orm'] : ['effect', 'hono']

  for (const name of dependencies) {
    symlinkSync(join(root, 'node_modules', name), join(modules, name), 'dir')
  }

  const entry = join(directory, 'app.ts')
  writeFileSync(entry, appSource)

  return run(entry).finally(() => {
    rmSync(directory, { recursive: true, force: true })
  })
}

const bundlers = {
  // Mirrors Wrangler's Worker bundle settings.
  esbuild: async (entry: string) => {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      conditions: ['workerd', 'worker', 'browser'],
      mainFields: ['browser', 'module', 'main'],
      external: ['node:*', 'cloudflare:*'],
      logLevel: 'silent',
    })

    return {
      code: result.outputFiles[0].text,
      warnings: result.warnings.map((warning) => warning.text),
    }
  },
  bun: async (entry: string) => {
    const result = await Bun.build({
      entrypoints: [entry],
      target: 'browser',
      conditions: ['workerd', 'worker'],
      external: ['node:*', 'cloudflare:*'],
      throw: false,
    })

    if (!result.success) {
      throw new AggregateError(result.logs, 'Bun.build failed')
    }

    return {
      code: await result.outputs[0].text(),
      warnings: result.logs.map((log) => log.message),
    }
  },
}

describe('Workers bundles', () => {
  for (const [name, bundle] of Object.entries(bundlers)) {
    test(`${name} builds an app without drizzle-orm installed`, () =>
      withApp({ drizzle: false }, async (entry) => {
        const { code, warnings } = await bundle(entry)

        expect(warnings.filter((warning) => warning.includes('drizzle-orm'))).toEqual([])
        // Left for runtime, behind route binding, instead of failing the build.
        expect(code).toMatch(runtimeImport)
        expect(code).not.toContain(drizzleMarker)
      }))

    test(`${name} bundles drizzle-orm when the app installs it`, () =>
      withApp({ drizzle: true }, async (entry) => {
        const { code } = await bundle(entry)

        expect(code).not.toMatch(runtimeImport)
        expect(code).toContain(drizzleMarker)
      }))
  }
})

describe('Route binding without drizzle-orm', () => {
  test('reports a configuration error with an install hint', () =>
    withApp({ drizzle: false }, async (entry) => {
      const binding = join(
        dirname(entry),
        'node_modules/@popcomputer/web/dist/effect/binding.js'
      )
      const { loadDrizzle } = await import(binding)
      const error: unknown = await loadDrizzle().then(
        () => undefined,
        (failure: unknown) => failure
      )

      expect(error).toMatchObject({
        _tag: 'RouteConfigurationError',
        code: 'HON_CFG_305_INVALID_CONFIG',
        hint: expect.stringContaining('bun add drizzle-orm'),
      })
    }))
})
