/**
 * Structured error types
 *
 * Every failure the request boundary renders becomes a StructuredError: a
 * stable code, the HTTP status, the request context and, in development,
 * suggestions for fixing it.
 */

import type { PagePropValue } from '../types.js'

export type ErrorParams = Readonly<Record<string, PagePropValue>>

export interface SafeHeaders {
  [header: string]: string
}

export interface FieldErrors {
  [field: string]: FieldError
}

/**
 * Error category for grouping related errors.
 */
export type ErrorCategory =
  | 'validation'
  | 'auth'
  | 'resource'
  | 'configuration'
  | 'http'
  | 'database'
  | 'routing'
  | 'service'
  | 'internal'

/**
 * Route information when error occurred.
 */
export interface RouteContext {
  /** HTTP method */
  method: string
  /** Route path pattern (e.g., "/projects/:project") */
  path: string
  /** Resolved route parameters */
  params: Record<string, string>
}

/**
 * Request information when error occurred.
 */
export interface RequestContext {
  /** Full request URL */
  url: string
  /** Relevant headers (filtered for security) */
  headers: SafeHeaders
}

/**
 * Context captured when an error occurs.
 */
export interface ErrorContext {
  route?: RouteContext
  request?: RequestContext
}

/**
 * A way to fix an error: what to do, and code to write when there is some.
 */
export interface FixSuggestion {
  /** What to change, in one sentence. */
  description: string
  /** Code to add or adapt, using the package's current API. */
  code?: string
}

/**
 * The format the request boundary renders for every error.
 */
export interface StructuredError {
  /** Unique error code (e.g., "WEB_VAL_001_FIELD_REQUIRED") */
  code: string
  /** Effect tag for the error class */
  tag: string
  /** Error category */
  category: ErrorCategory
  /** Short human-readable title */
  title: string
  /** Detailed error message */
  message: string
  /** HTTP status code */
  httpStatus: number
  /** Context when error occurred */
  context: ErrorContext
  /** Suggested fixes, most specific first */
  fixes: FixSuggestion[]
  /** ISO 8601 timestamp */
  timestamp: string
  /** Request correlation ID */
  requestId?: string
  /** Validation details projected by validation errors. */
  validation?: ValidationErrorData
  /** Optional protocol-safe response body owned by an HTTP error. */
  body?: unknown
}

/**
 * Extended error data for validation errors.
 */
export interface FieldError {
  /** The invalid value that was provided */
  value: unknown
  /** What was expected */
  expected: string
  /** Human-readable error message */
  message: string
  /** Path to the field (e.g., ["user", "address", "zip"]) */
  path: readonly string[]
  /** Effect Schema type that failed */
  schemaType?: string
}

/**
 * Validation-specific error extension.
 */
export interface ValidationErrorData {
  /** Field-level errors */
  fields: Record<string, FieldError>
  /** Inertia component to re-render */
  component?: string
}

/**
 * Error definition in the catalog.
 */
export interface ErrorDefinition {
  /** Unique error code */
  code: string
  /** Effect tag */
  tag: string
  /** Error category */
  category: ErrorCategory
  /** Short title */
  title: string
  /** Message template with {placeholders} */
  messageTemplate: string
  /** HTTP status code */
  httpStatus: number
  /** Functions that generate fix suggestions */
  defaultFixes: FixGenerator[]
}

/**
 * Function that generates a fix suggestion from the error's parameters.
 */
export type FixGenerator = (params: ErrorParams) => FixSuggestion
