/**
 * Structured Error Types for Honertia
 *
 * World-class error system optimized for AI/LLM consumption.
 * Every error includes machine-readable fix suggestions.
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
 * Source location information from stack trace.
 */
export interface SourceLocation {
  /** Original TypeScript file path */
  file: string
  /** Line number (1-indexed) */
  line: number
  /** Column number (1-indexed) */
  column: number
  /** Function or method name if available */
  functionName?: string
  /** Code snippet around the error */
  codeSnippet?: CodeSnippet
}

/**
 * Code snippet for visual error display.
 */
export interface CodeSnippet {
  /** Lines before the error line */
  before: string[]
  /** The line containing the error */
  line: string
  /** Lines after the error line */
  after: string[]
  /** Character range to highlight */
  highlight?: {
    start: number
    end: number
  }
}

/**
 * Route information when error occurred.
 */
export interface RouteContext {
  /** HTTP method */
  method: string
  /** Route path pattern (e.g., "/projects/{project}") */
  path: string
  /** Resolved route parameters */
  params: Record<string, string>
}

/**
 * Handler information when error occurred.
 */
export interface HandlerContext {
  /** Source file path */
  file?: string
  /** Function or handler name */
  function?: string
}

/**
 * Request information when error occurred.
 */
export interface RequestContext {
  /** Full request URL */
  url: string
  /** Relevant headers (filtered for security) */
  headers: SafeHeaders
  /** Request body for validation errors */
  body?: unknown
}

/**
 * Service information when error occurred.
 */
export interface ServiceContext {
  /** Service name (e.g., "DatabaseService") */
  name: string
  /** Operation that was attempted */
  operation?: string
}

/**
 * Complete context captured when an error occurs.
 */
export interface ErrorContext {
  route?: RouteContext
  handler?: HandlerContext
  request?: RequestContext
  service?: ServiceContext
}

/**
 * Type of fix operation.
 */
export type FixType =
  | 'add_code'
  | 'modify_code'
  | 'delete_code'
  | 'add_config'
  | 'install_dependency'
  | 'create_file'
  | 'run_command'

/**
 * Position for code insertion/modification.
 */
export interface FixPosition {
  /** Line number to insert at */
  line?: number
  /** Column number */
  column?: number
  /** Insert after this pattern */
  after?: string
  /** Insert before this pattern */
  before?: string
  /** Replace a range of lines */
  replace?: {
    startLine: number
    endLine: number
  }
}

/**
 * A single fix operation.
 */
export interface FixOperation {
  type: FixType
  /** File path for code changes */
  file?: string
  /** Position for insertion */
  position?: FixPosition
  /** Code or content to insert */
  content?: string
  /** Config path for config changes (e.g., "honertia.database") */
  configPath?: string
  /** Config value to set */
  configValue?: unknown
  /** Command to run */
  command?: string
  /** Package name for dependency installation */
  package?: string
  /** Version constraint for dependency */
  version?: string
}

/**
 * Action to take after applying a fix.
 */
export interface PostAction {
  type: 'restart_server' | 'rebuild' | 'run_migrations' | 'clear_cache' | 'run_tests'
  description: string
}

/**
 * A suggested fix for an error.
 */
export interface FixSuggestion {
  /** Unique identifier for this fix */
  id: string
  /** Type of fix */
  type: FixType
  /** Confidence level */
  confidence: 'high' | 'medium' | 'low'
  /** Human-readable description */
  description: string
  /** Whether this can be applied automatically */
  automated: boolean
  /** The fix operations to apply */
  operations: FixOperation[]
  /** Actions to take after applying */
  postActions?: PostAction[]
}

/**
 * Documentation reference for an error.
 */
export interface ErrorDocs {
  /** URL to documentation */
  url: string
  /** Related error codes */
  related: string[]
}

/**
 * The main structured error interface.
 * This is the format returned for all Honertia errors.
 */
export interface HonertiaStructuredError {
  /** Unique error code (e.g., "HON_VAL_001_FIELD_REQUIRED") */
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
  /** Source location from stack trace */
  source?: SourceLocation
  /** Suggested fixes */
  fixes: FixSuggestion[]
  /** Documentation links */
  docs?: ErrorDocs
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
  path: string[]
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
 * Configuration-specific error extension.
 */
export interface ConfigurationErrorData {
  /** The service that is missing */
  missingService: string
  /** Configuration path (e.g., "honertia.database") */
  configPath: string
  /** Setup function to use */
  setupFunction: string
}

/**
 * Route binding-specific error extension.
 */
export interface BindingErrorData {
  /** Route parameter name */
  param: string
  /** Database column being queried */
  column: string
  /** Table name */
  tableName: string
  /** The parameter value that failed */
  value: string
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
  /** Documentation path */
  docsPath: string
  /** Related error codes */
  related: string[]
}

/**
 * Function that generates a fix suggestion from context.
 */
export type FixGenerator = (
  context: ErrorContext,
  params: ErrorParams
) => FixSuggestion | null
