/* oxlint-disable effecttsgo/global-console, effecttsgo/node-builtin-import -- This CLI adapter owns native Node/Bun IO and raw command output; preserve the stdout/stderr format. */
/**
 * Feature Generation CLI Module
 *
 * Generates colocated feature files containing route definition,
 * handler logic, schema, and tests in a single file.
 * Optimized for AI agent workflows with reduced file operations.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  type ActionMethod,
  type FieldDefinition,
  parseSchemaString,
} from './generate.js'

/**
 * Options for generating a feature.
 */
export interface GenerateFeatureOptions {
  /**
   * Feature name (e.g., 'projects/archive', 'users/profile').
   */
  name: string
  /**
   * HTTP method (default: 'GET').
   */
  method?: ActionMethod
  /**
   * Route path (defaults based on name).
   */
  path?: string
  /**
   * Field definitions for request schema.
   */
  fields?: FieldDefinition[]
  /**
   * Authentication requirement.
   */
  auth?: 'required' | 'optional' | 'none'
  /**
   * Middleware to apply.
   */
  middleware?: string[]
  /**
   * Whether to include inline tests (default: true).
   */
  includeTests?: boolean
  /**
   * Whether to include props type (default: true).
   */
  includeProps?: boolean
  /**
   * Base directory for features (default: 'src/features').
   */
  baseDir?: string
}

/**
 * Result of generating a feature.
 */
export interface GenerateFeatureResult {
  /**
   * Whether generation was successful.
   */
  success: boolean
  /**
   * Generated file path.
   */
  path: string
  /**
   * Generated file content.
   */
  content: string
  /**
   * Route name for the feature.
   */
  routeName: string
  /**
   * Route path for the feature.
   */
  routePath: string
  /**
   * Error message if generation failed.
   */
  error?: string
}

/**
 * Generate a colocated feature file.
 *
 * Creates a single file containing:
 * - Route metadata
 * - Request/response types
 * - Validation schema
 * - Handler logic
 * - Inline tests
 *
 * @example
 * ```typescript
 * import { generateFeature } from '@popcomputer/web/cli'
 *
 * const result = generateFeature({
 *   name: 'projects/archive',
 *   method: 'POST',
 *   path: '/projects/{project}/archive',
 *   auth: 'required',
 * })
 *
 * // Write to file
 * await Bun.write(result.path, result.content)
 * ```
 */
export function generateFeature(options: GenerateFeatureOptions): GenerateFeatureResult {
  const {
    name,
    method = 'GET',
    auth = 'required',
    middleware = [],
    includeTests = true,
    includeProps = true,
    baseDir = 'src/features',
    fields = [],
  } = options

  // Parse feature name into parts
  const parts = name.split('/')

  if (parts.length < 2) {
    return {
      success: false,
      path: '',
      content: '',
      routeName: '',
      routePath: '',
      error: 'Feature name must include resource/action (e.g., "projects/archive")',
    }
  }

  const resource = parts[0]
  const action = parts[1]
  const routeName = `${resource}.${action}`

  // Generate path from name if not provided
  const routePath = options.path ?? generateDefaultPath(resource, action)

  // Generate file path
  const filePath = `${baseDir}/${resource}/${action}.ts`

  // Build the feature content
  const content = buildFeatureContent({
    resource,
    action,
    method,
    routePath,
    routeName,
    auth,
    middleware,
    fields,
    includeTests,
    includeProps,
  })

  return {
    success: true,
    path: filePath,
    content,
    routeName,
    routePath,
  }
}

/**
 * Generate default path based on resource/action naming.
 */
function generateDefaultPath(resource: string, action: string): string {
  // Common REST patterns
  switch (action) {
    case 'index':
    case 'list':
      return `/${resource}`
    case 'show':
    case 'get':
      return `/${resource}/{${singularize(resource)}}`
    case 'create':
    case 'store':
      return `/${resource}`
    case 'update':
    case 'edit':
      return `/${resource}/{${singularize(resource)}}`
    case 'destroy':
    case 'delete':
      return `/${resource}/{${singularize(resource)}}`
    default:
      // Custom action on a resource (e.g., projects/archive -> /projects/{project}/archive)
      return `/${resource}/{${singularize(resource)}}/${action}`
  }
}

