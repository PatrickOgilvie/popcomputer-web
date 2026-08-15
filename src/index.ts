/** Main entry point for @popcomputer/web. */

// =============================================================================
// Core (Setup, Middleware, Types, Helpers)
// =============================================================================

// Setup (recommended one-liner for most apps)
export {
  setupWeb,
  setupHonertia,
  createErrorHandlers,
  registerErrorHandlers,
  type WebSetupConfig,
  type WebFullConfig,
  type WebApplication,
  type HonertiaSetupConfig,
  type HonertiaFullConfig,
  type ErrorHandlerConfig,
  type AuthBackgroundTasks,
  type HonertiaApplication,
} from './setup.js'

// Core middleware (for manual setup)
export { web, honertia, HEADERS } from './middleware.js'

// Request context: typed framework state for plain Hono middleware,
// and service wiring for apps composing middleware manually.
export {
  webContext,
  webServices,
  honertiaContext,
  honertiaServices,
  type WebRequestContext,
  type WebProvidedServices,
  type HonertiaRequestContext,
  type HonertiaProvidedServices,
} from './request-context.js'

// Security middleware (opt-in CSRF defense-in-depth)
export { verifyOrigin, type VerifyOriginConfig } from './security.js'

export type {
  PageObject,
  WebConfig,
  WebInstance,
  HonertiaConfig,
  HonertiaInstance,
  RenderOptions,
} from './types.js'

// Helpers
export {
  createTemplate,
  createVersion,
  serializePage,
  vite,
  type PageProps,
} from './helpers.js'

// =============================================================================
// Re-exports for convenience (deprecated - use subpath imports instead)
// =============================================================================

// Effect Integration - prefer: import { ... } from '@popcomputer/web/effect'
export * from './effect/index.js'

// Schema Validators - prefer: import { ... } from '@popcomputer/web/schema'
// (already included via effect/index.js)

// Auth - prefer: import { ... } from '@popcomputer/web/auth'
// (already included via effect/index.js)
