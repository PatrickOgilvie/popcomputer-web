/**
 * `@popcomputer/web/effect`: everything an action and its routes use.
 *
 * Validators live in `@popcomputer/web/schema`, the Better Auth integration in
 * `@popcomputer/web/auth`, the KV data cache in `@popcomputer/web/cache` and
 * test seams in `@popcomputer/web/testing`.
 */

// Services
export {
  DatabaseService,
  AuthService,
  AuthUserService,
  PageService,
  RequestService,
  RequestStateService,
  BindingsService,
  ExecutionContextService,
  authorize,
  type AuthUser,
  type PageRenderer,
  type RequestContext,
  type RequestStateClient,
  type ExecutionContextClient,
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
  PendingPurges,
  purgeCache,
  PAGE_CACHE_TAG,
  recordCacheTag,
  type TableName,
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
  DatabaseError,
  DatabaseConstraintViolation,
  SessionLookupUnavailable,
  InvalidAuthSession,
  RouteConfigurationError,
  ConfigurationError,
  Redirect,
  type AppError,
} from './errors.js'

export { ErrorCodes, type ErrorCode } from './error-catalog.js'
export type { StructuredError, FieldError } from './error-types.js'

// Error Observer
export {
  EffectErrorObserverService,
  reportEffectError,
  type EffectErrorEvent,
} from './error-observer.js'

// Validation
export {
  createBodyParseValidationError,
  validateUnknown,
  validateRequest,
  type RequestValidationSource,
  type RequestValidationConflict,
  type RequestValidationOptions,
} from './validation.js'

// Bridge
export { effectBridge, type EffectBridgeConfig } from './bridge.js'

// Actions
export { action } from './action.js'

// Database operations
export {
  dbQuery,
  dbMutation,
  dbTransaction,
  dbBatch,
  uniqueFieldErrors,
  type UniqueFieldErrorsOptions,
  type DatabaseWriteError,
  type TransactionClient,
  type BatchArgument,
  type BatchResults,
} from './database.js'

// Runtime-owned background work
export { background } from './background.js'

// Response Helpers
export {
  redirect,
  render,
  flash,
  json,
  text,
  file,
  type ResponseOptions,
  type FileOptions,
  type FileBody,
  notFound,
  invalid,
  back,
  redirectNow,
  forbidden,
  httpError,
  prefersJson,
  jsonOrRender,
  share,
  shareProps,
  PageSharing,
  type SharedPropsInput,
} from './responses.js'

// Pages
export {
  type PageName,
  type PagePropsOf,
  type ClientPageProps,
  type Jsonify,
  type PageSchema,
  type PageSchemas,
} from './pages.js'

// Routing
export {
  EffectRouteBuilder,
  effectRoutes,
  type EffectHandler,
  type BaseServices,
  type CoreServices,
  type RouteAction,
  type RouteActionCheck,
  type PathModels,
  type EffectRouteOptions,
  type EffectRoutesConfig,
} from './routing.js'

// Route Registry
export {
  RouteRegistry,
  getAppRouteRegistry,
  type HttpMethod,
  type RouteMetadata,
  type RouteMetadataJson,
  type FindRouteOptions,
} from './route-registry.js'

// Route Model Binding
export {
  BoundModels,
  bound,
  routeBinding,
  type BoundModel,
  type BoundModelError,
  type BoundKey,
  type RouteBindingScope,
  type RouteBindingOptions,
  type RouteBindingDefinition,
  type RouteBindingTable,
  type RouteBindingConfig,
  type RouteBindingsConfig,
  type RouteModel,
} from './binding.js'

// Auth guards
export {
  RequireAuthLayer,
  RequireGuestLayer,
  createGuestLayer,
  currentUser,
  intendedUrl,
} from './auth.js'

// Config for the Worker's vars and secrets, named as the bindings declare them
export { config, type BindingConfig, type BindingName } from './config.js'

// The JSON body every failure answers a JSON client with
export type { ErrorResponseBody } from './error-formatter.js'
