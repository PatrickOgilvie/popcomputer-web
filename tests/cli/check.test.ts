/**
 * CLI Check Command Tests
 */

import { describe, test, expect } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkCommand,
  parseCheckArgs,
  checkHelp,
  RouteRegistry,
} from '../../src/cli/index.js'

// Helper to create a registry with test routes
const createTestRegistry = (routes: Array<{
  method: 'get' | 'post' | 'put' | 'delete'
  path: string
  name?: string
  bindings?: Array<{ param: string; column: string }>
}>) => {
  const registry = new RouteRegistry()

  for (const route of routes) {
    registry.register({
      method: route.method,
      path: route.path,
      honoPath: route.path.replace(/\{([^}:]+)(?::[^}]+)?\}/g, ':$1'),
      fullPath: route.path.replace(/\{([^}:]+)(?::[^}]+)?\}/g, ':$1'),
      bindings: route.bindings ?? [],
      prefix: '',
      name: route.name,
    })
  }

  return registry
}

describe('checkCommand', () => {
  describe('Basic Functionality', () => {
    test('returns pass for valid routes', () => {
      const registry = createTestRegistry([
        { method: 'get', path: '/projects', name: 'projects.index' },
        { method: 'post', path: '/projects', name: 'projects.create' },
      ])

      const result = checkCommand(registry)

      expect(result.status).toBe('pass')
      expect(result.summary.failed).toBe(0)
    })

    test('returns summary with counts', () => {
      const registry = createTestRegistry([
        { method: 'get', path: '/test', name: 'test.index' },
      ])

      const result = checkCommand(registry)

      expect(result.summary.total).toBeGreaterThan(0)
      expect(result.summary.passed).toBeGreaterThanOrEqual(0)
      expect(result.summary.warnings).toBeGreaterThanOrEqual(0)
      expect(result.summary.failed).toBeGreaterThanOrEqual(0)
    })

    test('includes checks array', () => {
      const registry = createTestRegistry([])
      const result = checkCommand(registry)

      expect(Array.isArray(result.checks)).toBe(true)
      expect(result.checks.length).toBeGreaterThan(0)
    })
  })

  describe('Naming Checks', () => {
    test('warns for unnamed routes', () => {
      const registry = createTestRegistry([
        { method: 'get', path: '/test' }, // No name
      ])

      const result = checkCommand(registry, { only: ['naming'] })

      expect(result.status).toBe('warn')
      expect(result.issues.some((i) => i.message.includes('no name'))).toBe(true)
    })

    test('throws error for duplicate route names at registration', () => {
      const registry = new RouteRegistry()
      registry.register({
        method: 'get',
        path: '/a',
        honoPath: '/a',
        fullPath: '/a',
        bindings: [],
        prefix: '',
        name: 'test.index',
      })

      expect(() => {
        registry.register({
          method: 'get',
          path: '/b',
          honoPath: '/b',
          fullPath: '/b',
          bindings: [],
          prefix: '',
          name: 'test.index', // Duplicate
        })
      }).toThrow('Duplicate route name')
    })

    test('warns for non-standard naming convention', () => {
      const registry = createTestRegistry([
        { method: 'get', path: '/test', name: 'TestIndex' }, // Not resource.action
      ])

      const result = checkCommand(registry, { only: ['naming'] })

      expect(result.issues.some((i) => i.message.includes("doesn't follow"))).toBe(true)
    })

    test('passes for proper naming', () => {
      const registry = createTestRegistry([
        { method: 'get', path: '/projects', name: 'projects.index' },
        { method: 'post', path: '/projects', name: 'projects.create' },
      ])

      const result = checkCommand(registry, { only: ['naming'] })
      const namingCheck = result.checks.find((c) => c.name === 'naming')

      expect(namingCheck?.status).toBe('pass')
    })
  })

  describe('Route Structure Checks', () => {
    test('warns for DELETE without resource binding', () => {
      const registry = createTestRegistry([
        { method: 'delete', path: '/projects', name: 'projects.delete' }, // No binding
      ])

      const result = checkCommand(registry, { only: ['routes'] })

      expect(result.issues.some((i) => i.message.includes('no resource binding'))).toBe(true)
    })

    test('passes for DELETE with binding', () => {
      const registry = createTestRegistry([
        {
          method: 'delete',
          path: '/projects/{project}',
          name: 'projects.destroy',
          bindings: [{ param: 'project', column: 'id' }],
        },
      ])

      const result = checkCommand(registry, { only: ['routes'] })
      const routesCheck = result.checks.find((c) => c.name === 'routes')

      expect(routesCheck?.status).toBe('pass')
    })

    test('suggests creating missing CRUD routes', () => {
      const registry = createTestRegistry([
        { method: 'get', path: '/projects', name: 'projects.index' },
        // Missing POST
      ])

      const result = checkCommand(registry, { only: ['routes'] })

      expect(result.issues.some((i) =>
        i.message.includes('no POST') &&
        i.fix?.command?.includes('generate:action')
      )).toBe(true)
    })
  })

  describe('Bindings Checks', () => {
    test('passes for standard bindings', () => {
      const registry = createTestRegistry([
        {
          method: 'get',
          path: '/projects/{project}',
          name: 'projects.show',
          bindings: [{ param: 'project', column: 'id' }],
        },
      ])

      const result = checkCommand(registry, { only: ['bindings'] })
      const bindingsCheck = result.checks.find((c) => c.name === 'bindings')

      expect(bindingsCheck?.status).toBe('pass')
    })

    test('notes custom binding columns', () => {
      const registry = createTestRegistry([
        {
          method: 'get',
          path: '/projects/{project:customColumn}',
          name: 'projects.show',
          bindings: [{ param: 'project', column: 'customColumn' }],
        },
      ])

      const result = checkCommand(registry, { only: ['bindings'] })

      expect(result.issues.some((i) =>
        i.message.includes('custom binding column') &&
        i.message.includes('customColumn')
      )).toBe(true)
    })
  })

  describe('Registration Checks', () => {
    test('fails for unregistered route exports', () => {
      const tmpRoot = join(process.cwd(), 'tmp', 'check-registration')
      const actionsDir = join(tmpRoot, 'actions')
      const filePath = join(actionsDir, 'create.ts')

      mkdirSync(actionsDir, { recursive: true })
      writeFileSync(filePath, `
export const route = {
  method: 'post',
  path: '/projects',
  name: 'projects.create',
}
`.trim())

      try {
        const registry = createTestRegistry([])
        const result = checkCommand(registry, {
          only: ['registration'],
          scanDirs: ['tmp/check-registration/actions'],
        })

        expect(result.status).toBe('fail')
        expect(result.issues.some((i) => i.message.includes('projects.create'))).toBe(true)
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true })
      }
    })

    test('passes when route exports are registered', () => {
      const tmpRoot = join(process.cwd(), 'tmp', 'check-registration-pass')
      const actionsDir = join(tmpRoot, 'actions')
      const filePath = join(actionsDir, 'create.ts')

      mkdirSync(actionsDir, { recursive: true })
      writeFileSync(filePath, `
export const route = {
  method: 'post',
  path: '/projects',
  name: 'projects.create',
}
`.trim())

      try {
        const registry = createTestRegistry([
          { method: 'post', path: '/projects', name: 'projects.create' },
        ])
        const result = checkCommand(registry, {
          only: ['registration'],
          scanDirs: ['tmp/check-registration-pass/actions'],
        })

        expect(result.status).toBe('pass')
        expect(result.issues.length).toBe(0)
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true })
      }
    })
  })

  describe('Filtering', () => {
    test('runs only specified checks', () => {
      const registry = createTestRegistry([])
      const result = checkCommand(registry, { only: ['naming'] })

      expect(result.checks.length).toBe(1)
      expect(result.checks[0].name).toBe('naming')
    })

    test('runs multiple specified checks', () => {
      const registry = createTestRegistry([])
      const result = checkCommand(registry, { only: ['naming', 'routes'] })

      expect(result.checks.length).toBe(2)
      expect(result.checks.map((c) => c.name)).toContain('naming')
      expect(result.checks.map((c) => c.name)).toContain('routes')
    })
  })

  describe('Fix Suggestions', () => {
    test('includes fix commands for issues', () => {
      const registry = createTestRegistry([
        { method: 'get', path: '/projects', name: 'projects.index' },
        // Missing POST triggers a suggestion
      ])

      const result = checkCommand(registry)
      const fixableIssues = result.issues.filter((i) => i.fix)

      expect(fixableIssues.length).toBeGreaterThan(0)
    })

    test('fix suggestions include command type', () => {
      const registry = createTestRegistry([
        { method: 'get', path: '/projects', name: 'projects.index' },
      ])

      const result = checkCommand(registry)
      const commandFixes = result.issues.filter((i) => i.fix?.type === 'command')

      for (const issue of commandFixes) {
        expect(issue.fix?.command).toBeDefined()
      }
    })
  })
})

