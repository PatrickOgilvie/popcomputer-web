/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * CLI Generate Command Tests
 */

import { describe, test, expect } from 'bun:test'
// oxlint-disable-next-line effecttsgo/node-builtin-import -- These integration tests use real temporary files and native paths to verify the Node CLI filesystem boundary.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
// oxlint-disable-next-line effecttsgo/node-builtin-import -- These integration tests use real temporary files and native paths to verify the Node CLI filesystem boundary.
import { join } from 'node:path'
import {
  generateAction,
  parseSchemaString,
  parseGenerateActionArgs,
  generateActionHelp,
  generateCrud,
  parseGenerateCrudArgs,
  generateCrudHelp,
} from '../../src/cli/index.js'

describe('parseSchemaString', () => {
  test('parses simple field', () => {
    const fields = parseSchemaString('name:string:required')
    expect(fields).toEqual([
      { name: 'name', type: 'string', modifier: 'required' },
    ])
  })

  test('parses multiple fields', () => {
    const fields = parseSchemaString('name:string:required, description:string:nullable')
    expect(fields).toEqual([
      { name: 'name', type: 'string', modifier: 'required' },
      { name: 'description', type: 'string', modifier: 'nullable' },
    ])
  })

  test('defaults type to string', () => {
    const fields = parseSchemaString('name')
    expect(fields[0].type).toBe('string')
  })

  test('defaults modifier to required', () => {
    const fields = parseSchemaString('name:string')
    expect(fields[0].modifier).toBe('required')
  })

  test('handles empty string', () => {
    const fields = parseSchemaString('')
    expect(fields).toEqual([])
  })

  test('parses all field types', () => {
    const schema = 'a:string:required, b:number:required, c:boolean:required, d:date:required, e:uuid:required, f:email:required'
    const fields = parseSchemaString(schema)

    expect(fields.map((f) => f.type)).toEqual([
      'string', 'number', 'boolean', 'date', 'uuid', 'email',
    ])
  })

  test('parses all modifiers', () => {
    const schema = 'a:string:required, b:string:nullable, c:string:optional'
    const fields = parseSchemaString(schema)

    expect(fields.map((f) => f.modifier)).toEqual([
      'required', 'nullable', 'optional',
    ])
  })
})

describe('parseGenerateActionArgs', () => {
  test('parses action name', () => {
    const options = parseGenerateActionArgs(['projects/create'])
    expect(options.name).toBe('projects/create')
  })

  test('parses --method option', () => {
    const options = parseGenerateActionArgs(['test', '--method', 'POST'])
    expect(options.method).toBe('POST')
  })

  test('parses -m shorthand', () => {
    const options = parseGenerateActionArgs(['test', '-m', 'get'])
    expect(options.method).toBe('GET')
  })

  test('parses --path option', () => {
    const options = parseGenerateActionArgs(['test', '--path', '/projects'])
    expect(options.path).toBe('/projects')
  })

  test('parses -p shorthand', () => {
    const options = parseGenerateActionArgs(['test', '-p', '/users/{user}'])
    expect(options.path).toBe('/users/{user}')
  })

  test('parses --auth option', () => {
    const options = parseGenerateActionArgs(['test', '--auth', 'required'])
    expect(options.auth).toBe('required')
  })

  test('parses -a shorthand', () => {
    const options = parseGenerateActionArgs(['test', '-a', 'guest'])
    expect(options.auth).toBe('guest')
  })

  test('parses --schema option', () => {
    const options = parseGenerateActionArgs(['test', '--schema', 'name:string:required'])
    expect(options.schema).toBe('name:string:required')
  })

  test('parses -s shorthand', () => {
    const options = parseGenerateActionArgs(['test', '-s', 'title:string'])
    expect(options.schema).toBe('title:string')
  })

  test('parses --force flag', () => {
    const options = parseGenerateActionArgs(['test', '--force'])
    expect(options.force).toBe(true)
  })

  test('parses -f shorthand', () => {
    const options = parseGenerateActionArgs(['test', '-f'])
    expect(options.force).toBe(true)
  })

  test('parses --preview flag', () => {
    const options = parseGenerateActionArgs(['test', '--preview'])
    expect(options.preview).toBe(true)
  })

  test('parses --json flag', () => {
    const options = parseGenerateActionArgs(['test', '--json'])
    expect(options.json).toBe(true)
  })

  test('parses multiple options', () => {
    const options = parseGenerateActionArgs([
      'projects/create',
      '-m', 'POST',
      '-p', '/projects',
      '-a', 'required',
      '-s', 'name:string:required',
      '--force',
      '--json',
    ])

    expect(options.name).toBe('projects/create')
    expect(options.method).toBe('POST')
    expect(options.path).toBe('/projects')
    expect(options.auth).toBe('required')
    expect(options.schema).toBe('name:string:required')
    expect(options.force).toBe(true)
    expect(options.json).toBe(true)
  })
})

