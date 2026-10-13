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
import {
  AuthUserService,
  authorize,
  bound,
  currentUser,
  type DefaultAuthUser,
} from '@popcomputer/web/effect'
import { signedIn } from '@popcomputer/web/testing'

const Project = S.Struct({ id: S.String, userId: S.String })
const routeBindings = { project: Project }

interface Member {
  readonly user: DefaultAuthUser['user'] & {
    readonly role: 'owner' | 'member'
    readonly teamId: string
  }
  readonly session: DefaultAuthUser['session']
}

declare module '@popcomputer/web/effect' {
  interface WebRouteBindingsType {
    type: typeof routeBindings
  }

  interface WebAuthUserType {
    type: Member
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

  const viewer = yield* currentUser
  expectType<Equals<typeof viewer, Member | null>>()

  const member = yield* AuthUserService
  expectType<Equals<typeof member, Member>>()
})

// Fields an application adds have no test default, so signedIn requires them.
signedIn({ id: 'user-1', role: 'owner', teamId: 'team-1' })
// @ts-expect-error role and teamId are required
signedIn({ id: 'user-1' })
