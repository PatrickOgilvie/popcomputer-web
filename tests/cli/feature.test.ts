/**
 * CLI Feature Generation Tests
 */

import { describe, test, expect } from 'bun:test'
import {
  generateFeature,
  parseGenerateFeatureArgs,
  generateFeatureHelp,
} from '../../src/cli/index.js'

describe('generateFeature', () => {
  describe('Basic Generation', () => {
    test('generates feature file for resource/action name', () => {
      const result = generateFeature({
        name: 'projects/archive',
      })

      expect(result.success).toBe(true)
      expect(result.path).toBe('src/features/projects/archive.ts')
      expect(result.routeName).toBe('projects.archive')
    })

    test('generates default path for custom action', () => {
      const result = generateFeature({
        name: 'projects/archive',
      })

      expect(result.routePath).toBe('/projects/{project}/archive')
    })

    test('generates default path for index action', () => {
      const result = generateFeature({
        name: 'projects/index',
      })

      expect(result.routePath).toBe('/projects')
    })

    test('generates default path for show action', () => {
      const result = generateFeature({
        name: 'projects/show',
      })

      expect(result.routePath).toBe('/projects/{project}')
    })

    test('generates default path for create action', () => {
      const result = generateFeature({
        name: 'projects/create',
        method: 'POST',
      })

      expect(result.routePath).toBe('/projects')
    })

    test('uses custom path when provided', () => {
      const result = generateFeature({
        name: 'projects/custom',
        path: '/api/v1/projects/custom-action',
      })

      expect(result.routePath).toBe('/api/v1/projects/custom-action')
    })

    test('fails for invalid name format', () => {
      const result = generateFeature({
        name: 'invalid',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('resource/action')
    })
  })

  describe('Content Generation', () => {
    test('includes imports', () => {
      const result = generateFeature({
        name: 'projects/archive',
      })

      expect(result.content).toContain("import { Effect } from 'effect'")
      expect(result.content).toContain("import * as S from 'effect/Schema'")
      expect(result.content).toContain("from '@popcomputer/web/effect'")
    })

    test('includes route metadata', () => {
      const result = generateFeature({
        name: 'projects/archive',
        method: 'POST',
      })

      expect(result.content).toContain("method: 'POST'")
      expect(result.content).toContain("path: '/projects/{project}/archive'")
      expect(result.content).toContain("name: 'projects.archive'")
    })

    test('includes handler with Effect.gen', () => {
      const result = generateFeature({
        name: 'projects/list',
        method: 'GET',
      })

      expect(result.content).toContain('export const handler = action(')
      expect(result.content).toContain('Effect.gen(function* ()')
    })

    test('includes authorize for auth: required', () => {
      const result = generateFeature({
        name: 'projects/create',
        method: 'POST',
        auth: 'required',
      })

      expect(result.content).toContain('const user = yield* authorize()')
    })

    test('excludes authorize for auth: none', () => {
      const result = generateFeature({
        name: 'api/status',
        method: 'GET',
        auth: 'none',
      })

      expect(result.content).not.toContain('yield* authorize()')
    })

    test('includes bound for routes with bindings', () => {
      const result = generateFeature({
        name: 'projects/show',
        method: 'GET',
        path: '/projects/{project}',
      })

      expect(result.content).toContain("yield* bound('project')")
    })

    test('includes validateRequest for routes with fields', () => {
      const result = generateFeature({
        name: 'projects/update',
        method: 'PUT',
        fields: [
          { name: 'name', type: 'string', modifier: 'required' },
        ],
      })

      expect(result.content).toContain('const input = yield* validateRequest(params)')
    })

    test('scaffolds dbMutation for mutating handlers', () => {
      const result = generateFeature({
        name: 'projects/create',
        method: 'POST',
        auth: 'required',
        fields: [
          { name: 'name', type: 'string', modifier: 'required' },
        ],
      })

      expect(result.content).toContain('const db = yield* DatabaseService')
      expect(result.content).toContain('yield* dbMutation(db, trustedInput, async (tx, trustedInput) => {')
      expect(result.content).toContain('const trustedInput = asTrusted({')
      expect(result.content).toContain("return yield* redirect('/projects')")
    })

    test('does not scaffold dbMutation for GET handlers', () => {
      const result = generateFeature({
        name: 'projects/show',
        method: 'GET',
      })

      expect(result.content).not.toContain('yield* dbMutation(')
    })
  })

  describe('Props Type Generation', () => {
    test('includes props type by default', () => {
      const result = generateFeature({
        name: 'projects/show',
      })

      expect(result.content).toContain('export interface ProjectsShowProps')
    })

    test('excludes props type when disabled', () => {
      const result = generateFeature({
        name: 'projects/show',
        includeProps: false,
      })

      expect(result.content).not.toContain('export interface ProjectsShowProps')
    })
  })

  describe('Schema Generation', () => {
    test('generates schema for fields', () => {
      const result = generateFeature({
        name: 'projects/create',
        method: 'POST',
        fields: [
          { name: 'name', type: 'string', modifier: 'required' },
          { name: 'description', type: 'string', modifier: 'nullable' },
        ],
      })

      expect(result.content).toContain('export const params = S.Struct({')
      expect(result.content).toContain('name: S.String')
      expect(result.content).toContain('description: S.NullOr(S.String)')
    })

    test('handles optional fields', () => {
      const result = generateFeature({
        name: 'projects/update',
        method: 'PUT',
        fields: [
          { name: 'bio', type: 'string', modifier: 'optional' },
        ],
      })

      expect(result.content).toContain('bio: S.optional(S.String)')
    })

    test('handles different field types', () => {
      const result = generateFeature({
        name: 'items/create',
        method: 'POST',
        fields: [
          { name: 'count', type: 'number', modifier: 'required' },
          { name: 'active', type: 'boolean', modifier: 'required' },
          { name: 'id', type: 'uuid', modifier: 'required' },
        ],
      })

      expect(result.content).toContain('count: S.Number')
      expect(result.content).toContain('active: S.Boolean')
      expect(result.content).toContain('id: S.UUID')
    })
  })

  describe('Test Generation', () => {
    test('includes inline tests by default', () => {
      const result = generateFeature({
        name: 'projects/archive',
        method: 'POST',
      })

      expect(result.content).toContain('export const tests = {')
      expect(result.content).toContain('describeRoute')
    })

    test('includes success test case', () => {
      const result = generateFeature({
        name: 'projects/archive',
        method: 'POST',
      })

      expect(result.content).toContain("'archives project successfully'")
    })

    test('includes auth test for required auth', () => {
      const result = generateFeature({
        name: 'projects/archive',
        method: 'POST',
        auth: 'required',
      })

      expect(result.content).toContain("'requires authentication'")
      expect(result.content).toContain('toHaveStatus(401)')
    })

    test('includes 404 test for routes with bindings', () => {
      const result = generateFeature({
        name: 'projects/show',
        method: 'GET',
        path: '/projects/{project}',
      })

      expect(result.content).toContain("'returns 404 for missing project'")
      expect(result.content).toContain('toHaveStatus(404)')
    })

    test('excludes tests when disabled', () => {
      const result = generateFeature({
        name: 'projects/show',
        includeTests: false,
      })

      expect(result.content).not.toContain('export const tests = {')
    })
  })

  describe('HTTP Methods', () => {
    test('generates GET handler', () => {
      const result = generateFeature({
        name: 'projects/index',
        method: 'GET',
      })

      expect(result.content).toContain("method: 'GET'")
      expect(result.content).toContain('yield* render(')
    })

    test('generates POST handler', () => {
      const result = generateFeature({
        name: 'projects/create',
        method: 'POST',
      })

      expect(result.content).toContain("method: 'POST'")
    })

    test('generates DELETE handler', () => {
      const result = generateFeature({
        name: 'projects/destroy',
        method: 'DELETE',
      })

      expect(result.content).toContain("method: 'DELETE'")
      expect(result.content).toContain('status: 204')
    })
  })

  describe('Middleware', () => {
    test('includes middleware in route metadata', () => {
      const result = generateFeature({
        name: 'admin/dashboard',
        middleware: ['auth', 'admin'],
      })

      expect(result.content).toContain("middleware: ['auth', 'admin']")
    })

    test('excludes middleware array when empty', () => {
      const result = generateFeature({
        name: 'public/home',
        middleware: [],
      })

      expect(result.content).not.toContain('middleware:')
    })
  })

  describe('Custom Base Directory', () => {
    test('uses custom base directory', () => {
      const result = generateFeature({
        name: 'projects/archive',
        baseDir: 'app/features',
      })

      expect(result.path).toBe('app/features/projects/archive.ts')
    })
  })

  describe('Singularization', () => {
    test('singularizes plural resource names', () => {
      const result = generateFeature({
        name: 'projects/show',
        method: 'GET',
        path: '/projects/{project}',
      })

      // Should use 'project' (singular) for binding
      expect(result.content).toContain("const project = yield* bound('project')")
    })

    test('handles -ies plural', () => {
      const result = generateFeature({
        name: 'categories/show',
        method: 'GET',
      })

      expect(result.routePath).toBe('/categories/{category}')
    })

    test('handles -es plural', () => {
      const result = generateFeature({
        name: 'boxes/show',
        method: 'GET',
      })

      expect(result.routePath).toBe('/boxes/{box}')
    })
  })
})

describe('parseGenerateFeatureArgs', () => {
  test('parses feature name', () => {
    const options = parseGenerateFeatureArgs(['projects/archive'])
    expect(options.name).toBe('projects/archive')
  })

  test('parses --method option', () => {
    const options = parseGenerateFeatureArgs(['projects/archive', '--method', 'POST'])
    expect(options.method).toBe('POST')
  })

  test('parses -m shorthand', () => {
    const options = parseGenerateFeatureArgs(['projects/archive', '-m', 'post'])
    expect(options.method).toBe('POST')
  })

  test('parses --path option', () => {
    const options = parseGenerateFeatureArgs(['users/profile', '--path', '/profile'])
    expect(options.path).toBe('/profile')
  })

  test('parses -p shorthand', () => {
    const options = parseGenerateFeatureArgs(['users/profile', '-p', '/me'])
    expect(options.path).toBe('/me')
  })

  test('parses --fields option', () => {
    const options = parseGenerateFeatureArgs(['projects/create', '--fields', 'name:string:required'])
    expect(options.fields).toBe('name:string:required')
  })

  test('parses --auth option', () => {
    const options = parseGenerateFeatureArgs(['api/status', '--auth', 'none'])
    expect(options.auth).toBe('none')
  })

  test('parses --middleware option', () => {
    const options = parseGenerateFeatureArgs(['admin/users', '--middleware', 'auth,admin'])
    expect(options.middleware).toEqual(['auth', 'admin'])
  })

  test('parses --no-tests flag', () => {
    const options = parseGenerateFeatureArgs(['api/health', '--no-tests'])
    expect(options.noTests).toBe(true)
  })

  test('parses --no-props flag', () => {
    const options = parseGenerateFeatureArgs(['api/health', '--no-props'])
    expect(options.noProps).toBe(true)
  })

  test('parses --output option', () => {
    const options = parseGenerateFeatureArgs(['projects/show', '--output', 'app/routes'])
    expect(options.output).toBe('app/routes')
  })

  test('parses --preview flag', () => {
    const options = parseGenerateFeatureArgs(['projects/show', '--preview'])
    expect(options.preview).toBe(true)
  })

  test('parses multiple options', () => {
    const options = parseGenerateFeatureArgs([
      'projects/archive',
      '-m', 'POST',
      '-p', '/projects/{project}/archive',
      '--auth', 'required',
      '--no-tests',
    ])

    expect(options.name).toBe('projects/archive')
    expect(options.method).toBe('POST')
    expect(options.path).toBe('/projects/{project}/archive')
    expect(options.auth).toBe('required')
    expect(options.noTests).toBe(true)
  })
})

describe('generateFeatureHelp', () => {
  test('includes usage information', () => {
    const help = generateFeatureHelp()

    expect(help).toContain('popweb generate:feature')
    expect(help).toContain('USAGE')
    expect(help).toContain('OPTIONS')
    expect(help).toContain('EXAMPLES')
  })

  test('documents all options', () => {
    const help = generateFeatureHelp()

    expect(help).toContain('--method')
    expect(help).toContain('--path')
    expect(help).toContain('--fields')
    expect(help).toContain('--auth')
    expect(help).toContain('--middleware')
    expect(help).toContain('--no-tests')
    expect(help).toContain('--no-props')
    expect(help).toContain('--output')
    expect(help).toContain('--preview')
  })

  test('describes colocated feature concept', () => {
    const help = generateFeatureHelp()

    expect(help).toContain('Route metadata')
    expect(help).toContain('Props type')
    expect(help).toContain('Request params schema')
    expect(help).toContain('Effect handler')
    expect(help).toContain('Inline test cases')
  })
})
