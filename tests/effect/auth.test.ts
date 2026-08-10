/**
 * Auth Layers and Helpers Tests
 */

import { describe, test, expect } from 'bun:test'
import { APIError } from 'better-auth'
import { Effect, Layer, Exit, Cause, Option } from 'effect'
import {
  RequireAuthLayer,
  RequireGuestLayer,
  isAuthenticated,
  currentUser,
  requireAuth,
  requireGuest,
  shareAuth,
} from '../../src/effect/auth.js'
import {
  AuthUserService,
  HonertiaService,
  type AuthUser,
  type HonertiaRenderer,
} from '../../src/effect/services.js'
import {
  AuthRateLimitError,
  HttpError,
  UnauthorizedError,
  ValidationError,
} from '../../src/effect/errors.js'
import type { BetterAuthActionError } from '../../src/effect/auth.js'

// Mock user data
const createMockUser = (overrides: Partial<AuthUser['user']> = {}): AuthUser => ({
  user: {
    id: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
    emailVerified: true,
    image: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  },
  session: {
    id: 'session-456',
    userId: 'user-123',
    expiresAt: new Date('2024-12-31'),
    token: 'test-token',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  },
})

// Mock HonertiaRenderer
const createMockHonertia = (): HonertiaRenderer & {
  shared: Record<string, unknown>
} => {
  const shared: Record<string, unknown> = {}
  return {
    shared,
    render: async (component, props) =>
      new Response(JSON.stringify({ component, props })),
    share: (key, value) => {
      shared[key] = value
    },
    setErrors: () => {},
  }
}

describe('RequireAuthLayer', () => {
  test('provides AuthUserService when user exists', async () => {
    // RequireAuthLayer reads from an existing AuthUserService and passes it through
    const mockUser = createMockUser()
    const baseLayer = Layer.succeed(AuthUserService, mockUser)

    // Consume AuthUserService after applying RequireAuthLayer on top of base layer
    const program = Effect.gen(function* () {
      return yield* AuthUserService
    })

    // RequireAuthLayer is applied over the base layer
    const result = await Effect.runPromise(
      Effect.provide(program, Layer.provide(RequireAuthLayer, baseLayer))
    )

    expect(result.user.id).toBe('user-123')
    expect(result.session.token).toBe('test-token')
  })

  test('fails with UnauthorizedError when no AuthUserService is available', async () => {
    // RequireAuthLayer checks serviceOption, which returns None when service isn't provided
    const program = Effect.gen(function* () {
      return yield* AuthUserService
    })

    const exit = await Effect.runPromiseExit(
      Effect.provide(program, RequireAuthLayer)
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const error = option.value as UnauthorizedError
        expect(error._tag).toBe('UnauthorizedError')
        expect(error.redirectTo).toBe('/login')
      }
    }
  })
})

describe('RequireGuestLayer', () => {
  test('succeeds when no user is present', async () => {
    // Without AuthUserService provided, guest check should pass
    const program = Effect.gen(function* () {
      return 'guest-allowed'
    }).pipe(Effect.provide(RequireGuestLayer))

    const result = await Effect.runPromise(program)
    expect(result).toBe('guest-allowed')
  })

  test('can be combined with other layers', async () => {
    // RequireGuestLayer is a no-op layer that only checks if user exists
    // When no user, it succeeds silently
    const program = Effect.succeed('guest-access')
    const exit = await Effect.runPromiseExit(Effect.provide(program, RequireGuestLayer))

    expect(Exit.isSuccess(exit)).toBe(true)
  })
})

describe('isAuthenticated', () => {
  test('returns true when user is present', async () => {
    const mockUser = createMockUser()
    const layer = Layer.succeed(AuthUserService, mockUser)

    const result = await Effect.runPromise(
      Effect.provide(isAuthenticated, layer)
    )

    expect(result).toBe(true)
  })

  test('returns false when no user', () => {
    // Without AuthUserService, should return false
    const result = Effect.runSync(isAuthenticated)
    expect(result).toBe(false)
  })
})

