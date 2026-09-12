/**
 * Error Formatters for Honertia
 *
 * Multiple output formats for structured errors:
 * - JSON for AI/API consumption
 * - Terminal with ANSI colors for CLI
 * - Inertia for browser rendering
 */

import type {
  HonertiaStructuredError,
  ValidationErrorData,
} from './error-types.js'
import type { PagePropValue, PageProps } from '../types.js'

/**
 * Interface for error formatters.
 */
export interface ErrorFormatter {
  format(error: HonertiaStructuredError): string | object
}

/**
 * Error categories whose messages may contain sensitive internals
 * (raw exception text, DB driver output, connection details, config values)
 * and must never be sent to clients in production.
 */
const SENSITIVE_MESSAGE_CATEGORIES = new Set<HonertiaStructuredError['category']>([
  'configuration',
  'internal',
  'database',
  'service',
])

/**
 * Generic, client-safe message used in place of sensitive error messages.
 */
const SAFE_GENERIC_MESSAGE = 'An error occurred. Please try again later.'

interface FormattedError {
  code: string
  tag: string
  category: HonertiaStructuredError['category']
  title: string
  message: string
  httpStatus: number
  timestamp: string
  requestId?: string
  source?: HonertiaStructuredError['source']
  context?: HonertiaStructuredError['context']
  fixes?: HonertiaStructuredError['fixes']
  docs?: HonertiaStructuredError['docs']
  validation?: object
  body?: unknown
}

/**
 * Return a client-safe message for an error.
 *
 * In development the real message is returned to aid debugging. In production
 * (or whenever `isDev` is false), messages for sensitive categories are replaced
 * with a generic string so raw exception text — which can leak stack details,
 * DB errors, secrets, or connection strings — never reaches the client.
 *
 * Shared by every client-facing formatter (JSON and Inertia) so the two paths
 * cannot drift apart.
 */
export function getClientSafeMessage(
  error: HonertiaStructuredError,
  isDev: boolean
): string {
  if (isDev) return error.message

  if (
    error.httpStatus >= 500 ||
    SENSITIVE_MESSAGE_CATEGORIES.has(error.category)
  ) {
    return SAFE_GENERIC_MESSAGE
  }

  return error.message
}

/**
 * Project validation details onto the client protocol without echoing the
 * rejected values. Those values can contain passwords, tokens, or other
 * request data even though the validation messages themselves are safe.
 */
function projectValidationExtension(value: ValidationErrorData | undefined): object | undefined {
  if (!value) return undefined

  const fields: Record<string, {
    expected: string
    message: string
    path: string[]
    schemaType?: string
  }> = {}

  for (const [name, field] of Object.entries(value.fields)) {
    fields[name] = {
      expected: field.expected,
      message: field.message,
      path: field.path,
      schemaType: field.schemaType,
    }
  }

  return value.component === undefined
    ? { fields }
    : { fields, component: value.component }
}

/**
 * Options for JSON formatter.
 */
export interface JsonFormatterOptions {
  /** Pretty print with indentation */
  pretty?: boolean
  /** Include source location */
  includeSource?: boolean
  /** Include request/route context */
  includeContext?: boolean
  /** Include fix suggestions */
  includeFixes?: boolean
  /** Include documentation links */
  includeDocs?: boolean
  /**
   * Emit the client-safe production projection: replace server-error messages,
   * omit server-error bodies and unknown extensions, and remove rejected
   * values from validation details.
   * @default false
   */
  safeMessages?: boolean
}

/**
 * JSON formatter for AI/LLM and API consumption.
 * Outputs machine-readable structured error data.
 */
export class JsonErrorFormatter implements ErrorFormatter {
  constructor(private options: JsonFormatterOptions = {}) {
    // Default all options to true
    this.options = {
      pretty: true,
      includeSource: true,
      includeContext: true,
      includeFixes: true,
      includeDocs: true,
      safeMessages: false,
      ...options,
    }
  }