/**
 * Simple singularization for resource names.
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
 * Capitalize first letter.
 */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Convert to PascalCase.
 */
function toPascalCase(s: string): string {
  return s.split(/[-_]/).map(capitalize).join('')
}

interface BuildOptions {
  resource: string
  action: string
  method: ActionMethod
  routePath: string
  routeName: string
  auth: 'required' | 'optional' | 'none'
  middleware: string[]
  fields: FieldDefinition[]
  includeTests: boolean
  includeProps: boolean
}

/**
 * Build the feature file content.
 */
function buildFeatureContent(options: BuildOptions): string {
  const {
    resource,
    action,
    method,
    routePath,
    routeName,
    auth,
    middleware,
    fields,
    includeTests,
    includeProps,
  } = options

  const resourcePascal = toPascalCase(resource)
  const actionPascal = toPascalCase(action)
  const propsTypeName = `${resourcePascal}${actionPascal}Props`

  // Determine what imports we need
  const imports = buildImports(options)
  const hasBindings = routePath.includes('{')
  const needsSchema = fields.length > 0

  const sections: string[] = []

  // File header
  sections.push(`/**
 * ${resourcePascal} ${actionPascal} Feature
 *
 * Colocated feature file containing route definition, handler, and tests.
 * Generated by popweb generate:feature
 */

${imports}`)

  // Props type
  if (includeProps) {
    sections.push(buildPropsType(propsTypeName, resource))
  }

  // Route metadata
  sections.push(buildRouteMetadata(method, routePath, routeName, middleware))

  // Params schema
  if (needsSchema) {
    sections.push(buildParamsSchema(fields))
  }

  // Handler
  sections.push(buildHandler({
    resource,
    action,
    method,
    auth,
    hasBindings,
    needsSchema,
    propsTypeName: includeProps ? propsTypeName : undefined,
  }))

  // Inline tests
  if (includeTests) {
    sections.push(buildInlineTests(resource, action, method, auth, hasBindings))
  }

  return sections.join('\n')
}

/**
 * Build imports section.
 */
function buildImports(options: BuildOptions): string {
  const { auth, fields, includeTests, method } = options

  const effectImports = ['Effect']
  const honertiaImports = ['action']
  const isMutationMethod = method !== 'GET'

  if (isMutationMethod) {
    honertiaImports.push('DatabaseService', 'dbMutation', 'redirect')
  } else {
    honertiaImports.push('render')
  }

  if (auth === 'required') {
    honertiaImports.push('authorize')
  }

  if (fields.length > 0) {
    honertiaImports.push('validateRequest')
  }

  if (isMutationMethod && (auth === 'required' || fields.length > 0)) {
    honertiaImports.push('asTrusted')
  }

  if (options.routePath.includes('{')) {
    honertiaImports.push('bound')
  }

  const lines = [
    `import { ${effectImports.join(', ')} } from 'effect'`,
    `import * as S from 'effect/Schema'`,
    `import { ${honertiaImports.sort().join(', ')} } from '@popcomputer/web/effect'`,
  ]

  if (includeTests) {
    lines.push(`import { describeRoute } from '@popcomputer/web/effect'`)
  }

  return lines.join('\n')
}

/**
 * Build props type definition.
 */
function buildPropsType(typeName: string, resource: string): string {
  const singular = singularize(resource)
  const singularPascal = toPascalCase(singular)

  return `
// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface ${typeName} {
  ${singular}: ${singularPascal}
  // Add additional props as needed
}

// TODO: Import or define ${singularPascal} type
interface ${singularPascal} {
  id: string
  // Add fields
}`
}

/**
 * Build route metadata export.
 */
