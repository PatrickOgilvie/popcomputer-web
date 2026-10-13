/**
 * The published declarations, as an application that augments the package's
 * types sees them.
 *
 * Bun tests and tests/typecheck-tests.ts compile against src, where an
 * augmentation reaches every type however its export is written. Declaration
 * emit can instead resolve an exported type before any application exists, as
 * it did when `bound` and `authorize` became inferred `Effect.fn` constants.
 * Only a program compiled against `dist` sees that.
 *
 * Run: bun run build && tsc -p tests/consumer-types
 */
import { Effect, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '@popcomputer/web'
import type { WebPage } from '@popcomputer/web/react'
import {
  AuthUserService,
  authorize,
  bound,
  currentUser,
  dbBatch,
  dbQuery,
  dbTransaction,
  render,
  type DefaultAuthUser,
} from '@popcomputer/web/effect'
import { signedIn, testEnv } from '@popcomputer/web/testing'

const Project = S.Struct({ id: S.String, userId: S.String })
const routeBindings = { project: Project }
const pages = {
  'Projects/Show': S.Struct({ project: S.Struct({ id: S.String, createdAt: S.Date }) }),
}

interface Member {
  readonly user: DefaultAuthUser['user'] & {
    readonly role: 'owner' | 'member'
    readonly teamId: string
  }
  readonly session: DefaultAuthUser['session']
}

interface ProjectRow {
  readonly id: string
  readonly userId: string
}

/** An asynchronous database client with transactions and batches. */
interface AppDatabase {
  findProject(id: string): Promise<ProjectRow>
  transaction<A>(run: (tx: AppDatabase) => Promise<A>): Promise<A>
  batch<const Statements extends readonly [Promise<unknown>, ...Promise<unknown>[]]>(
    statements: Statements
  ): Promise<{ -readonly [K in keyof Statements]: Awaited<Statements[K]> }>
}

declare module '@popcomputer/web/effect' {
  interface WebDatabaseType {
    type: AppDatabase
  }

  interface WebRouteBindingsType {
    type: typeof routeBindings
  }

  interface WebAuthUserType {
    type: Member
  }

  interface WebPagesType {
    type: typeof pages
  }

  interface WebBindingsType {
    type: { readonly REGION: string; readonly MAX_LINKS: string }
  }
}

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false

declare function expectType<T extends true>(): void

export const augmentedTypes = Effect.gen(function* () {
  const auth = yield* authorize((member) => member.user.role === 'owner')
  expectType<Equals<typeof auth, Member>>()

  const project = yield* bound('project')
  expectType<Equals<typeof project, typeof Project.Type>>()

  // @ts-expect-error 'projcet' is not a registered binding
  yield* bound('projcet')

  const viewer = yield* currentUser
  expectType<Equals<typeof viewer, Member | null>>()

  const member = yield* AuthUserService
  expectType<Equals<typeof member, Member>>()

  const row = yield* dbQuery((db) => db.findProject('project-1'))
  expectType<Equals<typeof row, ProjectRow>>()

  const inTransaction = yield* dbTransaction(dbQuery((db) => db.findProject('project-1')))
  expectType<Equals<typeof inTransaction, ProjectRow>>()

  const [first, second] = yield* dbBatch((db) => [db.findProject('a'), db.findProject('b')])
  expectType<Equals<[typeof first, typeof second], [ProjectRow, ProjectRow]>>()
})

// Registered pages type render and the React component.
export const showProject = render('Projects/Show', { project: { id: 'p1', createdAt: new Date() } })
// @ts-expect-error 'Projects/Edit' is not a registered page
render('Projects/Edit', {})
expectType<Equals<Parameters<WebPage<'Projects/Show'>>[0]['project']['createdAt'], string>>()

// Once the application registers its pages, setupWeb requires the registry.
export const configured = setupWeb(new Hono(), { version: '1', render: () => '', pages, auth: { session: S.Any } })
// @ts-expect-error pages is required
setupWeb(new Hono(), { version: '1', render: () => '', auth: { session: S.Any } })

// testEnv takes any of the application's bindings, with their declared types.
testEnv(signedIn({ id: 'user-1', role: 'owner', teamId: 'team-1' }), { REGION: 'weur' })
// @ts-expect-error REGIO is not a binding
testEnv(signedIn({ id: 'user-1', role: 'owner', teamId: 'team-1' }), { REGIO: 'weur' })

// Fields an application adds have no test default, so signedIn requires them.
signedIn({ id: 'user-1', role: 'owner', teamId: 'team-1' })
// @ts-expect-error role and teamId are required
signedIn({ id: 'user-1' })
