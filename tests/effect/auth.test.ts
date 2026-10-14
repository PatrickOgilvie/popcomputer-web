/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Auth Layers and Helpers Tests
 */

import { describe, test, expect } from 'bun:test'
import { Effect, Layer, Redacted, Schema as S } from 'effect'
import type { PageProps } from '../../src/types.js'
import {
  betterAuthRedirect,
  betterAuthLogoutAction,
  RequireAuthLayer,
  RequireGuestLayer,
  currentUser,
  shareAuth,
} from '../../src/effect/auth.js'
import {
  AuthService,
  RequestService,
  AuthUserService,
  PageService,
  type AuthUser,
  type PageRenderer,
  type RequestContext,
} from '../../src/effect/services.js'
import {
  AuthRateLimitError,
  HttpError,
  UnauthorizedError,
  ValidationError,
} from '../../src/effect/errors.js'
import type { BetterAuthActionError } from '../../src/effect/better-auth-boundary.js'
import type { WebDeclaration } from '../../src/effect/register.js'

/** The input Better Auth's email sign-in endpoint receives. */
interface EmailCredentialsInput {
  readonly body: { readonly email: string; readonly password: string }
}

/** What Better Auth's email sign-in endpoint answers, as far as these tests read it. */
interface SignInResult {
  readonly user: { readonly id: string }
}

/** A Better Auth endpoint as `auth.api` has it: a function with its path and method. */
type Endpoint<Input, Result> = ((input: Input) => Promise<Result>) & {
  readonly path: string
  readonly options: { readonly method: string }
}

/**
 * The framework reads an endpoint's path and method and sends the call
 * through Better Auth's handler, so the function itself never runs.
 */
const endpointAt = <Input, Result>(path: string): Endpoint<Input, Result> =>
  Object.assign(
    (_input: Input): Promise<Result> => Promise.reject(new Error(`${path} is called through Better Auth's handler`)),
    { path, options: { method: 'POST' } }
  )

/** The Better Auth endpoints these tests call, and the handler every call is sent through. */
interface TestAuth {
  readonly api: {
    readonly signInEmail: Endpoint<EmailCredentialsInput, SignInResult>
    readonly signOut: Endpoint<unknown, { readonly success: boolean }>
  }
  readonly handler: (request: Request) => Promise<Response>
}

declare module '../../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{
      auth: TestAuth
    }>
  }
}

/** A Better Auth whose request handler answers every call with `answer`. */
const answeringAuth = (answer: (request: Request) => Promise<Response>): TestAuth => ({
  api: {
    signInEmail: endpointAt('/sign-in/email'),
    signOut: endpointAt('/sign-out'),
  },
  handler: answer,
})

/** A form's POST to an action, as the action's RequestService has it. */
const formRequest = (): RequestContext => ({
  method: 'POST',
  url: 'http://localhost/login',
  headers: new Headers(),
  env: {},
  param: () => undefined,
  params: () => ({}),
  query: () => ({}),
  queries: () => ({}),
  json: async () => ({}),
  raw: () => new Request('http://localhost/login', { method: 'POST' }),
  parseBody: async () => ({}),
  header: () => undefined,
})

/** Run `effect` in a form's POST, with a Better Auth whose handler answers every call with `answer`. */
const answeredBy = <A, E>(
  answer: (request: Request) => Promise<Response>,
  effect: Effect.Effect<A, E, AuthService | RequestService>
): Effect.Effect<A, E> =>
  effect.pipe(
    Effect.provideService(AuthService, answeringAuth(answer)),
    Effect.provideService(RequestService, formRequest())
  )

// Mock user data
const createMockUser = (overrides: Partial<AuthUser['user']> = {}): AuthUser => ({
  user: {
    id: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
    emailVerified: true,
    image: null,
    // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture exercises the public Date/Better Auth contract; it does not read the clock.
    createdAt: new Date('2024-01-01'),
    // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture exercises the public Date/Better Auth contract; it does not read the clock.
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  },
  session: {
    id: 'session-456',
    userId: 'user-123',
    // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture exercises the public Date/Better Auth contract; it does not read the clock.
    expiresAt: new Date('2024-12-31'),
    token: Redacted.make('test-token'),
    // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture exercises the public Date/Better Auth contract; it does not read the clock.
    createdAt: new Date('2024-01-01'),
    // oxlint-disable-next-line effecttsgo/global-date -- Fixed native Date fixture exercises the public Date/Better Auth contract; it does not read the clock.
    updatedAt: new Date('2024-01-01'),
  },
})

// Mock PageRenderer
const createMockPage = (): PageRenderer & {
  sharedProps: PageProps
} => {
  const sharedProps: PageProps = {}

  return {
    sharedProps,
    render: async (component, props) =>
      Response.json({ component, props }),
    share: (key, value) => {
      sharedProps[key] = value
    },
    flash: () => {},
  }
}