describe('generateAction', () => {
  describe('Colocated File Content', () => {
    test('generates basic action with inline tests', () => {
      const result = generateAction({
        name: 'projects/create',
        method: 'POST',
        path: '/projects',
      })

      // Action content
      expect(result.content).toContain("import { Effect } from 'effect'")
      expect(result.content).toContain('export const createProject = action(')
      expect(result.content).toContain("method: 'post'")
      expect(result.content).toContain("path: '/projects'")
      expect(result.content).toContain("name: 'projects.create'")

      // Inline tests
      expect(result.content).toContain('Integration Tests (self-executing in test mode)')
      expect(result.content).toContain('createTestApp')
    })

    test('includes authorize for required auth', () => {
      const result = generateAction({
        name: 'test',
        method: 'POST',
        path: '/test',
        auth: 'required',
      })

      expect(result.content).toContain('authorize')
      expect(result.content).toContain('const auth = yield* authorize()')
    })

    test('excludes authorize for no auth', () => {
      const result = generateAction({
        name: 'test',
        method: 'POST',
        path: '/test',
        auth: 'none',
      })

      // Handler shouldn't have authorize
      expect(result.content).not.toContain('const auth = yield* authorize()')
    })

    test('includes schema for validated actions', () => {
      const result = generateAction({
        name: 'projects/create',
        method: 'POST',
        path: '/projects',
        schema: 'name:string:required, description:string:nullable',
      })

      expect(result.content).toContain('Schema as S')
      expect(result.content).toContain('validateRequest')
      expect(result.content).toContain('CreateProjectSchema = S.Struct({')
      expect(result.content).toContain('name: S.String')
      expect(result.content).toContain('description: S.String.pipe(S.NullOr)')
    })

    test('includes bound for route parameters', () => {
      const result = generateAction({
        name: 'projects/show',
        method: 'GET',
        path: '/projects/{project}',
      })

      expect(result.content).toContain('bound')
      expect(result.content).toContain("const project = yield* bound('project')")
    })

    test('uses render for GET requests', () => {
      const result = generateAction({
        name: 'projects/show',
        method: 'GET',
        path: '/projects/{project}',
      })

      expect(result.content).toContain('render')
      expect(result.content).toContain("return yield* render('Projects/ShowProject'")
    })

    test('uses redirect for POST requests', () => {
      const result = generateAction({
        name: 'projects/create',
        method: 'POST',
        path: '/projects',
      })

      expect(result.content).toContain('redirect')
      expect(result.content).toContain("return yield* redirect('/projects')")
    })

    test('scaffolds dbMutation for non-GET requests', () => {
      const result = generateAction({
        name: 'projects/create',
        method: 'POST',
        path: '/projects',
      })

      expect(result.content).toContain('const db = yield* DatabaseService')
      expect(result.content).toContain('yield* dbMutation(db, trustedInput, async (tx, trustedInput) => {')
      expect(result.content).toContain('Replace with your Drizzle write')
    })

    test('uses trusted payload boundary for mutating authenticated actions', () => {
      const result = generateAction({
        name: 'projects/create',
        method: 'POST',
        path: '/projects',
        auth: 'required',
        schema: 'name:string:required',
      })

      expect(result.content).toContain('const trustedInput = asTrusted({')
      expect(result.content).toContain('...input,')
      expect(result.content).toContain('userId: auth.user.id,')
    })

    test('does not scaffold dbMutation for GET requests', () => {
      const result = generateAction({
        name: 'projects/index',
        method: 'GET',
        path: '/projects',
      })

      expect(result.content).not.toContain('yield* dbMutation(')
    })

    test('handles uuid field type', () => {
      const result = generateAction({
        name: 'test',
        method: 'POST',
        path: '/test',
        schema: 'id:uuid:required',
      })

      expect(result.content).toContain('uuid')
      expect(result.content).toContain('id: uuid')
    })

    test('handles email field type', () => {
      const result = generateAction({
        name: 'test',
        method: 'POST',
        path: '/test',
        schema: 'email:email:required',
      })

      expect(result.content).toContain('email')
    })
  })

  describe('Inline Tests', () => {
    test('generates inline tests in same file', () => {
      const result = generateAction({
        name: 'projects/create',
        method: 'POST',
        path: '/projects',
      })

      expect(result.content).toContain("describe(`Route: ${route.name}")
      expect(result.content).toContain('createTestApp')
      expect(result.content).toContain('effectRoutes(app)')
      expect(result.content).not.toContain('new RouteRegistry()')
      expect(result.content).toContain('setupWeb(app, {')
      expect(result.content).toContain('database: () => ({})')
      expect(result.content).toContain('client: () => ({')
      expect(result.content).not.toContain('popweb: {')
    })

    test('includes auth tests for required auth', () => {
      const result = generateAction({
        name: 'test',
        method: 'POST',
        path: '/test',
        auth: 'required',
      })

      expect(result.content).toContain('redirects unauthenticated users to login')
      expect(result.content).toContain("toContain('/login')")
      expect(result.content).toContain("expiresAt: new Date('2099-01-01T00:00:00.000Z')")
    })

    test('generated authenticated mutation tests execute successfully', async () => {
      const result = generateAction({
        name: 'generated/create',
        method: 'POST',
        path: '/generated',
        auth: 'required',
        schema: 'name:string:required',
      })

      const directory = mkdtempSync(join(import.meta.dir, '.generated-action-'))
      const file = join(directory, 'create.ts')

      try {
        writeFileSync(file, result.content)

        const child = Bun.spawn(['bun', 'test', file], {
          cwd: join(import.meta.dir, '../..'),
          env: { ...process.env, NODE_ENV: 'test' },
          stdout: 'pipe',
          stderr: 'pipe',
        })

        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])

        expect(`${stdout}\n${stderr}`).toContain('3 pass')
        expect(exitCode).toBe(0)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })

    test('includes validation tests for schema', () => {
      const result = generateAction({
        name: 'test',
        method: 'POST',
        path: '/test',
        schema: 'name:string:required',
      })

      expect(result.content).toContain('validates required fields')
      expect(result.content).toContain('body: JSON.stringify({})')
      expect(result.content).toContain('toBe(422)')
    })

    test('includes 404 tests for route params', () => {
      const result = generateAction({
        name: 'test',
        method: 'GET',
        path: '/test/{item}',
      })

      expect(result.content).toContain('returns 404 for non-existent resource')
      expect(result.content).toContain('/test/non-existent-id')
    })

    test('includes success case test', () => {
      const result = generateAction({
        name: 'test',
        method: 'POST',
        path: '/test',
      })

      expect(result.content).toContain('processes request')
      expect(result.content).toContain('buildHeaders')
      expect(result.content).toContain('expect(res.status).toBe(303)')
    })

    test('can skip inline tests', () => {
      const result = generateAction({
        name: 'test',
        method: 'POST',
        path: '/test',
        skipTests: true,
      })

      expect(result.content).not.toContain('Integration Tests')
      expect(result.content).not.toContain('describe(')
    })
  })

  describe('File Paths', () => {
    test('generates correct path for resource/action format', () => {
      const result = generateAction({
        name: 'projects/create',
        method: 'POST',
        path: '/projects',
      })

      expect(result.path).toBe('src/actions/projects/create.ts')
    })

    test('generates correct path for PascalCase format', () => {
      const result = generateAction({
        name: 'CreateProject',
        method: 'POST',
        path: '/projects',
      })

      expect(result.path).toBe('src/actions/projects/create.ts')
    })

    test('respects custom directories', () => {
      const result = generateAction({
        name: 'test',
        method: 'POST',
        path: '/test',
        actionsDir: 'app/actions',
      })

      expect(result.path).toBe('app/actions/test.ts')
    })
  })

  describe('Route Name', () => {
    test('generates route name from resource/action', () => {
      const result = generateAction({
        name: 'projects/create',
        method: 'POST',
        path: '/projects',
      })

      expect(result.routeName).toBe('projects.create')
    })

    test('generates route name from PascalCase', () => {
      const result = generateAction({
        name: 'CreateProject',
        method: 'POST',
        path: '/projects',
      })

      expect(result.routeName).toBe('projects.create')
    })
  })
})

