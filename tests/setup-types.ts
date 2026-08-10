/**
 * Compile-time contracts for setupWeb's inferred application wiring.
 *
 * This file is checked by `bun run test:types`; it is intentionally not a
 * runtime test because the assertions are TypeScript assignability claims.
 */

import { Context, Effect, Layer, Schema as S } from 'effect'
import { Hono, type Context as HonoContext, type MiddlewareHandler } from 'hono'
import { setupWeb } from '@popcomputer/web'
import { betterAuthFormAction, bound } from '@popcomputer/web/effect'

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
    createdAt: S.DateFromSelf,
    updatedAt: S.DateFromSelf,
  }),
  session: S.Struct({
    id: S.String,
    userId: S.String,
    expiresAt: S.DateFromSelf,
    token: S.String,
    createdAt: S.DateFromSelf,
    updatedAt: S.DateFromSelf,
  }),
})

declare module '@popcomputer/web/effect' {
  interface WebDatabaseType {
    type: TestDatabase
  }

  interface WebAuthType {
    type: TestAuth
  }

  interface WebBindingsType {
    type: TestBindings
  }

  interface WebAuthUserType {
    type: S.Schema.Type<typeof TestAuthSession>
  }

  interface WebRouteBindingsType {
    type: typeof testRouteBindings
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

class TestSearchService extends Context.Tag('test/SearchService')<
  TestSearchService,
  { readonly search: () => 'ok' }
>() {}

const inferredMiddleware: MiddlewareHandler<TestEnv> = setupWeb({
  version: 'type-test',
  render: (page) => JSON.stringify(page),
  database: (context) => ({ name: context.env.DATABASE_NAME }),
  auth: {
    client: (context, { db }) => {
      const database: TestDatabase = db
      const secret: string = context.env.AUTH_SECRET
      void secret

      return { databaseName: database.name }
    },
    session: TestAuthSession,
  },
  effect: {
    services: () =>
      Layer.succeed(TestSearchService, {
        search: () => 'ok',
      }),
  },
})

void inferredMiddleware

const app = new Hono<TestEnv>()
const application = setupWeb(app, {
  version: 'type-test',
  render: (page) => JSON.stringify(page),
  errors: { component: 'Problem' },
})
const inferredApp: Hono<TestEnv> = application.app
const routeCount: number = application.routes.count()
void inferredApp
void routeCount

setupWeb({
  version: 'type-test',
  render: (page) => JSON.stringify(page),
  auth: {
    client: (context) => {
      const secret: string = context.env.AUTH_SECRET
      void secret
      return { databaseName: 'none' }
    },
  },
})

setupWeb({
  version: 'type-test',
  render: (page) => JSON.stringify(page),
  // @ts-expect-error Auth construction has one owner: the auth.client field.
  auth: () => ({ databaseName: 'legacy' }),
})

setupWeb({
  version: 'type-test',
  render: (page) => JSON.stringify(page),
  effect: {
    // @ts-expect-error Setup schema is a top-level setupWeb field.
    schema: {},
  },
})

// @ts-expect-error Database-backed auth requires a database factory.
setupWeb({
  version: 'type-test',
  render: (page) => JSON.stringify(page),
  auth: {
    client: (_context: HonoContext<TestEnv>, { db }: { readonly db: TestDatabase }) => ({
      databaseName: db.name,
    }),
  },
})

// @ts-expect-error A configured database factory must return a database object.
setupWeb({
  version: 'type-test',
  render: (page) => JSON.stringify(page),
  database: () => undefined,
})

const typedAuthAction = betterAuthFormAction({
  schema: S.Struct({ email: S.String }),
  errorComponent: 'Auth/Login',
  errorMapper: (error) => {
    const status: number | undefined = error.status
    const code: string | undefined = error.code
    const message: string = error.message
    void status
    void code

    return { email: message }
  },
  call: async (auth, input, request) => {
    const configuredAuth: TestAuth = auth
    const email: string = input.email
    const originalRequest: Request = request
    void configuredAuth
    void email
    void originalRequest

    return new Headers()
  },
})

void typedAuthAction
