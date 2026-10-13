/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * Compile-time contracts for setupWeb's inferred application wiring.
 *
 * This file is checked by `bun run test:types`; it is intentionally not a
 * runtime test because the assertions are TypeScript assignability claims.
 */

import { Context, Effect, Layer, Schema as S } from 'effect'
import { Hono, type Context as HonoContext } from 'hono'
import { setupWeb } from '@popcomputer/web'
import { cache, kvCache } from '@popcomputer/web/cache'
import {
  action,
  AuthService,
  background,
  bound,
  DatabaseService,
  json,
  NotFoundError,
  validateRequest,
} from '@popcomputer/web/effect'
import {
  betterAuthRedirect,
  effectifyBetterAuth,
  type BetterAuthBoundaryFailure,
} from '@popcomputer/web/auth'
import type { WebDeclaration } from '@popcomputer/web'

type TestDatabase = {
  readonly name: string
}

type TestAuth = {
  readonly databaseName: string
}

type TestBindings = {
  readonly DATABASE_NAME: string
  readonly AUTH_SECRET: string
}

type TestEnv = {
  readonly Bindings: TestBindings
}

const testRouteBindings = {
  project: S.Struct({ id: S.String }),
}

const TestAuthSession = S.Struct({
  user: S.Struct({
    id: S.String,
    email: S.String,
    name: S.NullOr(S.String),
    emailVerified: S.Boolean,
    image: S.NullOr(S.String),
    createdAt: S.Date,
    updatedAt: S.Date,
  }),
  session: S.Struct({
    id: S.String,
    userId: S.String,
    expiresAt: S.Date,
    token: S.RedactedFromValue(S.String),
    createdAt: S.Date,
    updatedAt: S.Date,
  }),
})

declare module '@popcomputer/web' {
  interface Register {
    web: WebDeclaration<{
      database: TestDatabase
      auth: TestAuth
      bindings: TestBindings
      user: S.Schema.Type<typeof TestAuthSession>
      routeBindings: typeof testRouteBindings
    }>
  }
}

const typedBoundProject = Effect.gen(function* () {
  const project = yield* bound('project')
  const id: string = project.id
  // @ts-expect-error Parser output contains no undeclared database fields.
  void project.internalName

  return id
})

void typedBoundProject

class TestSearchService extends Context.Service<
  TestSearchService,
  { readonly search: () => 'ok' }
>()('test/SearchService') {}

const inferredApplication = setupWeb(new Hono<TestEnv>(), {
  version: 'type-test',
  render: (page) => JSON.stringify(page),
  database: (context) => ({ name: context.env.DATABASE_NAME }),
  auth: {
    client: (context, { db, backgroundTasks }) => {
      const database: TestDatabase = db
      const secret: string = context.env.AUTH_SECRET

      const handleBackground: (promise: Promise<unknown>) => void =
        backgroundTasks.handler

      void secret
      void handleBackground

      return { databaseName: database.name }
    },
    session: TestAuthSession,
  },
}).services({
  request: () =>
    Layer.succeed(TestSearchService, {
      search: () => 'ok',
    }),
})

const inferredApplicationApp: Hono<TestEnv> = inferredApplication.app

void inferredApplicationApp

const app = new Hono<TestEnv>()

const application = setupWeb(app, {
  version: 'type-test',
  render: (page) => JSON.stringify(page),
  errors: { component: 'Problem' },
})

const inferredApp: Hono<TestEnv> = application.app

const routeCount: number = application.routes.toJson().length

void inferredApp

void routeCount

setupWeb(new Hono<TestEnv>(), {
  version: 'type-test',
  render: (page) => JSON.stringify(page),
  auth: {
    client: (context, { backgroundTasks }) => {
      const secret: string = context.env.AUTH_SECRET
      backgroundTasks.handler(Promise.resolve())
      void secret

      return { databaseName: 'none' }
    },
    session: TestAuthSession,
  },
})

setupWeb(new Hono<TestEnv>(), {
  version: 'type-test',
  render: (page) => JSON.stringify(page),
  // @ts-expect-error Auth construction has one owner: the auth.client field.
  auth: () => ({ databaseName: 'legacy' }),
})

setupWeb(new Hono<TestEnv>(), {
  version: 'type-test',
  render: (page) => JSON.stringify(page),
  // @ts-expect-error effect.services is now services.request.
  effect: {
    services: () => Layer.empty,
  },
})

setupWeb(new Hono<TestEnv>(), {
  version: 'type-test',
  render: (page) => JSON.stringify(page),
  auth: {
    // @ts-expect-error Database-backed auth requires a database factory.
    client: (_context: HonoContext<TestEnv>, { db }: { readonly db: TestDatabase }) => ({
      databaseName: db.name,
    }),
    session: TestAuthSession,
  },
})

setupWeb(new Hono<TestEnv>(), {
  version: 'type-test',
  render: (page) => JSON.stringify(page),
  // @ts-expect-error A configured database factory must return a database object.
  database: () => undefined,
})