function buildRouteMetadata(
  method: ActionMethod,
  path: string,
  name: string,
  middleware: string[]
): string {
  const middlewareStr = middleware.length > 0
    ? `\n  middleware: [${middleware.map((m) => `'${m}'`).join(', ')}],`
    : ''

  return `
// ─────────────────────────────────────────────────────────────
// Route Metadata
// ─────────────────────────────────────────────────────────────

export const route = {
  method: '${method.toUpperCase()}',
  path: '${path}',
  name: '${name}',${middlewareStr}
} as const`
}

/**
 * Build params schema from fields.
 */
function buildParamsSchema(fields: FieldDefinition[]): string {
  const schemaFields = fields.map((field) => {
    let schemaType = 'S.String'

    switch (field.type) {
      case 'string':
        break
      case 'number':
        schemaType = 'S.Number'
        break
      case 'boolean':
        schemaType = 'S.Boolean'
        break
      case 'date':
        schemaType = 'S.DateFromString'
        break
      case 'uuid':
        schemaType = 'S.String.check(S.isUUID())'
        break
      case 'email':
        schemaType = 'S.String.check(S.isPattern(/@/))'
        break
      case 'url':
        schemaType = 'S.String'
        break
    }

    if (field.modifier === 'nullable') {
      schemaType = `S.NullOr(${schemaType})`
    }

    if (field.modifier === 'optional') {
      schemaType = `S.optional(${schemaType})`
    }

    return `  ${field.name}: ${schemaType},`
  })

  return `
// ─────────────────────────────────────────────────────────────
// Request Schema
// ─────────────────────────────────────────────────────────────

export const params = S.Struct({
${schemaFields.join('\n')}
})`
}

interface HandlerOptions {
  resource: string
  action: string
  method: ActionMethod
  auth: 'required' | 'optional' | 'none'
  hasBindings: boolean
  needsSchema: boolean
  propsTypeName?: string
}

/**
 * Build handler function.
 */
function buildHandler(options: HandlerOptions): string {
  const {
    resource,
    action,
    method,
    auth,
    hasBindings,
    needsSchema,
  } = options

  const singular = singularize(resource)
  const componentPath = `${toPascalCase(resource)}/${toPascalCase(action)}`
  const isMutationMethod = method.toUpperCase() !== 'GET'

  const effectSteps: string[] = []

  // Auth
  if (auth === 'required') {
    effectSteps.push('const user = yield* authorize()')
  }

  // Binding
  if (hasBindings) {
    effectSteps.push(`const ${singular} = yield* bound('${singular}')`)
  }

  // Validation
  if (needsSchema) {
    effectSteps.push('const input = yield* validateRequest(params)')
  }

  if (isMutationMethod) {
    const trustedFields: string[] = []

    if (needsSchema) trustedFields.push('...input,')

    if (auth === 'required') trustedFields.push('userId: user.user.id,')

    if (trustedFields.length > 0) {
      effectSteps.push('')
      effectSteps.push('const trustedInput = asTrusted({')

      for (const field of trustedFields) {
        effectSteps.push(`  ${field}`)
      }

      effectSteps.push('})')
    }
  }

  // Handler logic based on method
  switch (method.toUpperCase()) {
    case 'GET':
      effectSteps.push('')
      effectSteps.push(`// TODO: Implement ${action} logic`)

      if (hasBindings) {
        effectSteps.push(`return yield* render('${componentPath}', { ${singular} })`)
      } else {
        effectSteps.push(`return yield* render('${componentPath}', { /* props */ })`)
      }

      break
    case 'POST':
    case 'PUT':
    case 'PATCH':
      effectSteps.push('')
      effectSteps.push(`// TODO: Implement ${action} logic`)
      effectSteps.push('const db = yield* DatabaseService')

      if (needsSchema || auth === 'required') {
        effectSteps.push('yield* dbMutation(db, trustedInput, async (tx, trustedInput) => {')
        effectSteps.push('  // Replace with your Drizzle write.')
        effectSteps.push('  // await tx.insert(schema.tableName).values(trustedInput)')
        effectSteps.push('  void tx')
        effectSteps.push('  void trustedInput')
        effectSteps.push('})')
      } else {
        effectSteps.push('yield* dbMutation(db, async (tx) => {')
        effectSteps.push('  // Replace with your Drizzle write.')
        effectSteps.push('  // await tx.insert(schema.tableName).values(asTrusted({ ... }))')
        effectSteps.push('  void tx')
        effectSteps.push('})')
      }

      effectSteps.push('')

      if (method.toUpperCase() === 'POST') {
        effectSteps.push(`return yield* redirect('/${resource}')`)
      } else if (hasBindings) {
        effectSteps.push(`return yield* redirect(\`/${resource}/\${${singular}.id}\`)`)
      } else {
        effectSteps.push(`return yield* redirect('/${resource}')`)
      }

      break
    case 'DELETE':
      effectSteps.push('')
      effectSteps.push(`// TODO: Implement ${action} logic`)
      effectSteps.push('const db = yield* DatabaseService')
      effectSteps.push('yield* dbMutation(db, async (tx) => {')
      effectSteps.push('  // Replace with your Drizzle delete.')
      effectSteps.push(`  // await tx.delete(${resource}).where(eq(${resource}.id, ${singular}.id))`)
      effectSteps.push('  void tx')
      effectSteps.push('})')
      effectSteps.push('')
      effectSteps.push(`return new Response(null, { status: 204 })`)
      break
  }

  const stepsCode = effectSteps.map((s) => s ? `    ${s}` : '').join('\n')

  return `
// ─────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────

export const handler = action(
  Effect.gen(function* () {
${stepsCode}
  })
)`
}

