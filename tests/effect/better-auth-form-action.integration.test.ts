/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
import { describe, expect, test } from 'bun:test'
import { betterAuth } from 'better-auth'
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory'
import { Cause, Effect, Exit, Layer, Option, Schema as S } from 'effect'
import { Hono } from 'hono'
import { betterAuthRedirect } from '../../src/effect/auth.js'
import { effectRoutes } from '../../src/effect/routing.js'
import { ValidationError } from '../../src/effect/errors.js'
import {
  AuthService,
  RequestService,
  type RequestContext,
} from '../../src/effect/services.js'
import { setupWeb } from '../../src/setup.js'
import { validateRequest } from '../../src/effect/validation.js'
import type { BetterAuthActionError } from '../../src/effect/better-auth-boundary.js'
import type { WebDeclaration } from '../../src/effect/register.js'

/**
 * A form action: validate the form, then call a Better Auth endpoint with the
 * input through its request handler and redirect with the cookies it sets.
 */
function formAction<A extends { readonly email: string; readonly password: string; readonly name?: string }, I>(config: {
  readonly schema: S.Codec<A, I, never, never>
  readonly endpoint?: 'signInEmail' | 'signUpEmail'
  readonly errorMapper?: (error: BetterAuthActionError) => Record<string, string>
}) {
  return Effect.gen(function* () {
    const input = yield* validateRequest(config.schema)
    const body = { name: input.name ?? 'Test User', email: input.email, password: input.password }

    return yield* config.endpoint === 'signUpEmail'
      ? betterAuthRedirect('signUpEmail', { body }, { redirectTo: '/', errors: config.errorMapper })
      : betterAuthRedirect('signInEmail', { body: { email: input.email, password: input.password } }, { redirectTo: '/', errors: config.errorMapper })
  })
}

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
    secret: 'web-better-auth-integration-test-secret-32-chars-',
    emailAndPassword: { enabled: true },
    logger: { disabled: true },
  })
}

/** A Better Auth whose request handler answers every call as the test says, for the boundary's classification. */
function answeringAuth(answer: (request: Request) => Promise<Response>) {
  return { ...createTestAuth(), handler: answer }
}

declare module '../../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{
      auth: ReturnType<typeof createTestAuth>
    }>
  }
}

function createAuthRequest(
  url: string,
  body: Readonly<Record<string, string>>
): RequestContext {
  return {
    method: 'POST',
    url,
    headers: new Headers({ 'content-type': 'application/json' }),
    env: {},
    param: () => undefined,
    params: () => ({}),
    query: () => ({}),
    queries: () => ({}),
    // SAFETY: The production RequestContext contract exposes JSON through an
    // unconstrained generic. This fixture owns the exact body supplied to the
    // action and mirrors that established boundary contract.
    json: async <A>() => body as A,
    raw: () => new Request('http://localhost/'),
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

describe('betterAuthRedirect in a form action with Better Auth', () => {
  test("maps invalid credentials, which Better Auth's handler refuses, to the mapper's field errors", async () => {
    const auth = createTestAuth()
    await auth.api.signUpEmail({
      body: {
        name: 'Test User',
        email: 'test@example.com',
        password: 'password123',
      },
    })

    const action = formAction({
      schema: CredentialsSchema,
      errorMapper: ({ code }) => ({ email: code ?? 'MISSING_ERROR_CODE' }),
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

    expect(error.errors).toEqual({ email: 'INVALID_EMAIL_OR_PASSWORD' })
  })

  test("maps a duplicate registration, which Better Auth's handler refuses, to the mapper's field errors", async () => {
    const auth = createTestAuth()

    const registration = {
      name: 'Test User',
      email: 'test@example.com',
      password: 'password123',
    }

    await auth.api.signUpEmail({ body: registration })

    const action = formAction({
      schema: RegistrationSchema,
      endpoint: 'signUpEmail',
      errorMapper: ({ code }) => ({ email: code ?? 'MISSING_ERROR_CODE' }),
    })

    const request = createAuthRequest('http://localhost:3000/register', registration)

    const layer = Layer.mergeAll(
      Layer.succeed(AuthService, auth),
      Layer.succeed(RequestService, request)
    )

    const exit = await Effect.runPromiseExit(Effect.provide(action, layer))
    const error = getValidationError(exit)

    expect(error.errors).toEqual({
      email: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
    })
  })

  test('does not expose an unknown dependency message through the production HTTP response', async () => {
    const secretMessage = 'postgres://user:secret@database.example/internal'
    let errorMapperCalled = false
    const auth = answeringAuth(async () => {
      // oxlint-disable-next-line no-throw-literal, only-throw-error -- SAFETY: This unverified SDK-shaped rejection tests that the boundary never exposes its secret-bearing fields.
      throw {
        status: 400,
        message: secretMessage,
        headers: { 'set-cookie': 'unverified=must-not-survive; Path=/' },
      }
    })

    const action = formAction({
      schema: CredentialsSchema,
      errorMapper: () => {
        errorMapperCalled = true

        return { form: 'This should not be rendered' }
      },
    })

    const app = new Hono()

    setupWeb(app, {
      version: 'test',
      render: (page) => JSON.stringify(page),
      auth: {
        client: () => auth,
      },
    })
    effectRoutes(app).post('/login', action)

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

  test('keeps the cookies of a Better Auth rejection, and none of its other headers', async () => {
    const auth = answeringAuth(async () =>
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
        }))

    const action = formAction({ schema: CredentialsSchema })

    const app = new Hono()

    setupWeb(app, {
      version: 'test',
      render: (page) => JSON.stringify(page),
      auth: { client: () => auth },
    })
    effectRoutes(app).post('/login', action)

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
    expect(response.headers.get('x-auth-recovery')).toBeNull()
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  test('follows a redirect Better Auth answers, with its cookies', async () => {
    const auth = answeringAuth(async () =>
      new Response(null, {
        status: 302,
        headers: {
          Location: 'https://identity.example/continue',
          'Set-Cookie': 'oauth-state=verified; HttpOnly; Path=/',
        },
      }))
    const action = formAction({ schema: CredentialsSchema })

    const app = new Hono()

    setupWeb(app, {
      version: 'test',
      render: (page) => JSON.stringify(page),
      auth: { client: () => auth },
    })
    effectRoutes(app).post('/login', action)

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
    expect(response.headers.getSetCookie()).toEqual(['oauth-state=verified; HttpOnly; Path=/'])
  })
})
