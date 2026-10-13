/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
import assert from 'node:assert/strict'
/**
 * Action Composables Tests
 */

import { describe, test, expect } from 'bun:test'
import { Option, Predicate, Effect, Schema as S, Layer, Exit, Cause, Redacted } from 'effect'
import type { PageProps } from '../../src/types.js'
import { action } from '../../src/effect/action.js'
import {
  DatabaseService,
  AuthUserService,
  RequestService,
  authorize,
  type AuthUser,
  type RequestContext,
} from '../../src/effect/services.js'
import { validateRequest } from '../../src/effect/validation.js'
import {
  Redirect,
  UnauthorizedError,
  ValidationError,
} from '../../src/effect/errors.js'

// Mock user
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

type AuthUserWithRole = AuthUser & {
  user: AuthUser['user'] & { role: 'admin' | 'user' }
}

const createMockUserWithRole = (
  role: AuthUserWithRole['user']['role']
): AuthUserWithRole => {
  const base = createMockUser()

  return {
    ...base,
    user: {
      ...base.user,
      role,
    },
  }
}

// SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
const hasRole = (auth: AuthUser): auth is AuthUserWithRole =>
  'role' in (auth.user as PageProps)

// Mock database
const createMockDb = () => ({
  insert: (_table: string) => ({
    values: <Data>(data: Data) => Promise.resolve({ inserted: data }),
  }),
  query: {
    users: {
      findMany: () => Promise.resolve([{ id: 1 }, { id: 2 }]),
    },
  },
})

type MockDatabase = ReturnType<typeof createMockDb>

declare module '../../src/effect/services.js' {
  interface WebDatabaseType {
    // Tests provide either the mock client or a named stub they serialize.
    type: MockDatabase | { readonly name: string }
  }
}

// Mock request context
// SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
const createMockRequest = (options: {
  method?: string
  body?: Record<string, string>
  params?: Record<string, string>
  query?: Record<string, string>
} = {}): RequestContext => ({
  method: options.method ?? 'POST',
  url: 'http://localhost/',
  headers: new Headers({ 'Content-Type': 'application/json' }),
  env: {},
  param: (name: string) => options.params?.[name],
  params: () => options.params ?? {},
  query: () => options.query ?? {},
  json: async <T>() => (options.body ?? {}) as T,
  parseBody: async () => options.body ?? {},
  header: (name: string) =>
    name.toLowerCase() === 'content-type' ? 'application/json' : undefined,
})

const assertResponse = (value: Response | Redirect): Response => {
  if (!(value instanceof Response)) {
    throw new Error('Expected Response')
  }

  return value
}

describe('action', () => {
  test('wraps an Effect and returns it unchanged', async () => {
    const myAction = action(
      Effect.succeed(new Response('Hello World'))
    )

    const response = assertResponse(await Effect.runPromise(myAction))
    const text = await response.text()

    expect(text).toBe('Hello World')
  })

  test('can access services inside action', async () => {
    const myAction = action(
      Effect.gen(function* () {
        const db = yield* DatabaseService

        return Response.json(db)
      })
    )

    const mockDb = { name: 'test-db' }
    const layer = Layer.succeed(DatabaseService, mockDb)

    const response = assertResponse(await Effect.runPromise(Effect.provide(myAction, layer)))
    const json = await response.json()

    expect(json).toEqual({ name: 'test-db' })
  })

  test('composes with validation', async () => {
    const schema = S.Struct({
      name: S.String.check(S.isMinLength(2)),
    })

    const myAction = action(
      Effect.gen(function* () {
        const input = yield* validateRequest(schema)

        return new Redirect({ url: `/created/${input.name}`, status: 303 })
      })
    )

    const request = createMockRequest({ body: { name: 'Test' } })
    const layer = Layer.succeed(RequestService, request)

    const result = await Effect.runPromise(Effect.provide(myAction, layer))

    expect(result).toBeInstanceOf(Redirect)
    // SAFETY: This test controls the value and confines the asserted contract to the boundary behavior under test.
    expect((result as Redirect).url).toBe('/created/Test')
  })

  test('composes with authorization', async () => {
    const myAction = action(
      Effect.gen(function* () {
        const user = yield* authorize()

        return new Response(`Hello ${user.user.name}`)
      })
    )

    const mockUser = createMockUser({ name: 'Jane' })
    const layer = Layer.succeed(AuthUserService, mockUser)

    const response = assertResponse(await Effect.runPromise(Effect.provide(myAction, layer)))
    const text = await response.text()

    expect(text).toBe('Hello Jane')
  })

  test('composes authorization, validation, and database', async () => {
    const schema = S.Struct({
      name: S.String,
    })

    const captured: { data: { userId: string; name: string } | null } = { data: null }

    const myAction = action(
      Effect.gen(function* () {
        const user = yield* authorize()
        const input = yield* validateRequest(schema)
        yield* DatabaseService

        captured.data = { userId: user.user.id, name: input.name }

        return new Redirect({ url: '/', status: 303 })
      })
    )

    const mockDb = createMockDb()
    const mockUser = createMockUser()
    const request = createMockRequest({ body: { name: 'Project' } })

    const layer = Layer.mergeAll(
      Layer.succeed(RequestService, request),
      Layer.succeed(DatabaseService, mockDb),
      Layer.succeed(AuthUserService, mockUser)
    )

    await Effect.runPromise(Effect.provide(myAction, layer))

    expect(captured.data).not.toBeNull()
    assert.ok(captured.data)
    expect(captured.data.userId).toBe('user-123')
    expect(captured.data.name).toBe('Project')
  })
})