/**
 * Build inline tests.
 */
function buildInlineTests(
  resource: string,
  action: string,
  method: ActionMethod,
  auth: 'required' | 'optional' | 'none',
  hasBindings: boolean
): string {
  const singular = singularize(resource)
  const testCases: string[] = []

  // Success case
  const successStatus = { DELETE: 204, GET: 200, POST: 303, PUT: 303, PATCH: 303 }[method]

  testCases.push(`
  '${action}s ${singular} successfully': async (t) => {
    ${auth === 'required' ? 'const user = await t.createUser()' : ''}
    ${hasBindings ? `const ${singular} = await t.create${toPascalCase(singular)}(${auth === 'required' ? '{ userId: user.id }' : ''})` : ''}

    const res = await t.request({
      ${auth === 'required' ? "as: 'user'," : ''}
      ${hasBindings ? `params: { ${singular}: ${singular}.id },` : ''}
    })

    t.expect(res).toHaveStatus(${successStatus})
  },`)

  // Auth failure case
  if (auth === 'required') {
    testCases.push(`
  'requires authentication': async (t) => {
    const res = await t.request({
      as: 'guest',
    })

    t.expect(res).toHaveStatus(401)
  },`)
  }

  // Not found case
  if (hasBindings) {
    testCases.push(`
  'returns 404 for missing ${singular}': async (t) => {
    ${auth === 'required' ? 'const user = await t.createUser()' : ''}

    const res = await t.request({
      ${auth === 'required' ? "as: 'user'," : ''}
      params: { ${singular}: 'nonexistent-id' },
    })

    t.expect(res).toHaveStatus(404)
  },`)
  }

  return `
// ─────────────────────────────────────────────────────────────
// Tests (inline - run with describeRoute)
// ─────────────────────────────────────────────────────────────

export const tests = {${testCases.join('')}
}

// Run tests with:
// describeRoute(route.name, app, tests)`
}

/**
 * CLI options for generate:feature command.
 */
export interface GenerateFeatureCliOptions {
  name?: string
  method?: ActionMethod
  path?: string
  fields?: string
  auth?: 'required' | 'optional' | 'none'
  middleware?: string[]
  noTests?: boolean
  noProps?: boolean
  output?: string
  force?: boolean
  preview?: boolean
}

/**
 * Parse CLI arguments for generate:feature command.
 */
