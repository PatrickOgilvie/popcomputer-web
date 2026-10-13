/**
 * `@popcomputer/web`: application composition and Hono-level APIs.
 *
 * Actions and routes import from `@popcomputer/web/effect`, validators from
 * `@popcomputer/web/schema`, the Better Auth integration from
 * `@popcomputer/web/auth`, the KV cache from `@popcomputer/web/cache` and test
 * seams from `@popcomputer/web/testing`.
 */

// =============================================================================
// Core (Setup, Middleware, Types, Helpers)
// =============================================================================

// Setup (recommended one-liner for most apps)
export {
  setupWeb,
  registerErrorHandlers,
  type WebSetupConfig,
  type WebApplication,
  type ErrorHandlerConfig,
  type AuthBackgroundTasks,
} from './setup.js'

// Core middleware (for manual setup)
export { web, HEADERS } from './middleware.js'

// Request context: typed framework state for plain Hono middleware,
// and service wiring for apps composing middleware manually.
export {
  webContext,
  webServices,
  type WebRequestContext,
  type WebProvidedServices,
} from './request-context.js'

// Security middleware (opt-in CSRF defense-in-depth)
export { verifyOrigin, type VerifyOriginConfig } from './security.js'

// Default edge page cache
export {
  pageCache,
  markPageDynamic,
  PAGE_CACHE_HEADER,
  VERSION_METADATA_BINDING,
  type PageCacheOptions,
  type PageCacheStore,
} from './page-cache.js'

export type {
  PageObject,
  WebConfig,
  WebInstance,
  RenderOptions,
} from './types.js'

// Helpers
export {
  createTemplate,
  createVersion,
  vite,
  type PageProps,
  type ViteDevServer,
} from './helpers.js'
