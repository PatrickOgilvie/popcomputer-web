/**
 * Code Generation Module
 *
 * Generates colocated action files with inline integration tests for Honertia.
 * Designed for AI agent workflows - one file contains everything:
 * - Route metadata
 * - Request schema
 * - Handler logic
 * - Integration tests (self-executing in test mode)
 *
 * This approach minimizes file operations and context pollution for LLMs.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * HTTP methods supported for actions.
 */
export type ActionMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * Authentication requirement for an action.
 */
export type AuthRequirement = 'required' | 'optional' | 'guest' | 'none'

/**
 * Field type for schema generation.
 */
export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'uuid' | 'email' | 'url'

/**
 * Field modifier for schema generation.
 */
export type FieldModifier = 'required' | 'nullable' | 'optional'

/**
 * Parsed field definition.
 */
export interface FieldDefinition {
  name: string
  type: FieldType
  modifier: FieldModifier
}

/**
 * Options for generating an action.
 */
export interface GenerateActionOptions {
  /**
   * Action name (e.g., 'projects/create' or 'CreateProject').
   */
  name: string
  /**
   * HTTP method.
   */
  method: ActionMethod
  /**
   * Route path (e.g., '/projects' or '/projects/{project}').
   */
  path: string
  /**
   * Authentication requirement.
   */
  auth?: AuthRequirement
  /**
   * Schema definition string (e.g., 'name:string:required, description:string:nullable').
   */
  schema?: string
  /**
   * Output directory for action files.
   */
  actionsDir?: string
  /**
   * Skip inline test generation.
   */
  skipTests?: boolean
  /**
   * Overwrite existing files.
   */
  force?: boolean
  /**
   * Preview mode - return generated code without writing files.
   */
  preview?: boolean
}

/**
 * Result of action generation.
 */
export interface GenerateActionResult {
  /**
   * Generated action file content (includes inline tests).
   */
  content: string
  /**
   * Path where action file will be/was written.
   */
  path: string
  /**
   * Route name for the action.
   */
  routeName: string
  /**
   * Whether file was written (false in preview mode).
   */
  written: boolean
}

/**
 * Parse a schema string into field definitions.
 *
 * @example
 * parseSchemaString('name:string:required, description:string:nullable')
 * // => [{ name: 'name', type: 'string', modifier: 'required' }, ...]
 */
export function parseSchemaString(schema: string): FieldDefinition[] {
  if (!schema.trim()) return []

  return schema.split(',').map((field) => {
    const parts = field.trim().split(':')
    const name = parts[0]?.trim() ?? ''
    const type = (parts[1]?.trim() ?? 'string') as FieldType
    const modifier = (parts[2]?.trim() ?? 'required') as FieldModifier

    return { name, type, modifier }
  })
}

/**
 * Convert a field type to Effect Schema type.
 */
function fieldTypeToSchema(type: FieldType): string {
  switch (type) {
    case 'string':
      return 'S.String'
    case 'number':
      return 'S.Number'
    case 'boolean':
      return 'S.Boolean'
    case 'date':
      return 'S.Date'
    case 'uuid':
      return 'uuid'
    case 'email':
      return 'email'
    case 'url':
      return 'S.String.pipe(S.pattern(/^https?:\\/\\/.+/))'
    default:
      return 'S.String'
  }
}

/**
 * Generate schema field with modifier.
 */
function generateSchemaField(field: FieldDefinition): string {
  const baseType = fieldTypeToSchema(field.type)

  switch (field.modifier) {
    case 'nullable':
      return `${baseType}.pipe(S.NullOr)`
    case 'optional':
      return `S.optional(${baseType})`
    default:
      return baseType
  }
}

/**
 * Convert action name to various formats.
 */