describe('generateActionHelp', () => {
  test('includes usage information', () => {
    const help = generateActionHelp()

    expect(help).toContain('popweb generate:action')
    expect(help).toContain('USAGE')
    expect(help).toContain('OPTIONS')
    expect(help).toContain('EXAMPLES')
  })

  test('documents all options', () => {
    const help = generateActionHelp()

    expect(help).toContain('--method')
    expect(help).toContain('--path')
    expect(help).toContain('--auth')
    expect(help).toContain('--schema')
    expect(help).toContain('--force')
    expect(help).toContain('--preview')
    expect(help).toContain('--json')
  })

  test('documents schema format', () => {
    const help = generateActionHelp()

    expect(help).toContain('SCHEMA FORMAT')
    expect(help).toContain('string')
    expect(help).toContain('number')
    expect(help).toContain('boolean')
    expect(help).toContain('required')
    expect(help).toContain('nullable')
    expect(help).toContain('optional')
  })
})

// ─────────────────────────────────────────────────────────────
// CRUD Generation Tests
// ─────────────────────────────────────────────────────────────

describe('generateCrud', () => {
  describe('Full CRUD Generation', () => {
    test('generates all 5 CRUD actions', () => {
      const result = generateCrud({ resource: 'projects' })

      expect(result.actions.length).toBe(5)
      expect(result.actions.map((a) => a.action)).toEqual([
        'index', 'show', 'create', 'update', 'destroy',
      ])
    })

    test('generates correct route names', () => {
      const result = generateCrud({ resource: 'projects' })

      expect(result.actions.map((a) => a.routeName)).toEqual([
        'projects.index',
        'projects.show',
        'projects.create',
        'projects.update',
        'projects.destroy',
      ])
    })

    test('generates correct paths', () => {
      const result = generateCrud({ resource: 'projects' })

      const paths = result.actions.map((a) => a.path)
      expect(paths).toContain('src/actions/projects/index.ts')
      expect(paths).toContain('src/actions/projects/show.ts')
      expect(paths).toContain('src/actions/projects/create.ts')
      expect(paths).toContain('src/actions/projects/update.ts')
      expect(paths).toContain('src/actions/projects/destroy.ts')
    })

    test('generates index file', () => {
      const result = generateCrud({ resource: 'projects' })

      expect(result.indexPath).toBe('src/actions/projects/index.ts')
      expect(result.indexContent).toContain('Project Actions')
      expect(result.indexContent).toContain('projectsRoutes')
    })
  })

  describe('Action Content', () => {
    test('index action uses GET method', () => {
      const result = generateCrud({ resource: 'projects' })
      const indexAction = result.actions.find((a) => a.action === 'index')

      expect(indexAction?.content).toContain("method: 'get'")
      expect(indexAction?.content).toContain("path: '/projects'")
    })

    test('show action has route binding', () => {
      const result = generateCrud({ resource: 'projects' })
      const showAction = result.actions.find((a) => a.action === 'show')

      expect(showAction?.content).toContain("path: '/projects/{project}'")
      expect(showAction?.content).toContain("bound('project')")
    })

    test('create action uses POST method', () => {
      const result = generateCrud({ resource: 'projects' })
      const createAction = result.actions.find((a) => a.action === 'create')

      expect(createAction?.content).toContain("method: 'post'")
    })

    test('update action uses PUT method', () => {
      const result = generateCrud({ resource: 'projects' })
      const updateAction = result.actions.find((a) => a.action === 'update')

      expect(updateAction?.content).toContain("method: 'put'")
      expect(updateAction?.content).toContain("path: '/projects/{project}'")
    })

    test('destroy action uses DELETE method', () => {
      const result = generateCrud({ resource: 'projects' })
      const destroyAction = result.actions.find((a) => a.action === 'destroy')

      expect(destroyAction?.content).toContain("method: 'delete'")
    })

    test('schema applies to create and update only', () => {
      const result = generateCrud({
        resource: 'projects',
        schema: 'name:string:required',
      })

      const createAction = result.actions.find((a) => a.action === 'create')
      const updateAction = result.actions.find((a) => a.action === 'update')
      const indexAction = result.actions.find((a) => a.action === 'index')

      expect(createAction?.content).toContain('CreateProjectSchema')
      expect(updateAction?.content).toContain('UpdateProjectSchema')
      expect(indexAction?.content).not.toContain('Schema as S')
    })

    test('all actions include inline tests', () => {
      const result = generateCrud({ resource: 'projects' })

      for (const action of result.actions) {
        expect(action.content).toContain('Integration Tests')
      }
    })
  })

  describe('Filtering Actions', () => {
    test('only generates specified actions', () => {
      const result = generateCrud({
        resource: 'projects',
        only: ['index', 'show'],
      })

      expect(result.actions.length).toBe(2)
      expect(result.actions.map((a) => a.action)).toEqual(['index', 'show'])
    })

    test('except excludes specified actions', () => {
      const result = generateCrud({
        resource: 'projects',
        except: ['destroy'],
      })

      expect(result.actions.length).toBe(4)
      expect(result.actions.map((a) => a.action)).not.toContain('destroy')
    })
  })

  describe('Singularization', () => {
    test('singularizes regular plurals', () => {
      const result = generateCrud({ resource: 'projects' })
      const showAction = result.actions.find((a) => a.action === 'show')

      expect(showAction?.content).toContain('{project}')
    })

    test('singularizes -ies plurals', () => {
      const result = generateCrud({ resource: 'categories' })
      const showAction = result.actions.find((a) => a.action === 'show')

      expect(showAction?.content).toContain('{category}')
    })

    test('singularizes -es plurals', () => {
      const result = generateCrud({ resource: 'boxes' })
      const showAction = result.actions.find((a) => a.action === 'show')

      expect(showAction?.content).toContain('{box}')
    })
  })

  describe('Custom Directories', () => {
    test('respects custom action directory', () => {
      const result = generateCrud({
        resource: 'projects',
        actionsDir: 'app/handlers',
      })

      expect(result.actions[0].path).toContain('app/handlers/projects')
      expect(result.indexPath).toBe('app/handlers/projects/index.ts')
    })
  })
})

