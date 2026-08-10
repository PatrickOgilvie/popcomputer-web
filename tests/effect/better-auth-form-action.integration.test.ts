import { describe, expect, test } from 'bun:test'
import { betterAuth } from 'better-auth'
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory'
import { Cause, Effect, Exit, Layer, Option, Schema as S } from 'effect'
import { Hono } from 'hono'
import { betterAuthFormAction } from '../../src/effect/auth.js'
import { effectHandler } from '../../src/effect/handler.js'
import { ValidationError } from '../../src/effect/errors.js'
import { AuthService, RequestService } from '../../src/effect/services.js'
import { setupHonertia } from '../../src/setup.js'

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
  body: Readonly<Record<string, unknown>>
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

  const failure = Cause.failureOption(exit.cause)
  expect(Option.isSome(failure)).toBe(true)
  if (Option.isNone(failure) || !(failure.value instanceof ValidationError)) {
    throw new Error('Expected a ValidationError')
  }

  return failure.value
}

describe('betterAuthFormAction with Better Auth', () => {
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
        throw { status: 400, message: secretMessage }
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
    expect(errorMapperCalled).toBe(false)
  })
})
