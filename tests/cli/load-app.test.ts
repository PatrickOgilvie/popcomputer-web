import { describe, expect, test } from 'bun:test'
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
