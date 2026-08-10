/**
 * Error Catalog for Honertia
 *
 * Central registry of all error codes with fix generators.
 * This is the single source of truth for error definitions.
 */

import type {
  ErrorCategory,
  ErrorContext,
  ErrorDefinition,
  FixGenerator,
  FixSuggestion,
  HonertiaStructuredError,
} from './error-types.js'

/**
 * All Honertia error codes organized by category.
 *
 * Naming convention: HON_<CATEGORY>_<NUMBER>_<NAME>
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
  VAL_001_FIELD_REQUIRED: 'HON_VAL_001_FIELD_REQUIRED',
  VAL_002_FIELD_INVALID: 'HON_VAL_002_FIELD_INVALID',
  VAL_003_BODY_PARSE_FAILED: 'HON_VAL_003_BODY_PARSE_FAILED',
  VAL_004_SCHEMA_MISMATCH: 'HON_VAL_004_SCHEMA_MISMATCH',
  VAL_005_TYPE_COERCION_FAILED: 'HON_VAL_005_TYPE_COERCION_FAILED',
  VAL_006_SOURCE_CONFLICT: 'HON_VAL_006_SOURCE_CONFLICT',

  // Auth Errors (AUTH)
  AUTH_100_UNAUTHENTICATED: 'HON_AUTH_100_UNAUTHENTICATED',
  AUTH_101_SESSION_EXPIRED: 'HON_AUTH_101_SESSION_EXPIRED',
  AUTH_102_FORBIDDEN: 'HON_AUTH_102_FORBIDDEN',
  AUTH_103_INVALID_CREDENTIALS: 'HON_AUTH_103_INVALID_CREDENTIALS',
  AUTH_104_RATE_LIMITED: 'HON_AUTH_104_RATE_LIMITED',

  // Resource Errors (RES)
  RES_200_NOT_FOUND: 'HON_RES_200_NOT_FOUND',
  RES_201_ALREADY_EXISTS: 'HON_RES_201_ALREADY_EXISTS',
  RES_202_GONE: 'HON_RES_202_GONE',

  // Configuration Errors (CFG)
  CFG_300_DATABASE_NOT_CONFIGURED: 'HON_CFG_300_DATABASE_NOT_CONFIGURED',
  CFG_301_AUTH_NOT_CONFIGURED: 'HON_CFG_301_AUTH_NOT_CONFIGURED',
  CFG_302_SCHEMA_NOT_CONFIGURED: 'HON_CFG_302_SCHEMA_NOT_CONFIGURED',
  CFG_303_HONERTIA_NOT_CONFIGURED: 'HON_CFG_303_HONERTIA_NOT_CONFIGURED',
  CFG_304_BINDINGS_NOT_CONFIGURED: 'HON_CFG_304_BINDINGS_NOT_CONFIGURED',
  CFG_305_INVALID_CONFIG: 'HON_CFG_305_INVALID_CONFIG',

  // HTTP Errors (HTTP)
  HTTP_400_BAD_REQUEST: 'HON_HTTP_400_BAD_REQUEST',
  HTTP_429_RATE_LIMITED: 'HON_HTTP_429_RATE_LIMITED',
  HTTP_500_INTERNAL_ERROR: 'HON_HTTP_500_INTERNAL_ERROR',
  HTTP_502_BAD_GATEWAY: 'HON_HTTP_502_BAD_GATEWAY',
  HTTP_503_SERVICE_UNAVAILABLE: 'HON_HTTP_503_SERVICE_UNAVAILABLE',

  // Database Errors (DB)
  DB_500_CONNECTION_FAILED: 'HON_DB_500_CONNECTION_FAILED',
  DB_501_QUERY_FAILED: 'HON_DB_501_QUERY_FAILED',
  DB_502_CONSTRAINT_VIOLATION: 'HON_DB_502_CONSTRAINT_VIOLATION',
  DB_503_TRANSACTION_FAILED: 'HON_DB_503_TRANSACTION_FAILED',

  // Routing Errors (RTE)
  RTE_600_BINDING_NOT_FOUND: 'HON_RTE_600_BINDING_NOT_FOUND',
  RTE_601_TABLE_NOT_FOUND: 'HON_RTE_601_TABLE_NOT_FOUND',
  RTE_602_PARAM_VALIDATION: 'HON_RTE_602_PARAM_VALIDATION',
  RTE_603_RELATION_NOT_FOUND: 'HON_RTE_603_RELATION_NOT_FOUND',
  RTE_604_BOUND_ROW_INVALID: 'HON_RTE_604_BOUND_ROW_INVALID',

  // Service Errors (SVC)
  SVC_700_SERVICE_UNAVAILABLE: 'HON_SVC_700_SERVICE_UNAVAILABLE',
  SVC_701_SERVICE_ERROR: 'HON_SVC_701_SERVICE_ERROR',

  // Internal Errors (INT)
  INT_800_UNEXPECTED: 'HON_INT_800_UNEXPECTED',
  INT_801_EFFECT_DEFECT: 'HON_INT_801_EFFECT_DEFECT',
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

/**
 * Fix generators for common scenarios.
 */
