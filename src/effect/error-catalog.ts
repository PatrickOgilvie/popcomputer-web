/**
 * Error catalog: codes, titles and default fixes for structured errors
 *
 * Every error code with its title, message template, status and fixes.
 */

import type {
  ErrorContext,
  ErrorDefinition,
  ErrorParams,
  FixGenerator,
  FixSuggestion,
  StructuredError,
} from './error-types.js'
import { Predicate } from 'effect'
import type { PagePropValue } from '../types.js'

// Error text accepts scalar labels. Never serialize arbitrary object payloads
// into diagnostics, where they could expose request fields or credentials.
function formatErrorParam(value: PagePropValue): string {
  if (value === null || value === undefined) return String(value)

  if (Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)) {
    return String(value)
  }

  return Array.isArray(value) ? '[array]' : '[object]'
}

/**
 * All error codes, organized by category.
 *
 * Naming convention: WEB_<CATEGORY>_<NUMBER>_<NAME>
 *
 * Categories:
 * - VAL (001-099): Validation errors
 * - AUTH (100-199): Authentication/authorization
 * - RES (200-299): Resource errors
 * - CFG (300-399): Configuration errors
 * - HTTP (400-499): HTTP errors
 * - DB (500-599): Database errors
 * - RTE (600-699): Routing errors
 * - SVC (700-799): Service errors
 * - INT (800-899): Internal errors
 */
