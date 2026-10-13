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
  loadUser,
  betterAuthSession,
  BetterAuthSessionRecord,
  type LoadUserConfig,
  type BetterAuthRedirectOptions,
  type BetterAuthHandlerOptions,
  type BetterAuthInputField,
  type BetterAuthSessionFields,
  type BetterAuthLogoutConfig,
  type BetterAuthActionError,
} from './effect/auth.js'

// Better Auth's additionalFields, from the user table
export { betterAuthFields, type BetterAuthFields, type BetterAuthFieldOptions } from './effect/auth-fields.js'

// Per-account sign-in limits, configured as setupWeb's auth.signInLimits
export {
  sweepSignInFailures,
  type RateLimiter,
  type SignInCountsTable,
  type SignInFailures,
  type SignInLimitsConfig,
} from './effect/sign-in-limits.js'
