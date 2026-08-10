/**
 * CLI OpenAPI Generation Tests
 */

import { describe, test, expect } from 'bun:test'
import {
  generateOpenApi,
  formatOpenApiOutput,
  parseGenerateOpenApiArgs,
  generateOpenApiHelp,
  RouteRegistry,
} from '../../src/cli/index.js'

// Helper to create test registry
const createTestRegistry = () => {
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
    method: 'get',
    path: '/projects/{project}',
    honoPath: '/projects/:project',
    fullPath: '/projects/:project',
    bindings: [{ param: 'project', column: 'id' }],
    prefix: '',
    name: 'projects.show',
  })

  registry.register({
    method: 'post',
    path: '/projects',
    honoPath: '/projects',
    fullPath: '/projects',
    bindings: [],
    prefix: '',
    name: 'projects.create',
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

describe('generateOpenApi', () => {
  describe('Basic Structure', () => {
    test('generates valid OpenAPI 3.1 spec', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
      })

      expect(spec.openapi).toBe('3.1.0')
      expect(spec.info.title).toBe('Test API')
      expect(spec.info.version).toBe('1.0.0')
    })

    test('includes paths for all routes', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
      })

      expect(Object.keys(spec.paths)).toContain('/projects')
      expect(Object.keys(spec.paths)).toContain('/projects/{project}')
      expect(Object.keys(spec.paths)).toContain('/api/users')
    })

    test('converts path params correctly', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
      })

      // Should convert :project to {project}
      expect(Object.keys(spec.paths)).toContain('/projects/{project}')
      expect(Object.keys(spec.paths)).not.toContain('/projects/:project')
    })
  })

  describe('Operations', () => {
    test('generates GET operations', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
      })

      expect(spec.paths['/projects']?.get).toBeDefined()
      expect(spec.paths['/projects']?.get?.responses['200']).toBeDefined()
    })

    test('generates POST operations', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
      })

      expect(spec.paths['/projects']?.post).toBeDefined()
      expect(spec.paths['/projects']?.post?.responses['201']).toBeDefined()
      expect(spec.paths['/projects']?.post?.responses['422']).toBeDefined()
    })

    test('generates PUT operations', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
      })

      expect(spec.paths['/projects/{project}']?.put).toBeDefined()
      expect(spec.paths['/projects/{project}']?.put?.responses['200']).toBeDefined()
    })

    test('generates DELETE operations', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
      })

      expect(spec.paths['/projects/{project}']?.delete).toBeDefined()
      expect(spec.paths['/projects/{project}']?.delete?.responses['204']).toBeDefined()
    })

    test('includes operationId from route name', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
      })

      expect(spec.paths['/projects']?.get?.operationId).toBe('projects_index')
      expect(spec.paths['/projects']?.post?.operationId).toBe('projects_create')
    })

    test('generates summary from route name', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
      })

      expect(spec.paths['/projects']?.get?.summary).toBe('List all projects')
      expect(spec.paths['/projects/{project}']?.get?.summary).toBe('Get a project')
      expect(spec.paths['/projects']?.post?.summary).toBe('Create a new project')
    })
  })

  describe('Parameters', () => {
    test('generates path parameters from bindings', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
      })

      const params = spec.paths['/projects/{project}']?.get?.parameters
      expect(params).toBeDefined()
      expect(params?.length).toBe(1)
      expect(params?.[0].name).toBe('project')
      expect(params?.[0].in).toBe('path')
      expect(params?.[0].required).toBe(true)
    })

    test('sets uuid format for id columns', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
      })

      const params = spec.paths['/projects/{project}']?.get?.parameters
      expect(params?.[0].schema.format).toBe('uuid')
    })
  })

  describe('Tags', () => {
    test('extracts tags from route names', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
      })

      expect(spec.tags).toBeDefined()
      expect(spec.tags?.some((t) => t.name === 'projects')).toBe(true)
      expect(spec.tags?.some((t) => t.name === 'users')).toBe(true)
    })

    test('assigns tags to operations', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
      })

      expect(spec.paths['/projects']?.get?.tags).toContain('projects')
      expect(spec.paths['/api/users']?.get?.tags).toContain('users')
    })

    test('uses custom tags when provided', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
        tags: [
          { name: 'custom', description: 'Custom tag' },
        ],
      })

      expect(spec.tags?.length).toBe(1)
      expect(spec.tags?.[0].name).toBe('custom')
    })
  })

  describe('Request Bodies', () => {
    test('includes request body for POST', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
      })

      expect(spec.paths['/projects']?.post?.requestBody).toBeDefined()
      expect(spec.paths['/projects']?.post?.requestBody?.content['application/json']).toBeDefined()
    })

    test('includes request body for PUT', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
      })

      expect(spec.paths['/projects/{project}']?.put?.requestBody).toBeDefined()
    })

    test('excludes request body for GET', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
      })

      expect(spec.paths['/projects']?.get?.requestBody).toBeUndefined()
    })

    test('excludes request body for DELETE', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
      })

      expect(spec.paths['/projects/{project}']?.delete?.requestBody).toBeUndefined()
    })
  })

  describe('Error Responses', () => {
    test('includes 404 for routes with bindings', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
      })

      expect(spec.paths['/projects/{project}']?.get?.responses['404']).toBeDefined()
    })

    test('excludes 404 for routes without bindings', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
      })

      expect(spec.paths['/projects']?.get?.responses['404']).toBeUndefined()
    })

    test('includes 401 for all routes', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
      })

      expect(spec.paths['/projects']?.get?.responses['401']).toBeDefined()
      expect(spec.paths['/projects/{project}']?.put?.responses['401']).toBeDefined()
    })
  })

  describe('Filtering', () => {
    test('filters by include prefix', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
        includePrefixes: ['/api'],
      })

      expect(Object.keys(spec.paths)).toEqual(['/api/users'])
    })

    test('filters by exclude prefix', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
        excludePrefixes: ['/api'],
      })

      expect(Object.keys(spec.paths)).not.toContain('/api/users')
      expect(Object.keys(spec.paths)).toContain('/projects')
    })
  })

  describe('Servers', () => {
    test('includes servers when provided', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
        servers: [
          { url: 'https://api.example.com', description: 'Production' },
          { url: 'https://staging.example.com', description: 'Staging' },
        ],
      })

      expect(spec.servers).toBeDefined()
      expect(spec.servers?.length).toBe(2)
      expect(spec.servers?.[0].url).toBe('https://api.example.com')
    })
  })

  describe('Security', () => {
    test('includes security schemes when provided', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
        defaultSecurity: [{ bearerAuth: [] }],
      })

      expect(spec.components?.securitySchemes?.bearerAuth).toBeDefined()
      expect(spec.security).toEqual([{ bearerAuth: [] }])
    })

    test('applies default security to operations', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
        defaultSecurity: [{ bearerAuth: [] }],
      })

      expect(spec.paths['/projects']?.get?.security).toEqual([{ bearerAuth: [] }])
    })
  })

  describe('JSON Output', () => {
    test('produces valid JSON', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
      })

      const json = JSON.stringify(spec)
      const parsed = JSON.parse(json)

      expect(parsed.openapi).toBe('3.1.0')
    })

    test('formats YAML output when requested', () => {
      const registry = createTestRegistry()
      const spec = generateOpenApi(registry, {
        info: { title: 'Test API', version: '1.0.0' },
      })

      const yaml = formatOpenApiOutput(spec, 'yaml')

      expect(yaml).toContain('openapi: 3.1.0')
      expect(yaml).toContain('info:')
      expect(yaml).toContain('paths:')
    })
  })
})