describe('parseCheckArgs', () => {
  test('parses --app option', () => {
    expect(parseCheckArgs(['--app', 'src/app.ts']).app).toBe('src/app.ts')
  })
  test('parses --json flag', () => {
    const options = parseCheckArgs(['--json'])
    expect(options.format).toBe('json')
  })

  test('parses --verbose flag', () => {
    const options = parseCheckArgs(['--verbose'])
    expect(options.verbose).toBe(true)
  })

  test('parses -v shorthand', () => {
    const options = parseCheckArgs(['-v'])
    expect(options.verbose).toBe(true)
  })

  test('parses --only option', () => {
    const options = parseCheckArgs(['--only', 'routes,naming'])
    expect(options.only).toEqual(['routes', 'naming'])
  })

  test('parses multiple options', () => {
    const options = parseCheckArgs(['--json', '-v', '--only', 'routes'])

    expect(options.format).toBe('json')
    expect(options.verbose).toBe(true)
    expect(options.only).toEqual(['routes'])
  })

  test('parses --scan option', () => {
    const options = parseCheckArgs(['--scan', 'src/actions,src/features'])
    expect(options.scanDirs).toEqual(['src/actions', 'src/features'])
  })
})

describe('checkHelp', () => {
  test('includes usage information', () => {
    const help = checkHelp()

    expect(help).toContain('popweb check')
    expect(help).toContain('USAGE')
    expect(help).toContain('OPTIONS')
  })

  test('documents all options', () => {
    const help = checkHelp()

    expect(help).toContain('--json')
    expect(help).toContain('--verbose')
    expect(help).toContain('--only')
    expect(help).toContain('--scan')
  })

  test('lists available checks', () => {
    const help = checkHelp()

    expect(help).toContain('routes')
    expect(help).toContain('naming')
    expect(help).toContain('bindings')
    expect(help).toContain('registration')
  })
})