const typedAuthAction = Effect.gen(function* () {
  const input = yield* validateRequest(S.Struct({ email: S.String }))

  // A client without Better Auth's endpoint types takes any endpoint name and body.
  return yield* betterAuthRedirect('signInEmail', { body: input }, {
    redirectTo: '/',
    errors: (error) => {
      const status: number | undefined = error.status
      const code: string | undefined = error.code
      const message: string = error.message
      void status
      void code

      return { email: message, password: undefined }
    },
  })
})

void typedAuthAction

const customBetterAuth = {
  api: {
    customEndpoint: async (input: { readonly value: string }) => ({
      echoed: input.value,
    }),
  },
  handler: async (_request: Request) => new Response('OK'),
}

const effectAuth = effectifyBetterAuth(customBetterAuth)

const customEndpointEffect: Effect.Effect<
  { readonly echoed: string },
  BetterAuthBoundaryFailure
> = effectAuth.api.customEndpoint({ value: 'typed' })

void customEndpointEffect

// @ts-expect-error Plugin endpoint arguments remain required and typed.
const invalidEndpointEffect = effectAuth.api.customEndpoint({ value: 123 })

void invalidEndpointEffect

// ---------------------------------------------------------------------------
// The routes setupWeb returns accept exactly the services it configures.
// ---------------------------------------------------------------------------

class TestMailer extends Context.Service<
  TestMailer,
  { readonly send: (to: string) => Effect.Effect<void> }
>()('test/Mailer') {}

class TestDomainFailure extends S.TaggedError<TestDomainFailure>()(
  'TestDomainFailure',
  {}
) {}

const usesDatabase = action(Effect.gen(function* () {
  const db = yield* DatabaseService

  return yield* json({ name: db.name })
}))

const usesAuthService = action(Effect.gen(function* () {
  const auth = yield* AuthService

  return yield* json({ databaseName: auth.databaseName })
}))

const usesMailer = action(Effect.gen(function* () {
  const mailer = yield* TestMailer
  yield* mailer.send('ada@example.com')

  return yield* json({ sent: true })
}))

const usesCoreServices = action(Effect.gen(function* () {
  yield* background('audit', Effect.void)

  return yield* json({ ok: true })
}))

const failsWithDomainError = action(Effect.gen(function* () {
  yield* new TestDomainFailure()

  return yield* json({ ok: true })
}))

const failsWithPackageError = action(Effect.gen(function* () {
  yield* new NotFoundError({ resource: 'project' })

  return yield* json({ ok: true })
}))

{
  const { routes } = setupWeb(new Hono<TestEnv>(), {
    version: 'type-test',
    render: (page) => JSON.stringify(page),
  })

  routes.get('/core', usesCoreServices)
  routes.get('/missing', failsWithPackageError)
  // @ts-expect-error No database is configured.
  routes.get('/database', usesDatabase)
  // @ts-expect-error No auth client is configured.
  routes.get('/auth', usesAuthService)
  // @ts-expect-error Nothing provides TestMailer.
  routes.post('/mail', usesMailer)
  // @ts-expect-error TestDomainFailure is not one of the package's errors.
  routes.post('/domain', failsWithDomainError)

  routes
    .provide(Layer.succeed(TestMailer, TestMailer.of({ send: () => Effect.void })))
    .post('/mail', usesMailer)
}

{
  const { routes } = setupWeb(new Hono<TestEnv>(), {
    version: 'type-test',
    render: (page) => JSON.stringify(page),
    database: (context) => ({ name: context.env.DATABASE_NAME }),
    auth: { client: (_context, { db }) => ({ databaseName: db.name }), session: TestAuthSession },
  }).services({
    request: () => Layer.succeed(TestMailer, TestMailer.of({ send: () => Effect.void })),
  })

  routes
    .get('/database', usesDatabase)
    .get('/auth', usesAuthService)
    .post('/mail', usesMailer)
}

{
  const { routes } = setupWeb(new Hono<TestEnv>(), {
    version: 'type-test',
    render: (page) => JSON.stringify(page),
    database: (context) => ({ name: context.env.DATABASE_NAME }),
  })

  routes.get('/database', usesDatabase)
  // @ts-expect-error A database alone does not configure auth.
  routes.get('/auth', usesAuthService)
}

// The data cache is a service the setup provides, and it never adds failures.
declare const kv: Parameters<typeof kvCache>[0]

const usesCache = action(Effect.gen(function* () {
  const count = yield* cache('count', Effect.succeed(1), S.Number, { ttl: '1 minute' })

  return yield* json({ count })
}))

{
  const { routes } = setupWeb(new Hono<TestEnv>(), {
    version: 'type-test',
    render: (page) => JSON.stringify(page),
  })

  // @ts-expect-error Nothing provides CacheService.
  routes.get('/count', usesCache)
}

{
  const { routes } = setupWeb(new Hono<TestEnv>(), {
    version: 'type-test',
    render: (page) => JSON.stringify(page),
  }).services({ request: () => kvCache(kv) })

  routes.get('/count', usesCache)
}
