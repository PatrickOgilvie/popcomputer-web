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
  type WebDatabaseType,
  type WebAuthType,
  type WebBindingsType,
  type WebAuthUserType,
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
  PAGE_CACHE_TAG,
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
  asTrusted,
  type Validated,
  type Trusted,
  type RequestValidationSource,
  type RequestValidationConflict,
  type RequestValidationOptions,
} from './validation.js'

// Bridge
export { effectBridge, type EffectBridgeConfig } from './bridge.js'

// Action Composables
export {
  action,
  dbMutation,
  dbTransaction,
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
  type RouteBindingScope,
  type RouteBindingOptions,
  type RouteBindingDefinition,
  type RouteBindingConfig,
  type RouteBindingsConfig,
  type WebRouteBindingsType,
} from './binding.js'

// Auth guards
export {
  RequireAuthLayer,
  RequireGuestLayer,
  createGuestLayer,
  currentUser,
} from './auth.js'