describe('RequireAuthLayer', () => {
  test('provides AuthUserService when user exists', async () => {
    // RequireAuthLayer reads from an existing AuthUserService and passes it through
    const mockUser = createMockUser()
    const baseLayer = Layer.succeed(AuthUserService, mockUser)

    // Consume AuthUserService after applying RequireAuthLayer on top of base layer
    const program = AuthUserService

    // RequireAuthLayer is applied over the base layer
    const result = await Effect.runPromise(
      Effect.provide(program, Layer.provide(RequireAuthLayer, baseLayer))
    )

    expect(result.user.id).toBe('user-123')
    expect(Redacted.value(result.session.token)).toBe('test-token')
  })

  test('fails with UnauthorizedError when no AuthUserService is available', async () => {
    // RequireAuthLayer checks serviceOption, which returns None when service isn't provided
    const error = await Effect.runPromise(Effect.flip(Effect.provide(AuthUserService, RequireAuthLayer)))

    expect(error).toBeInstanceOf(UnauthorizedError)
    // The boundary sends the visitor to setupWeb's auth.signInPath.
    expect(error.redirectTo).toBeUndefined()
  })
})

describe('RequireGuestLayer', () => {
  test('succeeds when no user is present', async () => {
    // Without AuthUserService provided, guest check should pass
    const program = Effect.succeed('guest-allowed').pipe(
      Effect.provide(RequireGuestLayer)
    )

    const result = await Effect.runPromise(program)
    expect(result).toBe('guest-allowed')
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

describe('shareAuth', () => {
  test('shares authenticated user', async () => {
    const mockUser = createMockUser({ name: 'John Doe' })
    const mockPage = createMockPage()

    const layer = Layer.mergeAll(
      Layer.succeed(AuthUserService, mockUser),
      Layer.succeed(PageService, mockPage)
    )

    await Effect.runPromise(Effect.provide(shareAuth(), layer))

    expect(mockPage.sharedProps.auth).toEqual({
      user: {
        id: mockUser.user.id,
        name: mockUser.user.name,
        image: mockUser.user.image,
      },
    })
  })

  test('shares the user through the public user schema, and nothing it does not name', async () => {
    const mockUser = createMockUser({ name: 'John Doe' })
    const mockPage = createMockPage()

    const layer = Layer.mergeAll(
      Layer.succeed(AuthUserService, mockUser),
      Layer.succeed(PageService, mockPage)
    )

    await Effect.runPromise(
      Effect.provide(shareAuth({ schema: S.Struct({ id: S.String, name: S.NullOr(S.String) }) }), layer)
    )

    expect(mockPage.sharedProps.auth).toEqual({ user: { id: mockUser.user.id, name: 'John Doe' } })
  })

  test('shares null when not authenticated', async () => {
    const mockPage = createMockPage()
    const layer = Layer.succeed(PageService, mockPage)

    await Effect.runPromise(Effect.provide(shareAuth(), layer))

    expect(mockPage.sharedProps.auth).toEqual({
      user: null,
    })
  })
})

describe('betterAuthRedirect', () => {
  const credentials = { body: { email: 'test@example.com', password: 'password123' } }

  test('returns 303 redirect on successful authentication', async () => {
    const session = 'better-auth.session_token=abc123; Path=/; HttpOnly'

    const response = await Effect.runPromise(answeredBy(
      async () => Response.json({ user: { id: 'user-123' } }, { headers: { 'Set-Cookie': session } }),
      betterAuthRedirect('signInEmail', credentials, { redirectTo: '/dashboard' })
    ))

    expect(response.status).toBe(303)
    expect(response.headers.get('Location')).toBe('/dashboard')
    expect(response.headers.getSetCookie()).toEqual([session])
  })

  test('uses default error mapper when errorMapper not provided', async () => {
    const error = await Effect.runPromise(Effect.flip(answeredBy(
      async () => Response.json({ message: 'Something went wrong' }, { status: 400 }),
      betterAuthRedirect('signInEmail', credentials, { redirectTo: '/' })
    )))

    expect(error).toBeInstanceOf(ValidationError)
    expect(error).toHaveProperty('errors', { form: 'Something went wrong' })
  })

  test('a redirectTo function builds the path from the body Better Auth answers', async () => {
    const response = await Effect.runPromise(answeredBy(
      async () => Response.json({ user: { id: 'u1' } }),
      betterAuthRedirect('signInEmail', credentials, { redirectTo: (result) => `/users/${result.user.id}` })
    ))

    expect(response.status).toBe(303)
    expect(response.headers.get('Location')).toBe('/users/u1')
  })

  test('maps a 401 Better Auth answers to ValidationError through the errors mapper', async () => {
    let mappedError: BetterAuthActionError | undefined

    const error = await Effect.runPromise(Effect.flip(answeredBy(
      async () => Response.json({ message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' }, { status: 401 }),
      betterAuthRedirect('signInEmail', credentials, {
        redirectTo: '/dashboard',
        errors: (rejection) => {
          mappedError = rejection

          return { email: rejection.code ?? 'MISSING_ERROR_CODE' }
        },
      })
    )))

    expect(error).toBeInstanceOf(ValidationError)
    expect(error).toHaveProperty('errors', { email: 'INVALID_EMAIL_OR_PASSWORD' })
    expect(mappedError?.status).toBe(401)
    expect(mappedError?.code).toBe('INVALID_EMAIL_OR_PASSWORD')
    expect(mappedError?.message).toBe('Invalid email or password')
  })

  test('keeps 5xx answers out of the form error mapper', async () => {
    let errorMapperCalled = false

    const error = await Effect.runPromise(Effect.flip(answeredBy(
      async () => Response.json({ message: 'Database connection failed' }, { status: 503 }),
      betterAuthRedirect('signInEmail', credentials, {
        redirectTo: '/',
        errors: () => {
          errorMapperCalled = true

          return { form: 'This should not be rendered' }
        },
      })
    )))

    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ status: 503, message: 'Authentication service failed.' })
    expect(errorMapperCalled).toBe(false)
  })

  test('models Better Auth rate limits separately from validation', async () => {
    let errorMapperCalled = false

    const error = await Effect.runPromise(Effect.flip(answeredBy(
      async () =>
        Response.json({ message: 'Too many requests. Please try again later.' }, {
          status: 429,
          headers: { 'X-Retry-After': '37' },
        }),
      betterAuthRedirect('signInEmail', credentials, {
        redirectTo: '/',
        errors: () => {
          errorMapperCalled = true

          return { form: 'This should not be rendered' }
        },
      })
    )))

    expect(error).toBeInstanceOf(AuthRateLimitError)
    expect(error).toMatchObject({ retryAfterSeconds: 37 })
    expect(errorMapperCalled).toBe(false)
  })
})

describe('betterAuthLogoutAction', () => {
  /** Better Auth's answer to a sign-out, with the cookies it sets. */
  const signedOut = (cookies: readonly string[] = []) => async () =>
    Response.json({ success: true }, { headers: cookies.map((cookie): [string, string] => ['Set-Cookie', cookie]) })

  test('returns 303 redirect to configured path', async () => {
    const response = await Effect.runPromise(answeredBy(signedOut(), betterAuthLogoutAction({ redirectTo: '/login' })))

    expect(response.status).toBe(303)
    expect(response.headers.get('Location')).toBe('/login')
  })

  test('redirects to the home page when not configured', async () => {
    const response = await Effect.runPromise(answeredBy(signedOut(), betterAuthLogoutAction({})))

    expect(response.headers.get('Location')).toBe('/')
  })

  test('copies Set-Cookie headers from better-auth signOut response', async () => {
    // A cookie name the fallback for a sign-out that sets none never uses.
    const response = await Effect.runPromise(answeredBy(
      signedOut(['myapp.session=; Max-Age=0; Path=/']),
      betterAuthLogoutAction({ redirectTo: '/login' })
    ))

    expect(response.headers.getSetCookie()).toEqual(['myapp.session=; Max-Age=0; Path=/'])
  })

  test('clears default cookies when better-auth returns no Set-Cookie', async () => {
    const response = await Effect.runPromise(answeredBy(signedOut(), betterAuthLogoutAction({ redirectTo: '/login' })))
    const cookies = response.headers.get('set-cookie') ?? ''

    // Should clear the default better-auth cookies
    expect(cookies).toContain('better-auth.session_token=')
    expect(cookies).toContain('Expires=Thu, 01 Jan 1970')
  })

  test('clears custom cookie names when specified', async () => {
    const response = await Effect.runPromise(answeredBy(
      signedOut(),
      betterAuthLogoutAction({ redirectTo: '/login', cookieNames: ['my-app-session', 'my-app-refresh'] })
    ))
    const cookies = response.headers.get('set-cookie') ?? ''

    expect(cookies).toContain('my-app-session=')
    expect(cookies).toContain('my-app-refresh=')
  })

  test('succeeds even when better-auth signOut fails', async () => {
    const response = await Effect.runPromise(answeredBy(
      async () => {
        throw new Error('Session not found')
      },
      betterAuthLogoutAction({ redirectTo: '/login' })
    ))

    // Should still succeed and redirect
    expect(response.status).toBe(303)
    expect(response.headers.get('Location')).toBe('/login')
  })
})
