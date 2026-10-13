/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
import assert from 'node:assert/strict'
/**
 * Action Composables Tests
 */

import { describe, test, expect } from 'bun:test'
import { Option, Predicate, Effect, Schema as S, Layer, Exit, Cause, Redacted } from 'effect'
import type { PageProps } from '../../src/types.js'
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

describe('dbTransaction', () => {
  test('runs operations in a transaction', async () => {
    const mockDb = {
      transaction: async <T>(fn: (tx: { insert: () => Promise<{ id: number }> }) => Promise<T>) => {
        const tx = { insert: () => Promise.resolve({ id: 1 }) }

        return fn(tx)
      },
    }

    const effect = dbTransaction(mockDb, async (tx) => {
      const result = await tx.insert()

      return { inserted: result.id }
    })

    const result = await Effect.runPromise(effect)

    expect(result).toEqual({ inserted: 1 })
  })

  test('rolls back on error', async () => {
    let rolledBack = false

    const mockDb = {
      transaction: async <T>(fn: (tx: Record<never, never>) => Promise<T>) => {
        try {
          return await fn({})
        } catch (e) {
          rolledBack = true
          // oxlint-disable-next-line only-throw-error -- SAFETY: The fake transaction rethrows the original dependency value so rollback and boundary classification are exercised together.
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
      transaction: async <T>(fn: (tx: Record<never, never>) => Promise<T>) => fn({}),
    }

    const effect = dbTransaction(mockDb, async () => {
      // oxlint-disable-next-line no-throw-literal, only-throw-error -- SAFETY: This intentionally malformed dependency failure verifies that the adapter classifies non-Error rejections.
      throw 'string error'
    })

    const exit = await Effect.runPromiseExit(effect)

    if (Exit.isFailure(exit) && Cause.hasFails(exit.cause)) {
      const option = Cause.findErrorOption(exit.cause)

      if (Option.isSome(option)) {
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

    const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : null
    expect(failure?._tag).toBe('Some')

    if (Predicate.isTagged(failure, 'Some')) {
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

    const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : null
    expect(failure?._tag).toBe('Some')

    if (Predicate.isTagged(failure, 'Some')) {
      expect(failure.value).toBeInstanceOf(DatabaseConstraintViolation)

      if (failure.value instanceof DatabaseConstraintViolation) {
        expect(failure.value.constraint).toBe('unique')
        expect(failure.value.httpStatus).toBe(409)
      }
    }
  })

  test.each([
    ['unique', `INSERT INTO pages (id, workspace_id, slug, title) VALUES (2, 1, 'intro', 'Again')`],
    ['unique', `INSERT INTO pages (id, workspace_id, slug, title) VALUES (1, 1, 'other', 'Same id')`],
    ['foreign-key', `INSERT INTO pages (id, workspace_id, slug, title) VALUES (3, 99, 'orphan', 'Orphan')`],
    ['not-null', `INSERT INTO pages (id, workspace_id, slug, title) VALUES (4, 1, 'untitled', NULL)`],
    ['check', `INSERT INTO pages (id, workspace_id, slug, title) VALUES (5, 1, 'blank', '')`],
  ] as const)('classifies a SQLite %s violation', async (constraint, statement) => {
    const { Database } = await import('bun:sqlite')
    const { drizzle } = await import('drizzle-orm/bun-sqlite')
    const { sql } = await import('drizzle-orm')
    const sqlite = new Database(':memory:')
    sqlite.run('PRAGMA foreign_keys = ON')
    sqlite.run('CREATE TABLE workspaces (id INTEGER PRIMARY KEY)')
    sqlite.run(`CREATE TABLE pages (
      id INTEGER PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
      slug TEXT NOT NULL,
      title TEXT NOT NULL CHECK (length(title) > 0),
      UNIQUE (workspace_id, slug)
    )`)
    sqlite.run('INSERT INTO workspaces (id) VALUES (1)')
    sqlite.run(`INSERT INTO pages (id, workspace_id, slug, title) VALUES (1, 1, 'intro', 'Intro')`)
    const db = drizzle(sqlite)

    const exit = await Effect.runPromiseExit(
      dbMutation(db, async (tx) => tx.run(sql.raw(statement)))
    )
    const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : null

    expect(Predicate.isTagged(failure, 'Some') && failure.value).toMatchObject({
      _tag: 'DatabaseConstraintViolation',
      constraint,
    })
  })

  test('classifies a SQLite constraint message without an extended code', async () => {
    const exit = await Effect.runPromiseExit(
      dbMutation({}, async () => {
        throw new Error('D1_ERROR: UNIQUE constraint failed: pages.workspace_id, pages.slug: SQLITE_CONSTRAINT')
      })
    )
    const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : null

    expect(Predicate.isTagged(failure, 'Some') && failure.value).toMatchObject({
      _tag: 'DatabaseConstraintViolation',
      constraint: 'unique',
    })
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
