/** Authentication and authorization exports for @popcomputer/web. */

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
  effectifyBetterAuth,
  loadUser,
  type AuthRoutesConfig,
  type AuthActionEffect,
  type BetterAuthFormActionConfig,
  type BetterAuthLogoutConfig,
  type BetterAuthActionResult,
  type BetterAuthActionError,
  type BetterAuthBoundaryFailure,
  type BetterAuthEffectApi,
  type BetterAuthEffectClient,
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
  AuthRedirect,
} from './effect/errors.js'
