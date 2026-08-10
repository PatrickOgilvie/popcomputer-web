/**
 * Honertia - Inertia.js-style adapter for Hono with Effect.js
 *
 * This is the main entry point for core functionality.
 * For Effect integration, import from 'honertia/effect'.
 * For schema validators, import from 'honertia/schema'.
 * For auth helpers, import from 'honertia/auth'.
 */

// =============================================================================
// Core (Setup, Middleware, Types, Helpers)
// =============================================================================

// Setup (recommended one-liner for most apps)
export {
  setupHonertia,
  createErrorHandlers,
  registerErrorHandlers,
  type HonertiaSetupConfig,
  type HonertiaFullConfig,
  type ErrorHandlerConfig,
  type HonertiaApplication,
} from './setup.js'

// Core middleware (for manual setup)
export { honertia, HEADERS } from './middleware.js'

// Request context: typed framework state for plain Hono middleware,
// and service wiring for apps composing middleware manually.
export {
  honertiaContext,
  honertiaServices,
  type HonertiaRequestContext,
  type HonertiaProvidedServices,
} from './request-context.js'

// Security middleware (opt-in CSRF defense-in-depth)
export { verifyOrigin, type VerifyOriginConfig } from './security.js'

export type {
  PageObject,
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

// Effect Integration - prefer: import { ... } from 'honertia/effect'
export * from './effect/index.js'

// Schema Validators - prefer: import { ... } from 'honertia/schema'
// (already included via effect/index.js)

// Auth - prefer: import { ... } from 'honertia/auth'
// (already included via effect/index.js)