  format(error: HonertiaStructuredError): FormattedError {
    const output: FormattedError = {
      code: error.code,
      tag: error.tag,
      category: error.category,
      title: error.title,
      message: getClientSafeMessage(error, !this.options.safeMessages),
      httpStatus: error.httpStatus,
      timestamp: error.timestamp,
    }

    if (error.requestId) {
      output.requestId = error.requestId
    }

    if (this.options.includeSource && error.source) {
      output.source = error.source
    }

    if (this.options.includeContext && error.context) {
      output.context = error.context
    }

    if (this.options.includeFixes && error.fixes.length > 0) {
      output.fixes = error.fixes
    }

    if (this.options.safeMessages) {
      const validation = projectValidationExtension(error.validation)

      if (validation) {
        output.validation = validation
      }

      // HttpError.body is an intentional client payload for 4xx responses.
      // Never forward it for 5xx responses, where arbitrary internals may have
      // been attached by a caller.
      if (error.httpStatus < 500 && error.body !== undefined) {
        output.body = error.body
      }
    } else {
      output.validation = projectValidationExtension(error.validation)
      output.body = error.body
    }

    if (this.options.includeDocs && error.docs) {
      output.docs = error.docs
    }

    return output
  }

  /**
   * Format to JSON string.
   */
  formatString(error: HonertiaStructuredError): string {
    const obj = this.format(error)

    return this.options.pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj)
  }
}

/**
 * ANSI color codes for terminal output.
 */
