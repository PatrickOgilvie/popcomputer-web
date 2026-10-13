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
  betterAuthCall,
  betterAuthHandler,
  betterAuthLogoutAction,
  effectifyBetterAuth,
  loadUser,
  betterAuthSession,
  BetterAuthSessionRecord,
  type LoadUserConfig,
  type BetterAuthRedirectOptions,
  type BetterAuthLogoutConfig,
  type BetterAuthActionResult,
  type BetterAuthActionError,
  type BetterAuthBoundaryFailure,
  type BetterAuthEffectApi,
  type BetterAuthEffectClient,
} from './effect/auth.js'

// Better Auth's additionalFields, from the user table
export { betterAuthFields, type BetterAuthFields, type BetterAuthFieldOptions } from './effect/auth-fields.js'
