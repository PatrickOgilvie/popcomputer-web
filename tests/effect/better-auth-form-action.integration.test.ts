/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
import { describe, expect, test } from 'bun:test'
import { APIError, betterAuth } from 'better-auth'
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory'
import { Cause, Effect, Exit, Layer, Option, Schema as S } from 'effect'
import { Hono } from 'hono'
import {
  betterAuthFormAction,
  effectifyBetterAuth,
} from '../../src/effect/auth.js'
import { effectHandler } from '../../src/effect/handler.js'
import { ValidationError } from '../../src/effect/errors.js'
import { AuthService, RequestService } from '../../src/effect/services.js'
import { setupHonertia } from '../../src/setup.js'
import type { RequestData } from '../../src/effect/validation.js'

const CredentialsSchema = S.Struct({
  email: S.String,
  password: S.String,
})

const RegistrationSchema = S.Struct({
  name: S.String,
  email: S.String,
  password: S.String,
})

function createTestAuth() {
  const database: MemoryDB = {
    user: [],
    session: [],
    account: [],
    verification: [],
  }

  return betterAuth({
    database: memoryAdapter(database),
    baseURL: 'http://localhost:3000',
    secret: 'honertia-better-auth-integration-test-secret-32-chars',
    emailAndPassword: { enabled: true },
    logger: { disabled: true },
  })
}

function createAuthRequest(
  url: string,
  body: Readonly<RequestData>
) {
  return {
    method: 'POST',
    url,
    headers: new Headers({ 'content-type': 'application/json' }),
    env: {},
    param: () => undefined,
    params: () => ({}),
    query: () => ({}),
    // SAFETY: The production RequestContext contract exposes JSON through an
    // unconstrained generic. This fixture owns the exact body supplied to the
    // action and mirrors that established boundary contract.
    json: async <A>() => body as A,
    parseBody: async () => body,
    header: (name: string) =>
      name.toLowerCase() === 'content-type' ? 'application/json' : undefined,
  }
}

function getValidationError(
  exit: Exit.Exit<Response, unknown>
): ValidationError {
  expect(Exit.isFailure(exit)).toBe(true)

  if (Exit.isSuccess(exit)) {
    throw new Error('Expected the Better Auth action to fail')
  }

  const failure = Cause.findErrorOption(exit.cause)
  expect(Option.isSome(failure)).toBe(true)

  if (Option.isNone(failure) || !(failure.value instanceof ValidationError)) {
    throw new Error('Expected a ValidationError')
  }

  return failure.value
}

