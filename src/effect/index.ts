/**
 * Effect Module Barrel Export
 *
 * Re-exports all Effect-related functionality.
 */

// Services
export {
  DatabaseService,
  AuthService,
  AuthUserService,
  EmailService,
  HonertiaService,
  RequestService,
  ResponseFactoryService,
  BindingsService,
  CacheService,
  CacheClientError,
  ExecutionContextService,
  authorize,
  type AuthUser,
  type EmailClient,
  type HonertiaRenderer,
  type RequestContext,
  type ResponseFactory,
  type CacheClient,
  type ExecutionContextClient,
  type HonertiaDatabaseType,
  type HonertiaAuthType,
  type HonertiaBindingsType,
  type HonertiaAuthUserType,
  type DefaultAuthUser,
  type DatabaseType,
  type SchemaType,
  type AuthType,
  type BindingsType,
} from './services.js'

// Errors
export {
  ValidationError,
  UnauthorizedError,
  NotFoundError,
  ForbiddenError,
  HttpError,
  RouteConfigurationError,
  HonertiaConfigurationError,
  Redirect,
  isStructuredError,
  toStructuredError,
  type AppError,
  type StructuredErrorCapable,
} from './errors.js'

// Error Types
export type {
  ErrorCategory,
  ErrorContext,
  SourceLocation,
  CodeSnippet,
  RouteContext,
  HandlerContext,
  RequestContext as ErrorRequestContext,
  ServiceContext,
  FixType,
  FixPosition,
  FixOperation,
  PostAction,
  FixSuggestion,
  ErrorDocs,
  HonertiaStructuredError,
  FieldError,
  ValidationErrorData,
  ConfigurationErrorData,
  BindingErrorData,
  ErrorDefinition,
  FixGenerator,
} from './error-types.js'

// Error Observer
export {
  EffectErrorObserverService,
  reportEffectError,
  type EffectErrorEvent,
} from './error-observer.js'

// Error Catalog
export {
  ErrorCodes,
  ErrorCatalog,
  createStructuredError,
  getConfigErrorCode,
  getErrorDefinition,
  getErrorsByCategory,
  type ErrorCode,
} from './error-catalog.js'

// Error Formatters
export {
  JsonErrorFormatter,
  TerminalErrorFormatter,
  InertiaErrorFormatter,
  detectOutputFormat,
  createFormatter,
  type ErrorFormatter,
  type JsonFormatterOptions,
  type TerminalFormatterOptions,
  type InertiaFormatterOptions,
  type OutputFormat,
  type FormatDetectionContext,
} from './error-formatter.js'

// Error Context
export {
  captureErrorContext,
  captureEnhancedContext,
  parseStackTrace,
  findUserFrame,
  createSourceLocation,
  createCodeSnippet,
  withHandlerContext,
  withServiceContext,
  mergeContexts,
  emptyContext,
  type StackFrame,
  type EnhancedErrorContext,
} from './error-context.js'

// Schema Validators
export * from './schema.js'

// Validation Helpers
export {
  getValidationData,
  formatSchemaErrors,
  formatSchemaErrorsWithDetails,
  createBodyParseValidationError,
  validate,
  validateUnknown,
  validateRequest,
  asValidated,
  asTrusted,
  type Validated,
  type Trusted,
  type FormattedSchemaErrors,
  type RequestValidationSource,
  type RequestValidationProfile,
  type RequestValidationConflict,
  type RequestValidationOptions,
  type RequestValidationConfig,
} from './validation.js'

// Validated Request Services
export {
  ValidatedBodyService,
  ValidatedQueryService,
  validatedBody,
  validatedQuery,
} from './validated-services.js'

// Bridge
export {
  effectBridge,
  buildContextLayer,
  getEffectRuntime,
  getEffectSchema,
  type EffectBridgeConfig,
} from './bridge.js'

// Handler
export {
  effectHandler,
  effect,
  handle,
  errorToResponse,
  getStructuredFromThrown,
} from './handler.js'

// Action Composables
export {
  action,
  dbMutation,
  dbTransaction,
  mergeMutationInput,
  type SafeTx,
  type MutationInput,
} from './action.js'

// Response Helpers
export {
  redirect,
  render,
  renderWithErrors,
  json,
  text,
  notFound,
  forbidden,
  httpError,
  prefersJson,
  jsonOrRender,
  share,
} from './responses.js'

// Routing
export {
  EffectRouteBuilder,
  effectRoutes,
  type EffectHandler,
  type BaseServices,
  type EffectRouteOptions,
  type EffectRoutesConfig,
} from './routing.js'

// Route Registry
export {
  RouteRegistry,
  getGlobalRegistry,
  resetGlobalRegistry,
  type HttpMethod,
  type RouteMetadata,
  type RouteMetadataJson,
  type FindRouteOptions,
} from './route-registry.js'

// Testing Utilities
export {
  describeRoute,
  createRouteTester,
  generateTestCases,
  type TestUserType,
  type TestUser,
  type TestRequestOptions,
  type TestExpectation,
  type TestContext,
  type TestCaseOptions,
  type TestFn,
  type TestAppConfig,
} from './testing.js'

// Test Layers
export {
  TestLayer,
  TestCaptureService,
  type TestCaptures,
} from './test-layers.js'

// Route Model Binding
export {
  BoundModels,
  BoundModelNotFound,
  bound,
  pluralize,
  parseBindings,
  toHonoPath,
  type ParsedBinding,
  type BoundModel,
} from './binding.js'

// Cache
export {
  CacheError,
  cache,
  cacheGet,
  cacheSet,
  cacheInvalidate,
  cacheInvalidatePrefix,
  type CacheOptions,
  type CacheGetOptions,
  type CacheInvalidateOptions,
} from '../cache.js'

// Auth
export {
  RequireAuthLayer,
  RequireGuestLayer,
  createGuestLayer,
  isAuthenticated,
  currentUser,
  requireAuth,
  requireGuest,
  shareAuth,
  shareAuthMiddleware,
  effectAuthRoutes,
  betterAuthFormAction,
  betterAuthLogoutAction,
  loadUser,
  type AuthRoutesConfig,
  type BetterAuthFormActionConfig,
  type BetterAuthLogoutConfig,
  type BetterAuthActionResult,
} from './auth.js'
