/**
 * CLI Routes Command Tests
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import {
  routesCommand,
  parseRoutesArgs,
  routesHelp,
  RouteRegistry,
} from '../../src/cli/index.js'

// Create a populated registry for testing
const createTestRegistry = (): RouteRegistry => {
  const registry = new RouteRegistry()

  registry.register({
    method: 'get',
    path: '/projects',
    honoPath: '/projects',
    fullPath: '/projects',
    bindings: [],
    prefix: '',
    name: 'projects.index',
  })

  registry.register({
    method: 'post',
    path: '/projects',
    honoPath: '/projects',
    fullPath: '/projects',
    bindings: [],
    prefix: '',
    name: 'projects.store',
  })

  registry.register({
    method: 'get',
    path: '/projects/{project}',
    honoPath: '/projects/:project',
    fullPath: '/projects/:project',
    bindings: [{ param: 'project', column: 'id' }],
    prefix: '',
    name: 'projects.show',
  })

  registry.register({
    method: 'put',
    path: '/projects/{project}',
    honoPath: '/projects/:project',
    fullPath: '/projects/:project',
    bindings: [{ param: 'project', column: 'id' }],
    prefix: '',
    name: 'projects.update',
  })

  registry.register({
    method: 'delete',
    path: '/projects/{project}',
    honoPath: '/projects/:project',
    fullPath: '/projects/:project',
    bindings: [{ param: 'project', column: 'id' }],
    prefix: '',
    name: 'projects.destroy',
  })

  registry.register({
    method: 'get',
    path: '/users',
    honoPath: '/users',
    fullPath: '/api/users',
    bindings: [],
    prefix: '/api',
    name: 'users.index',
  })

  return registry
}

describe('routesCommand', () => {
  let registry: RouteRegistry

  beforeEach(() => {
    registry = createTestRegistry()
  })

  describe('Output Formats', () => {
    test('returns table format by default', () => {
      const result = routesCommand(registry)

      expect(result.output).toContain('METHOD')
      expect(result.output).toContain('PATH')
      expect(result.output).toContain('BINDINGS')
      expect(result.output).toContain('GET')
      expect(result.output).toContain('/projects')
    })

    test('returns JSON format', () => {
      const result = routesCommand(registry, { format: 'json' })

      const parsed = JSON.parse(result.output)
      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed.length).toBe(6)
      expect(parsed[0]).toHaveProperty('method')
      expect(parsed[0]).toHaveProperty('path')
      expect(parsed[0]).toHaveProperty('fullPath')
    })

    test('returns minimal format', () => {
      const result = routesCommand(registry, { format: 'minimal' })

      expect(result.output).toContain('GET     /projects')
      expect(result.output).not.toContain('METHOD')
      expect(result.output).not.toContain('BINDINGS')
    })
  })

  describe('Filtering', () => {
    test('filters by method', () => {
      const result = routesCommand(registry, { method: 'get' })

      expect(result.count).toBe(3)
      expect(result.routes.every((r) => r.method === 'get')).toBe(true)
    })

    test('filters by prefix', () => {
      const result = routesCommand(registry, { prefix: '/api' })

      expect(result.count).toBe(1)
      expect(result.routes[0].name).toBe('users.index')
    })

    test('filters by name', () => {
      const result = routesCommand(registry, { name: 'projects.show' })

      expect(result.count).toBe(1)
      expect(result.routes[0].fullPath).toBe('/projects/:project')
    })

    test('filters by pattern', () => {
      const result = routesCommand(registry, { pattern: '/projects/*' })

      expect(result.count).toBe(3)
      expect(result.routes.every((r) => r.fullPath.startsWith('/projects/:'))).toBe(true)
    })

    test('handles invalid regex pattern without throwing', () => {
      const result = routesCommand(registry, { pattern: '[' })

      expect(result.count).toBe(0)
      expect(result.error).toContain('Invalid route pattern')
    })

    test('combines multiple filters', () => {
      const result = routesCommand(registry, {
        method: 'get',
        pattern: '/projects/*',
      })

      expect(result.count).toBe(1)
      expect(result.routes[0].name).toBe('projects.show')
    })
  })

  describe('Sorting', () => {
    test('sorts by path by default', () => {
      const result = routesCommand(registry, { format: 'json' })
      const paths = result.routes.map((r) => r.fullPath)

      expect(paths).toEqual([...paths].sort())
    })

    test('sorts by method', () => {
      const result = routesCommand(registry, { sortBy: 'method' })
      const methods = result.routes.map((r) => r.method)

      expect(methods).toEqual([...methods].sort())
    })

    test('sorts by name', () => {
      const result = routesCommand(registry, { sortBy: 'name' })
      const names = result.routes.map((r) => r.name ?? '')

      expect(names).toEqual([...names].sort())
    })

    test('reverses sort order', () => {
      const normalResult = routesCommand(registry, { sortBy: 'name' })
      const reversedResult = routesCommand(registry, { sortBy: 'name', reverse: true })

      const normalNames = normalResult.routes.map((r) => r.name)
      const reversedNames = reversedResult.routes.map((r) => r.name)

      expect(reversedNames).toEqual([...normalNames].reverse())
    })
  })

  describe('Empty Registry', () => {
    test('handles empty registry gracefully', () => {
      const emptyRegistry = new RouteRegistry()
      const result = routesCommand(emptyRegistry)

      expect(result.count).toBe(0)
      expect(result.output).toContain('No routes found')
    })

    test('handles empty JSON output', () => {
      const emptyRegistry = new RouteRegistry()
      const result = routesCommand(emptyRegistry, { format: 'json' })

      expect(JSON.parse(result.output)).toEqual([])
    })
  })

  describe('Result Structure', () => {
    test('includes routes array', () => {
      const result = routesCommand(registry)

      expect(result.routes).toBeDefined()
      expect(Array.isArray(result.routes)).toBe(true)
    })

    test('includes output string', () => {
      const result = routesCommand(registry)

      expect(result.output).toBeDefined()
      expect(result.output).toEqual(expect.any(String))
    })

    test('includes count', () => {
      const result = routesCommand(registry)

      expect(result.count).toBe(6)
    })
  })
})

describe('parseRoutesArgs', () => {
  test('parses --app option', () => {
    expect(parseRoutesArgs(['--app', 'src/app.ts']).app).toBe('src/app.ts')
  })
  test('parses --json flag', () => {
    const options = parseRoutesArgs(['--json'])
    expect(options.format).toBe('json')
  })

  test('parses --minimal flag', () => {
    const options = parseRoutesArgs(['--minimal'])
    expect(options.format).toBe('minimal')
  })

  test('parses --table flag', () => {
    const options = parseRoutesArgs(['--table'])
    expect(options.format).toBe('table')
  })

  test('parses --method option', () => {
    const options = parseRoutesArgs(['--method', 'post'])
    expect(options.method).toBe('post')
  })

  test('parses -m shorthand', () => {
    const options = parseRoutesArgs(['-m', 'get'])
    expect(options.method).toBe('get')
  })

  test('parses --prefix option', () => {
    const options = parseRoutesArgs(['--prefix', '/api'])
    expect(options.prefix).toBe('/api')
  })

  test('parses -p shorthand', () => {
    const options = parseRoutesArgs(['-p', '/api'])
    expect(options.prefix).toBe('/api')
  })

  test('parses --name option', () => {
    const options = parseRoutesArgs(['--name', 'projects.show'])
    expect(options.name).toBe('projects.show')
  })

  test('parses -n shorthand', () => {
    const options = parseRoutesArgs(['-n', 'projects.show'])
    expect(options.name).toBe('projects.show')
  })

  test('parses --pattern option', () => {
    const options = parseRoutesArgs(['--pattern', '/projects/*'])
    expect(options.pattern).toBe('/projects/*')
  })

  test('parses --sort option', () => {
    const options = parseRoutesArgs(['--sort', 'method'])
    expect(options.sortBy).toBe('method')
  })

  test('parses -s shorthand', () => {
    const options = parseRoutesArgs(['-s', 'name'])
    expect(options.sortBy).toBe('name')
  })

  test('parses --reverse flag', () => {
    const options = parseRoutesArgs(['--reverse'])
    expect(options.reverse).toBe(true)
  })

  test('parses -r shorthand', () => {
    const options = parseRoutesArgs(['-r'])
    expect(options.reverse).toBe(true)
  })

  test('parses multiple options', () => {
    const options = parseRoutesArgs([
      '--json',
      '-m', 'post',
      '-p', '/api',
      '-s', 'path',
      '-r',
    ])

    expect(options.format).toBe('json')
    expect(options.method).toBe('post')
    expect(options.prefix).toBe('/api')
    expect(options.sortBy).toBe('path')
    expect(options.reverse).toBe(true)
  })

  test('returns empty options for no args', () => {
    const options = parseRoutesArgs([])
    expect(options).toEqual({})
  })
})

describe('routesHelp', () => {
  test('returns help text', () => {
    const help = routesHelp()

    expect(help).toContain('popweb routes')
    expect(help).toContain('--json')
    expect(help).toContain('--method')
    expect(help).toContain('EXAMPLES')
  })

  test('includes all options', () => {
    const help = routesHelp()

    expect(help).toContain('--json')
    expect(help).toContain('--minimal')
    expect(help).toContain('--table')
    expect(help).toContain('--method')
    expect(help).toContain('--prefix')
    expect(help).toContain('--name')
    expect(help).toContain('--pattern')
    expect(help).toContain('--sort')
    expect(help).toContain('--reverse')
  })
})