function parseActionName(name: string): {
  pascalCase: string
  camelCase: string
  routeName: string
  directory: string
  fileName: string
} {
  // Handle 'projects/create' format
  if (name.includes('/')) {
    const parts = name.split('/')
    const resource = parts[0]
    const action = parts[1]

    const pascalResource = resource.charAt(0).toUpperCase() + resource.slice(1)
    const pascalAction = action.charAt(0).toUpperCase() + action.slice(1)

    return {
      pascalCase: `${pascalAction}${pascalResource.slice(0, -1)}`, // CreateProject
      camelCase: `${action}${pascalResource.slice(0, -1)}`, // createProject
      routeName: `${resource}.${action}`, // projects.create
      directory: resource, // projects
      fileName: action, // create
    }
  }

  // Handle 'CreateProject' format
  const pascalCase = name.charAt(0).toUpperCase() + name.slice(1)
  const camelCase = name.charAt(0).toLowerCase() + name.slice(1)

  // Try to extract resource from PascalCase (e.g., CreateProject -> project)
  const match = name.match(/^([A-Z][a-z]+)([A-Z][a-z]+)$/)
  if (match) {
    const action = match[1].toLowerCase()
    const resource = match[2].toLowerCase()

    return {
      pascalCase,
      camelCase,
      routeName: `${resource}s.${action}`,
      directory: `${resource}s`,
      fileName: action,
    }
  }

  return {
    pascalCase,
    camelCase,
    routeName: camelCase,
    directory: '',
    fileName: camelCase,
  }
}

/**
 * Extract route parameters from path.
 */
function extractRouteParams(path: string): string[] {
  const matches = path.match(/\{([^}:]+)(?::[^}]+)?\}/g) ?? []
  return matches.map((m) => m.replace(/[{}:]/g, '').split(':')[0])
}

/**
 * Generate colocated action file content with inline tests.
 */
function generateActionContent(options: GenerateActionOptions): string {
  const { method, path, auth = 'required', schema, skipTests = false } = options
  const names = parseActionName(options.name)
  const fields = schema ? parseSchemaString(schema) : []
  const routeParams = extractRouteParams(path)
  const isMutationMethod = method !== 'GET'

  const needsAuth = auth === 'required' || auth === 'optional'
  const needsValidation = fields.length > 0
  const needsBinding = routeParams.length > 0

  // Build imports
  const effectImports = ['Effect']
  if (needsValidation) effectImports.push('Schema as S')

  const honertiaImports = ['action']
  if (isMutationMethod) {
    honertiaImports.push('DatabaseService', 'dbMutation')
  }
  if (needsAuth) honertiaImports.push('authorize')
  if (needsValidation) honertiaImports.push('validateRequest')
  if (needsBinding) honertiaImports.push('bound')
  if (isMutationMethod && (needsValidation || needsAuth)) {
    honertiaImports.push('asTrusted')
  }

  // Add response helpers based on method
  if (method === 'GET') {
    honertiaImports.push('render')
  } else {
    honertiaImports.push('redirect')
  }

  // Add schema helpers if needed
  const schemaImports: string[] = []
  if (fields.some((f) => f.type === 'uuid')) schemaImports.push('uuid')
  if (fields.some((f) => f.type === 'email')) schemaImports.push('email')

  let content = `/**
 * ${names.pascalCase} Action
 *
 * Route: ${method} ${path}
 * Name: ${names.routeName}
 *
 * This file contains:
 * - Route configuration
 * - Request schema (if applicable)
 * - Handler logic
 * - Integration tests (run with: bun test ${names.directory ? `src/actions/${names.directory}/${names.fileName}.ts` : `src/actions/${names.fileName}.ts`})
 */

import { ${effectImports.join(', ')} } from 'effect'
import {
  ${honertiaImports.join(',\n  ')},${schemaImports.length > 0 ? `\n  ${schemaImports.join(',\n  ')},` : ''}
} from 'honertia/effect'
`

  // Add schema if needed
  if (needsValidation) {
    content += `
// ─────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────

export const ${names.pascalCase}Schema = S.Struct({
${fields.map((f) => `  ${f.name}: ${generateSchemaField(f)},`).join('\n')}
})

export type ${names.pascalCase}Input = S.Schema.Type<typeof ${names.pascalCase}Schema>
`
  }

  // Add route configuration
  content += `
// ─────────────────────────────────────────────────────────────
// Route Configuration
// ─────────────────────────────────────────────────────────────

export const route = {
  method: '${method.toLowerCase()}' as const,
  path: '${path}',
  name: '${names.routeName}',
}
`

  // Add action handler
  content += `
// ─────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────

export const ${names.camelCase} = action(
  Effect.gen(function* () {
`

  // Add auth check
  if (needsAuth) {
    content += `    const auth = yield* authorize()
`
  }

  // Add route model binding
  if (needsBinding) {
    for (const param of routeParams) {
      content += `    const ${param} = yield* bound('${param}')
`
    }
  }

  // Add validation
  if (needsValidation) {
    content += `
    const input = yield* validateRequest(${names.pascalCase}Schema)
`
  }

  // Add return based on method
  if (method === 'GET') {
    const componentName = names.directory
      ? `${names.directory.charAt(0).toUpperCase() + names.directory.slice(1)}/${names.pascalCase}`
      : names.pascalCase

    content += `
    // TODO: Implement ${names.camelCase} logic

    return yield* render('${componentName}', {
${needsBinding ? routeParams.map((p) => `      ${p},`).join('\n') + '\n' : ''}    })
`
  } else {
    const redirectPath = names.directory ? `/${names.directory}` : '/'
    const trustedFields: string[] = []
    if (needsValidation) trustedFields.push('...input,')
    if (needsAuth) trustedFields.push('userId: auth.user.id,')

    if (trustedFields.length > 0) {
      content += `
    const trustedInput = asTrusted({
${trustedFields.map((line) => `      ${line}`).join('\n')}
    })
`
    }

    content += `
    const db = yield* DatabaseService

${trustedFields.length > 0
  ? `    yield* dbMutation(db, trustedInput, async (tx, trustedInput) => {
      // TODO: Replace with your Drizzle write.
      // await tx.insert(schema.tableName).values(trustedInput)
      void tx
      void trustedInput
    })
`
  : `    yield* dbMutation(db, async (tx) => {
      // TODO: Replace with your Drizzle write.
      // await tx.insert(schema.tableName).values(asTrusted({ ... }))
      void tx
    })
`}
    return yield* redirect('${redirectPath}')
`
  }

  content += `  })
)
`

  // Add inline tests if not skipped
  if (!skipTests) {
    content += generateInlineTests(options, names, fields, routeParams, needsAuth, needsValidation)
  }

  return content
}