export const ErrorCodes = {
  // Validation Errors (VAL)
  VAL_001_FIELD_REQUIRED: 'WEB_VAL_001_FIELD_REQUIRED',
  VAL_003_BODY_PARSE_FAILED: 'WEB_VAL_003_BODY_PARSE_FAILED',
  VAL_004_SCHEMA_MISMATCH: 'WEB_VAL_004_SCHEMA_MISMATCH',
  VAL_006_SOURCE_CONFLICT: 'WEB_VAL_006_SOURCE_CONFLICT',

  // Auth Errors (AUTH)
  AUTH_100_UNAUTHENTICATED: 'WEB_AUTH_100_UNAUTHENTICATED',
  AUTH_101_SESSION_EXPIRED: 'WEB_AUTH_101_SESSION_EXPIRED',
  AUTH_102_FORBIDDEN: 'WEB_AUTH_102_FORBIDDEN',
  AUTH_104_RATE_LIMITED: 'WEB_AUTH_104_RATE_LIMITED',

  // Resource Errors (RES)
  RES_200_NOT_FOUND: 'WEB_RES_200_NOT_FOUND',

  // Configuration Errors (CFG)
  CFG_300_DATABASE_NOT_CONFIGURED: 'WEB_CFG_300_DATABASE_NOT_CONFIGURED',
  CFG_301_AUTH_NOT_CONFIGURED: 'WEB_CFG_301_AUTH_NOT_CONFIGURED',
  CFG_302_SCHEMA_NOT_CONFIGURED: 'WEB_CFG_302_SCHEMA_NOT_CONFIGURED',
  CFG_305_INVALID_CONFIG: 'WEB_CFG_305_INVALID_CONFIG',

  // HTTP Errors (HTTP)
  HTTP_400_BAD_REQUEST: 'WEB_HTTP_400_BAD_REQUEST',
  HTTP_429_RATE_LIMITED: 'WEB_HTTP_429_RATE_LIMITED',
  HTTP_4XX_CLIENT_ERROR: 'WEB_HTTP_4XX_CLIENT_ERROR',
  HTTP_500_INTERNAL_ERROR: 'WEB_HTTP_500_INTERNAL_ERROR',
  HTTP_502_BAD_GATEWAY: 'WEB_HTTP_502_BAD_GATEWAY',
  HTTP_503_SERVICE_UNAVAILABLE: 'WEB_HTTP_503_SERVICE_UNAVAILABLE',

  // Database Errors (DB)
  DB_501_OPERATION_FAILED: 'WEB_DB_501_OPERATION_FAILED',
  DB_502_CONSTRAINT_VIOLATION: 'WEB_DB_502_CONSTRAINT_VIOLATION',

  // Routing Errors (RTE)
  RTE_600_BINDING_NOT_FOUND: 'WEB_RTE_600_BINDING_NOT_FOUND',
  RTE_601_TABLE_NOT_FOUND: 'WEB_RTE_601_TABLE_NOT_FOUND',
  RTE_603_RELATION_NOT_FOUND: 'WEB_RTE_603_RELATION_NOT_FOUND',
  RTE_604_BOUND_ROW_INVALID: 'WEB_RTE_604_BOUND_ROW_INVALID',
  RTE_605_BINDING_AMBIGUOUS: 'WEB_RTE_605_BINDING_AMBIGUOUS',

  // Service Errors (SVC)
  SVC_700_SERVICE_UNAVAILABLE: 'WEB_SVC_700_SERVICE_UNAVAILABLE',
  SVC_701_SERVICE_ERROR: 'WEB_SVC_701_SERVICE_ERROR',
  SVC_702_CACHE_UNAVAILABLE: 'WEB_SVC_702_CACHE_UNAVAILABLE',
  SVC_703_CACHE_PURGE_FAILED: 'WEB_SVC_703_CACHE_PURGE_FAILED',

  // Internal Errors (INT)
  INT_800_UNEXPECTED: 'WEB_INT_800_UNEXPECTED',
  INT_801_EFFECT_DEFECT: 'WEB_INT_801_EFFECT_DEFECT',
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

/**
 * Fix generators for common scenarios. Code uses the documented application:
 * `setupWeb(app, config)` in `src/app.ts`, `createDb` and `createAuth`
 * factories, and a Drizzle schema module.
 */
const fixGenerators = {
  addDatabaseConfig: (): FixSuggestion => ({
    description: 'Give setupWeb a database factory (database: (c) => createDb(...)), and register setupWeb\'s result.',
    code: `setupWeb(app, {
  version,
  render,
  database: (c) => createDb(c.env.DATABASE_URL),
})`,
  }),

  addAuthConfig: (): FixSuggestion => ({
    description: 'Give setupWeb a Better Auth client factory (auth: { client }), and register setupWeb\'s result.',
    code: `setupWeb(app, {
  version,
  render,
  database: (c) => createDb(c.env.DATABASE_URL),
  auth: {
    client: (c, { db, backgroundTasks }) => createAuth({
      db,
      secret: c.env.BETTER_AUTH_SECRET,
      baseURL: new URL(c.req.url).origin,
      advanced: { backgroundTasks },
    }),
  },
})`,
  }),

  addSchemaConfig: (): FixSuggestion => ({
    description: 'Pass the Drizzle schema to setupWeb so route model binding can find tables.',
    code: `import * as schema from './schema'

setupWeb(app, { version, render, database, schema })`,
  }),

  provideRequiredField: (params: ErrorParams): FixSuggestion => ({
    description: `Send a value for "${formatErrorParam(params.field)}", or make the field optional in the schema with S.optional(...).`,
  }),

  signIn: (): FixSuggestion => ({
    description: 'Authenticate the request as the route requires: sign in for a session, or send the credential the application checks, such as an API key.',
  }),
}

/**
 * The error catalog with all error definitions.
 */
export const ErrorCatalog = {
  // Validation Errors
  [ErrorCodes.VAL_001_FIELD_REQUIRED]: {
    code: ErrorCodes.VAL_001_FIELD_REQUIRED,
    tag: 'ValidationError',
    category: 'validation',
    title: 'Required Field Missing',
    messageTemplate: 'The field "{field}" is required but was not provided.',
    httpStatus: 422,
    defaultFixes: [fixGenerators.provideRequiredField],
  },

  [ErrorCodes.VAL_003_BODY_PARSE_FAILED]: {
    code: ErrorCodes.VAL_003_BODY_PARSE_FAILED,
    tag: 'ValidationError',
    category: 'validation',
    title: 'Request Body Parse Failed',
    messageTemplate: 'Could not parse request body: {reason}',
    httpStatus: 400,
    defaultFixes: [],
  },

  [ErrorCodes.VAL_004_SCHEMA_MISMATCH]: {
    code: ErrorCodes.VAL_004_SCHEMA_MISMATCH,
    tag: 'ValidationError',
    category: 'validation',
    title: 'Schema Validation Failed',
    messageTemplate: 'Request data does not match the expected schema.',
    httpStatus: 422,
    defaultFixes: [],
  },

  [ErrorCodes.VAL_006_SOURCE_CONFLICT]: {
    code: ErrorCodes.VAL_006_SOURCE_CONFLICT,
    tag: 'ValidationError',
    category: 'validation',
    title: 'Request Source Conflict',
    messageTemplate: 'Conflicting values were provided for "{field}" across request sources.',
    httpStatus: 422,
    defaultFixes: [],
  },

  // Auth Errors
  [ErrorCodes.AUTH_100_UNAUTHENTICATED]: {
    code: ErrorCodes.AUTH_100_UNAUTHENTICATED,
    tag: 'UnauthorizedError',
    category: 'auth',
    title: 'Authentication Required',
    messageTemplate: 'You must be logged in to access this resource.',
    httpStatus: 401,
    defaultFixes: [fixGenerators.signIn],
  },

  [ErrorCodes.AUTH_101_SESSION_EXPIRED]: {
    code: ErrorCodes.AUTH_101_SESSION_EXPIRED,
    tag: 'UnauthorizedError',
    category: 'auth',
    title: 'Session Expired',
    messageTemplate: 'Your session has expired. Please log in again.',
    httpStatus: 401,
    defaultFixes: [fixGenerators.signIn],
  },

  [ErrorCodes.AUTH_102_FORBIDDEN]: {
    code: ErrorCodes.AUTH_102_FORBIDDEN,
    tag: 'ForbiddenError',
    category: 'auth',
    title: 'Access Forbidden',
    messageTemplate: 'You do not have permission to access this resource.',
    httpStatus: 403,
    defaultFixes: [],
  },

  [ErrorCodes.AUTH_104_RATE_LIMITED]: {
    code: ErrorCodes.AUTH_104_RATE_LIMITED,
    tag: 'AuthRateLimitError',
    category: 'auth',
    title: 'Authentication Rate Limited',
    messageTemplate: 'Too many authentication attempts. Please try again later.',
    httpStatus: 429,
    defaultFixes: [],
  },

  // Resource Errors
  [ErrorCodes.RES_200_NOT_FOUND]: {
    code: ErrorCodes.RES_200_NOT_FOUND,
    tag: 'NotFoundError',
    category: 'resource',
    title: 'Resource Not Found',
    messageTemplate: 'The {resource} was not found.',
    httpStatus: 404,
    defaultFixes: [],
  },

  // Configuration Errors
  [ErrorCodes.CFG_300_DATABASE_NOT_CONFIGURED]: {
    code: ErrorCodes.CFG_300_DATABASE_NOT_CONFIGURED,
    tag: 'ConfigurationError',
    category: 'configuration',
    title: 'Database Not Configured',
    messageTemplate:
      'DatabaseService is not configured. You attempted to use the database in {location}.',
    httpStatus: 500,
    defaultFixes: [fixGenerators.addDatabaseConfig],
  },

  [ErrorCodes.CFG_301_AUTH_NOT_CONFIGURED]: {
    code: ErrorCodes.CFG_301_AUTH_NOT_CONFIGURED,
    tag: 'ConfigurationError',
    category: 'configuration',
    title: 'Auth Not Configured',
    messageTemplate:
      'AuthService is not configured. You attempted to use auth in {location}.',
    httpStatus: 500,
    defaultFixes: [fixGenerators.addAuthConfig],
  },

  [ErrorCodes.CFG_302_SCHEMA_NOT_CONFIGURED]: {
    code: ErrorCodes.CFG_302_SCHEMA_NOT_CONFIGURED,
    tag: 'ConfigurationError',
    category: 'configuration',
    title: 'Schema Not Configured',
    messageTemplate:
      'Schema is not configured for route model binding. Cannot resolve binding "{binding}".',
    httpStatus: 500,
    defaultFixes: [fixGenerators.addSchemaConfig],
  },

  [ErrorCodes.CFG_305_INVALID_CONFIG]: {
    code: ErrorCodes.CFG_305_INVALID_CONFIG,
    tag: 'ConfigurationError',
    category: 'configuration',
    title: 'Invalid Configuration',
    messageTemplate: 'Invalid configuration: {reason}',
    httpStatus: 500,
    defaultFixes: [],
  },

  // HTTP Errors
  [ErrorCodes.HTTP_400_BAD_REQUEST]: {
    code: ErrorCodes.HTTP_400_BAD_REQUEST,
    tag: 'HttpError',
    category: 'http',
    title: 'Bad Request',
    messageTemplate: 'The request could not be understood: {reason}',
    httpStatus: 400,
    defaultFixes: [],
  },

  [ErrorCodes.HTTP_429_RATE_LIMITED]: {
    code: ErrorCodes.HTTP_429_RATE_LIMITED,
    tag: 'HttpError',
    category: 'http',
    title: 'Rate Limited',
    messageTemplate: 'Too many requests. Please try again in {retryAfter} seconds.',
    httpStatus: 429,
    defaultFixes: [],
  },

  [ErrorCodes.HTTP_4XX_CLIENT_ERROR]: {
    code: ErrorCodes.HTTP_4XX_CLIENT_ERROR,
    tag: 'HttpError',
    category: 'http',
    title: 'Request Failed',
    messageTemplate: '{reason}',
    httpStatus: 400,
    defaultFixes: [],
  },

  [ErrorCodes.HTTP_500_INTERNAL_ERROR]: {
    code: ErrorCodes.HTTP_500_INTERNAL_ERROR,
    tag: 'HttpError',
    category: 'http',
    title: 'Internal Server Error',
    messageTemplate: 'An unexpected error occurred.',
    httpStatus: 500,
    defaultFixes: [],
  },

  [ErrorCodes.HTTP_502_BAD_GATEWAY]: {
    code: ErrorCodes.HTTP_502_BAD_GATEWAY,
    tag: 'HttpError',
    category: 'http',
    title: 'Bad Gateway',
    messageTemplate: 'The upstream server returned an invalid response.',
    httpStatus: 502,
    defaultFixes: [],
  },

  [ErrorCodes.HTTP_503_SERVICE_UNAVAILABLE]: {
    code: ErrorCodes.HTTP_503_SERVICE_UNAVAILABLE,
    tag: 'HttpError',
    category: 'http',
    title: 'Service Unavailable',
    messageTemplate: 'The service is temporarily unavailable. Please try again later.',
    httpStatus: 503,
    defaultFixes: [],
  },

  // Database Errors

  [ErrorCodes.DB_501_OPERATION_FAILED]: {
    code: ErrorCodes.DB_501_OPERATION_FAILED,
    tag: 'DatabaseError',
    category: 'database',
    title: 'Database Error',
    messageTemplate: 'The database {operation} failed.',
    httpStatus: 500,
    defaultFixes: [],
  },

  [ErrorCodes.DB_502_CONSTRAINT_VIOLATION]: {
    code: ErrorCodes.DB_502_CONSTRAINT_VIOLATION,
    tag: 'DatabaseConstraintViolation',
    category: 'database',
    title: 'Constraint Violation',
    messageTemplate: 'Database constraint violation: {constraint}',
    httpStatus: 409,
    defaultFixes: [],
  },

  // Routing Errors
  [ErrorCodes.RTE_600_BINDING_NOT_FOUND]: {
    code: ErrorCodes.RTE_600_BINDING_NOT_FOUND,
    tag: 'RouteConfigurationError',
    category: 'routing',
    title: 'Route Binding Not Found',
    messageTemplate:
      'Route binding "{binding}" was not found in the request context.',
    httpStatus: 500,
    defaultFixes: [],
  },

  [ErrorCodes.RTE_601_TABLE_NOT_FOUND]: {
    code: ErrorCodes.RTE_601_TABLE_NOT_FOUND,
    tag: 'RouteConfigurationError',
    category: 'routing',
    title: 'Schema Table Not Found',
    messageTemplate:
      'No table "{table}" found in schema for route model binding.',
    httpStatus: 500,
    defaultFixes: [fixGenerators.addSchemaConfig],
  },

  [ErrorCodes.RTE_603_RELATION_NOT_FOUND]: {
    code: ErrorCodes.RTE_603_RELATION_NOT_FOUND,
    tag: 'RouteConfigurationError',
    category: 'routing',
    title: 'Relation Not Found',
    messageTemplate:
      'No relation found between "{parent}" and "{child}" for nested binding.',
    httpStatus: 500,
    defaultFixes: [],
  },

  [ErrorCodes.RTE_604_BOUND_ROW_INVALID]: {
    code: ErrorCodes.RTE_604_BOUND_ROW_INVALID,
    tag: 'RouteConfigurationError',
    category: 'routing',
    title: 'Bound Row Invalid',
    messageTemplate:
      'A row loaded for route binding "{binding}" did not satisfy its registered schema.',
    httpStatus: 500,
    defaultFixes: [],
  },

  [ErrorCodes.RTE_605_BINDING_AMBIGUOUS]: {
    code: ErrorCodes.RTE_605_BINDING_AMBIGUOUS,
    tag: 'RouteConfigurationError',
    category: 'routing',
    title: 'Route Binding Ambiguous',
    messageTemplate:
      'Route binding "{binding}" matched more than one row of "{table}".',
    httpStatus: 500,
    defaultFixes: [],
  },

  // Service Errors
  [ErrorCodes.SVC_700_SERVICE_UNAVAILABLE]: {
    code: ErrorCodes.SVC_700_SERVICE_UNAVAILABLE,
    tag: 'SessionLookupUnavailable',
    category: 'service',
    title: 'Service Unavailable',
    messageTemplate: 'The "{service}" service is not available.',
    httpStatus: 503,
    defaultFixes: [],
  },

  [ErrorCodes.SVC_701_SERVICE_ERROR]: {
    code: ErrorCodes.SVC_701_SERVICE_ERROR,
    tag: 'InvalidAuthSession',
    category: 'service',
    title: 'Service Error',
    messageTemplate: 'The "{service}" service encountered an error: {reason}',
    httpStatus: 500,
    defaultFixes: [],
  },

  [ErrorCodes.SVC_702_CACHE_UNAVAILABLE]: {
    code: ErrorCodes.SVC_702_CACHE_UNAVAILABLE,
    tag: 'CacheError',
    category: 'service',
    title: 'Cache Unavailable',
    messageTemplate: 'The cache store failed: {reason}',
    httpStatus: 503,
    defaultFixes: [],
  },

  [ErrorCodes.SVC_703_CACHE_PURGE_FAILED]: {
    code: ErrorCodes.SVC_703_CACHE_PURGE_FAILED,
    tag: 'ResponseCachePurgeError',
    category: 'service',
    title: 'Cache Purge Failed',
    messageTemplate: 'Workers Cache did not purge the requested entries.',
    httpStatus: 500,
    defaultFixes: [],
  },

  // Internal Errors
  [ErrorCodes.INT_800_UNEXPECTED]: {
    code: ErrorCodes.INT_800_UNEXPECTED,
    tag: 'HttpError',
    category: 'internal',
    title: 'Unexpected Error',
    messageTemplate: 'An unexpected error occurred: {reason}',
    httpStatus: 500,
    defaultFixes: [],
  },

  [ErrorCodes.INT_801_EFFECT_DEFECT]: {
    code: ErrorCodes.INT_801_EFFECT_DEFECT,
    tag: 'HttpError',
    category: 'internal',
    title: 'Effect Defect',
    messageTemplate: 'An unhandled Effect defect occurred: {reason}',
    httpStatus: 500,
    defaultFixes: [],
  },
} satisfies Record<ErrorCode, ErrorDefinition>

/**
 * Create a structured error from an error code and parameters.
 *
 * @param code - The error code (from ErrorCodes) or any string. Unknown codes fallback to INT_800_UNEXPECTED.
 * @param params - Parameters to interpolate into the message template.
 * @param context - The error context (route, request, handler info).
 * @returns A structured error with fix suggestions.
 *
 * @example
 * ```ts
 * const error = createStructuredError(
 *   ErrorCodes.VAL_001_FIELD_REQUIRED,
 *   { field: 'email' },
 *   captureErrorContext(c)
 * )
 * ```
 */
export function createStructuredError(
  code: string,
  params: ErrorParams,
  context: ErrorContext
): StructuredError {
  // Check if code is a valid ErrorCode
  // SAFETY: The error boundary established the structured-error variant before restoring its precise local contract.
  const isValidCode = Object.values(ErrorCodes).includes(code as ErrorCode)
  // SAFETY: The error boundary established the structured-error variant before restoring its precise local contract.
  const definition = isValidCode ? ErrorCatalog[code as ErrorCode] : undefined

  if (!definition) {
    // Fallback for unknown codes
    return createStructuredError(
      ErrorCodes.INT_800_UNEXPECTED,
      { reason: `Unknown error code: ${code}` },
      context
    )
  }

  // Interpolate message template
  let message = definition.messageTemplate

  for (const [key, value] of Object.entries(params)) {
    message = message.replaceAll(`{${key}}`, () => formatErrorParam(value))
  }

  const fixes = definition.defaultFixes.map((generate: FixGenerator) => generate(params))

  return {
    code: definition.code,
    tag: definition.tag,
    category: definition.category,
    title: definition.title,
    message,
    httpStatus: definition.httpStatus,
    context,
    fixes,
    // oxlint-disable-next-line effecttsgo/global-date -- The synchronous diagnostic formatter stamps its output at the native reporting boundary; this timestamp does not drive application decisions.
    timestamp: new Date().toISOString(),
  }
}

/**
 * Mapping of service name patterns to configuration error codes.
 */
const SERVICE_ERROR_CODE_MAP: Array<{ pattern: RegExp; code: ErrorCode }> = [
  { pattern: /database/i, code: ErrorCodes.CFG_300_DATABASE_NOT_CONFIGURED },
  { pattern: /auth/i, code: ErrorCodes.CFG_301_AUTH_NOT_CONFIGURED },
  { pattern: /schema/i, code: ErrorCodes.CFG_302_SCHEMA_NOT_CONFIGURED },
]

/**
 * Determine the appropriate configuration error code from a service name or message.
 *
 * @param serviceName - The service name (e.g., 'DatabaseService').
 * @param message - Optional message to check if service name doesn't match.
 * @returns The appropriate error code, defaulting to CFG_305_INVALID_CONFIG.
 */
export function getConfigErrorCode(
  serviceName?: string,
  message?: string
): ErrorCode {
  const searchText = `${serviceName ?? ''} ${message ?? ''}`

  for (const { pattern, code } of SERVICE_ERROR_CODE_MAP) {
    if (pattern.test(searchText)) {
      return code
    }
  }

  return ErrorCodes.CFG_305_INVALID_CONFIG
}