describe('currentUser', () => {
  test('returns user when authenticated', async () => {
    const mockUser = createMockUser({ name: 'Jane Doe' })
    const layer = Layer.succeed(AuthUserService, mockUser)

    const result = await Effect.runPromise(
      Effect.provide(currentUser, layer)
    )

    expect(result).not.toBeNull()
    expect(result?.user.name).toBe('Jane Doe')
  })

  test('returns null when not authenticated', () => {
    const result = Effect.runSync(currentUser)
    expect(result).toBeNull()
  })
})

describe('requireAuth', () => {
  test('returns user when authenticated', async () => {
    const mockUser = createMockUser()
    const layer = Layer.succeed(AuthUserService, mockUser)

    const result = await Effect.runPromise(
      Effect.provide(requireAuth(), layer)
    )

    expect(result.user.id).toBe('user-123')
  })

  test('fails with UnauthorizedError when not authenticated', () => {
    const exit = Effect.runSyncExit(requireAuth())

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const error = option.value as UnauthorizedError
        expect(error._tag).toBe('UnauthorizedError')
        expect(error.redirectTo).toBe('/login')
      }
    }
  })

  test('uses custom redirect URL', () => {
    const exit = Effect.runSyncExit(requireAuth('/signin'))

    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const error = option.value as UnauthorizedError
        expect(error.redirectTo).toBe('/signin')
      }
    }
  })
})

describe('requireGuest', () => {
  test('succeeds when not authenticated', () => {
    const result = Effect.runSync(requireGuest())
    expect(result).toBeUndefined()
  })

  test('fails with UnauthorizedError when authenticated', async () => {
    const mockUser = createMockUser()
    const layer = Layer.succeed(AuthUserService, mockUser)

    const exit = await Effect.runPromiseExit(
      Effect.provide(requireGuest(), layer)
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const error = option.value as UnauthorizedError
        expect(error._tag).toBe('UnauthorizedError')
        expect(error.redirectTo).toBe('/')
      }
    }
  })

  test('uses custom redirect URL', async () => {
    const mockUser = createMockUser()
    const layer = Layer.succeed(AuthUserService, mockUser)

    const exit = await Effect.runPromiseExit(
      Effect.provide(requireGuest('/dashboard'), layer)
    )

    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const error = option.value as UnauthorizedError
        expect(error.redirectTo).toBe('/dashboard')
      }
    }
  })
})

describe('shareAuth', () => {
  test('shares authenticated user', async () => {
    const mockUser = createMockUser({ name: 'John Doe' })
    const mockHonertia = createMockHonertia()

    const layer = Layer.mergeAll(
      Layer.succeed(AuthUserService, mockUser),
      Layer.succeed(HonertiaService, mockHonertia)
    )

    await Effect.runPromise(Effect.provide(shareAuth(), layer))

    expect(mockHonertia.shared.auth).toEqual({
      user: {
        id: mockUser.user.id,
        name: mockUser.user.name,
        image: mockUser.user.image,
      },
    })
  })

  test('supports an explicit public user projection', async () => {
    const mockUser = createMockUser({ name: 'John Doe' })
    const mockHonertia = createMockHonertia()
    const layer = Layer.mergeAll(
      Layer.succeed(AuthUserService, mockUser),
      Layer.succeed(HonertiaService, mockHonertia)
    )

    await Effect.runPromise(
      Effect.provide(
        shareAuth({ project: (auth) => ({ displayName: auth.user.name }) }),
        layer
      )
    )

    expect(mockHonertia.shared.auth).toEqual({
      user: { displayName: 'John Doe' },
    })
  })

  test('projects only whitelisted fields when configured', async () => {
    const mockUser = createMockUser({ name: 'John Doe' })
    const mockHonertia = createMockHonertia()

    const layer = Layer.mergeAll(
      Layer.succeed(AuthUserService, mockUser),
      Layer.succeed(HonertiaService, mockHonertia)
    )

    await Effect.runPromise(
      Effect.provide(shareAuth({ fields: ['id', 'name'] }), layer)
    )

    const shared = mockHonertia.shared.auth as { user: Record<string, unknown> }
    expect(Object.keys(shared.user).sort()).toEqual(['id', 'name'])
  })

  test('shares null when not authenticated', async () => {
    const mockHonertia = createMockHonertia()
    const layer = Layer.succeed(HonertiaService, mockHonertia)

    await Effect.runPromise(Effect.provide(shareAuth(), layer))

    expect(mockHonertia.shared.auth).toEqual({
      user: null,
    })
  })
})

