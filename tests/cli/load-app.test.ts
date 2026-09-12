/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
import { describe, expect, test } from 'bun:test'
// oxlint-disable-next-line effecttsgo/node-builtin-import -- These integration tests use real temporary files and native paths to verify the Node CLI filesystem boundary.
import { join } from 'node:path'
import { loadAppRouteRegistry } from '../../src/cli/load-app.js'

describe('loadAppRouteRegistry', () => {
  test('loads metadata from the application entrypoint selected by --app', async () => {
    const registry = await loadAppRouteRegistry(
      join(import.meta.dir, '..', 'fixtures', 'cli-app.ts')
    )

    expect(registry.count()).toBe(1)
    expect(registry.findByName('fixture.show')?.fullPath).toBe('/cli-fixture')
  })
})
