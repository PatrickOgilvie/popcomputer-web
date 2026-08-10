/**
 * Project Health Check Module
 *
 * Validates project structure, routes, and configuration.
 * Returns machine-readable output with fix suggestions.
 */

import {
  RouteRegistry,
  type RouteMetadataJson,
} from '../effect/route-registry.js'
import { loadAppRouteRegistry } from './load-app.js'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

/**
 * Status of a single check.
 */
export type CheckStatus = 'pass' | 'warn' | 'fail'

/**
 * Result of a single check.
 */
export interface CheckResult {
  /**
   * Name of the check.
   */
  name: string
  /**
   * Status of the check.
   */
  status: CheckStatus
  /**
   * Human-readable message.
   */
  message: string
  /**
   * Details about issues found.
   */
  details?: CheckDetail[]
}

/**
 * Detail about a specific issue.
 */
export interface CheckDetail {
  /**
   * Type of issue.
   */
  type: 'error' | 'warning' | 'info'
  /**
   * Description of the issue.
   */
  message: string
  /**
   * File path (if applicable).
   */
  file?: string
  /**
   * Line number (if applicable).
   */
  line?: number
  /**
   * Fix suggestion.
   */
  fix?: FixSuggestion
}

/**
 * Fix suggestion for an issue.
 */
export interface FixSuggestion {
  /**
   * Type of fix.
   */
  type: 'command' | 'edit' | 'manual'
  /**
   * Command to run (for 'command' type).
   */
  command?: string
  /**
   * Description of manual fix.
   */
  description?: string
}

/**
 * Overall check result.
 */
export interface CheckCommandResult {
  /**
   * Overall status.
   */
  status: CheckStatus
  /**
   * Individual check results.
   */
  checks: CheckResult[]
  /**
   * Summary statistics.
   */
  summary: {
    total: number
    passed: number
    warnings: number
    failed: number
  }
  /**
   * All issues requiring attention.
   */
  issues: CheckDetail[]
}

/**
 * Options for check command.
 */
export interface CheckCommandOptions {
  /** Application entrypoint loaded by the CLI. */
  app?: string
  /**
   * Only run specific checks.
   */
  only?: ('routes' | 'naming' | 'bindings' | 'registration')[]
  /**
   * Output format.
   */
  format?: 'text' | 'json'
  /**
   * Show verbose output.
   */
  verbose?: boolean
  /**
   * Directories to scan for colocated route exports.
   * Defaults to ['src/actions', 'src/features'].
   */
  scanDirs?: string[]
  /**
   * Base directory for resolving scanDirs.
   * Defaults to process.cwd().
   */
  cwd?: string
}

interface RouteExportInfo {
  file: string
  line?: number
  name?: string
  method?: string
  path?: string
}

const DEFAULT_ROUTE_SCAN_DIRS = ['src/actions', 'src/features']
const ROUTE_FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

function shouldScanFile(fileName: string): boolean {
  if (fileName.endsWith('.d.ts')) return false
  if (fileName.includes('.test.') || fileName.includes('.spec.')) return false
  return ROUTE_FILE_EXTENSIONS.has(extname(fileName))
}

function walkFiles(dir: string, files: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue

    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(fullPath, files)
      continue
    }

    if (entry.isFile() && shouldScanFile(entry.name)) {
      files.push(fullPath)
    }
  }
}

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

function findMatchingBrace(source: string, startIndex: number): number {
  let depth = 0
  let inString: '"' | "'" | '`' | null = null
  let escaped = false

  for (let i = startIndex; i < source.length; i++) {
    const ch = source[i]

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === inString) {
        inString = null
      }
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch
      continue
    }

    if (ch === '{') {
      depth += 1
      continue
    }

    if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }

  return -1
}

function extractRouteExports(source: string, file: string): RouteExportInfo[] {
  const results: RouteExportInfo[] = []
  const needle = 'export const route'
  let index = 0

  while ((index = source.indexOf(needle, index)) !== -1) {
    const braceStart = source.indexOf('{', index)
    if (braceStart === -1) break

    const braceEnd = findMatchingBrace(source, braceStart)
    if (braceEnd === -1) break

    const block = source.slice(braceStart, braceEnd + 1)
    const nameMatch = /name\s*:\s*['"]([^'"]+)['"]/.exec(block)
    const methodMatch = /method\s*:\s*['"]([^'"]+)['"]/.exec(block)
    const pathMatch = /path\s*:\s*['"]([^'"]+)['"]/.exec(block)
    const line = nameMatch
      ? lineNumberAt(source, braceStart + nameMatch.index)
      : lineNumberAt(source, index)

    results.push({
      file,
      line,
      name: nameMatch?.[1],
      method: methodMatch?.[1],
      path: pathMatch?.[1],
    })

    index = braceEnd + 1
  }

  return results
}

