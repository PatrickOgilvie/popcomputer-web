/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Compile-time type tests for Effect module.
 * If this file compiles, the types are correct.
 */

import { Context, Effect, Layer, Schema as S } from 'effect'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Hono } from 'hono'
import {
  DatabaseService,
  AuthService,
  AuthUserService,
  PageService,
  effectRoutes,
  RequireAuthLayer,
  bound,
  validateUnknown,
  type DatabaseType,
  type SchemaType,
  type AuthType,
  type AuthUser,
  type DefaultAuthUser,
  type BoundModel,
} from '../src/effect/index.js'
import { pluralize } from '../src/effect/binding.js'

// ============================================================================
// Test Utilities
// ============================================================================

/** Assert two types are exactly equal */
type AssertEqual<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false

/** Assert T extends U */
type AssertExtends<T, U> = T extends U ? true : false

// ============================================================================
// Mock Schema for Testing
// ============================================================================

const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
})

const schema = { projects, categories }

const routeBindings = {
  project: S.Struct({ id: S.String, name: S.String }),
  category: S.Struct({ id: S.String, title: S.String }),
  publicProject: S.Struct({ id: S.String }),
}

type Project = typeof projects.$inferSelect

type Category = typeof categories.$inferSelect

type PublicProject = S.Schema.Type<typeof routeBindings.publicProject>

// Custom auth user type for testing WebAuthUserType augmentation
interface CustomAuthUser {
  user: {
    id: string
    email: string
    name: string | null
    emailVerified: boolean
    image: string | null
    createdAt: Date
    updatedAt: Date
    // Custom fields from Better Auth plugins
    isAnonymous: boolean
    role: 'admin' | 'user'
  }
  session: {
    id: string
    userId: string
    expiresAt: Date
    token: string
    createdAt: Date
    updatedAt: Date
  }
}

// Augment interfaces for testing
declare module '../src/effect/register.js' {
  interface Register {
    web: WebDeclaration<{
      database: { query: (sql: string) => Promise<unknown[]> }
      schema: typeof schema
      routeBindings: typeof routeBindings
      auth: { getSession: () => Promise<object> }
      user: CustomAuthUser
    }>
  }
}

// ============================================================================
// Pluralize Type Tests (must match runtime pluralize function)
// ============================================================================

// Test: project → projects (simple 's')
const _pluralProject: AssertEqual<BoundModel<'project'>, Project> = true

// Test: category → categories (y → ies)
const _pluralCategory: AssertEqual<BoundModel<'category'>, Category> = true

// Parser output, rather than the raw table row, owns the bound-model contract.
const _parsedPublicProject: AssertEqual<
  BoundModel<'publicProject'>,
  PublicProject
> = true

// ============================================================================
// Module Augmentation Tests
// ============================================================================

// DatabaseType resolves to augmented type
const _dbType: AssertExtends<DatabaseType, { query: (sql: string) => Promise<unknown[]> }> = true

// SchemaType resolves to augmented schema
const _schemaType: AssertExtends<SchemaType, typeof schema> = true

// AuthType resolves to augmented type
const _authType: AssertExtends<AuthType, { getSession: () => Promise<object> }> = true

// AuthUser resolves to augmented custom type (not DefaultAuthUser)
const _authUserType: AssertExtends<AuthUser, CustomAuthUser> = true

// AuthUser has custom fields from augmentation
const _authUserHasCustomFields: AssertExtends<AuthUser, { user: { isAnonymous: boolean; role: 'admin' | 'user' } }> = true

// DefaultAuthUser should NOT have custom fields (verifies it's the fallback)
type DefaultHasCustomFields = DefaultAuthUser extends { user: { isAnonymous: boolean } } ? true : false

const _defaultNoCustomFields: DefaultHasCustomFields = false

// ============================================================================
// Service Type Tests
// ============================================================================

// DatabaseService yields the augmented database type
const _testDbService = Effect.gen(function* () {
  const db = yield* DatabaseService
  const _query: (sql: string) => Promise<unknown[]> = db.query

  return db
})

// AuthService yields the augmented auth type
const _testAuthService = Effect.gen(function* () {
  const auth = yield* AuthService
const _getSession: () => Promise<object> = auth.getSession

  return auth
})

