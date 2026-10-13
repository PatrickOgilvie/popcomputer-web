/**
 * `@popcomputer/web/auth`: the Better Auth integration.
 *
 * Generic guards (`authorize`, `currentUser`, `RequireAuthLayer`,
 * `RequireGuestLayer`) and the auth services live in `@popcomputer/web/effect`.
 */

export {
  shareAuth,
  shareAuthMiddleware,
  betterAuthRedirect,
  betterAuthHandler,
  betterAuthLogoutAction,
  effectifyBetterAuth,
  loadUser,
  type LoadUserConfig,
  type BetterAuthRedirectOptions,
  type BetterAuthLogoutConfig,
  type BetterAuthActionResult,
  type BetterAuthActionError,
  type BetterAuthBoundaryFailure,
  type BetterAuthEffectApi,
  type BetterAuthEffectClient,
} from './effect/auth.js'