describe('authorize', () => {
  test('returns user when no check function provided', async () => {
    const effect = authorize()

    const mockUser = createMockUser({ name: 'Jane' })
    const layer = Layer.succeed(AuthUserService, mockUser)

    const result = await Effect.runPromise(Effect.provide(effect, layer))

    expect(result.user.name).toBe('Jane')
  })

  test('returns user when check passes', async () => {
    const effect = authorize((a) => a.user.email === 'test@example.com')

    const mockUser = createMockUser()
    const layer = Layer.succeed(AuthUserService, mockUser)

    const result = await Effect.runPromise(Effect.provide(effect, layer))

    expect(result.user.email).toBe('test@example.com')
  })

  test('fails with ForbiddenError when check fails', async () => {
    const effect = authorize((a) => a.user.email === 'admin@example.com')

    const mockUser = createMockUser({ email: 'user@example.com' })
    const layer = Layer.succeed(AuthUserService, mockUser)

    const exit = await Effect.runPromiseExit(Effect.provide(effect, layer))

    expect(Exit.isFailure(exit)).toBe(true)

    if (Exit.isFailure(exit) && Cause.hasFails(exit.cause)) {
      const option = Cause.findErrorOption(exit.cause)

      if (Option.isSome(option)) {
        expect(option.value._tag).toBe('ForbiddenError')
      }
    }
  })

  test('fails without authenticated user', async () => {
    const effect = authorize()

    const exit = await Effect.runPromiseExit(effect)
    expect(Exit.isFailure(exit)).toBe(true)

    if (Exit.isFailure(exit) && Cause.hasFails(exit.cause)) {
      const option = Cause.findErrorOption(exit.cause)

      if (Option.isSome(option)) {
        const error = option.value
        expect(error._tag).toBe('UnauthorizedError')

        if (Predicate.isTagged(error, 'UnauthorizedError')) {
          expect(error.redirectTo).toBe('/login')
        }
      }
    }
  })

  test('can check user roles', async () => {
    // Simulate a user with role (extending the mock)
    const userWithRole = createMockUserWithRole('admin')

    const effect = authorize((u) => hasRole(u) && u.user.role === 'admin')

    const layer = Layer.succeed(AuthUserService, userWithRole)

    const result = await Effect.runPromise(Effect.provide(effect, layer))
    expect(result).toBeDefined()
  })
})

describe('Composable Action Patterns', () => {
  test('rejects an unauthenticated invalid request before validating its body', async () => {
    const schema = S.Struct({
      name: S.String.check(S.isMinLength(3)),
    })

    const myAction = action(
      Effect.gen(function* () {
        yield* authorize()
        yield* validateRequest(schema)

        return new Redirect({ url: '/', status: 303 })
      })
    )

    const request = createMockRequest({ body: { name: '' } })

    const exit = await Effect.runPromiseExit(myAction.pipe(
      Effect.provideService(RequestService, request),
    ))

    assert.ok(Exit.isFailure(exit))
    const failure = Cause.findErrorOption(exit.cause)
    assert.ok(Option.isSome(failure))
    expect(failure.value).toBeInstanceOf(UnauthorizedError)
  })

  test('validation before authorization pattern (for input-based auth)', async () => {
    const schema = S.Struct({
      ownerId: S.String,
    })

    const myAction = action(
      Effect.gen(function* () {
        const input = yield* validateRequest(schema)
        // Use input for authorization check
        yield* authorize((a) => a.user.id === input.ownerId)

        return new Response('OK')
      })
    )

    const mockUser = createMockUser({ id: 'owner-123' })
    const request = createMockRequest({ body: { ownerId: 'owner-123' } })

    const layer = Layer.mergeAll(
      Layer.succeed(RequestService, request),
      Layer.succeed(AuthUserService, mockUser)
    )

    const response = await Effect.runPromise(Effect.provide(myAction, layer))
    expect(response).toBeInstanceOf(Response)
  })

  test('chain multiple actions', async () => {
    const validateEmail = (email: string) =>
      email.includes('@')
        ? Effect.succeed(email)
        : Effect.fail(new ValidationError({ errors: { email: 'Invalid' } }))

    const createUser = (email: string) =>
      Effect.gen(function* () {
        yield* DatabaseService

        return { id: 'new-id', email }
      })

    const sendWelcome = (userId: string) =>
      Effect.succeed({ sent: true, userId })

    const registrationFlow = action(
      Effect.gen(function* () {
        const email = yield* validateEmail('test@example.com')
        const user = yield* createUser(email)
        const _ = yield* sendWelcome(user.id)

        return new Redirect({ url: '/welcome', status: 303 })
      })
    )

    const layer = Layer.succeed(DatabaseService, createMockDb())
    const result = await Effect.runPromise(Effect.provide(registrationFlow, layer))

    expect(result).toBeInstanceOf(Redirect)
  })

  test('handle errors in flow', async () => {
    const riskyOperation = Effect.fail(
      new ValidationError({ errors: { field: 'Error' } })
    )

    const safeFlow = action(
      riskyOperation.pipe(
        Effect.catchTag('ValidationError', (e) =>
          Effect.succeed(Response.json(e.errors, { status: 422 }))
        )
      )
    )

    const response = await Effect.runPromise(safeFlow)
    expect(response.status).toBe(422)
  })

  test('minimal action without auth or validation', async () => {
    const publicAction = action(
      Effect.succeed(new Response('Public content'))
    )

    const response = assertResponse(await Effect.runPromise(publicAction))
    const text = await response.text()

    expect(text).toBe('Public content')
  })
})