function collectRouteExports(cwd: string, scanDirs: string[]): RouteExportInfo[] {
  const results: RouteExportInfo[] = []

  for (const scanDir of scanDirs) {
    const absoluteDir = resolve(cwd, scanDir)
    let files: string[] = []

    try {
      walkFiles(absoluteDir, files)
    } catch {
      continue
    }

    for (const file of files) {
      const source = readFileSync(file, 'utf-8')
      const relativePath = relative(cwd, file)
      results.push(...extractRouteExports(source, relativePath))
    }
  }

  return results
}

/**
 * Check that routes follow naming conventions.
 */
function checkRouteNaming(routes: RouteMetadataJson[]): CheckResult {
  const issues: CheckDetail[] = []

  // Check for unnamed routes
  const unnamedRoutes = routes.filter((r) => !r.name)
  if (unnamedRoutes.length > 0) {
    for (const route of unnamedRoutes) {
      issues.push({
        type: 'warning',
        message: `Route ${route.method.toUpperCase()} ${route.fullPath} has no name`,
        fix: {
          type: 'manual',
          description: `Add { name: 'resource.action' } option to route registration`,
        },
      })
    }
  }

  // Check for duplicate names
  const nameCount = new Map<string, number>()
  for (const route of routes) {
    if (route.name) {
      nameCount.set(route.name, (nameCount.get(route.name) ?? 0) + 1)
    }
  }

  for (const [name, count] of nameCount) {
    if (count > 1) {
      issues.push({
        type: 'error',
        message: `Duplicate route name: '${name}' used ${count} times`,
        fix: {
          type: 'manual',
          description: 'Ensure each route has a unique name',
        },
      })
    }
  }

  // Check naming convention (resource.action)
  const validNamePattern = /^[a-z]+\.[a-z]+$/
  for (const route of routes) {
    if (route.name && !validNamePattern.test(route.name)) {
      issues.push({
        type: 'warning',
        message: `Route name '${route.name}' doesn't follow 'resource.action' convention`,
        fix: {
          type: 'manual',
          description: 'Use format: resource.action (e.g., projects.create)',
        },
      })
    }
  }

  const errorCount = issues.filter((i) => i.type === 'error').length
  const warningCount = issues.filter((i) => i.type === 'warning').length

  return {
    name: 'naming',
    status: errorCount > 0 ? 'fail' : warningCount > 0 ? 'warn' : 'pass',
    message: errorCount > 0
      ? `${errorCount} naming error${errorCount === 1 ? '' : 's'} found`
      : warningCount > 0
      ? `${warningCount} naming warning${warningCount === 1 ? '' : 's'}`
      : `All ${routes.length} routes follow naming conventions`,
    details: issues.length > 0 ? issues : undefined,
  }
}

/**
 * Check route structure and paths.
 */
function checkRouteStructure(routes: RouteMetadataJson[]): CheckResult {
  const issues: CheckDetail[] = []

  // Check for routes without method-appropriate paths
  for (const route of routes) {
    // POST/PUT/PATCH should typically have a resource path
    if (['post', 'put', 'patch'].includes(route.method)) {
      if (route.fullPath === '/') {
        issues.push({
          type: 'warning',
          message: `${route.method.toUpperCase()} route at root path '/' is unusual`,
          fix: {
            type: 'manual',
            description: 'Consider using a resource-based path like /resource',
          },
        })
      }
    }

    // DELETE should have a parameter
    if (route.method === 'delete' && route.bindings.length === 0) {
      issues.push({
        type: 'warning',
        message: `DELETE route ${route.fullPath} has no resource binding`,
        fix: {
          type: 'manual',
          description: 'DELETE routes typically need a resource identifier: /resource/{id}',
        },
      })
    }
  }

  // Check for RESTful resource completeness
  const resourceRoutes = new Map<string, Set<string>>()
  for (const route of routes) {
    // Extract resource from path (e.g., /projects -> projects)
    const match = route.fullPath.match(/^\/([a-z]+)/)
    if (match) {
      const resource = match[1]
      if (!resourceRoutes.has(resource)) {
        resourceRoutes.set(resource, new Set())
      }
      resourceRoutes.get(resource)!.add(route.method)
    }
  }

  // Check for incomplete CRUD (info, not error)
  for (const [resource, methods] of resourceRoutes) {
    const hasIndex = methods.has('get')
    const hasCreate = methods.has('post')

    if (hasIndex && !hasCreate) {
      issues.push({
        type: 'info',
        message: `Resource '${resource}' has GET but no POST (create) route`,
        fix: {
          type: 'command',
          command: `popweb generate:action ${resource}/create --method POST --path /${resource}`,
        },
      })
    }
  }

  const errorCount = issues.filter((i) => i.type === 'error').length
  const warningCount = issues.filter((i) => i.type === 'warning').length

  return {
    name: 'routes',
    status: errorCount > 0 ? 'fail' : warningCount > 0 ? 'warn' : 'pass',
    message: errorCount > 0
      ? `${errorCount} route error${errorCount === 1 ? '' : 's'} found`
      : warningCount > 0
      ? `${warningCount} route warning${warningCount === 1 ? '' : 's'}`
      : `${routes.length} route${routes.length === 1 ? '' : 's'} validated`,
    details: issues.length > 0 ? issues : undefined,
  }
}