describe('betterAuthFormAction', () => {
  // Import the function we're testing
  const { betterAuthFormAction } = require('../../src/effect/auth.js') as typeof import('../../src/effect/auth.js')
  const { AuthService, RequestService } = require('../../src/effect/services.js') as typeof import('../../src/effect/services.js')
  const S = require('effect').Schema

  // Helper to create a mock request context for auth actions
  const createAuthRequest = (options: {
    method?: string
    url?: string
    body?: Record<string, unknown>
    headers?: Record<string, string>
  } = {}) => ({
    method: options.method ?? 'POST',
    url: options.url ?? 'http://localhost/login',
    headers: new Headers({
      'Content-Type': 'application/json',
      ...options.headers,
    }),
    param: () => undefined,
    params: () => ({}),
    query: () => ({}),
    json: async <T>() => options.body as T,
    parseBody: async () => options.body ?? {},
    header: (name: string) =>
      name.toLowerCase() === 'content-type' ? 'application/json' : undefined,
  })

  // Mock auth client
  const createMockAuth = (options: {
    shouldSucceed?: boolean
    error?: { code?: string; message?: string }
    responseHeaders?: Headers
  } = {}) => ({
    api: {
      signInEmail: async () => {
        if (!options.shouldSucceed && options.error) {
          throw options.error
        }
        return {
          headers: options.responseHeaders ?? new Headers({
            'set-cookie': 'better-auth.session_token=abc123; Path=/; HttpOnly',
          }),
        }
      },
      signUpEmail: async () => {
        if (!options.shouldSucceed && options.error) {
          throw options.error
        }
        return {
          headers: options.responseHeaders ?? new Headers({
            'set-cookie': 'better-auth.session_token=xyz789; Path=/; HttpOnly',
          }),
        }
      },
    },
  })

  test('returns 303 redirect on successful authentication', async () => {
    const LoginSchema = S.Struct({
      email: S.String,
      password: S.String,
    })

    const action = betterAuthFormAction({
      schema: LoginSchema,
      errorComponent: 'Auth/Login',
      redirectTo: '/dashboard',
      call: (auth: any, input: any, request: Request) =>
        auth.api.signInEmail({
          body: { email: input.email, password: input.password },
          request,
          returnHeaders: true,
        }),
    })

    const mockAuth = createMockAuth({ shouldSucceed: true })
    const mockRequest = createAuthRequest({
      body: { email: 'test@example.com', password: 'password123' },
    })

    const layer = Layer.mergeAll(
      Layer.succeed(AuthService, mockAuth),
      Layer.succeed(RequestService, mockRequest)
    )

    const exit = await Effect.runPromiseExit(Effect.provide(action, layer))

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const response = exit.value as Response
      expect(response.status).toBe(303)
      expect(response.headers.get('Location')).toBe('/dashboard')
    }
  })

  test('copies Set-Cookie headers from better-auth response', async () => {
    const LoginSchema = S.Struct({
      email: S.String,
      password: S.String,
    })

    const sessionCookie = 'better-auth.session_token=secret123; Path=/; HttpOnly; SameSite=Lax'
    const mockHeaders = new Headers()
    mockHeaders.set('set-cookie', sessionCookie)

    const action = betterAuthFormAction({
      schema: LoginSchema,
      errorComponent: 'Auth/Login',
      redirectTo: '/',
      call: async () => ({ headers: mockHeaders }),
    })

    const mockAuth = createMockAuth({ shouldSucceed: true })
    const mockRequest = createAuthRequest({
      body: { email: 'test@example.com', password: 'password123' },
    })

    const layer = Layer.mergeAll(
      Layer.succeed(AuthService, mockAuth),
      Layer.succeed(RequestService, mockRequest)
    )

    const exit = await Effect.runPromiseExit(Effect.provide(action, layer))

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const response = exit.value as Response
      expect(response.headers.get('set-cookie')).toContain('better-auth.session_token')
    }
  })

  test('fails with ValidationError when schema validation fails', async () => {
    const LoginSchema = S.Struct({
      email: S.String.pipe(S.minLength(1)),
      password: S.String.pipe(S.minLength(8)),
    })

    const action = betterAuthFormAction({
      schema: LoginSchema,
      errorComponent: 'Auth/Login',
      redirectTo: '/',
      call: async () => ({ headers: new Headers() }),
    })

    const mockAuth = createMockAuth({ shouldSucceed: true })
    const mockRequest = createAuthRequest({
      body: { email: '', password: 'short' }, // Invalid: empty email, short password
    })

    const layer = Layer.mergeAll(
      Layer.succeed(AuthService, mockAuth),
      Layer.succeed(RequestService, mockRequest)
    )

    const exit = await Effect.runPromiseExit(Effect.provide(action, layer))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const error = option.value as any
        expect(error._tag).toBe('ValidationError')
        expect(error.component).toBe('Auth/Login')
      }
    }
  })

  test('calls errorMapper when better-auth returns an error', async () => {
    const LoginSchema = S.Struct({
      email: S.String,
      password: S.String,
    })

    const errorMapper = (error: BetterAuthActionError) => {
      switch (error.code) {
        case 'INVALID_EMAIL_OR_PASSWORD':
          return { email: 'Invalid email or password' }
        case 'USER_NOT_FOUND':
          return { email: 'No account found with this email' }
        default:
          return { form: error.message ?? 'Login failed' }
      }
    }

    const action = betterAuthFormAction({
      schema: LoginSchema,
      errorComponent: 'Auth/Login',
      redirectTo: '/',
      errorMapper,
      call: async () => {
        throw new APIError('UNAUTHORIZED', {
          code: 'INVALID_EMAIL_OR_PASSWORD',
          message: 'Invalid credentials',
        })
      },
    })

    const mockAuth = createMockAuth()
    const mockRequest = createAuthRequest({
      body: { email: 'test@example.com', password: 'wrongpassword' },
    })

    const layer = Layer.mergeAll(
      Layer.succeed(AuthService, mockAuth),
      Layer.succeed(RequestService, mockRequest)
    )

    const exit = await Effect.runPromiseExit(Effect.provide(action, layer))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const error = option.value as any
        expect(error._tag).toBe('ValidationError')
        expect(error.errors.email).toBe('Invalid email or password')
        expect(error.component).toBe('Auth/Login')
      }
    }
  })

  test('uses default error mapper when errorMapper not provided', async () => {
    const LoginSchema = S.Struct({
      email: S.String,
      password: S.String,
    })

    const action = betterAuthFormAction({
      schema: LoginSchema,
      errorComponent: 'Auth/Login',
      redirectTo: '/',
      // No errorMapper provided - should use default
      call: async () => {
        throw new APIError('BAD_REQUEST', {
          message: 'Something went wrong',
        })
      },
    })

    const mockAuth = createMockAuth()
    const mockRequest = createAuthRequest({
      body: { email: 'test@example.com', password: 'password123' },
    })

    const layer = Layer.mergeAll(
      Layer.succeed(AuthService, mockAuth),
      Layer.succeed(RequestService, mockRequest)
    )

    const exit = await Effect.runPromiseExit(Effect.provide(action, layer))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        const error = option.value as any
        expect(error._tag).toBe('ValidationError')
        expect(error.errors.form).toBe('Something went wrong')
      }
    }
  })

  test('keeps unknown dependency messages out of form validation', async () => {
    const LoginSchema = S.Struct({
      email: S.String,
      password: S.String,
    })

    let errorMapperCalled = false
    const action = betterAuthFormAction({
      schema: LoginSchema,
      errorComponent: 'Auth/Login',
      errorMapper: () => {
        errorMapperCalled = true
        return { form: 'This should not be rendered' }
      },
      call: async () => {
        throw {
          status: 400,
          code: 'DATABASE_ERROR',
          message: 'postgres://user:secret@database.example/internal',
        }
      },
    })

    const mockAuth = createMockAuth()
    const mockRequest = createAuthRequest({
      body: { email: 'test@example.com', password: 'password123' },
    })
    const layer = Layer.mergeAll(
      Layer.succeed(AuthService, mockAuth),
      Layer.succeed(RequestService, mockRequest)
    )

    const exit = await Effect.runPromiseExit(Effect.provide(action, layer))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause)
      expect(Option.isSome(failure)).toBe(true)
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(HttpError)
        expect(failure.value.status).toBe(502)
        expect(failure.value.message).toBe('Authentication service failed.')
      }
    }
    expect(errorMapperCalled).toBe(false)
  })

  test('does not trust APIError identity claimed only by a nested response', async () => {
    const LoginSchema = S.Struct({
      email: S.String,
      password: S.String,
    })

    let errorMapperCalled = false
    const action = betterAuthFormAction({
      schema: LoginSchema,
      errorComponent: 'Auth/Login',
      errorMapper: () => {
        errorMapperCalled = true
        return { form: 'This should not be rendered' }
      },
      call: async () => {
        const error = new Error('driver diagnostic with internal details')
        Object.assign(error, {
          response: { name: 'APIError', status: 401, message: 'spoofed' },
        })
        throw error
      },
    })

    const mockAuth = createMockAuth()
    const mockRequest = createAuthRequest({
      body: { email: 'test@example.com', password: 'password123' },
    })
    const layer = Layer.mergeAll(
      Layer.succeed(AuthService, mockAuth),
      Layer.succeed(RequestService, mockRequest)
    )

    const exit = await Effect.runPromiseExit(Effect.provide(action, layer))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause)
      expect(Option.isSome(failure)).toBe(true)
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(HttpError)
        expect(failure.value.status).toBe(502)
        expect(failure.value.message).toBe('Authentication service failed.')
      }
    }
    expect(errorMapperCalled).toBe(false)
  })

  test('supports dynamic redirectTo as function', async () => {
    const LoginSchema = S.Struct({
      email: S.String,
      password: S.String,
      returnTo: S.optional(S.String),
    })

    const action = betterAuthFormAction({
      schema: LoginSchema,
      errorComponent: 'Auth/Login',
      redirectTo: (input: { returnTo?: string }) => input.returnTo ?? '/home',
      call: async () => ({ headers: new Headers() }),
    })

    const mockAuth = createMockAuth({ shouldSucceed: true })
    const mockRequest = createAuthRequest({
      body: { email: 'test@example.com', password: 'password123', returnTo: '/settings' },
    })

    const layer = Layer.mergeAll(
      Layer.succeed(AuthService, mockAuth),
      Layer.succeed(RequestService, mockRequest)
    )

    const exit = await Effect.runPromiseExit(Effect.provide(action, layer))

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const response = exit.value as Response
      expect(response.headers.get('Location')).toBe('/settings')
    }
  })

  test('handles better-auth Response object', async () => {
    const LoginSchema = S.Struct({
      email: S.String,
      password: S.String,
    })

    const action = betterAuthFormAction({
      schema: LoginSchema,
      errorComponent: 'Auth/Login',
      redirectTo: '/',
      call: async () => {
        // Some better-auth methods return a full Response
        return new Response(null, {
          headers: { 'set-cookie': 'test-cookie=value; Path=/' },
        })
      },
    })

    const mockAuth = createMockAuth({ shouldSucceed: true })
    const mockRequest = createAuthRequest({
      body: { email: 'test@example.com', password: 'password123' },
    })

    const layer = Layer.mergeAll(
      Layer.succeed(AuthService, mockAuth),
      Layer.succeed(RequestService, mockRequest)
    )

    const exit = await Effect.runPromiseExit(Effect.provide(action, layer))

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const response = exit.value as Response
      expect(response.status).toBe(303)
      expect(response.headers.get('set-cookie')).toContain('test-cookie')
    }
  })

  test('maps a resolved better-auth 401 Response to ValidationError', async () => {
    const LoginSchema = S.Struct({
      email: S.String,
      password: S.String,
    })

    let mappedError: BetterAuthActionError | undefined
    const action = betterAuthFormAction({
      schema: LoginSchema,
      errorComponent: 'Auth/Login',
      redirectTo: '/dashboard',
      errorMapper: (error) => {
        mappedError = error
        return { email: error.code ?? 'MISSING_ERROR_CODE' }
      },
      call: async () =>
        new Response(
          JSON.stringify({
            message: 'Invalid email or password',
            code: 'INVALID_EMAIL_OR_PASSWORD',
          }),
          {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }
        ),
    })

    const mockAuth = createMockAuth()
    const mockRequest = createAuthRequest({
      body: { email: 'test@example.com', password: 'wrong-password' },
    })
    const layer = Layer.mergeAll(
      Layer.succeed(AuthService, mockAuth),
      Layer.succeed(RequestService, mockRequest)
    )

    const exit = await Effect.runPromiseExit(Effect.provide(action, layer))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause)
      expect(Option.isSome(failure)).toBe(true)
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(ValidationError)
        expect(failure.value.errors).toEqual({ email: 'INVALID_EMAIL_OR_PASSWORD' })
        expect(failure.value.component).toBe('Auth/Login')
      }
    }

    expect(mappedError?.status).toBe(401)
    expect(mappedError?.code).toBe('INVALID_EMAIL_OR_PASSWORD')
    expect(mappedError?.message).toBe('Invalid email or password')
  })

  test('keeps resolved better-auth 5xx responses out of the form error mapper', async () => {
    const LoginSchema = S.Struct({
      email: S.String,
      password: S.String,
    })

    let errorMapperCalled = false
    const action = betterAuthFormAction({
      schema: LoginSchema,
      errorComponent: 'Auth/Login',
      errorMapper: () => {
        errorMapperCalled = true
        return { form: 'This should not be rendered' }
      },
      call: async () =>
        new Response(
          JSON.stringify({ message: 'Database connection failed' }),
          {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }
        ),
    })

    const mockAuth = createMockAuth()
    const mockRequest = createAuthRequest({
      body: { email: 'test@example.com', password: 'password123' },
    })
    const layer = Layer.mergeAll(
      Layer.succeed(AuthService, mockAuth),
      Layer.succeed(RequestService, mockRequest)
    )

    const exit = await Effect.runPromiseExit(Effect.provide(action, layer))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause)
      expect(Option.isSome(failure)).toBe(true)
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(HttpError)
        expect(failure.value.status).toBe(503)
        expect(failure.value.message).toBe('Authentication service failed.')
      }
    }
    expect(errorMapperCalled).toBe(false)
  })

  test('models resolved Better Auth rate limits separately from validation', async () => {
    const LoginSchema = S.Struct({
      email: S.String,
      password: S.String,
    })

    let errorMapperCalled = false
    const action = betterAuthFormAction({
      schema: LoginSchema,
      errorComponent: 'Auth/Login',
      errorMapper: () => {
        errorMapperCalled = true
        return { form: 'This should not be rendered' }
      },
      call: async () =>
        new Response(
          JSON.stringify({ message: 'Too many requests. Please try again later.' }),
          {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'X-Retry-After': '37',
            },
          }
        ),
    })

    const mockAuth = createMockAuth()
    const mockRequest = createAuthRequest({
      body: { email: 'test@example.com', password: 'password123' },
    })
    const layer = Layer.mergeAll(
      Layer.succeed(AuthService, mockAuth),
      Layer.succeed(RequestService, mockRequest)
    )

    const exit = await Effect.runPromiseExit(Effect.provide(action, layer))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause)
      expect(Option.isSome(failure)).toBe(true)
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(AuthRateLimitError)
        expect(failure.value.retryAfterSeconds).toBe(37)
      }
    }
    expect(errorMapperCalled).toBe(false)
  })

  test('handles better-auth Headers object', async () => {
    const LoginSchema = S.Struct({
      email: S.String,
      password: S.String,
    })

    const action = betterAuthFormAction({
      schema: LoginSchema,
      errorComponent: 'Auth/Login',
      redirectTo: '/',
      call: async () => {
        // Some better-auth methods return raw Headers
        const headers = new Headers()
        headers.set('set-cookie', 'session=xyz; Path=/')
        return headers
      },
    })

    const mockAuth = createMockAuth({ shouldSucceed: true })
    const mockRequest = createAuthRequest({
      body: { email: 'test@example.com', password: 'password123' },
    })

    const layer = Layer.mergeAll(
      Layer.succeed(AuthService, mockAuth),
      Layer.succeed(RequestService, mockRequest)
    )

    const exit = await Effect.runPromiseExit(Effect.provide(action, layer))

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const response = exit.value as Response
      expect(response.headers.get('set-cookie')).toContain('session=xyz')
    }
  })
})

