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
  type DatabaseType,
  type SchemaType,
  type AuthType,
  type AuthUser,
  type DefaultAuthUser,
  type BoundModel,
} from '../src/effect/index.js'
import type { WebDeclaration } from '../src/effect/register.js'

// ============================================================================
// Test Utilities
// ============================================================================

/** Whether two types are identical; `any` equals only `any`. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

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
// Module Augmentation Tests
// ============================================================================

// DatabaseType resolves to augmented type
const _dbType: Equals<DatabaseType, { query: (sql: string) => Promise<unknown[]> }> = true

// SchemaType resolves to augmented schema
const _schemaType: Equals<SchemaType, typeof schema> = true

// AuthType resolves to augmented type
const _authType: Equals<AuthType, { getSession: () => Promise<object> }> = true

// AuthUser resolves to augmented custom type (not DefaultAuthUser)
const _authUserType: Equals<AuthUser, CustomAuthUser> = true

// DefaultAuthUser should NOT have custom fields (verifies it's the fallback)
const _defaultNoCustomFields: Equals<
  DefaultAuthUser extends { user: { isAnonymous: boolean } } ? true : false,
  false
> = true

// ============================================================================
// Service Type Tests
// ============================================================================

// DatabaseService yields the augmented database type
const _testDbService = Effect.gen(function* () {
  const db = yield* DatabaseService
  const _db: Equals<typeof db, { query: (sql: string) => Promise<unknown[]> }> = true

  return db
})

// AuthService yields the augmented auth type
const _testAuthService = Effect.gen(function* () {
  const auth = yield* AuthService
  const _auth: Equals<typeof auth, { getSession: () => Promise<object> }> = true

  return auth
})

// AuthUserService yields the augmented AuthUser type with custom fields
const _testAuthUserService = Effect.gen(function* () {
  const authUser = yield* AuthUserService
  // Custom fields should be typed correctly
  const _isAnonymous: Equals<typeof authUser.user.isAnonymous, boolean> = true
  const _role: Equals<typeof authUser.user.role, 'admin' | 'user'> = true
  // Standard fields still work
  const _id: Equals<typeof authUser.user.id, string> = true
  const _email: Equals<typeof authUser.user.email, string> = true

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

// Parser output, rather than the raw table row, owns the bound-model contract.
const _parsedPublicProject: Equals<BoundModel<'publicProject'>, PublicProject> = true

const _testParsedBound = Effect.gen(function* () {
  const project = yield* bound('publicProject')
  const _project: Equals<typeof project, PublicProject> = true
  // @ts-expect-error The registered parser strips fields it does not declare.
  void project.name

  return project
})