describe('parseGenerateCrudArgs', () => {
  test('parses resource name', () => {
    const options = parseGenerateCrudArgs(['projects'])
    expect(options.resource).toBe('projects')
  })

  test('parses --schema option', () => {
    const options = parseGenerateCrudArgs(['projects', '--schema', 'name:string'])
    expect(options.schema).toBe('name:string')
  })

  test('parses -s shorthand', () => {
    const options = parseGenerateCrudArgs(['projects', '-s', 'name:string'])
    expect(options.schema).toBe('name:string')
  })

  test('parses --auth option', () => {
    const options = parseGenerateCrudArgs(['projects', '--auth', 'required'])
    expect(options.auth).toBe('required')
  })

  test('parses --only option', () => {
    const options = parseGenerateCrudArgs(['projects', '--only', 'index,show'])
    expect(options.only).toBe('index,show')
  })

  test('parses --except option', () => {
    const options = parseGenerateCrudArgs(['projects', '--except', 'destroy'])
    expect(options.except).toBe('destroy')
  })

  test('parses --force flag', () => {
    const options = parseGenerateCrudArgs(['projects', '--force'])
    expect(options.force).toBe(true)
  })

  test('parses --preview flag', () => {
    const options = parseGenerateCrudArgs(['projects', '--preview'])
    expect(options.preview).toBe(true)
  })

  test('parses --json flag', () => {
    const options = parseGenerateCrudArgs(['projects', '--json'])
    expect(options.json).toBe(true)
  })

  test('parses multiple options', () => {
    const options = parseGenerateCrudArgs([
      'projects',
      '-s', 'name:string',
      '-a', 'required',
      '--only', 'index,create',
      '--json',
    ])

    expect(options.resource).toBe('projects')
    expect(options.schema).toBe('name:string')
    expect(options.auth).toBe('required')
    expect(options.only).toBe('index,create')
    expect(options.json).toBe(true)
  })
})

describe('generateCrudHelp', () => {
  test('includes usage information', () => {
    const help = generateCrudHelp()

    expect(help).toContain('popweb generate:crud')
    expect(help).toContain('USAGE')
    expect(help).toContain('OPTIONS')
    expect(help).toContain('EXAMPLES')
  })

  test('documents all options', () => {
    const help = generateCrudHelp()

    expect(help).toContain('--schema')
    expect(help).toContain('--auth')
    expect(help).toContain('--only')
    expect(help).toContain('--except')
    expect(help).toContain('--force')
    expect(help).toContain('--preview')
    expect(help).toContain('--json')
  })

  test('lists all CRUD actions', () => {
    const help = generateCrudHelp()

    expect(help).toContain('index')
    expect(help).toContain('show')
    expect(help).toContain('create')
    expect(help).toContain('update')
    expect(help).toContain('destroy')
  })

  test('shows HTTP methods for actions', () => {
    const help = generateCrudHelp()

    expect(help).toContain('GET')
    expect(help).toContain('POST')
    expect(help).toContain('PUT')
    expect(help).toContain('DELETE')
  })
})
