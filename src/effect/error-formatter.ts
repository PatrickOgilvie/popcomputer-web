/**
 * Error formatters for terminal, JSON and Inertia output
 *
 * Multiple output formats for structured errors:
 * - JSON for AI/API consumption
 * - Terminal with ANSI colors for CLI
 * - Inertia for browser rendering
 */

import type { ErrorResponseBody } from './error-response.js'
import { wantsJson } from './negotiation.js'
import type {
  StructuredError,
  ValidationErrorData,
} from './error-types.js'
import type { PagePropValue, PageProps } from '../types.js'

/**
 * Interface for error formatters.
 */
export interface ErrorFormatter {
  format(error: StructuredError): string | object
}

/**
 * Error categories whose messages may contain sensitive internals
 * (raw exception text, DB driver output, connection details, config values)
 * and must never be sent to clients in production.
 */
const SENSITIVE_MESSAGE_CATEGORIES = new Set<StructuredError['category']>([
  'configuration',
  'internal',
  'database',
  'service',
])

/**
 * Generic, client-safe message used in place of sensitive error messages.
 */
const SAFE_GENERIC_MESSAGE = 'An error occurred. Please try again later.'
const NOT_FOUND_MESSAGE = 'Nothing was found at this address.'

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
  error: StructuredError,
  isDev: boolean
): string {
  if (isDev) return error.message

  // Every 404 reads the same, so a response cannot tell a missing record from
  // one the visitor may not see, whatever resource name the action used.
  if (error.httpStatus === 404) return NOT_FOUND_MESSAGE

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
    path: readonly string[]
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

  return { fields }
}

/**
 * Options for JSON formatter.
 */
export interface JsonFormatterOptions {
  /** Pretty print with indentation */
  pretty?: boolean
  /** Include request/route context */
  includeContext?: boolean
  /** Include fix suggestions, which can contain setup code */
  includeFixes?: boolean
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
      includeContext: true,
      includeFixes: true,
      safeMessages: false,
      ...options,
    }
  }

  format(error: StructuredError): ErrorResponseBody {
    const validation = projectValidationExtension(error.validation)
    // HttpError.body is an intentional client payload for 4xx responses.
    // Safe messages never forward it for 5xx responses, where arbitrary
    // internals may have been attached by a caller.
    const body = this.options.safeMessages && error.httpStatus >= 500 ? undefined : error.body

    return {
      code: error.code,
      tag: error.tag,
      category: error.category,
      title: error.title,
      message: getClientSafeMessage(error, !this.options.safeMessages),
      httpStatus: error.httpStatus,
      timestamp: error.timestamp,
      ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(this.options.includeContext && error.context ? { context: error.context } : {}),
      ...(this.options.includeFixes && error.fixes.length > 0 ? { fixes: error.fixes } : {}),
      ...(error.validation
        ? {
            errors: Object.fromEntries(
              Object.entries(error.validation.fields).map(([name, field]) => [name, field.message])
            ),
          }
        : {}),
      ...(validation === undefined ? {} : { validation }),
      ...(body === undefined ? {} : { body }),
    }
  }

  /**
   * Format to JSON string.
   */
  formatString(error: StructuredError): string {
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

  format(error: StructuredError): string {
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
        lines.push(`  ${i + 1}. ${fix.description}`)

        for (const codeLine of fix.code?.split('\n') ?? []) {
          lines.push(`     ${c.dim}${codeLine}${c.reset}`)
        }
      })

      if (error.fixes.length > (this.options.maxFixes ?? 3)) {
        lines.push(
          `  ${c.dim}... and ${error.fixes.length - (this.options.maxFixes ?? 3)} more${c.reset}`
        )
      }

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
      isDev: true,
      ...options,
    }
  }

  format(error: StructuredError): PageProps {
    const props = new Map<string, PagePropValue>([
      ['status', error.httpStatus],
      ['code', error.code],
      ['title', error.title],
      ['message', getClientSafeMessage(error, this.options.isDev ?? false)],
    ])

    if (this.options.includeFixes && error.fixes.length > 0) {
      props.set('fixes', error.fixes.map((fix) =>
        fix.code === undefined
          ? { description: fix.description }
          : { description: fix.description, code: fix.code }
      ))
      props.set('hint', error.fixes[0].description)
    }

    return Object.fromEntries(props)
  }
}

/**
 * Request context for format detection.
 */
export interface FormatDetectionContext {
  header: (name: string) => string | undefined
  method: string
  url: string
}

/** User-Agents of AI agents and command-line clients, which read errors as JSON. */
const JSON_CLIENTS = ['claude-code', 'claude', 'anthropic', 'CLI', 'curl']

/**
 * Whether a failure answers the request as JSON rather than a page: never for
 * an Inertia visit; otherwise for an AI agent or command-line client, by its
 * User-Agent, and for a client that asks for JSON.
 */
export function answersErrorAsJson(request: FormatDetectionContext): boolean {
  // An Inertia visit takes Inertia's page protocol whatever its User-Agent or
  // Accept says: an agent driving the application in a browser sends both.
  if (request.header('X-Inertia') === 'true') return false

  const userAgent = request.header('User-Agent') ?? ''

  return JSON_CLIENTS.some((client) => userAgent.includes(client)) || wantsJson((name) => request.header(name))
}