/**
 * Generate inline tests section for action file.
 * Tests self-execute when the file is run in test mode.
 */
function generateInlineTests(
  options: GenerateActionOptions,
  names: ReturnType<typeof parseActionName>,
  fields: FieldDefinition[],
  routeParams: string[],
  needsAuth: boolean,
  needsValidation: boolean
): string {
  const { method } = options

  let content = `
// ─────────────────────────────────────────────────────────────
// Integration Tests (self-executing in test mode)
// ─────────────────────────────────────────────────────────────

// Tests run automatically when file is executed with bun test
if (typeof Bun !== 'undefined' && Bun.env?.NODE_ENV === 'test') {
  const { describe, test, expect } = await import('bun:test')
  const { Hono } = await import('hono')
  const { effectRoutes } = await import('honertia/effect')
  const { setupHonertia } = await import('honertia')

  const sessionCookie = 'better-auth.session_token'
  const sessionToken = 'test-session-token'

  const buildHeaders = (
    authenticated: boolean,
    extra: Record<string, string> = {}
  ): Record<string, string> => ({
    ...(authenticated ? { Cookie: \`\${sessionCookie}=\${sessionToken}\` } : {}),
    ...extra,
  })

  // Create test app with this route
  const createTestApp = () => {
    const app = new Hono()

    setupHonertia(app, {
      honertia: {
        version: '1.0.0',
        render: (page) => JSON.stringify(page),
${method !== 'GET' ? `        database: () => ({}),
` : ''}      },
      auth: {
        client: () => ({
          api: {
            getSession: async ({ headers }: { headers: Headers }) => {
              const cookie = headers.get('cookie') ?? ''
              if (!cookie.includes(\`\${sessionCookie}=\${sessionToken}\`)) {
                return null
              }

              return {
                user: {
                  id: 'test-user',
                  email: 'test@example.com',
                  name: 'Test User',
                  emailVerified: true,
                  image: null,
                  createdAt: new Date('2024-01-01T00:00:00.000Z'),
                  updatedAt: new Date('2024-01-01T00:00:00.000Z'),
                },
                session: {
                  id: 'test-session',
                  userId: 'test-user',
                  expiresAt: new Date('2099-01-01T00:00:00.000Z'),
                  token: sessionToken,
                  createdAt: new Date('2024-01-01T00:00:00.000Z'),
                  updatedAt: new Date('2024-01-01T00:00:00.000Z'),
                },
              }
            },
          },
        }),
        sessionCookie,
      },
    })

    effectRoutes(app)
      .${method.toLowerCase()}(route.path, ${names.camelCase}, { name: route.name })

    return { app }
  }

  describe(\`Route: \${route.name} [\${route.method.toUpperCase()} \${route.path}]\`, () => {
    const { app } = createTestApp()
`

  // Add authentication tests
  if (needsAuth) {
    content += `
    test('${needsValidation && method !== 'GET' ? 'rejects unauthenticated JSON requests' : 'redirects unauthenticated users to login'}', async () => {
      const res = await app.request('${options.path.replace(/\{[^}]+\}/g, 'test-id')}', {
        method: '${method}',
${needsValidation && method !== 'GET' ? `        headers: { 'Content-Type': 'application/json' },\n        body: JSON.stringify({ ${fields.map((f) => `${f.name}: 'test'`).join(', ')} }),\n` : ''}      })

      expect(res.status).toBe(${needsValidation && method !== 'GET' ? '401' : '302'})
${needsValidation && method !== 'GET' ? '' : "      expect(res.headers.get('location')).toContain('/login')\n"}    })
`
  }

  // Add validation tests
  if (needsValidation && method !== 'GET') {
    content += `
    test('validates required fields', async () => {
      const res = await app.request('${options.path.replace(/\{[^}]+\}/g, 'test-id')}', {
        method: '${method}',
        headers: buildHeaders(${needsAuth ? 'true' : 'false'}, {
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(422)
    })
`
  }

  // Add route param tests
  if (routeParams.length > 0) {
    content += `
    test('returns 404 for non-existent resource', async () => {
      const res = await app.request('${options.path.replace(/\{[^}]+\}/g, 'non-existent-id')}', {
        method: '${method}',
        headers: buildHeaders(${needsAuth ? 'true' : 'false'}${
      needsValidation && method !== 'GET'
        ? `, {\n          'Content-Type': 'application/json',\n        }`
        : ''
    }),
${needsValidation && method !== 'GET' ? `        body: JSON.stringify({ ${fields.map((f) => `${f.name}: 'test'`).join(', ')} }),\n` : ''}      })

      expect(res.status).toBe(404)
    })
`
  }

  // Add success test
  content += `
    test('${method === 'GET' ? 'renders page' : 'processes request'} with valid data', async () => {
      const res = await app.request('${options.path.replace(/\{[^}]+\}/g, 'valid-id')}', {
        method: '${method}',
        headers: buildHeaders(${needsAuth ? 'true' : 'false'}${
    needsValidation && method !== 'GET'
      ? `, {\n          'Content-Type': 'application/json',\n        }`
      : ''
  }),
${needsValidation && method !== 'GET' ? `        body: JSON.stringify({ ${fields.map((f) => `${f.name}: 'test value'`).join(', ')} }),\n` : ''}      })

      expect(res.status).toBe(${method === 'GET' ? '200' : '303'})
    })
`

  content += `  })
}
`

  return content
}