describe('parseGenerateOpenApiArgs', () => {
  test('parses --app option', () => {
    expect(parseGenerateOpenApiArgs(['--app', 'src/app.ts']).app).toBe('src/app.ts')
  })
  test('parses --title option', () => {
    const options = parseGenerateOpenApiArgs(['--title', 'My API'])
    expect(options.title).toBe('My API')
  })

  test('parses -t shorthand', () => {
    const options = parseGenerateOpenApiArgs(['-t', 'My API'])
    expect(options.title).toBe('My API')
  })

  test('parses --version option', () => {
    const options = parseGenerateOpenApiArgs(['--version', '2.0.0'])
    expect(options.version).toBe('2.0.0')
  })

  test('parses --output option', () => {
    const options = parseGenerateOpenApiArgs(['--output', 'openapi.json'])
    expect(options.output).toBe('openapi.json')
  })

  test('parses --format option', () => {
    const options = parseGenerateOpenApiArgs(['--format', 'yaml'])
    expect(options.format).toBe('yaml')
  })

  test('parses -o shorthand', () => {
    const options = parseGenerateOpenApiArgs(['-o', 'spec.json'])
    expect(options.output).toBe('spec.json')
  })

  test('parses --server option', () => {
    const options = parseGenerateOpenApiArgs(['--server', 'https://api.example.com'])
    expect(options.server).toBe('https://api.example.com')
  })

  test('parses --include option', () => {
    const options = parseGenerateOpenApiArgs(['--include', '/api,/v1'])
    expect(options.includePrefixes).toEqual(['/api', '/v1'])
  })

  test('parses --exclude option', () => {
    const options = parseGenerateOpenApiArgs(['--exclude', '/internal'])
    expect(options.excludePrefixes).toEqual(['/internal'])
  })

  test('parses --preview flag', () => {
    const options = parseGenerateOpenApiArgs(['--preview'])
    expect(options.preview).toBe(true)
  })

  test('parses multiple options', () => {
    const options = parseGenerateOpenApiArgs([
      '-t', 'My API',
      '-v', '1.0.0',
      '-o', 'openapi.json',
      '-s', 'https://api.example.com',
      '--include', '/api',
    ])

    expect(options.title).toBe('My API')
    expect(options.version).toBe('1.0.0')
    expect(options.output).toBe('openapi.json')
    expect(options.server).toBe('https://api.example.com')
    expect(options.includePrefixes).toEqual(['/api'])
  })
})

describe('generateOpenApiHelp', () => {
  test('includes usage information', () => {
    const help = generateOpenApiHelp()

    expect(help).toContain('popweb generate:openapi')
    expect(help).toContain('USAGE')
    expect(help).toContain('OPTIONS')
    expect(help).toContain('EXAMPLES')
  })

  test('documents all options', () => {
    const help = generateOpenApiHelp()

    expect(help).toContain('--title')
    expect(help).toContain('--version')
    expect(help).toContain('--output')
    expect(help).toContain('--server')
    expect(help).toContain('--include')
    expect(help).toContain('--exclude')
    expect(help).toContain('--preview')
  })
})