const fixGenerators = {
  /**
   * Generate fix for adding database configuration.
   */
  addDatabaseConfig: (): FixSuggestion => ({
    id: 'add-database-config',
    type: 'modify_code',
    confidence: 'high',
    description: 'Add database configuration to setupHonertia',
    automated: true,
    operations: [
      {
        type: 'modify_code',
        position: { after: 'setupHonertia({' },
        content: `
  honertia: {
    database: (c) => drizzle(c.env.DB),`,
      },
    ],
    postActions: [
      {
        type: 'restart_server',
        description: 'Restart the dev server for changes to take effect',
      },
    ],
  }),

  /**
   * Generate fix for adding auth configuration.
   */
  addAuthConfig: (): FixSuggestion => ({
    id: 'add-auth-config',
    type: 'modify_code',
    confidence: 'high',
    description: 'Add auth configuration to setupHonertia',
    automated: true,
    operations: [
      {
        type: 'modify_code',
        position: { after: 'setupHonertia({' },
        content: `
  auth: {
    client: (c) => betterAuth({ database: c.var.db }),
  },`,
      },
    ],
    postActions: [
      {
        type: 'restart_server',
        description: 'Restart the dev server for changes to take effect',
      },
    ],
  }),

  /**
   * Generate fix for adding schema configuration.
   */
  addSchemaConfig: (): FixSuggestion => ({
    id: 'add-schema-config',
    type: 'modify_code',
    confidence: 'high',
    description: 'Add schema configuration for route model binding',
    automated: true,
    operations: [
      {
        type: 'add_code',
        position: { line: 1 },
        content: "import * as schema from './db/schema'",
      },
      {
        type: 'modify_code',
        position: { after: 'honertia: {' },
        content: '\n      schema,',
      },
    ],
    postActions: [
      {
        type: 'restart_server',
        description: 'Restart the dev server for changes to take effect',
      },
    ],
  }),

  /**
   * Generate fix for making a field optional.
   */
  makeFieldOptional: (
    ctx: ErrorContext,
    params: Record<string, unknown>
  ): FixSuggestion => ({
    id: 'make-field-optional',
    type: 'modify_code',
    confidence: 'medium',
    description: `Make the "${params.field}" field optional in your schema`,
    automated: false,
    operations: [
      {
        type: 'modify_code',
        file: ctx.handler?.file,
        content: `S.optional(S.String), // Make ${params.field} optional`,
      },
    ],
  }),

  /**
   * Generate fix for providing a required field.
   */
  provideRequiredField: (
    ctx: ErrorContext,
    params: Record<string, unknown>
  ): FixSuggestion => {
    const routeInfo = ctx.route
      ? ` for ${ctx.route.method} ${ctx.route.path}`
      : ''
    return {
      id: 'provide-field-value',
      type: 'modify_code',
      confidence: 'high',
      description: `Provide a value for the "${params.field}" field in your request${routeInfo}`,
      automated: false,
      operations: [],
    }
  },

  /**
   * Generate fix for adding RequireAuthLayer.
   */
  addAuthMiddleware: (): FixSuggestion => ({
    id: 'add-auth-middleware',
    type: 'modify_code',
    confidence: 'high',
    description: 'Add RequireAuthLayer to protect this route',
    automated: true,
    operations: [
      {
        type: 'modify_code',
        content: `.provide(RequireAuthLayer)`,
      },
    ],
  }),

  /**
   * Generate fix for redirecting to login.
   */
  redirectToLogin: (): FixSuggestion => ({
    id: 'redirect-to-login',
    type: 'modify_code',
    confidence: 'high',
    description: 'User needs to authenticate - redirect to login page',
    automated: false,
    operations: [],
  }),
}