/**
 * Generate a colocated action file with inline tests.
 *
 * @example
 * ```typescript
 * const result = generateAction({
 *   name: 'projects/create',
 *   method: 'POST',
 *   path: '/projects',
 *   auth: 'required',
 *   schema: 'name:string:required, description:string:nullable',
 * })
 *
 * console.log(result.content) // Single file with action + inline tests
 * console.log(result.path)    // src/actions/projects/create.ts
 * ```
 */
export function generateAction(options: GenerateActionOptions): GenerateActionResult {
  const names = parseActionName(options.name)
  const actionsDir = options.actionsDir ?? 'src/actions'

  const path = names.directory
    ? `${actionsDir}/${names.directory}/${names.fileName}.ts`
    : `${actionsDir}/${names.fileName}.ts`

  const content = generateActionContent(options)

  return {
    content,
    path,
    routeName: names.routeName,
    written: false, // CLI will handle file writing
  }
}

function writeGeneratedFile(path: string, content: string, force = false): void {
  if (existsSync(path) && !force) {
    throw new Error(`File already exists: ${path}. Use --force to overwrite.`)
  }

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

/**
 * Options for the generate:action CLI command.
 */
export interface GenerateActionCliOptions {
  name: string
  method?: string
  path?: string
  auth?: string
  schema?: string
  actionsDir?: string
  skipTests?: boolean
  force?: boolean
  preview?: boolean
  json?: boolean
}

/**
 * Parse CLI arguments for generate:action command.
 */
export function parseGenerateActionArgs(args: string[]): GenerateActionCliOptions {
  const options: GenerateActionCliOptions = {
    name: '',
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (!arg.startsWith('-')) {
      if (!options.name) {
        options.name = arg
      }
      continue
    }

    switch (arg) {
      case '--method':
      case '-m':
        options.method = args[++i]?.toUpperCase()
        break
      case '--path':
      case '-p':
        options.path = args[++i]
        break
      case '--auth':
      case '-a':
        options.auth = args[++i]
        break
      case '--schema':
      case '-s':
        options.schema = args[++i]
        break
      case '--actions-dir':
        options.actionsDir = args[++i]
        break
      case '--skip-tests':
      case '--no-tests':
        options.skipTests = true
        break
      case '--force':
      case '-f':
        options.force = true
        break
      case '--preview':
        options.preview = true
        break
      case '--json':
        options.json = true
        break
    }
  }

  return options
}

/**
 * Get help text for the generate:action command.
 */
export function generateActionHelp(): string {
  return `
honertia generate:action - Generate a colocated action with inline tests

USAGE:
  honertia generate:action <name> [OPTIONS]

ARGUMENTS:
  <name>              Action name (e.g., 'projects/create' or 'CreateProject')

OPTIONS:
  -m, --method        HTTP method (GET, POST, PUT, PATCH, DELETE)
  -p, --path          Route path (e.g., '/projects' or '/projects/{project}')
  -a, --auth          Auth requirement (required, optional, guest, none)
  -s, --schema        Schema definition (e.g., 'name:string:required, desc:string:nullable')
  --actions-dir       Output directory for actions (default: src/actions)
  --skip-tests        Skip inline test generation
  -f, --force         Overwrite existing files
  --preview           Preview generated code without writing
  --json              Output as JSON

OUTPUT:
  Creates a SINGLE file containing:
  - Route configuration (method, path, name)
  - Request schema (if --schema provided)
  - Effect handler with auth, validation, bindings
  - Inline integration tests (self-executing in test mode)

  Tests run automatically when file is executed with \`bun test\`

SCHEMA FORMAT:
  fieldName:type:modifier

  Types:     string, number, boolean, date, uuid, email, url
  Modifiers: required (default), nullable, optional

EXAMPLES:
  # Basic action
  honertia generate:action projects/create --method POST --path /projects

  # Action with authentication
  honertia generate:action projects/create --method POST --path /projects --auth required

  # Action with schema
  honertia generate:action projects/create \\
    --method POST \\
    --path /projects \\
    --auth required \\
    --schema "name:string:required, description:string:nullable"

  # Action with route parameters
  honertia generate:action projects/update \\
    --method PUT \\
    --path "/projects/{project}" \\
    --auth required \\
    --schema "name:string:required"

  # Preview generated code
  honertia generate:action projects/create --preview

  # Output as JSON (for agents)
  honertia generate:action projects/create --json --preview
`.trim()
}

/**
 * Run the generate:action command.
 */
export function runGenerateAction(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(generateActionHelp())
    return
  }

  const options = parseGenerateActionArgs(args)

  if (!options.name) {
    console.error('Error: Action name is required')
    console.error('Run "honertia generate:action --help" for usage')
    process.exit(1)
  }

  // Derive path from name if not provided
  const names = parseActionName(options.name)
  const defaultPath = names.directory
    ? `/${names.directory}`
    : `/${names.fileName}`

  const result = generateAction({
    name: options.name,
    method: (options.method ?? 'POST') as ActionMethod,
    path: options.path ?? defaultPath,
    auth: (options.auth ?? 'required') as AuthRequirement,
    schema: options.schema,
    actionsDir: options.actionsDir,
    skipTests: options.skipTests,
    force: options.force,
    preview: options.preview,
  })

  let written = false
  if (!options.preview) {
    try {
      writeGeneratedFile(result.path, result.content, options.force ?? false)
      written = true
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    }
  }

  if (options.json) {
    console.log(JSON.stringify({
      path: result.path,
      routeName: result.routeName,
      content: result.content,
      preview: options.preview ?? false,
      written,
    }, null, 2))
    return
  }

  if (options.preview) {
    console.log('Would create:', result.path)
    console.log('')
    console.log(result.content)
    return
  }

  console.log('Generated:', result.path)
  console.log(`  Route: ${result.routeName}`)
  console.log(`  Tests: ${options.skipTests ? 'skipped' : 'included (inline)'}`)
  console.log('')
  console.log(`Run tests with: bun test ${result.path}`)
}

