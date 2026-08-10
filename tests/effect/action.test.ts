/**
 * Action Composables Tests
 */

import { describe, test, expect } from 'bun:test'
import { Effect, Schema as S, Layer, Exit, Cause } from 'effect'
import {
  action,
  dbMutation,
  dbTransaction,
} from '../../src/effect/action.js'
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
  DatabaseConstraintViolation,
  DatabaseMutationFailed,
  DatabaseTransactionFailed,
  Redirect,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
} from '../../src/effect/errors.js'

// Mock user
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

const hasRole = (auth: AuthUser): auth is AuthUserWithRole =>
  'role' in (auth.user as Record<string, unknown>)

// Mock database
const createMockDb = () => ({
  insert: (table: string) => ({
    values: (data: unknown) => Promise.resolve({ inserted: data }),
  }),
  query: {
    users: {
      findMany: () => Promise.resolve([{ id: 1 }, { id: 2 }]),
    },
  },
})

// Mock request context
const createMockRequest = (options: {
  method?: string
  body?: Record<string, unknown>
  params?: Record<string, string>
  query?: Record<string, string>
} = {}): RequestContext => ({
  method: options.method || 'POST',
  url: 'http://localhost/',
  headers: new Headers({ 'Content-Type': 'application/json' }),
  param: (name: string) => options.params?.[name],
  params: () => options.params || {},
  query: () => options.query || {},
  json: async <T>() => (options.body || {}) as T,
  parseBody: async () => options.body || {},
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
        return new Response(JSON.stringify(db))
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
      name: S.String.pipe(S.minLength(2)),
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

    let capturedData: { userId: string; name: string } | null = null

    const myAction = action(
      Effect.gen(function* () {
        const user = yield* authorize()
        const input = yield* validateRequest(schema)
        const db = yield* DatabaseService

        capturedData = { userId: user.user.id, name: input.name }
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

    expect(capturedData).not.toBeNull()
    expect(capturedData!.userId).toBe('user-123')
    expect(capturedData!.name).toBe('Project')
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
    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        expect((option.value as ForbiddenError)._tag).toBe('ForbiddenError')
      }
    }
  })

  test('fails without authenticated user', async () => {
    const effect = authorize()

    const exit = await Effect.runPromiseExit(effect)
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

  test('can check user roles', async () => {
    // Simulate a user with role (extending the mock)
    const userWithRole = createMockUserWithRole('admin')

    const effect = authorize((u) => hasRole(u) && u.user.role === 'admin')

    const layer = Layer.succeed(AuthUserService, userWithRole)

    const result = await Effect.runPromise(Effect.provide(effect, layer))
    expect(result).toBeDefined()
  })
})

describe('dbTransaction', () => {
  test('runs operations in a transaction', async () => {
    const mockDb = {
      transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
        const tx = { insert: () => Promise.resolve({ id: 1 }) }
        return fn(tx)
      },
    }

    const effect = dbTransaction(mockDb, async (tx) => {
      const result = await (tx as { insert: () => Promise<{ id: number }> }).insert()
      return { inserted: result.id }
    })

    const result = await Effect.runPromise(effect)

    expect(result).toEqual({ inserted: 1 })
  })

  test('rolls back on error', async () => {
    let rolledBack = false
    const mockDb = {
      transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
        try {
          return await fn({})
        } catch (e) {
          rolledBack = true
          throw e
        }
      },
    }

    const effect = dbTransaction(mockDb, async () => {
      throw new Error('Operation failed')
    })

    const exit = await Effect.runPromiseExit(effect)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(rolledBack).toBe(true)
  })

  test('classifies unknown failures as transaction failures', async () => {
    const mockDb = {
      transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
    }

    const effect = dbTransaction(mockDb, async () => {
      throw 'string error'
    })

    const exit = await Effect.runPromiseExit(effect)

    if (Exit.isFailure(exit) && Cause.isFailure(exit.cause)) {
      const option = Cause.failureOption(exit.cause)
      if (option._tag === 'Some') {
        expect(option.value).toBeInstanceOf(DatabaseTransactionFailed)
        expect(option.value._tag).toBe('DatabaseTransactionFailed')
      }
    }
  })
})

describe('database failure classification', () => {
  test('keeps generic mutation failures out of the broad Error channel', async () => {
    const exit = await Effect.runPromiseExit(
      dbMutation({}, async () => {
        throw new Error('connection reset')
      })
    )

    const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : null
    expect(failure?._tag).toBe('Some')
    if (failure?._tag === 'Some') {
      expect(failure.value).toBeInstanceOf(DatabaseMutationFailed)
      expect(failure.value.cause).toBeInstanceOf(Error)
    }
  })

  test('classifies provider constraint codes separately', async () => {
    const exit = await Effect.runPromiseExit(
      dbMutation({}, async () => {
        throw Object.assign(new Error('duplicate key'), { code: '23505' })
      })
    )

    const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : null
    expect(failure?._tag).toBe('Some')
    if (failure?._tag === 'Some') {
      expect(failure.value).toBeInstanceOf(DatabaseConstraintViolation)
      expect(failure.value.constraint).toBe('unique')
      expect(failure.value.httpStatus).toBe(409)
    }
  })
})

describe('Composable Action Patterns', () => {
  test('authorization before validation pattern', async () => {
    const schema = S.Struct({
      name: S.String.pipe(S.minLength(3)),
    })

    let authCheckTime = 0
    let validationTime = 0

    const myAction = action(
      Effect.gen(function* () {
        authCheckTime = Date.now()
        yield* authorize()

        validationTime = Date.now()
        const input = yield* validateRequest(schema)

        return new Redirect({ url: '/', status: 303 })
      })
    )

    const mockUser = createMockUser()
    const request = createMockRequest({ body: { name: 'Test' } })

    const layer = Layer.mergeAll(
      Layer.succeed(RequestService, request),
      Layer.succeed(AuthUserService, mockUser)
    )

    await Effect.runPromise(Effect.provide(myAction, layer))

    // Auth should happen before validation
    expect(authCheckTime).toBeLessThanOrEqual(validationTime)
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
        const db = yield* DatabaseService
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
          Effect.succeed(new Response(JSON.stringify(e.errors), { status: 422 }))
        )
      )
    )

    const response = await Effect.runPromise(safeFlow)
    expect(response.status).toBe(422)
  })

  test('minimal action without auth or validation', async () => {
    const publicAction = action(
      Effect.gen(function* () {
        return new Response('Public content')
      })
    )

    const response = assertResponse(await Effect.runPromise(publicAction))
    const text = await response.text()

    expect(text).toBe('Public content')
  })
})
