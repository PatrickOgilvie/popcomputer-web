/**
 * The published declarations, as an application that registers its setup
 * sees them.
 *
 * The application declares each type once, in setupWeb's configuration, and
 * registers setupWeb's result; every API typed by the application's types
 * must follow from that one registration. Bun tests and
 * tests/typecheck-tests.ts compile against src, where any type resolves
 * however its export is written. Declaration emit can instead resolve an
 * exported type before any application exists, as it did when `bound` and
 * `authorize` became inferred `Effect.fn` constants. Only a program compiled
 * against `dist` sees that.
 *
 * Run: bun run build && tsc -p tests/consumer-types
 */
import { Context, Effect, Layer, Schema as S, Struct } from 'effect'
import { Hono } from 'hono'
import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { betterAuthSession } from '@popcomputer/web/auth'
import { tableSchema } from '@popcomputer/web/schema'
import { setupWeb } from '@popcomputer/web'
import type { FlashData, SharedProps, WebPage } from '@popcomputer/web/react'
import {
  action,
  AuthUserService,
  authorize,
  config,
  BindingsService,
  bound,
  currentUser,
  dbBatch,
  dbQuery,
  dbTransaction,
  flash,
  json,
  type DatabaseError,
  type DatabaseService,
  render,
  share,
  shareProps,
} from '@popcomputer/web/effect'
import { readPage, signedIn, testEnv } from '@popcomputer/web/testing'

const Project = S.Struct({ id: S.String, userId: S.String })

// A binding can name its table: the model is the table's row.
const members = pgTable('members', {
  id: text('id').primaryKey(),
  role: text('role', { enum: ['owner', 'member'] }).notNull(),
})

const paths = {
  project: '/projects/{project}',
  member: '/members/{member}',
} as const

const pages = {
  'Projects/Show': S.Struct({ project: S.Struct({ id: S.String, createdAt: S.Date }) }),
}

// The user's fields are declared once, in the table: the session and the
// public user derive from it.
const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name'),
  emailVerified: boolean('email_verified').notNull(),
  image: text('image'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  role: text('role', { enum: ['owner', 'member'] }).notNull(),
  teamId: text('team_id').notNull(),
})

const MemberSession = betterAuthSession(tableSchema(users))

const PublicMember = tableSchema(users).mapFields(Struct.pick(['id', 'name', 'role']))

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

declare function createDb(region: string): AppDatabase

type Env = { Bindings: { readonly REGION: string; readonly MAX_LINKS: string } }

/** A domain service that reads the database. */
class Projects extends Context.Service<
  Projects,
  { readonly find: (id: string) => Effect.Effect<ProjectRow, DatabaseError, DatabaseService> }
>()('app/Projects') {}

// Its layer states its type: setupWeb's type includes its services, and the
// database type comes from setupWeb, so an inferred one would refer to itself.
const ProjectsLive: Layer.Layer<Projects> = Layer.succeed(
  Projects,
  Projects.of({ find: (id) => dbQuery((db) => db.findProject(id)) })
)

/** A service provided to a group of routes, after the registration. */
class Audit extends Context.Service<
  Audit,
  { readonly latest: Effect.Effect<ProjectRow, DatabaseError, DatabaseService> }
>()('app/Audit') {}

// routes.provide is outside setupWeb's type, so its layer needs no annotation.
const AuditLive = Layer.succeed(Audit, Audit.of({ latest: dbQuery((db) => db.findProject('latest')) }))

// Every type the application uses is declared here, once.
export const web = setupWeb(new Hono<Env>(), {
  version: '1',
  render: () => '',
  database: (c) => createDb(c.env.REGION),
  bindings: { project: Project, member: members },
  pages,
  paths,
  auth: { session: MemberSession, share: PublicMember },
  shared: S.Struct({ locale: S.String }),
  flash: S.Struct({ success: S.String }),
  services: { app: ProjectsLive },
})

// ...and registered, once.
declare module '@popcomputer/web' {
  interface Register {
    web: typeof web
  }
}

type Member = typeof MemberSession.Type

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false

declare function expectType<T extends true>(): void