// ─────────────────────────────────────────────────────────────
// CRUD Generation
// ─────────────────────────────────────────────────────────────

/**
 * CRUD action type.
 */
export type CrudAction = 'index' | 'show' | 'create' | 'update' | 'destroy'

/**
 * Options for generating CRUD actions.
 */
export interface GenerateCrudOptions {
  /**
   * Resource name (e.g., 'projects', 'users').
   */
  resource: string
  /**
   * Schema fields for create/update actions.
   */
  schema?: string
  /**
   * Authentication requirement for all actions.
   */
  auth?: AuthRequirement
  /**
   * Output directory for action files.
   */
  actionsDir?: string
  /**
   * Skip inline test generation.
   */
  skipTests?: boolean
  /**
   * Only generate specific actions.
   */
  only?: CrudAction[]
  /**
   * Exclude specific actions.
   */
  except?: CrudAction[]
  /**
   * Preview mode.
   */
  preview?: boolean
}

/**
 * Result of a single CRUD action generation.
 */
export interface CrudActionResult {
  action: CrudAction
  path: string
  routeName: string
  content: string
}

/**
 * Result of CRUD generation.
 */
export interface GenerateCrudResult {
  /**
   * Resource name.
   */
  resource: string
  /**
   * Generated actions.
   */
  actions: CrudActionResult[]
  /**
   * Index file content (re-exports all actions).
   */
  indexContent: string
  /**
   * Index file path.
   */
  indexPath: string
}