/**
 * The error catalog with all error definitions.
 */
export const ErrorCatalog: Record<ErrorCode, ErrorDefinition> = {
  // Validation Errors
  [ErrorCodes.VAL_001_FIELD_REQUIRED]: {
    code: ErrorCodes.VAL_001_FIELD_REQUIRED,
    tag: 'ValidationError',
    category: 'validation',
    title: 'Required Field Missing',
    messageTemplate: 'The field "{field}" is required but was not provided.',
    httpStatus: 422,
    defaultFixes: [fixGenerators.provideRequiredField, fixGenerators.makeFieldOptional],
    docsPath: '/errors/validation/field-required',
    related: [ErrorCodes.VAL_002_FIELD_INVALID, ErrorCodes.VAL_004_SCHEMA_MISMATCH],
  },

  [ErrorCodes.VAL_002_FIELD_INVALID]: {
    code: ErrorCodes.VAL_002_FIELD_INVALID,
    tag: 'ValidationError',
    category: 'validation',
    title: 'Invalid Field Value',
    messageTemplate: 'The field "{field}" has an invalid value: {reason}',
    httpStatus: 422,
    defaultFixes: [],
    docsPath: '/errors/validation/field-invalid',
    related: [ErrorCodes.VAL_001_FIELD_REQUIRED, ErrorCodes.VAL_005_TYPE_COERCION_FAILED],
  },

  [ErrorCodes.VAL_003_BODY_PARSE_FAILED]: {
    code: ErrorCodes.VAL_003_BODY_PARSE_FAILED,
    tag: 'ValidationError',
    category: 'validation',
    title: 'Request Body Parse Failed',
    messageTemplate: 'Could not parse request body: {reason}',
    httpStatus: 400,
    defaultFixes: [],
    docsPath: '/errors/validation/body-parse-failed',
    related: [ErrorCodes.HTTP_400_BAD_REQUEST],
  },

  [ErrorCodes.VAL_004_SCHEMA_MISMATCH]: {
    code: ErrorCodes.VAL_004_SCHEMA_MISMATCH,
    tag: 'ValidationError',
    category: 'validation',
    title: 'Schema Validation Failed',
    messageTemplate: 'Request data does not match the expected schema.',
    httpStatus: 422,
    defaultFixes: [],
    docsPath: '/errors/validation/schema-mismatch',
    related: [
      ErrorCodes.VAL_001_FIELD_REQUIRED,
      ErrorCodes.VAL_002_FIELD_INVALID,
      ErrorCodes.VAL_006_SOURCE_CONFLICT,
    ],
  },

  [ErrorCodes.VAL_005_TYPE_COERCION_FAILED]: {
    code: ErrorCodes.VAL_005_TYPE_COERCION_FAILED,
    tag: 'ValidationError',
    category: 'validation',
    title: 'Type Coercion Failed',
    messageTemplate: 'Could not convert "{field}" to {expectedType}.',
    httpStatus: 422,
    defaultFixes: [],
    docsPath: '/errors/validation/type-coercion-failed',
    related: [ErrorCodes.VAL_002_FIELD_INVALID],
  },

  [ErrorCodes.VAL_006_SOURCE_CONFLICT]: {
    code: ErrorCodes.VAL_006_SOURCE_CONFLICT,
    tag: 'ValidationError',
    category: 'validation',
    title: 'Request Source Conflict',
    messageTemplate: 'Conflicting values were provided for "{field}" across request sources.',
    httpStatus: 422,
    defaultFixes: [],
    docsPath: '/errors/validation/source-conflict',
    related: [ErrorCodes.VAL_004_SCHEMA_MISMATCH],
  },

  // Auth Errors
  [ErrorCodes.AUTH_100_UNAUTHENTICATED]: {
    code: ErrorCodes.AUTH_100_UNAUTHENTICATED,
    tag: 'UnauthorizedError',
    category: 'auth',
    title: 'Authentication Required',
    messageTemplate: 'You must be logged in to access this resource.',
    httpStatus: 401,
    defaultFixes: [fixGenerators.redirectToLogin],
    docsPath: '/errors/auth/unauthenticated',
    related: [ErrorCodes.AUTH_101_SESSION_EXPIRED, ErrorCodes.AUTH_102_FORBIDDEN],
  },

  [ErrorCodes.AUTH_101_SESSION_EXPIRED]: {
    code: ErrorCodes.AUTH_101_SESSION_EXPIRED,
    tag: 'UnauthorizedError',
    category: 'auth',
    title: 'Session Expired',
    messageTemplate: 'Your session has expired. Please log in again.',
    httpStatus: 401,
    defaultFixes: [fixGenerators.redirectToLogin],
    docsPath: '/errors/auth/session-expired',
    related: [ErrorCodes.AUTH_100_UNAUTHENTICATED],
  },

  [ErrorCodes.AUTH_102_FORBIDDEN]: {
    code: ErrorCodes.AUTH_102_FORBIDDEN,
    tag: 'ForbiddenError',
    category: 'auth',
    title: 'Access Forbidden',
    messageTemplate: 'You do not have permission to access this resource.',
    httpStatus: 403,
    defaultFixes: [],
    docsPath: '/errors/auth/forbidden',
    related: [ErrorCodes.AUTH_100_UNAUTHENTICATED],
  },

  [ErrorCodes.AUTH_103_INVALID_CREDENTIALS]: {
    code: ErrorCodes.AUTH_103_INVALID_CREDENTIALS,
    tag: 'UnauthorizedError',
    category: 'auth',
    title: 'Invalid Credentials',
    messageTemplate: 'The provided credentials are invalid.',
    httpStatus: 401,
    defaultFixes: [],
    docsPath: '/errors/auth/invalid-credentials',
    related: [ErrorCodes.AUTH_100_UNAUTHENTICATED],
  },

  [ErrorCodes.AUTH_104_RATE_LIMITED]: {
    code: ErrorCodes.AUTH_104_RATE_LIMITED,
    tag: 'AuthRateLimitError',
    category: 'auth',
    title: 'Authentication Rate Limited',
    messageTemplate: 'Too many authentication attempts. Please try again later.',
    httpStatus: 429,
    defaultFixes: [],
    docsPath: '/errors/auth/rate-limited',
    related: [ErrorCodes.AUTH_103_INVALID_CREDENTIALS],
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
    docsPath: '/errors/resource/not-found',
    related: [ErrorCodes.RES_202_GONE],
  },

  [ErrorCodes.RES_201_ALREADY_EXISTS]: {
    code: ErrorCodes.RES_201_ALREADY_EXISTS,
    tag: 'HttpError',
    category: 'resource',
    title: 'Resource Already Exists',
    messageTemplate: 'A {resource} with this identifier already exists.',
    httpStatus: 409,
    defaultFixes: [],
    docsPath: '/errors/resource/already-exists',
    related: [ErrorCodes.DB_502_CONSTRAINT_VIOLATION],
  },

  [ErrorCodes.RES_202_GONE]: {
    code: ErrorCodes.RES_202_GONE,
    tag: 'HttpError',
    category: 'resource',
    title: 'Resource Gone',
    messageTemplate: 'The {resource} has been permanently deleted.',
    httpStatus: 410,
    defaultFixes: [],
    docsPath: '/errors/resource/gone',
    related: [ErrorCodes.RES_200_NOT_FOUND],
  },

  // Configuration Errors
  [ErrorCodes.CFG_300_DATABASE_NOT_CONFIGURED]: {
    code: ErrorCodes.CFG_300_DATABASE_NOT_CONFIGURED,
    tag: 'HonertiaConfigurationError',
    category: 'configuration',
    title: 'Database Not Configured',
    messageTemplate:
      'DatabaseService is not configured. You attempted to use the database in {location}.',
    httpStatus: 500,
    defaultFixes: [() => fixGenerators.addDatabaseConfig()],
    docsPath: '/errors/configuration/database-not-configured',
    related: [ErrorCodes.CFG_301_AUTH_NOT_CONFIGURED, ErrorCodes.CFG_302_SCHEMA_NOT_CONFIGURED],
  },

  [ErrorCodes.CFG_301_AUTH_NOT_CONFIGURED]: {
    code: ErrorCodes.CFG_301_AUTH_NOT_CONFIGURED,
    tag: 'HonertiaConfigurationError',
    category: 'configuration',
    title: 'Auth Not Configured',
    messageTemplate:
      'AuthService is not configured. You attempted to use auth in {location}.',
    httpStatus: 500,
    defaultFixes: [() => fixGenerators.addAuthConfig()],
    docsPath: '/errors/configuration/auth-not-configured',
    related: [ErrorCodes.CFG_300_DATABASE_NOT_CONFIGURED],
  },

  [ErrorCodes.CFG_302_SCHEMA_NOT_CONFIGURED]: {
    code: ErrorCodes.CFG_302_SCHEMA_NOT_CONFIGURED,
    tag: 'HonertiaConfigurationError',
    category: 'configuration',
    title: 'Schema Not Configured',
    messageTemplate:
      'Schema is not configured for route model binding. Cannot resolve binding "{binding}".',
    httpStatus: 500,
    defaultFixes: [() => fixGenerators.addSchemaConfig()],
    docsPath: '/errors/configuration/schema-not-configured',
    related: [ErrorCodes.RTE_601_TABLE_NOT_FOUND],
  },

  [ErrorCodes.CFG_303_HONERTIA_NOT_CONFIGURED]: {
    code: ErrorCodes.CFG_303_HONERTIA_NOT_CONFIGURED,
    tag: 'HonertiaConfigurationError',
    category: 'configuration',
    title: 'Honertia Not Configured',
    messageTemplate: 'Honertia middleware is not configured. Cannot render Inertia responses.',
    httpStatus: 500,
    defaultFixes: [],
    docsPath: '/errors/configuration/honertia-not-configured',
    related: [ErrorCodes.CFG_300_DATABASE_NOT_CONFIGURED],
  },

  [ErrorCodes.CFG_304_BINDINGS_NOT_CONFIGURED]: {
    code: ErrorCodes.CFG_304_BINDINGS_NOT_CONFIGURED,
    tag: 'HonertiaConfigurationError',
    category: 'configuration',
    title: 'Worker Bindings Not Available',
    messageTemplate: 'Cloudflare Worker bindings are not available in this context.',
    httpStatus: 500,
    defaultFixes: [],
    docsPath: '/errors/configuration/bindings-not-configured',
    related: [ErrorCodes.CFG_300_DATABASE_NOT_CONFIGURED],
  },

  [ErrorCodes.CFG_305_INVALID_CONFIG]: {
    code: ErrorCodes.CFG_305_INVALID_CONFIG,
    tag: 'HonertiaConfigurationError',
    category: 'configuration',
    title: 'Invalid Configuration',
    messageTemplate: 'Invalid configuration: {reason}',
    httpStatus: 500,
    defaultFixes: [],
    docsPath: '/errors/configuration/invalid-config',
    related: [],
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
    docsPath: '/errors/http/bad-request',
    related: [ErrorCodes.VAL_003_BODY_PARSE_FAILED],
  },

  [ErrorCodes.HTTP_429_RATE_LIMITED]: {
    code: ErrorCodes.HTTP_429_RATE_LIMITED,
    tag: 'HttpError',
    category: 'http',
    title: 'Rate Limited',
    messageTemplate: 'Too many requests. Please try again in {retryAfter} seconds.',
    httpStatus: 429,
    defaultFixes: [],
    docsPath: '/errors/http/rate-limited',
    related: [],
  },

  [ErrorCodes.HTTP_500_INTERNAL_ERROR]: {
    code: ErrorCodes.HTTP_500_INTERNAL_ERROR,
    tag: 'HttpError',
    category: 'http',
    title: 'Internal Server Error',
    messageTemplate: 'An unexpected error occurred.',
    httpStatus: 500,
    defaultFixes: [],
    docsPath: '/errors/http/internal-error',
    related: [ErrorCodes.INT_800_UNEXPECTED],
  },

  [ErrorCodes.HTTP_502_BAD_GATEWAY]: {
    code: ErrorCodes.HTTP_502_BAD_GATEWAY,
    tag: 'HttpError',
    category: 'http',
    title: 'Bad Gateway',
    messageTemplate: 'The upstream server returned an invalid response.',
    httpStatus: 502,
    defaultFixes: [],
    docsPath: '/errors/http/bad-gateway',
    related: [ErrorCodes.HTTP_503_SERVICE_UNAVAILABLE],
  },

  [ErrorCodes.HTTP_503_SERVICE_UNAVAILABLE]: {
    code: ErrorCodes.HTTP_503_SERVICE_UNAVAILABLE,
    tag: 'HttpError',
    category: 'http',
    title: 'Service Unavailable',
    messageTemplate: 'The service is temporarily unavailable. Please try again later.',
    httpStatus: 503,
    defaultFixes: [],
    docsPath: '/errors/http/service-unavailable',
    related: [ErrorCodes.HTTP_502_BAD_GATEWAY],
  },

  // Database Errors
  [ErrorCodes.DB_500_CONNECTION_FAILED]: {
    code: ErrorCodes.DB_500_CONNECTION_FAILED,
    tag: 'HttpError',
    category: 'database',
    title: 'Database Connection Failed',
    messageTemplate: 'Could not connect to the database: {reason}',
    httpStatus: 500,
    defaultFixes: [],
    docsPath: '/errors/database/connection-failed',
    related: [ErrorCodes.CFG_300_DATABASE_NOT_CONFIGURED],
  },

  [ErrorCodes.DB_501_QUERY_FAILED]: {
    code: ErrorCodes.DB_501_QUERY_FAILED,
    tag: 'DatabaseMutationFailed',
    category: 'database',
    title: 'Database Query Failed',
    messageTemplate: 'Database query failed: {reason}',
    httpStatus: 500,
    defaultFixes: [],
    docsPath: '/errors/database/query-failed',
    related: [ErrorCodes.DB_502_CONSTRAINT_VIOLATION],
  },

  [ErrorCodes.DB_502_CONSTRAINT_VIOLATION]: {
    code: ErrorCodes.DB_502_CONSTRAINT_VIOLATION,
    tag: 'DatabaseConstraintViolation',
    category: 'database',
    title: 'Constraint Violation',
    messageTemplate: 'Database constraint violation: {constraint}',
    httpStatus: 409,
    defaultFixes: [],
    docsPath: '/errors/database/constraint-violation',
    related: [ErrorCodes.RES_201_ALREADY_EXISTS],
  },

  [ErrorCodes.DB_503_TRANSACTION_FAILED]: {
    code: ErrorCodes.DB_503_TRANSACTION_FAILED,
    tag: 'DatabaseTransactionFailed',
    category: 'database',
    title: 'Transaction Failed',
    messageTemplate: 'Database transaction failed and was rolled back: {reason}',
    httpStatus: 500,
    defaultFixes: [],
    docsPath: '/errors/database/transaction-failed',
    related: [ErrorCodes.DB_501_QUERY_FAILED],
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
    docsPath: '/errors/routing/binding-not-found',
    related: [ErrorCodes.RTE_601_TABLE_NOT_FOUND],
  },

  [ErrorCodes.RTE_601_TABLE_NOT_FOUND]: {
    code: ErrorCodes.RTE_601_TABLE_NOT_FOUND,
    tag: 'RouteConfigurationError',
    category: 'routing',
    title: 'Schema Table Not Found',
    messageTemplate:
      'No table "{table}" found in schema for route model binding.',
    httpStatus: 500,
    defaultFixes: [() => fixGenerators.addSchemaConfig()],
    docsPath: '/errors/routing/table-not-found',
    related: [ErrorCodes.CFG_302_SCHEMA_NOT_CONFIGURED],
  },

  [ErrorCodes.RTE_602_PARAM_VALIDATION]: {
    code: ErrorCodes.RTE_602_PARAM_VALIDATION,
    tag: 'NotFoundError',
    category: 'routing',
    title: 'Invalid Route Parameter',
    messageTemplate: 'Route parameter "{param}" has invalid value: {value}',
    httpStatus: 404,
    defaultFixes: [],
    docsPath: '/errors/routing/param-validation',
    related: [ErrorCodes.RES_200_NOT_FOUND],
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
    docsPath: '/errors/routing/relation-not-found',
    related: [ErrorCodes.RTE_601_TABLE_NOT_FOUND],
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
    docsPath: '/errors/routing/bound-row-invalid',
    related: [ErrorCodes.RTE_600_BINDING_NOT_FOUND],
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
    docsPath: '/errors/service/unavailable',
    related: [ErrorCodes.CFG_300_DATABASE_NOT_CONFIGURED],
  },

  [ErrorCodes.SVC_701_SERVICE_ERROR]: {
    code: ErrorCodes.SVC_701_SERVICE_ERROR,
    tag: 'InvalidAuthSession',
    category: 'service',
    title: 'Service Error',
    messageTemplate: 'The "{service}" service encountered an error: {reason}',
    httpStatus: 500,
    defaultFixes: [],
    docsPath: '/errors/service/error',
    related: [ErrorCodes.INT_800_UNEXPECTED],
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
    docsPath: '/errors/internal/unexpected',
    related: [],
  },

  [ErrorCodes.INT_801_EFFECT_DEFECT]: {
    code: ErrorCodes.INT_801_EFFECT_DEFECT,
    tag: 'HttpError',
    category: 'internal',
    title: 'Effect Defect',
    messageTemplate: 'An unhandled Effect defect occurred: {reason}',
    httpStatus: 500,
    defaultFixes: [],
    docsPath: '/errors/internal/effect-defect',
    related: [ErrorCodes.INT_800_UNEXPECTED],
  },
}