/**
 * Check route model bindings.
 */
function checkBindings(routes: RouteMetadataJson[]): CheckResult {
  const issues: CheckDetail[] = []

  for (const route of routes) {
    for (const binding of route.bindings) {
      // Check binding column names
      if (binding.column !== 'id' && binding.column !== 'slug' && binding.column !== 'uuid') {
        issues.push({
          type: 'info',
          message: `Route ${route.fullPath} uses custom binding column '${binding.column}' for {${binding.param}}`,
        })
      }
    }

    // Check for path parameter without binding (edge case)
    const pathParams = route.honoPath.match(/:([^/]+)/g) ?? []
    if (pathParams.length !== route.bindings.length) {
      issues.push({
        type: 'warning',
        message: `Route ${route.fullPath} has ${pathParams.length} path params but ${route.bindings.length} bindings`,
      })
    }
  }

  const warningCount = issues.filter((i) => i.type === 'warning').length

  return {
    name: 'bindings',
    status: warningCount > 0 ? 'warn' : 'pass',
    message: warningCount > 0
      ? `${warningCount} binding warning${warningCount === 1 ? '' : 's'}`
      : `All route bindings valid`,
    details: issues.length > 0 ? issues : undefined,
  }
}

/**
 * Check that colocated route exports are registered.
 */
function checkRouteRegistration(
  routes: RouteMetadataJson[],
  options: CheckCommandOptions
): CheckResult {
  const issues: CheckDetail[] = []
  const registeredNames = new Set(routes.map((route) => route.name).filter(Boolean) as string[])
  const cwd = options.cwd ?? process.cwd()
  const scanDirs = options.scanDirs ?? DEFAULT_ROUTE_SCAN_DIRS
  const exports = collectRouteExports(cwd, scanDirs)

  for (const routeExport of exports) {
    if (!routeExport.name) {
      issues.push({
        type: 'warning',
        message: `Route export in ${routeExport.file} has no name`,
        file: routeExport.file,
        line: routeExport.line,
        fix: {
          type: 'manual',
          description: 'Add a name to the route export so registration can be verified',
        },
      })
      continue
    }

    if (!registeredNames.has(routeExport.name)) {
      const location = routeExport.method && routeExport.path
        ? ` (${routeExport.method.toUpperCase()} ${routeExport.path})`
        : ''

      issues.push({
        type: 'error',
        message: `Route '${routeExport.name}' is not registered${location}`,
        file: routeExport.file,
        line: routeExport.line,
        fix: {
          type: 'manual',
          description: `Register '${routeExport.name}' in effectRoutes() or registerRoutes()`,
        },
      })
    }
  }

  const errorCount = issues.filter((i) => i.type === 'error').length
  const warningCount = issues.filter((i) => i.type === 'warning').length

  let message = 'No colocated route exports found'
  if (exports.length > 0 && errorCount === 0 && warningCount === 0) {
    message = `All ${exports.length} route export${exports.length === 1 ? '' : 's'} registered`
  } else if (errorCount > 0) {
    message = `${errorCount} unregistered route export${errorCount === 1 ? '' : 's'} found`
  } else if (warningCount > 0) {
    message = `${warningCount} route export warning${warningCount === 1 ? '' : 's'}`
  }

  return {
    name: 'registration',
    status: errorCount > 0 ? 'fail' : warningCount > 0 ? 'warn' : 'pass',
    message,
    details: issues.length > 0 ? issues : undefined,
  }
}

/**
 * Run all project checks.
 *
 * @example
 * ```typescript
 * import './app' // Register routes
 * import { checkCommand, getGlobalRegistry } from '@popcomputer/web/cli'
 *
 * const result = checkCommand(getGlobalRegistry())
 * if (result.status === 'fail') {
 *   console.error('Check failed:', result.issues)
 *   process.exit(1)
 * }
 * ```
 */