describe('betterAuthFormAction with Better Auth', () => {
  test('retains custom endpoint types and values through the Effect façade', async () => {
    const auth = {
      api: {
        pluginEndpoint: async (input: { readonly value: string }) => ({
          echoed: input.value,
        }),
      },
      handler: async (_request: Request) => new Response('OK'),
    }

    const authEffect = effectifyBetterAuth(auth)

    const result = await Effect.runPromise(
      authEffect.api.pluginEndpoint({ value: 'from-plugin' })
    )

    expect(result).toEqual({ echoed: 'from-plugin' })
    expect(authEffect.raw).toBe(auth)
    expect(authEffect.api.pluginEndpoint).toBe(authEffect.api.pluginEndpoint)
    expect('pluginEndpoint' in authEffect.api).toBe(true)
    expect('missingEndpoint' in authEffect.api).toBe(false)
    expect(Object.keys(authEffect.api)).toEqual(['pluginEndpoint'])
  })

  test('preserves explicit asResponse error responses in the success channel', async () => {
    const auth = {
      api: {
        pluginEndpoint: async (_input: { readonly asResponse: true }) =>
          new Response('Unauthorized', { status: 401 }),
      },
      handler: async (_request: Request) => new Response('OK'),
    }

    const authEffect = effectifyBetterAuth(auth)

    const response = await Effect.runPromise(
      authEffect.api.pluginEndpoint({ asResponse: true })
    )

    expect(response.status).toBe(401)
    expect(await response.text()).toBe('Unauthorized')
  })

  test('does not treat a plugin domain status as an HTTP envelope', async () => {
    const auth = {
      api: {
        pluginEndpoint: async () => ({ status: 451, state: 'awaiting-review' }),
      },
      handler: async (_request: Request) => new Response('OK'),
    }

    const authEffect = effectifyBetterAuth(auth)

    const result = await Effect.runPromise(authEffect.api.pluginEndpoint())

    expect(result).toEqual({ status: 451, state: 'awaiting-review' })
  })

  test('normalizes invalid credentials when a Request makes Better Auth return a Response', async () => {
    const auth = createTestAuth()
    await auth.api.signUpEmail({
      body: {
        name: 'Test User',
        email: 'test@example.com',
        password: 'password123',
      },
    })

    const action = betterAuthFormAction({
      schema: CredentialsSchema,
      errorComponent: 'Auth/Login',
      errorMapper: ({ code }) => ({ email: code ?? 'MISSING_ERROR_CODE' }),
      call: (authClient: typeof auth, input, request) =>
        authClient.api.signInEmail({
          body: input,
          request,
          returnHeaders: true,
        }),
    })

    const request = createAuthRequest('http://localhost:3000/login', {
      email: 'test@example.com',
      password: 'wrong-password',
    })

    const layer = Layer.mergeAll(
      Layer.succeed(AuthService, auth),
      Layer.succeed(RequestService, request)
    )

    const exit = await Effect.runPromiseExit(Effect.provide(action, layer))
    const error = getValidationError(exit)

    expect(error.component).toBe('Auth/Login')
    expect(error.errors).toEqual({ email: 'INVALID_EMAIL_OR_PASSWORD' })
  })

  test('normalizes duplicate registration when a Request makes Better Auth return a Response', async () => {
    const auth = createTestAuth()

    const registration = {
      name: 'Test User',
      email: 'test@example.com',
      password: 'password123',
    }

    await auth.api.signUpEmail({ body: registration })

    const action = betterAuthFormAction({
      schema: RegistrationSchema,
      errorComponent: 'Auth/Register',
      errorMapper: ({ code }) => ({ email: code ?? 'MISSING_ERROR_CODE' }),
      call: (authClient: typeof auth, input, request) =>
        authClient.api.signUpEmail({
          body: input,
          request,
          returnHeaders: true,
        }),
    })

    const request = createAuthRequest('http://localhost:3000/register', registration)

    const layer = Layer.mergeAll(
      Layer.succeed(AuthService, auth),
      Layer.succeed(RequestService, request)
    )

    const exit = await Effect.runPromiseExit(Effect.provide(action, layer))
    const error = getValidationError(exit)

    expect(error.component).toBe('Auth/Register')
    expect(error.errors).toEqual({
      email: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
    })
  })

  test('does not expose an unknown dependency message through the production HTTP response', async () => {
    const auth = createTestAuth()
    const secretMessage = 'postgres://user:secret@database.example/internal'
    let errorMapperCalled = false

    const action = betterAuthFormAction({
      schema: CredentialsSchema,
      errorComponent: 'Auth/Login',
      errorMapper: () => {
        errorMapperCalled = true

        return { form: 'This should not be rendered' }
      },
      call: async () => {
        // oxlint-disable-next-line no-throw-literal, only-throw-error -- SAFETY: This unverified SDK-shaped rejection tests that the boundary never exposes its secret-bearing fields.
        throw {
          status: 400,
          message: secretMessage,
          headers: { 'set-cookie': 'unverified=must-not-survive; Path=/' },
        }
      },
    })

    const app = new Hono()

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: 'test',
          render: (page) => JSON.stringify(page),
        },
        auth: {
          client: () => auth,
        },
      })
    )
    app.post('/login', effectHandler(action))

    const response = await app.request('/login', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: 'test@example.com',
        password: 'password123',
      }),
    })

    const body = await response.text()

    expect(response.status).toBe(502)
    expect(body).not.toContain(secretMessage)
    expect(body).not.toContain('secret')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(errorMapperCalled).toBe(false)
  })

  test('preserves cookies from a resolved Better Auth error response', async () => {
    const auth = createTestAuth()

    const action = betterAuthFormAction({
      schema: CredentialsSchema,
      errorComponent: 'Auth/Login',
      call: async () =>
        Response.json({
            code: 'INVALID_SESSION',
            message: 'Please sign in again.',
          }, {
            status: 401,
            headers: {
              'content-type': 'application/json',
              'set-cookie': 'better-auth.session_token=; Max-Age=0; Path=/',
              'x-auth-recovery': 'reauthenticate',
            },
          }),
    })

    const app = new Hono()

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: 'test',
          render: (page) => JSON.stringify(page),
        },
        auth: { client: () => auth },
      })
    )
    app.post('/login', effectHandler(action))

    const response = await app.request('/login', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: 'test@example.com',
        password: 'password123',
      }),
    })

    expect(response.status).toBe(422)
    expect(response.headers.get('set-cookie')).toContain(
      'better-auth.session_token='
    )
    expect(response.headers.get('x-auth-recovery')).toBe('reauthenticate')
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  test('preserves Better Auth hidden headers from a thrown APIError', async () => {
    const auth = createTestAuth()

    const apiError = new APIError('UNAUTHORIZED', {
      code: 'INVALID_SESSION',
      message: 'Please sign in again.',
    })

    Reflect.set(
      apiError,
      Symbol.for('better-call:api-error-headers'),
      new Headers({
        'set-cookie': 'better-auth.session_token=; Max-Age=0; Path=/',
        'x-auth-recovery': 'reauthenticate',
      })
    )

    const action = betterAuthFormAction({
      schema: CredentialsSchema,
      errorComponent: 'Auth/Login',
      call: async () => {
        throw apiError
      },
    })

    const app = new Hono()

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: 'test',
          render: (page) => JSON.stringify(page),
        },
        auth: { client: () => auth },
      })
    )
    app.post('/login', effectHandler(action))

    const response = await app.request('/login', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: 'test@example.com',
        password: 'password123',
      }),
    })

    expect(response.status).toBe(422)
    expect(response.headers.get('set-cookie')).toContain(
      'better-auth.session_token='
    )
    expect(response.headers.get('x-auth-recovery')).toBe('reauthenticate')
  })

  test('preserves thrown Better Auth redirects as redirect control flow', async () => {
    const auth = createTestAuth()

    const redirect = new APIError('FOUND', undefined, {
      Location: 'https://identity.example/continue',
      'Set-Cookie': 'oauth-state=verified; HttpOnly; Path=/',
    })

    const action = betterAuthFormAction({
      schema: CredentialsSchema,
      errorComponent: 'Auth/Login',
      call: async () => {
        throw redirect
      },
    })

    const app = new Hono()

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: 'test',
          render: (page) => JSON.stringify(page),
        },
        auth: { client: () => auth },
      })
    )
    app.post('/login', effectHandler(action))

    const response = await app.request('/login', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: 'test@example.com',
        password: 'password123',
      }),
    })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      'https://identity.example/continue'
    )
    expect(response.headers.get('set-cookie')).toContain('oauth-state=verified')
  })

  test('does not trust an Error named APIError without a numeric statusCode', async () => {
    const auth = createTestAuth()
    const spoofedError = new Error('spoofed')
    spoofedError.name = 'APIError'
    Reflect.set(spoofedError, 'status', 401)
    Reflect.set(spoofedError, 'headers', {
      'set-cookie': 'spoofed=must-not-survive; Path=/',
      'x-spoofed-auth': 'true',
    })

    const action = betterAuthFormAction({
      schema: CredentialsSchema,
      errorComponent: 'Auth/Login',
      call: async () => {
        throw spoofedError
      },
    })

    const app = new Hono()

    app.use(
      '*',
      setupHonertia({
        honertia: {
          version: 'test',
          render: (page) => JSON.stringify(page),
        },
        auth: { client: () => auth },
      })
    )
    app.post('/login', effectHandler(action))

    const response = await app.request('/login', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: 'test@example.com',
        password: 'password123',
      }),
    })

    expect(response.status).toBe(502)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('x-spoofed-auth')).toBeNull()
  })
})