// AuthUserService yields the augmented AuthUser type with custom fields
const _testAuthUserService = Effect.gen(function* () {
  const authUser = yield* AuthUserService
  // Custom fields should be typed correctly
  const _isAnonymous: boolean = authUser.user.isAnonymous
  const _role: 'admin' | 'user' = authUser.user.role
  // Standard fields still work
  const _id: string = authUser.user.id
  const _email: string = authUser.user.email

  return authUser
})

// ============================================================================
// EffectRouteBuilder.provide() Type Tests
// ============================================================================

const _builderWithRequireAuthLayer = effectRoutes(new Hono()).provide(RequireAuthLayer)

class SharedPropsService extends Context.Service<
  SharedPropsService,
  { ready: true }
>()('SharedPropsService') {}

// Context-aware layer that depends on request-scoped base services.
const SharePropsLayer = Layer.effect(
  SharedPropsService,
  Effect.gen(function* () {
    const db = yield* DatabaseService
    const page = yield* PageService
    page.share('authUserAvatarSeed', 'seed-123')
    void db

    return { ready: true as const }
  })
)

const _builderWithContextAwareProvide = effectRoutes(new Hono()).provide(SharePropsLayer)

// Cross-layer dependency: layerB depends on layerA's output (ProvidedServices).
class CrossServiceA extends Context.Service<
  CrossServiceA,
  { val: string }
>()('CrossServiceA') {}

class CrossServiceB extends Context.Service<
  CrossServiceB,
  { derived: string }
>()('CrossServiceB') {}

const CrossLayerA = Layer.succeed(CrossServiceA, { val: 'hello' })

const CrossLayerB = Layer.effect(
  CrossServiceB,
  Effect.gen(function* () {
    const a = yield* CrossServiceA

    return { derived: a.val + '-world' }
  })
)

const _builderWithCrossLayerProvide = effectRoutes(new Hono())
  .provide(CrossLayerA)
  .provide(CrossLayerB)

// ============================================================================
// BoundModel Type Tests
// ============================================================================

// bound() returns correctly typed model
const _testBound = Effect.gen(function* () {
  const project = yield* bound('project')
  const _id: string = project.id
  const _name: string = project.name

  return project
})

// bound() with category (tests y → ies pluralization)
const _testBoundCategory = Effect.gen(function* () {
  const category = yield* bound('category')
  const _id: string = category.id
  const _title: string = category.title

  return category
})

const _testParsedBound = Effect.gen(function* () {
  const project = yield* bound('publicProject')
  const _id: string = project.id
  // @ts-expect-error The registered parser strips fields it does not declare.
  void project.name

  return project
})

// ============================================================================
// Runtime Tests
// ============================================================================

import { describe, test, expect } from 'bun:test'
import type { WebDeclaration } from '../src/effect/register.js'

describe('Effect type tests', () => {
  test('pluralize function matches Pluralize type', () => {
    // These runtime checks complement the compile-time assertions above
    expect(pluralize('project')).toBe('projects')
    expect(pluralize('category')).toBe('categories')
    expect(pluralize('day')).toBe('days')
    expect(pluralize('box')).toBe('boxes')
    expect(pluralize('class')).toBe('classes')
    expect(pluralize('match')).toBe('matches')
    expect(pluralize('wish')).toBe('wishes')
    // Words already ending in double consonants
    expect(pluralize('buzz')).toBe('buzzes')
    expect(pluralize('boss')).toBe('bosses')
    expect(pluralize('fizz')).toBe('fizzes')
  })

  test('compile-time type assertions passed', () => {
    // If we got here, all the type assertions above compiled successfully
    expect(_pluralProject).toBe(true)
    expect(_pluralCategory).toBe(true)
    expect(_dbType).toBe(true)
    expect(_schemaType).toBe(true)
    expect(_authType).toBe(true)
    // AuthUser augmentation assertions
    expect(_authUserType).toBe(true)
    expect(_authUserHasCustomFields).toBe(true)
    expect(_defaultNoCustomFields).toBe(false)
  })

  test('effect generators are properly typed', () => {
    expect(_testDbService).toBeDefined()
    expect(_testAuthService).toBeDefined()
    expect(_testAuthUserService).toBeDefined()
    expect(_testBound).toBeDefined()
    expect(_testBoundCategory).toBeDefined()
  })
})