export function checkCommand(
  registry: RouteRegistry,
  options: CheckCommandOptions = {}
): CheckCommandResult {
  const routes = registry.toJson()
  const checks: CheckResult[] = []

  const shouldRun = (name: string) =>
    !options.only || options.only.includes(name as any)

  // Run checks
  if (shouldRun('routes')) {
    checks.push(checkRouteStructure(routes))
  }

  if (shouldRun('naming')) {
    checks.push(checkRouteNaming(routes))
  }

  if (shouldRun('bindings')) {
    checks.push(checkBindings(routes))
  }

  if (shouldRun('registration')) {
    checks.push(checkRouteRegistration(routes, options))
  }

  // Calculate summary
  const passed = checks.filter((c) => c.status === 'pass').length
  const warnings = checks.filter((c) => c.status === 'warn').length
  const failed = checks.filter((c) => c.status === 'fail').length

  // Collect all issues
  const issues: CheckDetail[] = []
  for (const check of checks) {
    if (check.details) {
      issues.push(...check.details)
    }
  }

  return {
    status: failed > 0 ? 'fail' : warnings > 0 ? 'warn' : 'pass',
    checks,
    summary: {
      total: checks.length,
      passed,
      warnings,
      failed,
    },
    issues,
  }
}

/**
 * Format check result as text.
 */
function formatCheckText(result: CheckCommandResult, verbose: boolean): string {
  const lines: string[] = []

  // Status icons
  const icons: Record<CheckStatus, string> = {
    pass: '[PASS]',
    warn: '[WARN]',
    fail: '[FAIL]',
  }

  lines.push('Popcomputer Web Project Check')
  lines.push('='.repeat(50))
  lines.push('')

  // Individual checks
  for (const check of result.checks) {
    lines.push(`${icons[check.status]} ${check.name}: ${check.message}`)

    if (verbose && check.details) {
      for (const detail of check.details) {
        const prefix = detail.type === 'error' ? '  ERROR' : detail.type === 'warning' ? '  WARN ' : '  INFO '
        lines.push(`${prefix}: ${detail.message}`)
        if (detail.fix) {
          if (detail.fix.command) {
            lines.push(`         Fix: ${detail.fix.command}`)
          } else if (detail.fix.description) {
            lines.push(`         Fix: ${detail.fix.description}`)
          }
        }
      }
    }
  }

  lines.push('')
  lines.push('-'.repeat(50))

  // Summary
  const { summary } = result
  lines.push(`Summary: ${summary.passed} passed, ${summary.warnings} warnings, ${summary.failed} failed`)

  if (result.status === 'pass') {
    lines.push('')
    lines.push('All checks passed!')
  } else if (result.status === 'fail') {
    lines.push('')
    lines.push('Some checks failed. Run with --verbose for details.')
  }

  return lines.join('\n')
}

/**
 * Parse CLI arguments for check command.
 */
export function parseCheckArgs(args: string[]): CheckCommandOptions {
  const options: CheckCommandOptions = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    switch (arg) {
      case '--app':
        options.app = args[++i]
        break
      case '--json':
        options.format = 'json'
        break
      case '--verbose':
      case '-v':
        options.verbose = true
        break
      case '--only':
        const checks = args[++i]?.split(',') ?? []
        options.only = checks as any
        break
      case '--scan':
        const scanDirs = args[++i]?.split(',').filter(Boolean) ?? []
        if (scanDirs.length > 0) {
          options.scanDirs = scanDirs
        }
        break
    }
  }

  return options
}

/**
 * Get help text for check command.
 */
export function checkHelp(): string {
  return `
popweb check - Validate project structure and configuration

USAGE:
  popweb check --app <entrypoint> [OPTIONS]

OPTIONS:
  --app <path>        Application entrypoint exporting the app or route registry
  --json              Output as JSON (machine-readable)
  -v, --verbose       Show detailed output with fix suggestions
  --only <checks>     Run specific checks (comma-separated)
  --scan <dirs>       Scan directories for route exports (comma-separated)
                      Available: routes, naming, bindings, registration

CHECKS:
  routes    Validate route structure and paths
  naming    Check route naming conventions
  bindings  Validate route model bindings
  registration  Ensure colocated route exports are registered

EXAMPLES:
  # Run all checks
  popweb check --app src/app.ts

  # Run with verbose output
  popweb check --app src/app.ts --verbose

  # Output as JSON for agents
  popweb check --app src/app.ts --json

  # Run specific checks
  popweb check --app src/app.ts --only routes,naming
`.trim()
}

/**
 * Run the check command from CLI arguments.
 */
export async function runCheck(
  args: string[] = [],
  registry?: RouteRegistry
): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(checkHelp())
    return
  }

  const options = parseCheckArgs(args)
  const resolvedRegistry = registry ?? (
    options.app ? await loadAppRouteRegistry(options.app) : undefined
  )
  if (!resolvedRegistry) {
    throw new Error('Missing application entrypoint. Pass --app src/app.ts.')
  }
  const result = checkCommand(resolvedRegistry, options)

  if (options.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(formatCheckText(result, options.verbose ?? false))
  }

  // Exit with error code if checks failed
  if (result.status === 'fail') {
    process.exit(1)
  }
}
