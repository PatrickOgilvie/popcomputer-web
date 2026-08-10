/**
 * Popcomputer Web CLI
 *
 * CLI utilities for introspection and code generation.
 * Designed for both human developers and AI agent workflows.
 */

import {
  RouteRegistry,
  type RouteMetadataJson,
} from '../effect/route-registry.js'
import { loadAppRouteRegistry } from './load-app.js'

/**
 * Output format for CLI commands.
 */
export type OutputFormat = 'table' | 'json' | 'minimal'

/**
 * Options for the routes command.
 */
export interface RoutesCommandOptions {
  /** Application entrypoint loaded by the CLI. */
  app?: string
  /**
   * Output format (default: 'table').
   */
  format?: OutputFormat
  /**
   * Filter by HTTP method.
   */
  method?: string
  /**
   * Filter by path prefix.
   */
  prefix?: string
  /**
   * Filter by route name.
   */
  name?: string
  /**
   * Include only routes matching this pattern.
   */
  pattern?: string
  /**
   * Sort by field (default: 'path').
   */
  sortBy?: 'method' | 'path' | 'name'
  /**
   * Reverse sort order.
   */
  reverse?: boolean
}

/**
 * Result of the routes command.
 */
export interface RoutesCommandResult {
  /**
   * Routes found matching the filters.
   */
  routes: RouteMetadataJson[]
  /**
   * Formatted output string (for table/minimal formats).
   */
  output: string
  /**
   * Total count of routes.
   */
  count: number
  /**
   * Optional error when command options are invalid.
   */
  error?: string
}

/**
 * Format routes as a minimal list (just METHOD PATH).
 */
function formatMinimal(routes: RouteMetadataJson[]): string {
  if (routes.length === 0) {
    return 'No routes found.'
  }

  return routes
    .map((r) => `${r.method.toUpperCase().padEnd(7)} ${r.fullPath}`)
    .join('\n')
}

/**
 * Format routes as a detailed table.
 */
function formatTable(routes: RouteMetadataJson[]): string {
  if (routes.length === 0) {
    return 'No routes found.'
  }

  // Calculate column widths
  const methodWidth = Math.max(6, ...routes.map((r) => r.method.length))
  const pathWidth = Math.max(4, ...routes.map((r) => r.fullPath.length))
  const nameWidth = Math.max(4, ...routes.map((r) => r.name?.length ?? 0))
  const hasNames = routes.some((r) => r.name)

  const lines: string[] = []

  // Header
  const headerParts = [
    'METHOD'.padEnd(methodWidth),
    'PATH'.padEnd(pathWidth),
  ]
  if (hasNames) headerParts.push('NAME'.padEnd(nameWidth))
  headerParts.push('BINDINGS')

  const header = headerParts.join('  ')
  lines.push(header)
  lines.push('-'.repeat(header.length))

  // Routes
  for (const route of routes) {
    const bindings =
      route.bindings.length > 0
        ? route.bindings.map((b) => `{${b.param}:${b.column}}`).join(', ')
        : '-'

    const rowParts = [
      route.method.toUpperCase().padEnd(methodWidth),
      route.fullPath.padEnd(pathWidth),
    ]
    if (hasNames) rowParts.push((route.name ?? '').padEnd(nameWidth))
    rowParts.push(bindings)

    lines.push(rowParts.join('  '))
  }

  lines.push('')
  lines.push(`Total: ${routes.length} route${routes.length === 1 ? '' : 's'}`)

  return lines.join('\n')
}

/**
 * Sort routes by the specified field.
 */
function sortRoutes(
  routes: RouteMetadataJson[],
  sortBy: 'method' | 'path' | 'name',
  reverse: boolean
): RouteMetadataJson[] {
  const sorted = [...routes].sort((a, b) => {
    let comparison = 0
    switch (sortBy) {
      case 'method':
        comparison = a.method.localeCompare(b.method)
        break
      case 'path':
        comparison = a.fullPath.localeCompare(b.fullPath)
        break
      case 'name':
        comparison = (a.name ?? '').localeCompare(b.name ?? '')
        break
    }
    return reverse ? -comparison : comparison
  })
  return sorted
}