const colors = {
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
  white: '\x1b[37m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  underline: '\x1b[4m',
}

/**
 * Options for terminal formatter.
 */
export interface TerminalFormatterOptions {
  /** Use ANSI colors */
  useColors?: boolean
  /** Show source code snippet */
  showSnippet?: boolean
  /** Show fix suggestions */
  showFixes?: boolean
  /** Maximum number of fixes to show */
  maxFixes?: number
}

/**
 * Terminal formatter with ANSI colors.
 * Outputs Rust/Elm-style human-readable errors.
 */
export class TerminalErrorFormatter implements ErrorFormatter {
  private c: typeof colors | Record<keyof typeof colors, string>

  constructor(private options: TerminalFormatterOptions = {}) {
    this.options = {
      useColors: true,
      showSnippet: true,
      showFixes: true,
      maxFixes: 3,
      ...options,
    }

    // Use colors or empty strings
    // SAFETY: The error boundary established the structured-error variant before restoring its precise local contract.
    this.c = this.options.useColors
      ? colors
      : Object.fromEntries(Object.keys(colors).map((k) => [k, ''])) as Record<
          keyof typeof colors,
          string
        >
  }

  format(error: HonertiaStructuredError): string {
    const { c } = this
    const lines: string[] = []

    // Empty line for spacing
    lines.push('')

    // Header with error code
    lines.push(
      `${c.red}${c.bold}ERROR${c.reset} ${c.gray}[${error.code}]${c.reset}`
    )
    lines.push(`${c.bold}${error.title}${c.reset}`)
    lines.push('')

    // Message
    lines.push(error.message)
    lines.push('')

    // Source location with code snippet
    if (error.source) {
      lines.push(`${c.cyan}Location:${c.reset}`)
      lines.push(
        `  ${c.dim}${error.source.file}:${error.source.line}:${error.source.column}${c.reset}`
      )

      if (this.options.showSnippet && error.source.codeSnippet) {
        lines.push('')
        const snippet = error.source.codeSnippet
        const errorLine = error.source.line
        const startLine = errorLine - snippet.before.length

        // Lines before
        snippet.before.forEach((line, i) => {
          const lineNum = String(startLine + i).padStart(4)
          lines.push(`${c.gray}${lineNum} |${c.reset} ${line}`)
        })

        // Error line (highlighted)
        const errorLineNum = String(errorLine).padStart(4)
        lines.push(`${c.red}${errorLineNum} |${c.reset} ${snippet.line}`)

        // Pointer arrow
        if (snippet.highlight) {
          const padding = ' '.repeat(7 + snippet.highlight.start)

          const arrows = '^'.repeat(
            Math.max(1, snippet.highlight.end - snippet.highlight.start)
          )

          lines.push(`${c.red}${padding}${arrows}${c.reset}`)
        }

        // Lines after
        snippet.after.forEach((line, i) => {
          const lineNum = String(errorLine + 1 + i).padStart(4)
          lines.push(`${c.gray}${lineNum} |${c.reset} ${line}`)
        })

        lines.push('')
      }
    }

    // Route context
    if (error.context.route) {
      const { method, path, params } = error.context.route
      lines.push(`${c.cyan}Route:${c.reset} ${method} ${path}`)

      if (Object.keys(params).length > 0) {
        lines.push(
          `${c.cyan}Params:${c.reset} ${JSON.stringify(params)}`
        )
      }

      lines.push('')
    }

    // Fix suggestions
    if (this.options.showFixes && error.fixes.length > 0) {
      lines.push(`${c.yellow}${c.bold}Suggested Fixes:${c.reset}`)

      const fixesToShow = error.fixes.slice(0, this.options.maxFixes)
      fixesToShow.forEach((fix, i) => {
        const confidenceLabels = {
          high: `${c.green}[high]${c.reset}`,
          medium: `${c.yellow}[med]${c.reset}`,
          low: `${c.gray}[low]${c.reset}`,
        }

        const confidence = confidenceLabels[fix.confidence]

        const auto = fix.automated ? `${c.cyan}(auto)${c.reset} ` : ''
        lines.push(`  ${i + 1}. ${confidence} ${auto}${fix.description}`)

        // Show code preview if available
        if (fix.operations[0]?.content) {
          const preview = fix.operations[0].content.trim().split('\n')[0]

          if (preview.length > 60) {
            lines.push(`     ${c.dim}${preview.slice(0, 60)}...${c.reset}`)
          } else {
            lines.push(`     ${c.dim}${preview}${c.reset}`)
          }
        }
      })

      if (error.fixes.length > (this.options.maxFixes ?? 3)) {
        lines.push(
          `  ${c.dim}... and ${error.fixes.length - (this.options.maxFixes ?? 3)} more${c.reset}`
        )
      }

      lines.push('')
    }

    // Documentation link
    if (error.docs?.url) {
      lines.push(`${c.cyan}Docs:${c.reset} ${c.underline}${error.docs.url}${c.reset}`)
      lines.push('')
    }

    return lines.join('\n')
  }
}

/**
 * Options for Inertia formatter.
 */
export interface InertiaFormatterOptions {
  /** Include fix suggestions */
  includeFixes?: boolean
  /** Include source location */
  includeSource?: boolean
  /** Development mode (shows more details) */
  isDev?: boolean
}

/**
 * Inertia formatter for browser error pages.
 * Outputs props for an Inertia error component.
 */
export class InertiaErrorFormatter implements ErrorFormatter {
  constructor(private options: InertiaFormatterOptions = {}) {
    this.options = {
      includeFixes: true,
      includeSource: true,
      isDev: true,
      ...options,
    }
  }

  format(error: HonertiaStructuredError): PageProps {
    const props = new Map<string, PagePropValue>([
      ['status', error.httpStatus],
      ['code', error.code],
      ['title', error.title],
      ['message', getClientSafeMessage(error, this.options.isDev ?? false)],
    ])

    if (this.options.includeFixes && error.fixes.length > 0) {
      props.set('fixes', error.fixes.map((f) => ({
        description: f.description,
        confidence: f.confidence,
        automated: f.automated,
      })))

      // Include first high-confidence fix as a hint
      const highConfidenceFix = error.fixes.find((f) => f.confidence === 'high')

      if (highConfidenceFix) {
        props.set('hint', highConfidenceFix.description)
      }
    }

    if (this.options.includeSource && this.options.isDev && error.source) {
      props.set('source', {
        file: error.source.file,
        line: error.source.line,
        column: error.source.column,
      })
    }

    if (error.docs?.url) {
      props.set('docsUrl', error.docs.url)
    }

    return Object.fromEntries(props)
  }
}

/**
 * Output format types.
 */
export type OutputFormat = 'json' | 'terminal' | 'inertia'

/**
 * Request context for format detection.
 */
export interface FormatDetectionContext {
  header: (name: string) => string | undefined
  method: string
  url: string
}

/**
 * Detect the appropriate output format based on request headers and environment.
 *
 * Detection priority:
 * 1. AI/CLI User-Agents (claude-code, curl) → 'json'
 * 2. Accept: application/json header → 'json'
 * 3. X-Inertia: true header → 'inertia'
 * 4. Content-Type: application/json → 'json'
 * 5. Development environment → 'terminal'
 * 6. Production browser requests → 'inertia'
 *
 * @param request - Request context with header accessor, method, and URL.
 * @param env - Environment variables for detecting dev/prod mode.
 * @returns The detected output format: 'json', 'terminal', or 'inertia'.
 *
 * @example
 * ```ts
 * const format = detectOutputFormat(
 *   { header: (n) => c.req.header(n), method: c.req.method, url: c.req.url },
 *   c.env
 * )
 * const formatter = createFormatter(format, isDev)
 * ```
 */
export function detectOutputFormat<Environment>(
  request: FormatDetectionContext,
  env?: Environment
): OutputFormat {
  // Check for AI/CLI User-Agent
  const userAgent = request.header('User-Agent') ?? ''

  if (
    userAgent.includes('claude-code') ||
    userAgent.includes('claude') ||
    userAgent.includes('anthropic') ||
    userAgent.includes('CLI') ||
    userAgent.includes('curl')
  ) {
    return 'json'
  }

  // Check Accept header
  const accept = request.header('Accept') ?? ''

  if (accept.includes('application/json')) {
    return 'json'
  }

  // Check for Inertia request
  if (request.header('X-Inertia') === 'true') {
    return 'inertia'
  }

  // Check Content-Type for API requests
  const contentType = request.header('Content-Type') ?? ''

  if (contentType.includes('application/json')) {
    return 'json'
  }

  // Development mode defaults to terminal-style logging.
  // Must be explicitly signalled — CF_PAGES_BRANCH is intentionally excluded
  // because it is present on production Pages deployments too.
  const environment = env instanceof Object ? env : {}

  const isDev =
    Object.getOwnPropertyDescriptor(environment, 'ENVIRONMENT')?.value === 'development' ||
    Object.getOwnPropertyDescriptor(environment, 'NODE_ENV')?.value === 'development'

  if (isDev) {
    return 'terminal'
  }

  // Production browser requests get Inertia format
  return 'inertia'
}

/**
 * Create a formatter instance for the given output format.
 *
 * @param format - The output format: 'json', 'terminal', or 'inertia'.
 * @param isDev - Whether to include dev-only details (source, context). Defaults to true.
 * @returns An ErrorFormatter instance configured for the format.
 *
 * @example
 * ```ts
 * const format = detectOutputFormat(request, env)
 * const formatter = createFormatter(format, isDev)
 * const output = formatter.format(structuredError)
 * ```
 */
export function createFormatter(
  format: OutputFormat,
  isDev: boolean = true
): ErrorFormatter {
  switch (format) {
    case 'json':
      return new JsonErrorFormatter({
        pretty: isDev,
        includeSource: isDev,
        includeContext: isDev,
        includeFixes: true,
        includeDocs: true,
        // Match the framework's own production handlers: sensitive-category
        // messages must never reach clients through this public factory.
        safeMessages: !isDev,
      })

    case 'terminal':
      return new TerminalErrorFormatter({
        useColors: true,
        showSnippet: true,
        showFixes: true,
        maxFixes: 3,
      })

    case 'inertia':
      return new InertiaErrorFormatter({
        includeFixes: isDev,
        includeSource: isDev,
        isDev,
      })
  }
}