describe('betterAuthLogoutAction', () => {
  const { betterAuthLogoutAction } = require('../../src/effect/auth.js') as typeof import('../../src/effect/auth.js')
  const { AuthService, RequestService } = require('../../src/effect/services.js') as typeof import('../../src/effect/services.js')

  const createLogoutRequest = () => ({
    method: 'POST',
    url: 'http://localhost/logout',
    headers: new Headers({
      'Content-Type': 'application/json',
      'Cookie': 'better-auth.session_token=abc123',
    }),
    param: () => undefined,
    params: () => ({}),
    query: () => ({}),
    json: async <T>() => ({} as T),
    parseBody: async () => ({}),
    header: (name: string) => {
      if (name.toLowerCase() === 'cookie') return 'better-auth.session_token=abc123'
      return undefined
    },
  })

  const createMockAuthForLogout = (options: { responseHeaders?: Headers } = {}) => ({
    api: {
      signOut: async () => {
        return options.responseHeaders ?? new Headers()
      },
    },
  })

  test('returns 303 redirect to configured path', async () => {
    const action = betterAuthLogoutAction({
      redirectTo: '/login',
    })

    const mockAuth = createMockAuthForLogout()
    const mockRequest = createLogoutRequest()

    const layer = Layer.mergeAll(
      Layer.succeed(AuthService, mockAuth),
      Layer.succeed(RequestService, mockRequest)
    )

    const exit = await Effect.runPromiseExit(Effect.provide(action, layer))

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const response = exit.value as Response
      expect(response.status).toBe(303)
      expect(response.headers.get('Location')).toBe('/login')
    }
  })

  test('defaults to /login redirect when not specified', async () => {
    const action = betterAuthLogoutAction({})

    const mockAuth = createMockAuthForLogout()
    const mockRequest = createLogoutRequest()

    const layer = Layer.mergeAll(
      Layer.succeed(AuthService, mockAuth),
      Layer.succeed(RequestService, mockRequest)
    )

    const exit = await Effect.runPromiseExit(Effect.provide(action, layer))

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const response = exit.value as Response
      expect(response.headers.get('Location')).toBe('/login')
    }
  })

  test('copies Set-Cookie headers from better-auth signOut response', async () => {
    const logoutHeaders = new Headers()
    logoutHeaders.set('set-cookie', 'better-auth.session_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT')

    const action = betterAuthLogoutAction({
      redirectTo: '/login',
    })

    const mockAuth = createMockAuthForLogout({ responseHeaders: logoutHeaders })
    const mockRequest = createLogoutRequest()

    const layer = Layer.mergeAll(
      Layer.succeed(AuthService, mockAuth),
      Layer.succeed(RequestService, mockRequest)
    )

    const exit = await Effect.runPromiseExit(Effect.provide(action, layer))

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const response = exit.value as Response
      expect(response.headers.get('set-cookie')).toContain('Expires=Thu, 01 Jan 1970')
    }
  })

  test('clears default cookies when better-auth returns no Set-Cookie', async () => {
    const action = betterAuthLogoutAction({
      redirectTo: '/login',
    })

    const mockAuth = createMockAuthForLogout({ responseHeaders: new Headers() })
    const mockRequest = createLogoutRequest()

    const layer = Layer.mergeAll(
      Layer.succeed(AuthService, mockAuth),
      Layer.succeed(RequestService, mockRequest)
    )

    const exit = await Effect.runPromiseExit(Effect.provide(action, layer))

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const response = exit.value as Response
      const cookies = response.headers.get('set-cookie') ?? ''
      // Should clear the default better-auth cookies
      expect(cookies).toContain('better-auth.session_token=')
      expect(cookies).toContain('Expires=Thu, 01 Jan 1970')
    }
  })

  test('clears custom cookie names when specified', async () => {
    const action = betterAuthLogoutAction({
      redirectTo: '/login',
      cookieNames: ['my-app-session', 'my-app-refresh'],
    })

    const mockAuth = createMockAuthForLogout({ responseHeaders: new Headers() })
    const mockRequest = createLogoutRequest()

    const layer = Layer.mergeAll(
      Layer.succeed(AuthService, mockAuth),
      Layer.succeed(RequestService, mockRequest)
    )

    const exit = await Effect.runPromiseExit(Effect.provide(action, layer))

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const response = exit.value as Response
      const cookies = response.headers.get('set-cookie') ?? ''
      expect(cookies).toContain('my-app-session=')
      expect(cookies).toContain('my-app-refresh=')
    }
  })

  test('succeeds even when better-auth signOut fails', async () => {
    const action = betterAuthLogoutAction({
      redirectTo: '/login',
    })

    // Auth that throws on signOut
    const failingAuth = {
      api: {
        signOut: async () => {
          throw new Error('Session not found')
        },
      },
    }

    const mockRequest = createLogoutRequest()

    const layer = Layer.mergeAll(
      Layer.succeed(AuthService, failingAuth),
      Layer.succeed(RequestService, mockRequest)
    )

    const exit = await Effect.runPromiseExit(Effect.provide(action, layer))

    // Should still succeed and redirect
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const response = exit.value as Response
      expect(response.status).toBe(303)
      expect(response.headers.get('Location')).toBe('/login')
    }
  })
})

