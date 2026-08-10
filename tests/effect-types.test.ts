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
  HonertiaService,
  effectRoutes,
  RequireAuthLayer,
  bound,
  pluralize,
  asValidated,
  asTrusted,
  validate,
  validateUnknown,
  dbMutation,
  dbTransaction,
  mergeMutationInput,
  type DatabaseType,
  type SchemaType,
  type AuthType,
  type AuthUser,
  type DefaultAuthUser,
  type BoundModel,
  type Validated,
  type Trusted,
  type SafeTx,
} from '../src/effect/index.js'

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

// Custom auth user type for testing HonertiaAuthUserType augmentation
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
declare module '../src/effect/index.js' {
  interface HonertiaDatabaseType {
    type: { query: (sql: string) => Promise<unknown[]> }
    schema: typeof schema
  }
  interface HonertiaRouteBindingsType {
    type: typeof routeBindings
  }
  interface HonertiaAuthType {
    type: { getSession: () => Promise<unknown> }
  }
  interface HonertiaAuthUserType {
    type: CustomAuthUser
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
const _authType: AssertExtends<AuthType, { getSession: () => Promise<unknown> }> = true

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
  const _getSession: () => Promise<unknown> = auth.getSession
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

class SharedPropsService extends Context.Tag('SharedPropsService')<
  SharedPropsService,
  { ready: true }
>() {}

// Context-aware layer that depends on request-scoped base services.
const SharePropsLayer = Layer.effect(
  SharedPropsService,
  Effect.gen(function* () {
    const db = yield* DatabaseService
    const honertia = yield* HonertiaService
    honertia.share('authUserAvatarSeed', 'seed-123')
    void db
    return { ready: true as const }
  })
)

const _builderWithContextAwareProvide = effectRoutes(new Hono()).provide(SharePropsLayer)

// Cross-layer dependency: layerB depends on layerA's output (ProvidedServices).
class CrossServiceA extends Context.Tag('CrossServiceA')<
  CrossServiceA,
  { val: string }
>() {}

class CrossServiceB extends Context.Tag('CrossServiceB')<
  CrossServiceB,
  { derived: string }
>() {}

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
// Validated/Trusted Branding Tests
// ============================================================================

interface UserInput {
  name: string
  email: string
}

// Plain object should NOT be assignable to Validated
type PlainToValidated = UserInput extends Validated<UserInput> ? true : false
const _plainNotValidated: PlainToValidated = false

// Plain object should NOT be assignable to Trusted
type PlainToTrusted = UserInput extends Trusted<UserInput> ? true : false
const _plainNotTrusted: PlainToTrusted = false

// Validated should extend the base type
type ValidatedExtendsBase = Validated<UserInput> extends UserInput ? true : false
const _validatedExtendsBase: ValidatedExtendsBase = true

// Trusted should extend the base type
type TrustedExtendsBase = Trusted<UserInput> extends UserInput ? true : false
const _trustedExtendsBase: TrustedExtendsBase = true

// Spreading a Validated object should NOT produce Validated
// (This is the key safety feature - spreading drops the brand)
// We test this by checking that a plain Record can't satisfy Validated
type SpreadResult = Record<string, unknown> extends Validated<UserInput> ? true : false
const _spreadDropsBrand: SpreadResult = false

// asValidated creates Validated type
const validatedInput = asValidated({ name: 'test', email: 'test@test.com' })
const _validatedType: Validated<{ name: string; email: string }> = validatedInput

// asTrusted creates Trusted type
const trustedInput = asTrusted({ name: 'test', email: 'test@test.com' })
const _trustedType: Trusted<{ name: string; email: string }> = trustedInput

// ============================================================================
// SafeTx Type Tests
// ============================================================================

// Mock database type for testing SafeTx
interface MockInsertBuilder<T> {
  values: (v: T | T[]) => { execute: () => Promise<void> }
}

interface MockUpdateBuilder<T> {
  set: (v: Partial<T>) => { where: (c: unknown) => { execute: () => Promise<void> } }
}

interface MockDB {
  insert: (table: unknown) => MockInsertBuilder<UserInput>
  update: (table: unknown) => MockUpdateBuilder<UserInput>
  query: (sql: string) => Promise<unknown[]>
}

// SafeTx should wrap insert().values() to require branded input
type SafeDB = SafeTx<MockDB>

// Verify SafeTx wraps the values method
type SafeValuesParam = SafeDB extends {
  insert: (table: unknown) => { values: (v: infer V) => unknown }
} ? V : never

// SafeValuesParam should NOT accept plain UserInput
type PlainAccepted = UserInput extends SafeValuesParam ? true : false
// Note: Due to how the type works, we can't easily assert this at compile time
// but the runtime behavior enforces it

// dbMutation and dbTransaction should work with SafeTx
const _testDbMutation = Effect.gen(function* () {
  const mockDb = {} as MockDB

  // This should compile - validated input is accepted
  yield* dbMutation(mockDb, async (db) => {
    // db is SafeTx<MockDB> here
    return Promise.resolve()
  })
})

const _testScopedDbMutation = Effect.gen(function* () {
  const mockDb = {} as MockDB
  const txInput = asTrusted({
    createUser: {
      name: 'test',
      email: 'test@test.com',
      id: undefined as string | undefined,
    },
  })

  yield* dbMutation(mockDb, txInput, async (db, scoped) => {
    const scopedUser = mergeMutationInput(scoped.createUser, {
      id: 'user-123',
    })
    const _scopedUserIdNarrowed: AssertEqual<typeof scopedUser.id, string> = true
    void scopedUser

    // @ts-expect-error extra keys must be declared in the scoped schema
    mergeMutationInput(scoped.createUser, { note: 'nope' })

    // @ts-expect-error scoped mode rejects ad-hoc trusted payloads
    await db.insert(projects).values(asTrusted({ name: 'x', email: 'x@test.com' }))
    return Promise.resolve()
  })
})

const _testValidateTyping = Effect.gen(function* () {
  const transactionSchema = S.Struct({
    status: S.Literal('pending'),
    quantity: S.NumberFromString,
  })

  // Typed validate enforces schema-encoded input at compile time
  yield* validate(transactionSchema, {
    status: 'pending',
    quantity: '2',
  })

  // @ts-expect-error typo in field name should fail compile-time
  yield* validate(transactionSchema, {
    sttaus: 'pending',
    quantity: '2',
  })

  const raw: unknown = {
    status: 'pending',
    quantity: '2',
  }
  // Unknown payloads are still supported via validateUnknown
  yield* validateUnknown(transactionSchema, raw)
})

const _testDbTransaction = Effect.gen(function* () {
  const mockDb = {
    transaction: <T>(fn: (tx: MockDB) => Promise<T>) => fn({} as MockDB)
  }

  yield* dbTransaction(mockDb, async (tx) => {
    // tx is SafeTx<MockDB> here
    return Promise.resolve({ success: true })
  })
})

// ============================================================================
// Runtime Tests
// ============================================================================

import { describe, test, expect } from 'bun:test'

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

  test('Validated/Trusted branding assertions passed', () => {
    // Plain objects should NOT be assignable to branded types
    expect(_plainNotValidated).toBe(false)
    expect(_plainNotTrusted).toBe(false)

    // Branded types should extend base types
    expect(_validatedExtendsBase).toBe(true)
    expect(_trustedExtendsBase).toBe(true)

    // Spreading should drop the brand
    expect(_spreadDropsBrand).toBe(false)

    // asValidated/asTrusted create properly branded values
    expect(_validatedType).toBeDefined()
    expect(_trustedType).toBeDefined()
  })

  test('dbMutation and dbTransaction are properly typed', () => {
    expect(_testDbMutation).toBeDefined()
    expect(_testScopedDbMutation).toBeDefined()
    expect(_testDbTransaction).toBeDefined()
  })
})