/**
 * Base URL for error documentation.
 */
const DOCS_BASE_URL = 'https://honertia.dev'

/**
 * Create a structured error from an error code and parameters.
 *
 * @param code - The error code (from ErrorCodes) or any string. Unknown codes fallback to INT_800_UNEXPECTED.
 * @param params - Parameters to interpolate into the message template.
 * @param context - The error context (route, request, handler info).
 * @returns A fully structured error with fix suggestions.
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
  code: ErrorCode | string,
  params: Record<string, unknown>,
  context: ErrorContext
): HonertiaStructuredError {
  // Check if code is a valid ErrorCode
  const isValidCode = Object.values(ErrorCodes).includes(code as ErrorCode)
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
    message = message.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value))
  }

  // Generate fixes
  const fixes = definition.defaultFixes
    .map((gen: FixGenerator) => gen(context, params))
    .filter((f: FixSuggestion | null): f is FixSuggestion => f !== null)

  return {
    code: definition.code,
    tag: definition.tag,
    category: definition.category,
    title: definition.title,
    message,
    httpStatus: definition.httpStatus,
    context,
    fixes,
    docs: {
      url: `${DOCS_BASE_URL}${definition.docsPath}`,
      related: definition.related,
    },
    timestamp: new Date().toISOString(),
  }
}

/**
 * Get an error definition by code.
 */
export function getErrorDefinition(code: ErrorCode): ErrorDefinition | undefined {
  return ErrorCatalog[code]
}

/**
 * Get all error codes for a category.
 */
export function getErrorsByCategory(category: ErrorCategory): ErrorCode[] {
  return (Object.values(ErrorCodes) as ErrorCode[]).filter(
    (code) => ErrorCatalog[code]?.category === category
  )
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
