/**
 * Error Context Capture for Honertia
 *
 * Utilities for capturing request, route, and handler context
 * when errors occur.
 */

import type { Context as HonoContext, Env } from 'hono'
import { Schema as S } from 'effect'
import type { ErrorContext, SourceLocation, CodeSnippet, SafeHeaders } from './error-types.js'

/**
 * Headers that are safe to include in error context.
 * Excludes sensitive headers like Authorization, Cookie, etc.
 */
const SAFE_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'content-length',
  'x-inertia',
  'x-inertia-version',
  'x-requested-with',
  'user-agent',
  'referer',
  'origin',
]

/**
 * Extract safe headers from a request.
 */
function extractSafeHeaders(headers: Headers): SafeHeaders {
  const result: SafeHeaders = {}

  for (const key of SAFE_HEADERS) {
    const value = headers.get(key)

    if (value) {
      result[key] = value
    }
  }

  return result
}

/**
 * Capture error context from a Hono request context.
 *
 * Extracts route information (method, path, params) and request details
 * (URL, safe headers) for inclusion in structured errors. Sensitive headers
 * like Authorization and Cookie are automatically filtered out.
 *
 * @param c - The Hono request context.
 * @returns An ErrorContext object with route and request information.
 *
 * @example
 * ```ts
 * app.use('*', async (c, next) => {
 *   try {
 *     await next()
 *   } catch (err) {
 *     const context = captureErrorContext(c)
 *     const structured = toStructuredError(err, context)
 *     // ...
 *   }
 * })
 * ```
 */
export function captureErrorContext<E extends Env>(c: HonoContext<E>): ErrorContext {
  const context: ErrorContext = {}

  // Route context
  try {
    const routePath = c.req.routePath ?? c.req.path
    const params = c.req.param()

    context.route = {
      method: c.req.method,
      path: routePath,
      params: S.is(S.String)(params) ? {} : params,
    }
  } catch {
    // Ignore errors extracting route info
  }

  // Request context
  try {
    context.request = {
      url: c.req.url,
      headers: extractSafeHeaders(c.req.raw.headers),
    }
  } catch {
    // Ignore errors extracting request info
  }

  return context
}

/**
 * Parse a V8 stack trace into structured frames.
 */
export interface StackFrame {
  /** Function name if available */
  functionName?: string
  /** File path */
  file: string
  /** Line number */
  line: number
  /** Column number */
  column: number
  /** Whether this is from node_modules or framework code */
  isInternal: boolean
}

/**
 * Parse a stack trace string into frames.
 */
export function parseStackTrace(stack: string): StackFrame[] {
  const frames: StackFrame[] = []
  const lines = stack.split('\n')

  for (const line of lines) {
    // Match V8 stack format: "    at functionName (file:line:col)"
    // or "    at file:line:col"
    const match = line.match(/^\s*at\s+(?:(.+?)\s+\()?(.+):(\d+):(\d+)\)?$/)

    if (match) {
      const file = match[2]

      const isInternal =
        file.includes('node_modules') ||
        file.includes('@popcomputer/web/dist') ||
        file.includes('effect/dist') ||
        file.startsWith('node:')

      frames.push({
        functionName: match[1],
        file,
        line: parseInt(match[3], 10),
        column: parseInt(match[4], 10),
        isInternal,
      })
    }
  }

  return frames
}

/**
 * Find the first user code frame (non-internal).
 */
export function findUserFrame(frames: StackFrame[]): StackFrame | undefined {
  return frames.find((f) => !f.isInternal)
}

/**
 * Create a source location from an error.
 * Attempts to find the relevant user code location.
 */
export function createSourceLocation(error: Error): SourceLocation | undefined {
  if (!error.stack) return undefined

  const frames = parseStackTrace(error.stack)
  const userFrame = findUserFrame(frames)

  if (!userFrame) return undefined

  return {
    file: userFrame.file,
    line: userFrame.line,
    column: userFrame.column,
    functionName: userFrame.functionName,
  }
}

/**
 * Create a code snippet from source code.
 * Used when source code is available (e.g., in development).
 *
 * @param sourceCode - The full source code content.
 * @param line - The 1-indexed line number where the error occurred.
 * @param contextLines - Number of lines to include before/after the error line.
 * @param highlightStart - Optional start column for highlighting.
 * @param highlightEnd - Optional end column for highlighting.
 * @returns A CodeSnippet with before/after context.
 */
export function createCodeSnippet(
  sourceCode: string,
  line: number,
  contextLines: number = 2,
  highlightStart?: number,
  highlightEnd?: number
): CodeSnippet {
  const lines = sourceCode.split('\n')

  // Validate line number is within bounds
  const validLine = Math.max(1, Math.min(line, lines.length))
  const startLine = Math.max(0, validLine - 1 - contextLines)
  const endLine = Math.min(lines.length, validLine + contextLines)

  const before = lines.slice(startLine, validLine - 1)
  const errorLine = lines[validLine - 1] ?? ''
  const after = lines.slice(validLine, endLine)

  const snippet: CodeSnippet = {
    before,
    line: errorLine,
    after,
  }

  if (highlightStart !== undefined && highlightEnd !== undefined) {
    snippet.highlight = {
      start: highlightStart,
      end: highlightEnd,
    }
  }

  return snippet
}

/**
 * Enhanced error context with source location.
 */
export interface EnhancedErrorContext extends ErrorContext {
  source?: SourceLocation
}

/**
 * Capture enhanced error context including source location.
 */
export function captureEnhancedContext<E extends Env>(
  c: HonoContext<E>,
  error?: Error
): EnhancedErrorContext {
  // SAFETY: The error boundary established the structured-error variant before restoring its precise local contract.
  const context = captureErrorContext(c) as EnhancedErrorContext

  if (error) {
    context.source = createSourceLocation(error)
  }

  return context
}

/**
 * Add handler context to an error context.
 */
export function withHandlerContext(
  context: ErrorContext,
  file?: string,
  functionName?: string
): ErrorContext {
  return {
    ...context,
    handler: {
      file,
      function: functionName,
    },
  }
}

/**
 * Add service context to an error context.
 */
export function withServiceContext(
  context: ErrorContext,
  serviceName: string,
  operation?: string
): ErrorContext {
  return {
    ...context,
    service: {
      name: serviceName,
      operation,
    },
  }
}

/**
 * Merge error contexts, with later values taking precedence.
 */
export function mergeContexts(...contexts: Partial<ErrorContext>[]): ErrorContext {
  const result: ErrorContext = {}

  for (const ctx of contexts) {
    if (ctx.route) {
      result.route = { ...result.route, ...ctx.route }
    }

    if (ctx.handler) {
      result.handler = { ...result.handler, ...ctx.handler }
    }

    if (ctx.request) {
      result.request = { ...result.request, ...ctx.request }
    }

    if (ctx.service) {
      result.service = { ...result.service, ...ctx.service }
    }
  }

  return result
}

/**
 * Create an empty error context.
 */
export function emptyContext(): ErrorContext {
  return {}
}