export function parseGenerateFeatureArgs(args: string[]): GenerateFeatureCliOptions {
  const options: GenerateFeatureCliOptions = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    switch (arg) {
      case '--method':
      case '-m':
        // SAFETY: The CLI parser checked this option against its finite accepted values before constructing the typed command.
        options.method = args[++i]?.toUpperCase() as ActionMethod
        break
      case '--path':
      case '-p':
        options.path = args[++i]
        break
      case '--fields':
      case '-f':
        options.fields = args[++i]
        break
      case '--auth':
      case '-a':
        // SAFETY: The CLI parser checked this option against its finite accepted values before constructing the typed command.
        options.auth = args[++i] as 'required' | 'optional' | 'none'
        break
      case '--middleware':
        options.middleware = args[++i]?.split(',')
        break
      case '--no-tests':
        options.noTests = true
        break
      case '--no-props':
        options.noProps = true
        break
      case '--output':
      case '-o':
        options.output = args[++i]
        break
      case '--force':
        options.force = true
        break
      case '--preview':
        options.preview = true
        break
      default:
        if (!arg.startsWith('-') && !options.name) {
          options.name = arg
        }
    }
  }

  return options
}

/**
 * Get help text for generate:feature command.
 */
export function generateFeatureHelp(): string {
  return `
popweb generate:feature - Generate a colocated feature file

USAGE:
  popweb generate:feature <resource/action> [OPTIONS]

DESCRIPTION:
  Creates a single file containing route definition, handler,
  schema, and tests. Optimized for AI agent workflows with
  reduced file operations.

OPTIONS:
  -m, --method        HTTP method (GET, POST, PUT, PATCH, DELETE)
  -p, --path          Route path (default: derived from name)
  -f, --fields        Schema fields (e.g., "name:string:required")
  -a, --auth          Auth requirement (required, optional, none)
  --middleware        Middleware to apply (comma-separated)
  --no-tests          Skip inline test generation
  --no-props          Skip props type generation
  -o, --output        Output directory (default: src/features)
  --force             Overwrite existing file
  --preview           Preview without writing file

EXAMPLES:
  # Generate archive feature
  popweb generate:feature projects/archive --method POST

  # Custom path with fields
  popweb generate:feature users/profile \\
    --path "/profile" \\
    --fields "name:string:required, bio:string:nullable"

  # API endpoint without tests
  popweb generate:feature api/status --no-tests --auth none

OUTPUT:
  Creates: src/features/<resource>/<action>.ts

  Contains:
  - Route metadata (method, path, name, middleware)
  - Props type definition
  - Request params schema
  - Effect handler with auth, bindings, validation
  - Inline test cases
`.trim()
}

/**
 * Run the generate:feature command from CLI arguments.
 */
export function runGenerateFeature(args: string[] = []): void {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(generateFeatureHelp())

    return
  }

  const cliOptions = parseGenerateFeatureArgs(args)

  if (!cliOptions.name) {
    console.log('Error: Feature name required')
    console.log('Usage: popweb generate:feature <resource/action> [OPTIONS]')
    console.log('Run with --help for more information')
    process.exit(1)
  }

  const result = generateFeature({
    name: cliOptions.name,
    method: cliOptions.method,
    path: cliOptions.path,
    fields: cliOptions.fields ? parseSchemaString(cliOptions.fields) : undefined,
    auth: cliOptions.auth,
    middleware: cliOptions.middleware,
    includeTests: !cliOptions.noTests,
    includeProps: !cliOptions.noProps,
    baseDir: cliOptions.output ?? 'src/features',
  })

  if (!result.success) {
    console.log(`Error: ${result.error}`)
    process.exit(1)
  }

  if (cliOptions.preview) {
    console.log(`Preview: ${result.path}`)
    console.log('-'.repeat(50))
    console.log(result.content)

    return
  }

  if (existsSync(result.path) && !cliOptions.force) {
    console.log(`Error: File already exists at ${result.path}`)
    console.log('Use --force to overwrite')
    process.exit(1)
  }

  mkdirSync(dirname(result.path), { recursive: true })
  writeFileSync(result.path, result.content, 'utf-8')

  console.log(`Generated: ${result.path}`)
  console.log(`  Route: ${result.routeName}`)
  console.log(`  Path: ${result.routePath}`)
}
