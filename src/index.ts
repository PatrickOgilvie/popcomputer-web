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
} from './setup.js'

// Core middleware (for manual setup)
export { honertia, HEADERS } from './middleware.js'

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