/**
 * Get singular form of a resource name.
 */
function singularize(word: string): string {
  if (word.endsWith('ies')) {
    return word.slice(0, -3) + 'y'
  }
  if (word.endsWith('es')) {
    return word.slice(0, -2)
  }
  if (word.endsWith('s')) {
    return word.slice(0, -1)
  }
  return word
}

/**
 * CRUD action configurations.
 */
const CRUD_CONFIGS: Record<CrudAction, {
  method: ActionMethod
  pathSuffix: string
  hasBinding: boolean
  needsSchema: boolean
}> = {
  index: { method: 'GET', pathSuffix: '', hasBinding: false, needsSchema: false },
  show: { method: 'GET', pathSuffix: '/{resource}', hasBinding: true, needsSchema: false },
  create: { method: 'POST', pathSuffix: '', hasBinding: false, needsSchema: true },
  update: { method: 'PUT', pathSuffix: '/{resource}', hasBinding: true, needsSchema: true },
  destroy: { method: 'DELETE', pathSuffix: '/{resource}', hasBinding: true, needsSchema: false },
}

/**
 * Generate full CRUD actions for a resource.
 *
 * @example
 * ```typescript
 * const result = generateCrud({
 *   resource: 'projects',
 *   schema: 'name:string:required, description:string:nullable',
 *   auth: 'required',
 * })
 *
 * // Generates 5 colocated action files + 1 index file
 * console.log(result.actions.map(a => a.routeName))
 * // ['projects.index', 'projects.show', 'projects.create', 'projects.update', 'projects.destroy']
 * ```
 */