export const derivedTypes = Effect.gen(function* () {
  const auth = yield* authorize((member) => member.user.role === 'owner')
  expectType<Equals<typeof auth, Member>>()

  const project = yield* bound('project')
  expectType<Equals<typeof project, typeof Project.Type>>()

  const boundMember = yield* bound('member')
  expectType<Equals<typeof boundMember, typeof members.$inferSelect>>()

  // @ts-expect-error 'projcet' is not a registered binding
  yield* bound('projcet')

  const viewer = yield* currentUser
  expectType<Equals<typeof viewer, Member | null>>()

  const member = yield* AuthUserService
  expectType<Equals<typeof member, Member>>()

  const bindings = yield* BindingsService
  expectType<Equals<typeof bindings, Env['Bindings']>>()

  const row = yield* dbQuery((db) => db.findProject('project-1'))
  expectType<Equals<typeof row, ProjectRow>>()

  const inTransaction = yield* dbTransaction(dbQuery((db) => db.findProject('project-1')))
  expectType<Equals<typeof inTransaction, ProjectRow>>()

  const [first, second] = yield* dbBatch((db) => [db.findProject('a'), db.findProject('b')])
  expectType<Equals<[typeof first, typeof second], [ProjectRow, ProjectRow]>>()

  yield* share('locale', 'en-GB')
  // @ts-expect-error 'theme' is not a shared prop
  yield* share('theme', 'dark')

  yield* flash('success', 'Saved.')
  // @ts-expect-error a flashed success message is a string
  yield* flash('success', 1)
})

// Shared props computed for every page are typed by setupWeb's shared.
web.routes.provide(shareProps(Effect.map(dbQuery((db) => db.findProject('p1')), (project) => ({ locale: project.id }))))
// @ts-expect-error 'theme' is not a shared prop
web.routes.provide(shareProps(Effect.succeed({ theme: 'dark' })))

// Actions use services from setupWeb and from routes.provide alike.
web.routes
  .provide(AuditLive)
  .get(
    paths.project,
    action(
      Effect.gen(function* () {
        const projects = yield* Projects
        const audit = yield* Audit
        const project = yield* projects.find('project-1')
        const latest = yield* audit.latest

        return yield* json({ project, latest })
      })
    )
  )

// Config names are the bindings the Hono app declares.
export const region = config.string('REGION')
// @ts-expect-error REGOIN is not a binding
config.string('REGOIN')

// Scheduled work runs with the setup's services, and only those.
export const scheduled = (env: Env['Bindings']) => web.routes.run(dbQuery((db) => db.findProject('p1')), env)

class Unprovided extends Context.Service<Unprovided, { readonly value: number }>()('app/Unprovided') {}
// @ts-expect-error Unprovided is not a service the setup provides
web.routes.run(Effect.gen(function* () { return (yield* Unprovided).value }), { REGION: 'weur', MAX_LINKS: '5' })

// Routes register only on declared paths.
// @ts-expect-error '/projets/{project}' is not a declared path
web.routes.get('/projets/{project}', action(json({})))

// Registered pages type render and the React component.
export const showProject = render('Projects/Show', { project: { id: 'p1', createdAt: new Date() } })
// @ts-expect-error 'Projects/Edit' is not a registered page
render('Projects/Edit', {})
expectType<Equals<Parameters<WebPage<'Projects/Show'>>[0]['project']['createdAt'], string>>()

// Shared props and flash data follow their schemas on the client.
expectType<Equals<SharedProps['auth']['user'], { readonly id: string; readonly name: string | null; readonly role: 'owner' | 'member' } | null>>()
expectType<Equals<SharedProps['locale'], string | undefined>>()
expectType<Equals<FlashData['success'], string | undefined>>()

// testEnv takes any of the application's bindings, with their declared types.
testEnv(signedIn({ id: 'user-1', role: 'owner', teamId: 'team-1' }), { REGION: 'weur' })
// @ts-expect-error REGIO is not a binding
testEnv(signedIn({ id: 'user-1', role: 'owner', teamId: 'team-1' }), { REGIO: 'weur' })

// A test reads flashed values with their declared types.
export const flashed = async (response: Response) => {
  const page = await readPage(response, 'Projects/Show')
  expectType<Equals<typeof page.flash.success, string | undefined>>()
  // A field error compares with a message.
  const message: string | Readonly<Record<string, string>> | undefined = page.props.errors.name
  expectType<Equals<typeof page.props.project.createdAt, string>>()
  return message
}

// Fields an application adds have no test default, so signedIn requires them.
signedIn({ id: 'user-1', role: 'owner', teamId: 'team-1' })
// @ts-expect-error role and teamId are required
signedIn({ id: 'user-1' })