/**
 * List all registered routes.
 *
 * @example
 * ```typescript
 * // In a script that imports your app
 * // The CLI imports the configured application passed with --app.
 * import { routesCommand, getGlobalRegistry } from '@popcomputer/web/cli'
 *
 * const result = routesCommand(getGlobalRegistry(), { format: 'json' })
 * console.log(result.output)
 * ```
 *
 * @example
 * ```bash
 * # Usage with a custom script
 * bun run scripts/routes.ts --json
 * ```
 */
export function routesCommand(
  registry: RouteRegistry,
  options: RoutesCommandOptions = {}
): RoutesCommandResult {
  const {
    format = 'table',
    method,
    prefix,
    name,
    pattern,
    sortBy = 'path',
    reverse = false,
  } = options

  // Get all routes as JSON
  let routes = registry.toJson()

  // Apply filters
  if (method) {
    const normalizedMethod = method.toLowerCase()
    routes = routes.filter((r) => r.method === normalizedMethod)
  }

  if (prefix) {
    routes = routes.filter((r) => r.fullPath.startsWith(prefix))
  }

  if (name) {
    routes = routes.filter((r) => r.name === name)
  }

  let patternError: string | undefined
  if (pattern) {
    try {
      const regex = new RegExp(
        pattern.replace(/\*/g, '.*').replace(/\{[^}]+\}/g, '[^/]+')
      )
      routes = routes.filter((r) => regex.test(r.fullPath))
    } catch {
      routes = []
      patternError = `Invalid route pattern: ${pattern}`
    }
  }

  // Sort routes
  routes = sortRoutes(routes, sortBy, reverse)

  // Format output
  let output: string
  switch (format) {
    case 'json':
      output = JSON.stringify(routes, null, 2)
      break
    case 'minimal':
      output = formatMinimal(routes)
      break
    case 'table':
    default:
      output = formatTable(routes)
      break
  }

  return {
    routes,
    output,
    count: routes.length,
    error: patternError,
  }
}

/**
 * Parse CLI arguments for the routes command.
 */
export function parseRoutesArgs(args: string[]): RoutesCommandOptions {
  const options: RoutesCommandOptions = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    switch (arg) {
      case '--json':
        options.format = 'json'
        break
      case '--app':
        options.app = args[++i]
        break
      case '--minimal':
        options.format = 'minimal'
        break
      case '--table':
        options.format = 'table'
        break
      case '--method':
      case '-m':
        options.method = args[++i]
        break
      case '--prefix':
      case '-p':
        options.prefix = args[++i]
        break
      case '--name':
      case '-n':
        options.name = args[++i]
        break
      case '--pattern':
        options.pattern = args[++i]
        break
      case '--sort':
      case '-s':
        options.sortBy = args[++i] as 'method' | 'path' | 'name'
        break
      case '--reverse':
      case '-r':
        options.reverse = true
        break
    }
  }

  return options
}

/**
 * Get help text for the routes command.
 */
export function routesHelp(): string {
  return `
popweb routes - List all registered routes

USAGE:
  popweb routes --app <entrypoint> [OPTIONS]

OPTIONS:
  --app <path>     Application entrypoint exporting the app or route registry
  --json          Output as JSON (machine-readable)
  --minimal       Output as minimal list (METHOD PATH)
  --table         Output as formatted table (default)

  -m, --method    Filter by HTTP method (get, post, put, patch, delete)
  -p, --prefix    Filter by path prefix
  -n, --name      Filter by route name
  --pattern       Filter by path pattern (supports * wildcard)

  -s, --sort      Sort by field (method, path, name)
  -r, --reverse   Reverse sort order

EXAMPLES:
  # List all routes as a table
  popweb routes --app src/app.ts

  # Output as JSON for agent consumption
  popweb routes --app src/app.ts --json

  # Filter by method
  popweb routes --app src/app.ts --method post

  # Filter by prefix
  popweb routes --app src/app.ts --prefix /api

  # Find routes matching a pattern
  popweb routes --app src/app.ts --pattern '/projects/*'
`.trim()
}

