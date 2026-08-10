/**
 * Honertia Auth
 *
 * Re-exports all authentication and authorization functionality.
 * Import from 'honertia/auth' for auth-related functionality.
 */

export {
  RequireAuthLayer,
  RequireGuestLayer,
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
  type AuthActionEffect,
  type BetterAuthFormActionConfig,
  type BetterAuthLogoutConfig,
  type BetterAuthActionResult,
  type BetterAuthActionError,
} from './effect/auth.js'

// Re-export auth-related services
export {
  AuthService,
  AuthUserService,
  type AuthUser,
} from './effect/services.js'

// Re-export auth-related errors
export {
  UnauthorizedError,
  ForbiddenError,
  AuthRateLimitError,
} from './effect/errors.js'
