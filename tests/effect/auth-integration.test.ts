/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Auth Integration Type Tests
 *
 * These tests verify that the factory functions (betterAuthFormAction, betterAuthLogoutAction)
 * return types that are compatible with effectAuthRoutes config.
 *
 * If these tests fail to compile, it indicates a type mismatch between
 * the factory return types and the config interface expectations.
 */

import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { Schema as S } from 'effect'
import {
  effectAuthRoutes,
  betterAuthFormAction,
  betterAuthLogoutAction,
  type AuthRoutesConfig,
  type AuthActionEffect,
} from '../../src/effect/auth.js'

/**
 * Type-level tests: These just need to compile successfully.
 * The actual runtime behavior is tested in auth.test.ts
 */
describe('Auth Integration Types', () => {
  // Test schemas
  const LoginSchema = S.Struct({
    email: S.String,
    password: S.String,
  })

  const RegisterSchema = S.Struct({
    email: S.String,
    password: S.String,
    name: S.String,
  })

  // Mock auth client type
  type MockAuthClient = {
    api: {
      signInEmail: (opts: { readonly body?: unknown; readonly request?: Request; readonly returnHeaders?: boolean }) => Promise<{ headers: Headers }>
      signUpEmail: (opts: { readonly body?: unknown; readonly request?: Request; readonly returnHeaders?: boolean }) => Promise<{ headers: Headers }>
      signOut: (opts: { readonly body?: unknown; readonly request?: Request; readonly returnHeaders?: boolean }) => Promise<{ headers: Headers }>
    }
  }

  describe('betterAuthFormAction return type compatibility', () => {
    test('loginAction accepts betterAuthFormAction result', () => {
      // Create action using the factory
      const loginAction = betterAuthFormAction<
        S.Schema.Type<typeof LoginSchema>,
        S.Schema.Encoded<typeof LoginSchema>,
        MockAuthClient
      >({
        schema: LoginSchema,
        errorComponent: 'Auth/Login',
        call: async (_auth, _input) => {
          return { headers: new Headers() }
        },
      })

      // This should compile without error - the factory result should be assignable to the config
      const config: AuthRoutesConfig = {
        loginAction: loginAction,
      }

      expect(config.loginAction).toBeDefined()
    })

    test('registerAction accepts betterAuthFormAction result', () => {
      const registerAction = betterAuthFormAction<
        S.Schema.Type<typeof RegisterSchema>,
        S.Schema.Encoded<typeof RegisterSchema>,
        MockAuthClient
      >({
        schema: RegisterSchema,
        errorComponent: 'Auth/Register',
        call: async (_auth, _input) => {
          return { headers: new Headers() }
        },
      })

      const config: AuthRoutesConfig = {
        registerAction: registerAction,
      }

      expect(config.registerAction).toBeDefined()
    })
  })

  describe('betterAuthLogoutAction return type compatibility', () => {
    test('logoutAction accepts betterAuthLogoutAction result', () => {
      const logoutAction = betterAuthLogoutAction({
        redirectTo: '/login',
      })

      // This should compile without error
      const config: AuthRoutesConfig = {
        logoutAction: logoutAction,
      }

      expect(config.logoutAction).toBeDefined()
    })
  })

  describe('effectAuthRoutes accepts factory results directly', () => {
    test('all auth actions can be passed to effectAuthRoutes', () => {
      const app = new Hono()

      const loginAction = betterAuthFormAction<
        S.Schema.Type<typeof LoginSchema>,
        S.Schema.Encoded<typeof LoginSchema>,
        MockAuthClient
      >({
        schema: LoginSchema,
        errorComponent: 'Auth/Login',
        call: async (_auth, _input) => ({ headers: new Headers() }),
      })

      const registerAction = betterAuthFormAction<
        S.Schema.Type<typeof RegisterSchema>,
        S.Schema.Encoded<typeof RegisterSchema>,
        MockAuthClient
      >({
        schema: RegisterSchema,
        errorComponent: 'Auth/Register',
        call: async (_auth, _input) => ({ headers: new Headers() }),
      })

      const logoutAction = betterAuthLogoutAction({
        redirectTo: '/login',
      })

      // This is the key test - this exact pattern was failing before the fix
      // No @ts-expect-error should be needed
      effectAuthRoutes(app, {
        loginComponent: 'Auth/Login',
        registerComponent: 'Auth/Register',
        logoutRedirect: '/login',
        loginAction,
        registerAction,
        logoutAction,
      })

      // If we get here, the types are compatible
      expect(true).toBe(true)
    })

    test('guestActions accepts betterAuthFormAction results', () => {
      const app = new Hono()

      const ForgotPasswordSchema = S.Struct({
        email: S.String,
      })

      const forgotPasswordAction = betterAuthFormAction<
        S.Schema.Type<typeof ForgotPasswordSchema>,
        S.Schema.Encoded<typeof ForgotPasswordSchema>,
        MockAuthClient
      >({
        schema: ForgotPasswordSchema,
        errorComponent: 'Auth/ForgotPassword',
        call: async (_auth, _input) => ({ headers: new Headers() }),
      })

      // guestActions should also accept the factory results
      effectAuthRoutes(app, {
        guestActions: {
          '/forgot-password': forgotPasswordAction,
        },
      })

      expect(true).toBe(true)
    })
  })

  describe('AuthActionEffect type assignment', () => {
    test('betterAuthFormAction result is assignable to AuthActionEffect', () => {
      const action = betterAuthFormAction({
        schema: LoginSchema,
        errorComponent: 'Auth/Login',
        call: async () => ({ headers: new Headers() }),
      })

      // Explicit type assignment - should compile
      const typed: AuthActionEffect = action

      expect(typed).toBeDefined()
    })

    test('betterAuthLogoutAction result is assignable to AuthActionEffect', () => {
      const action = betterAuthLogoutAction()

      // Explicit type assignment - should compile
      const typed: AuthActionEffect = action

      expect(typed).toBeDefined()
    })
  })
})