describe('Auth flow patterns', () => {
  test('protected route pattern', async () => {
    const mockUser = createMockUser()

    const protectedHandler = Effect.gen(function* () {
      const user = yield* requireAuth()
      return `Welcome, ${user.user.name}!`
    })

    const layer = Layer.succeed(AuthUserService, mockUser)
    const result = await Effect.runPromise(Effect.provide(protectedHandler, layer))

    expect(result).toBe('Welcome, Test User!')
  })

  test('guest-only route pattern', async () => {
    const guestHandler = Effect.gen(function* () {
      yield* requireGuest()
      return 'Login page'
    })

    const result = Effect.runSync(guestHandler)
    expect(result).toBe('Login page')
  })

  test('conditional auth pattern', async () => {
    const conditionalHandler = Effect.gen(function* () {
      const user = yield* currentUser
      if (user) {
        return `Hello, ${user.user.name}`
      }
      return 'Hello, Guest'
    })

    // Without user
    const guestResult = Effect.runSync(conditionalHandler)
    expect(guestResult).toBe('Hello, Guest')

    // With user
    const mockUser = createMockUser({ name: 'Alice' })
    const layer = Layer.succeed(AuthUserService, mockUser)
    const userResult = await Effect.runPromise(Effect.provide(conditionalHandler, layer))
    expect(userResult).toBe('Hello, Alice')
  })

  test('auth check without failing', async () => {
    const checkHandler = Effect.gen(function* () {
      const authed = yield* isAuthenticated
      return authed ? 'Logged in' : 'Logged out'
    })

    const guestResult = Effect.runSync(checkHandler)
    expect(guestResult).toBe('Logged out')

    const mockUser = createMockUser()
    const layer = Layer.succeed(AuthUserService, mockUser)
    const userResult = await Effect.runPromise(Effect.provide(checkHandler, layer))
    expect(userResult).toBe('Logged in')
  })
})