/**
 * Run the routes command from CLI arguments.
 *
 * @example
 * ```typescript
 * // scripts/routes.ts
 * import './app' // Register routes
 * import { runRoutes } from '@popcomputer/web/cli'
 *
 * runRoutes(process.argv.slice(2))
 * ```
 */
export async function runRoutes(
  args: string[] = [],
  registry?: RouteRegistry
): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(routesHelp())
    return
  }

  const options = parseRoutesArgs(args)
  const resolvedRegistry = registry ?? (
    options.app ? await loadAppRouteRegistry(options.app) : undefined
  )
  if (!resolvedRegistry) {
    throw new Error('Missing application entrypoint. Pass --app src/app.ts.')
  }
  const result = routesCommand(resolvedRegistry, options)
  if (result.error) {
    console.error(result.error)
    process.exit(1)
  }
  console.log(result.output)
}

// Re-export registry functions for convenience
export {
  RouteRegistry,
  getAppRouteRegistry,
  findAppRouteRegistry,
  getGlobalRegistry,
  resetGlobalRegistry,
} from '../effect/route-registry.js'
export { loadAppRouteRegistry } from './load-app.js'

// Code generation
export {
  generateAction,
  parseSchemaString,
  parseGenerateActionArgs,
  generateActionHelp,
  runGenerateAction,
  generateCrud,
  parseGenerateCrudArgs,
  generateCrudHelp,
  runGenerateCrud,
  type ActionMethod,
  type AuthRequirement,
  type FieldType,
  type FieldModifier,
  type FieldDefinition,
  type GenerateActionOptions,
  type GenerateActionResult,
  type GenerateActionCliOptions,
  type CrudAction,
  type GenerateCrudOptions,
  type CrudActionResult,
  type GenerateCrudResult,
  type GenerateCrudCliOptions,
} from './generate.js'

// Inline test runner generation
export {
  generateInlineTestsRunner,
  parseGenerateInlineTestsRunnerArgs,
  generateInlineTestsRunnerHelp,
  runGenerateInlineTestsRunner,
  type GenerateInlineTestsRunnerOptions,
  type GenerateInlineTestsRunnerResult,
} from './inline-tests.js'

// Project health checks
export {
  checkCommand,
  parseCheckArgs,
  checkHelp,
  runCheck,
  type CheckStatus,
  type CheckResult,
  type CheckDetail,
  type FixSuggestion,
  type CheckCommandResult,
  type CheckCommandOptions,
} from './check.js'

// OpenAPI generation
export {
  generateOpenApi,
  formatOpenApiOutput,
  parseGenerateOpenApiArgs,
  generateOpenApiHelp,
  runGenerateOpenApi,
  type OpenApiInfo,
  type OpenApiServer,
  type OpenApiTag,
  type OpenApiSecurityScheme,
  type OpenApiParameter,
  type OpenApiSchema,
  type OpenApiResponse,
  type OpenApiOperation,
  type OpenApiPathItem,
  type OpenApiSpec,
  type GenerateOpenApiOptions,
  type GenerateOpenApiCliOptions,
} from './openapi.js'

// Database migrations
export {
  defineMigration,
  sql,
  dbStatus,
  dbMigrate,
  dbRollback,
  dbGenerate,
  parseDbArgs,
  dbHelp,
  runDb,
  type MigrationStatus,
  type DbStatusResult,
  type DbMigrateResult,
  type DbRollbackResult,
  type DbCommandOptions,
  type MigrationDefinition,
} from './db.js'

// Feature generation
export {
  generateFeature,
  parseGenerateFeatureArgs,
  generateFeatureHelp,
  runGenerateFeature,
  type GenerateFeatureOptions,
  type GenerateFeatureResult,
  type GenerateFeatureCliOptions,
} from './feature.js'
