/**
 * Effect Test Layers
 *
 * Reusable Layer helpers for tests.
 */

import { Context, Effect, Layer } from 'effect'
import {
  AuthUserService,
  DatabaseService,
  EmailService,
  type AuthUser,
  type DatabaseType,
} from './services.js'
import type { PageProps } from '../types.js'

export interface TestCaptures {
  emails: Array<{ to: string; subject: string; body: string }>
  logs: Array<{ level: string; message: string }>
  events: Array<{ name: string; payload: unknown }>
}

export class TestCaptureService extends Context.Service<
  TestCaptureService,
  {
    capture: <K extends keyof TestCaptures>(
      key: K,
      value: TestCaptures[K][number]
    ) => Effect.Effect<void>
    get: () => Effect.Effect<TestCaptures>
  }
>()('@popcomputer/web/TestCapture') {}

const createEmptyCaptures = (): TestCaptures => ({
  emails: [],
  logs: [],
  events: [],
})

const createId = (): string => {
  if (globalThis.crypto?.randomUUID instanceof Function) {
    return globalThis.crypto.randomUUID()
  }
  return `test_${Math.random().toString(16).slice(2)}`
}

// Simple Map-backed mock database for tests.
function createMockDb() {
  const tables = new Map<string, Map<string, PageProps>>()

  const ensureTable = (table: string) => {
    let store = tables.get(table)
    if (!store) {
      store = new Map()
      tables.set(table, store)
    }
    return store
  }

  return {
    insert: (table: string) => ({
      values: (data: PageProps) => ({
        returning: async () => {
          const id = createId()
          const record = { id, ...data }
          ensureTable(table).set(id, record)
          return [record]
        },
      }),
    }),
    select: () => ({
      from: (table: string) => {
        const store = ensureTable(table)
        let predicate: ((row: PageProps) => boolean) | null = null

        const builder = {
          where: <Condition>(condition: Condition) => {
            if (condition instanceof Function) {
              predicate = (row) => Boolean(condition(row))
            }
            return builder
          },
          // Cross-database compatible: returns array, use [0] for single row
          limit: async (n: number) => {
            const values = Array.from(store.values())
            const currentPredicate = predicate
            const filtered = currentPredicate ? values.filter((row) => currentPredicate(row)) : values
            return filtered.slice(0, n)
          },
          // Legacy SQLite-style method (kept for backwards compatibility)
          get: async () => {
            const values = Array.from(store.values())
            const currentPredicate = predicate
            return currentPredicate ? values.find((row) => currentPredicate(row)) : values[0]
          },
          all: async () => {
            const values = Array.from(store.values())
            const currentPredicate = predicate
            return currentPredicate ? values.filter((row) => currentPredicate(row)) : values
          },
        }

        return builder
      },
    }),
  }
}

type TestAuthUserInput =
  | AuthUser
  | (Partial<AuthUser['user']> & { id: string } & PageProps)

function createTestAuthUser(input: TestAuthUserInput): AuthUser {
  if ('user' in input && 'session' in input) {
    // SAFETY: This test adapter constructs and owns the fixture, so the asserted framework contract is confined to controlled test data.
    return input as AuthUser
  }

  const { id, ...rest } = input
  const baseUser = {
    id,
    email: 'test@example.com',
    name: null,
    emailVerified: false,
    image: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...rest,
  }

  // SAFETY: This test adapter constructs and owns the fixture, so the asserted framework contract is confined to controlled test data.
  return {
    user: baseUser as AuthUser['user'],
    session: {
      id: 'test-session',
      userId: baseUser.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      token: 'test-token',
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  }
}

function asTestDatabase<Database>(database: Database): DatabaseType {
  // SAFETY: TestLayer is an explicit test-only seam; callers choose a fixture implementing the augmented DatabaseType contract.
  return database as DatabaseType
}

export const TestLayer = {
  Database: {
    /** Map-based mock database - good for unit tests */
    inMemory: () => Layer.succeed(DatabaseService, asTestDatabase(createMockDb())),
    /** Use your own database instance (e.g., SQLite :memory:) */
    use: <Database>(db: Database) =>
      Layer.succeed(DatabaseService, asTestDatabase(db)),
  },

  Auth: {
    guest: () => Layer.empty,
    withUser: (user: TestAuthUserInput) =>
      Layer.succeed(AuthUserService, createTestAuthUser(user)),
    withRole: (role: string) =>
      TestLayer.Auth.withUser({ id: 'test-user', role }),
  },

  Email: {
    captured: () =>
      Layer.effect(
        EmailService,
        Effect.gen(function* () {
          const capture = yield* TestCaptureService
          return {
            send: (to: string, subject: string, body: string) =>
              capture.capture('emails', { to, subject, body }),
          }
        })
      ),
  },

  Capture: {
    make: () =>
      Layer.effect(
        TestCaptureService,
        Effect.sync(() => {
          const captures = createEmptyCaptures()
          return {
            capture: <K extends keyof TestCaptures>(
              key: K,
              value: TestCaptures[K][number]
            ) =>
              Effect.sync(() => {
                // SAFETY: This test adapter constructs and owns the fixture, so the asserted framework contract is confined to controlled test data.
                const list = captures[key] as Array<TestCaptures[K][number]>
                list.push(value)
              }),
            get: () => Effect.succeed(captures),
          }
        })
      ),
  },
}
