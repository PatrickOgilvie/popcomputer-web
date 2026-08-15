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
  PageService,
  HonertiaService,
  RequestService,
  RequestStateService,
  ResponseFactoryService,
  BindingsService,
  CacheService,
  CacheClientError,
  ExecutionContextService,
  authorize,
  type AuthUser,
  type EmailClient,
  type PageRenderer,
  type HonertiaRenderer,
  type RequestContext,
  type RequestStateClient,
  type ResponseFactory,
  type CacheClient,
  type ExecutionContextClient,
  type WebDatabaseType,
  type WebAuthType,
  type WebBindingsType,
  type WebAuthUserType,
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

// Workers Cache integration
export {
  ResponseCacheService,
  ResponseCachePurgeError,
  deriveCacheTags,
  type ResponseCacheClient,
  type ResponseCachePurgeInput,
  type RouteCacheOptions,
} from './response-cache.js'

// Errors
export {
  ValidationError,
  UnauthorizedError,
  NotFoundError,
  ForbiddenError,
  AuthRateLimitError,
  AuthRedirect,
  HttpError,
  DatabaseMutationFailed,
  DatabaseTransactionFailed,
  DatabaseConstraintViolation,
  SessionLookupUnavailable,
  InvalidAuthSession,
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
  getEffectBindings,
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
  classifyDatabaseFailure,
  mergeMutationInput,
  type SafeTx,
  type MutationInput,
} from './action.js'

// Runtime-owned background work
export { background } from './background.js'

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
  getAppRouteRegistry,
  findAppRouteRegistry,
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
  routeBinding,
  pluralize,
  parseBindings,
  toHonoPath,
  type ParsedBinding,
  type BoundModel,
  type RouteBindingScope,
  type RouteBindingOptions,
  type RouteBindingDefinition,
  type RouteBindingConfig,
  type RouteBindingsConfig,
  type WebRouteBindingsType,
  type HonertiaRouteBindingsType,
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
  effectifyBetterAuth,
  loadUser,
  type AuthRoutesConfig,
  type BetterAuthFormActionConfig,
  type BetterAuthLogoutConfig,
  type BetterAuthActionResult,
  type BetterAuthActionError,
  type BetterAuthBoundaryFailure,
  type BetterAuthEffectApi,
  type BetterAuthEffectClient,
} from './auth.js'
