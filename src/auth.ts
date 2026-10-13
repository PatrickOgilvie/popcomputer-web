/**
 * `@popcomputer/web/auth`: the Better Auth integration.
 *
 * Generic guards (`authorize`, `currentUser`, `RequireAuthLayer`,
 * `RequireGuestLayer`) and the auth services live in `@popcomputer/web/effect`.
 */

export {
  shareAuth,
  shareAuthMiddleware,
  effectAuthRoutes,
  betterAuthFormAction,
  betterAuthLogoutAction,
  effectifyBetterAuth,
  loadUser,
  type AuthRoutesConfig,
  type LoadUserConfig,
  type AuthActionEffect,
  type BetterAuthFormActionConfig,
  type BetterAuthLogoutConfig,
  type BetterAuthActionResult,
  type BetterAuthActionError,
  type BetterAuthBoundaryFailure,
  type BetterAuthEffectApi,
  type BetterAuthEffectClient,
} from './effect/auth.js'