export function generateCrud(options: GenerateCrudOptions): GenerateCrudResult {
  const {
    resource,
    schema,
    auth = 'required',
    actionsDir = 'src/actions',
    skipTests = false,
    only,
    except = [],
  } = options

  const singular = singularize(resource)
  const actions: CrudActionResult[] = []

  // Determine which actions to generate
  const allActions: CrudAction[] = ['index', 'show', 'create', 'update', 'destroy']
  const actionsToGenerate = only ?? allActions.filter((a) => !except.includes(a))

  for (const action of actionsToGenerate) {
    const config = CRUD_CONFIGS[action]
    const path = `/${resource}${config.pathSuffix.replace('{resource}', `{${singular}}`)}`

    const result = generateAction({
      name: `${resource}/${action}`,
      method: config.method,
      path,
      auth,
      schema: config.needsSchema ? schema : undefined,
      actionsDir,
      skipTests,
    })

    actions.push({
      action,
      path: result.path,
      routeName: result.routeName,
      content: result.content,
    })
  }

  // Generate index file that re-exports all actions
  const indexContent = generateCrudIndexContent(resource, actionsToGenerate)
  const indexPath = `${actionsDir}/${resource}/index.ts`

  return {
    resource,
    actions,
    indexContent,
    indexPath,
  }
}

/**
 * Generate index file content for CRUD actions.
 */
function generateCrudIndexContent(resource: string, actions: CrudAction[]): string {
  const singular = singularize(resource)
  const pascalSingular = singular.charAt(0).toUpperCase() + singular.slice(1)

  let content = `/**
 * ${pascalSingular} Actions
 *
 * Re-exports all ${resource} actions and their route configurations.
 */

`

  // Export each action
  for (const action of actions) {
    const actionName = `${action}${pascalSingular}`
    const exportName = action === 'index' ? `list${pascalSingular}s` : actionName

    content += `export { ${exportName === actionName ? actionName : `${getActionFunctionName(action, singular)} as ${exportName}`}, route as ${action}Route } from './${action}.js'\n`
  }

  // Export combined routes object
  content += `
/**
 * All ${resource} routes for registration.
 */
export const ${resource}Routes = {
${actions.map((a) => `  '${resource}.${a}': ${a}Route,`).join('\n')}
}
`

  return content
}

/**
 * Get the function name for a CRUD action.
 */
function getActionFunctionName(action: CrudAction, singular: string): string {
  const pascalSingular = singular.charAt(0).toUpperCase() + singular.slice(1)

  switch (action) {
    case 'index':
      return `list${pascalSingular}s`
    case 'show':
      return `show${pascalSingular}`
    case 'create':
      return `create${pascalSingular}`
    case 'update':
      return `update${pascalSingular}`
    case 'destroy':
      return `destroy${pascalSingular}`
  }
}

/**
 * Options for the generate:crud CLI command.
 */
export interface GenerateCrudCliOptions {
  resource: string
  schema?: string
  auth?: string
  actionsDir?: string
  skipTests?: boolean
  only?: string
  except?: string
  force?: boolean
  preview?: boolean
  json?: boolean
}

/**
 * Parse CLI arguments for generate:crud command.
 */
export function parseGenerateCrudArgs(args: string[]): GenerateCrudCliOptions {
  const options: GenerateCrudCliOptions = {
    resource: '',
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (!arg.startsWith('-')) {
      if (!options.resource) {
        options.resource = arg
      }
      continue
    }

    switch (arg) {
      case '--schema':
      case '-s':
        options.schema = args[++i]
        break
      case '--auth':
      case '-a':
        options.auth = args[++i]
        break
      case '--actions-dir':
        options.actionsDir = args[++i]
        break
      case '--skip-tests':
      case '--no-tests':
        options.skipTests = true
        break
      case '--only':
        options.only = args[++i]
        break
      case '--except':
        options.except = args[++i]
        break
      case '--force':
      case '-f':
        options.force = true
        break
      case '--preview':
        options.preview = true
        break
      case '--json':
        options.json = true
        break
    }
  }

  return options
}

/**
 * Get help text for the generate:crud command.
 */
export function generateCrudHelp(): string {
  return `
honertia generate:crud - Generate full CRUD with colocated actions and inline tests

USAGE:
  honertia generate:crud <resource> [OPTIONS]

ARGUMENTS:
  <resource>          Resource name (e.g., 'projects', 'users')

OPTIONS:
  -s, --schema        Schema for create/update (e.g., 'name:string:required')
  -a, --auth          Auth requirement (required, optional, guest, none)
  --actions-dir       Output directory for actions (default: src/actions)
  --skip-tests        Skip inline test generation
  --only              Only generate specific actions (comma-separated)
  --except            Exclude specific actions (comma-separated)
  -f, --force         Overwrite existing files
  --preview           Preview generated code without writing
  --json              Output as JSON

ACTIONS:
  index     GET    /<resource>              List all resources
  show      GET    /<resource>/{resource}   Show single resource
  create    POST   /<resource>              Create new resource
  update    PUT    /<resource>/{resource}   Update existing resource
  destroy   DELETE /<resource>/{resource}   Delete resource

OUTPUT:
  Creates colocated action files, each containing:
  - Route configuration
  - Request schema
  - Effect handler
  - Inline integration tests

EXAMPLES:
  # Generate full CRUD
  honertia generate:crud projects

  # Generate with schema
  honertia generate:crud projects \\
    --schema "name:string:required, description:string:nullable"

  # Generate only read operations
  honertia generate:crud projects --only index,show

  # Generate all except destroy
  honertia generate:crud projects --except destroy

  # Preview generated code
  honertia generate:crud projects --preview

  # Run tests for all CRUD actions
  bun test src/actions/projects/
`.trim()
}

/**
 * Run the generate:crud command.
 */
export function runGenerateCrud(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(generateCrudHelp())
    return
  }

  const cliOptions = parseGenerateCrudArgs(args)

  if (!cliOptions.resource) {
    console.error('Error: Resource name is required')
    console.error('Run "honertia generate:crud --help" for usage')
    process.exit(1)
  }

  const result = generateCrud({
    resource: cliOptions.resource,
    schema: cliOptions.schema,
    auth: (cliOptions.auth ?? 'required') as AuthRequirement,
    actionsDir: cliOptions.actionsDir,
    skipTests: cliOptions.skipTests,
    only: cliOptions.only?.split(',') as CrudAction[] | undefined,
    except: cliOptions.except?.split(',') as CrudAction[] | undefined,
    preview: cliOptions.preview,
  })

  let written = false
  if (!cliOptions.preview) {
    try {
      for (const action of result.actions) {
        writeGeneratedFile(action.path, action.content, cliOptions.force ?? false)
      }
      writeGeneratedFile(result.indexPath, result.indexContent, cliOptions.force ?? false)
      written = true
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    }
  }

  if (cliOptions.json) {
    console.log(JSON.stringify({
      resource: result.resource,
      indexPath: result.indexPath,
      actions: result.actions.map((a) => ({
        action: a.action,
        path: a.path,
        routeName: a.routeName,
        content: a.content,
      })),
      indexContent: result.indexContent,
      preview: cliOptions.preview ?? false,
      written,
    }, null, 2))
    return
  }

  if (cliOptions.preview) {
    console.log(`Would generate CRUD for: ${result.resource}`)
    console.log('')

    for (const action of result.actions) {
      console.log(`─── ${action.action.toUpperCase()} ───`)
      console.log(`Would create: ${action.path}`)
      console.log('')
      console.log(action.content)
      console.log('')
    }

    console.log(`─── INDEX ───`)
    console.log(`Would create: ${result.indexPath}`)
    console.log('')
    console.log(result.indexContent)
    return
  }

  console.log(`Generated CRUD for: ${result.resource}`)
  console.log('')
  console.log('Files (with inline tests):')
  for (const action of result.actions) {
    console.log(`  ${action.path}`)
  }
  console.log(`  ${result.indexPath}`)
  console.log('')
  console.log('Routes:')
  for (const action of result.actions) {
    console.log(`  ${action.routeName}`)
  }
  console.log('')
  console.log(`Run tests with: bun test ${result.actions[0]?.path.split('/').slice(0, -1).join('/')}/`)
}
