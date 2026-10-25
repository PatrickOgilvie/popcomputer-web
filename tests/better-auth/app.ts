/**
 * The application the seam tests drive: registered as docs/ registers
 * one, with each Better Auth flow written the way docs/ tells an agent
 * to write it.
 */

import { and, eq } from 'drizzle-orm'
import { Effect, Layer, Schema as S } from 'effect'
import { Hono } from 'hono'
import { setupWeb } from '../../src/setup.js'
import { action } from '../../src/effect/action.js'
import { RequireAuthLayer, RequireGuestLayer } from '../../src/effect/auth.js'
import { authorize } from '../../src/effect/services.js'
import { bound } from '../../src/effect/binding.js'
import { dbMutation, dbQuery } from '../../src/effect/database.js'
import { json, notFound, redirect, render } from '../../src/effect/responses.js'
import { validateRequest } from '../../src/effect/validation.js'
import { betterAuthCall, betterAuthHandler, betterAuthLogoutAction, betterAuthRedirect, betterAuthSession } from '../../src/auth.js'
import { currentPassword, email, password, requiredString, tableSchema } from '../../src/schema.js'
import { createAuth, loadedOnFirstUse, schema, type CreateAuthOptions, type Outbox, type TestDatabase } from './fixture.js'

export interface Bindings {
  readonly OUTBOX: Outbox
  readonly SESSION?: CreateAuthOptions['session']
  /** The origin emailed links name, a declared var as docs/setup.md declares it. */
  readonly APP_URL?: string
  /** Load Better Auth on first use, as an application keeping it out of Worker startup does. */
  readonly LAZY?: boolean
}

export const paths = {
  home: '/',
  signUp: '/sign-up',
  checkEmail: '/check-email',
  verifyEmail: '/verify-email',
  signIn: '/sign-in',
  signInAcme: '/sign-in/acme',
  twoFactor: '/two-factor',
  enableTwoFactor: '/two-factor/enable',
  magicLink: '/magic-link',
  magicLinkVerify: '/magic-link/verify',
  dashboard: '/dashboard',
  me: '/me',
  organizations: '/organizations',
  organization: '/organizations/{organization}',
  organizationInvitations: '/organizations/{organization}/invitations',
  organizationActivate: '/organizations/{organization}/activate',
  invitationAccept: '/invitations/{invitationId}/accept',
  banUser: '/admin/users/{userId}/ban',
  impersonateUser: '/admin/users/{userId}/impersonate',
  signOut: '/sign-out',
  authApi: '/api/auth/*',
} as const

export const web = setupWeb(new Hono<{ Bindings: Bindings }>(), {
  version: '1',
  render: (page) => JSON.stringify(page),
  // Each test gives its own database through testEnv's `database`.
  database: (): TestDatabase => {
    throw new Error('The seam tests give each request its database through testEnv.')
  },
  schema,
  paths,
  bindings: { organization: schema.organization },
  auth: {
    client: (c, { db }) => {
      const create = () => createAuth({ db, outbox: c.env.OUTBOX, session: c.env.SESSION, baseURL: c.env.APP_URL })

      return c.env.LAZY === true ? loadedOnFirstUse(create) : create()
    },
    session: betterAuthSession(tableSchema(schema.user), tableSchema(schema.session)),
    signInPath: paths.signIn,
    homePath: paths.dashboard,
  },
})

declare module '../../src/effect/register.js' {
  interface Register {
    web: typeof web
  }
}

export const { app, routes } = web

const SignUp = S.Struct({ name: requiredString, email, password: password({ min: 10 }), timeZone: requiredString })
const SignIn = S.Struct({ email, password: currentPassword })

const signUp = action(Effect.gen(function* () {
  const input = yield* validateRequest(SignUp)

  // Signs nobody in: Better Auth emails the link that proves the address.
  return yield* betterAuthRedirect('signUpEmail', { body: input }, {
    redirectTo: paths.checkEmail,
    errors: (error) => ({ email: error.message }),
  })
}))

/** Proves the address and signs nobody in: the member signs in with their password next. */
const verifyEmail = action(Effect.gen(function* () {
  const input = yield* validateRequest(S.Struct({ token: requiredString }))

  return yield* betterAuthRedirect('verifyEmail', { query: input }, { redirectTo: paths.signIn })
}).pipe(Effect.catchTag('ValidationError', () => render('Auth/LinkExpired'))))

const signIn = action(Effect.gen(function* () {
  const input = yield* validateRequest(SignIn)

  return yield* betterAuthRedirect('signInEmail', { body: input }, {
    // A member with two-factor on is asked for a code before being signed in.
    redirectTo: (result) => ('twoFactorRedirect' in result ? paths.twoFactor : paths.dashboard),
    errors: (error) => ({ email: error.message }),
  })
}))

const verifyTwoFactor = action(Effect.gen(function* () {
  const input = yield* validateRequest(S.Struct({ code: requiredString }))

  return yield* betterAuthRedirect('verifyBackupCode', { body: input }, {
    redirectTo: paths.dashboard,
    errors: (error) => ({ code: error.message }),
  })
}))

const enableTwoFactor = action(Effect.gen(function* () {
  yield* authorize()
  const input = yield* validateRequest(S.Struct({ password: currentPassword }))
  const enrolment = yield* betterAuthCall('enableTwoFactor', { body: input }, {
    errors: (error) => ({ password: error.message }),
  })

  return yield* json({ backupCodes: 'backupCodes' in enrolment ? enrolment.backupCodes : [] })
}))

const signInWithAcme = action(betterAuthRedirect('signInSocial', { body: { provider: 'acme', callbackURL: paths.dashboard } }, {
  redirectTo: (result) => result.url ?? paths.signIn,
}))

const sendMagicLink = action(Effect.gen(function* () {
  const input = yield* validateRequest(S.Struct({ email }))
  yield* betterAuthCall('signInMagicLink', { body: input })

  return yield* redirect(paths.home)
}))

const verifyMagicLink = action(Effect.gen(function* () {
  const input = yield* validateRequest(S.Struct({ token: requiredString }))

  return yield* betterAuthRedirect('magicLinkVerify', { query: input }, { redirectTo: paths.dashboard })
}).pipe(Effect.catchTag('ValidationError', () => render('Auth/LinkExpired'))))

/** The application's own record of each member, made on their first visit however they signed up. */
const EnsureProfile = Layer.effectDiscard(Effect.gen(function* () {
  const auth = yield* authorize()
  const [existing] = yield* dbQuery((db) => db.select().from(schema.profile).where(eq(schema.profile.userId, auth.user.id)).limit(1))

  if (existing === undefined) {
    yield* dbMutation((db) =>
      db.insert(schema.profile).values({ userId: auth.user.id, displayName: auth.user.name }).onConflictDoNothing()
    )
  }
}))

const me = action(Effect.gen(function* () {
  const auth = yield* authorize()

  return yield* json({
    id: auth.user.id,
    email: auth.user.email,
    role: auth.user.role,
    timeZone: auth.user.timeZone,
    activeOrganizationId: auth.session.activeOrganizationId,
    impersonatedBy: auth.session.impersonatedBy,
  })
}))

const createOrganization = action(Effect.gen(function* () {
  yield* authorize()
  const input = yield* validateRequest(S.Struct({ name: requiredString, slug: requiredString }))
  const created = yield* betterAuthCall('createOrganization', { body: input }, {
    errors: (error) => ({ slug: error.message }),
  })

  return yield* redirect(paths.organization, { organization: created.id })
}))

/** The signed-in member's role in the bound organization; one who is not a member is told it does not exist. */
const membership = Effect.gen(function* () {
  const auth = yield* authorize()
  const organization = yield* bound('organization')
  const [row] = yield* dbQuery((db) =>
    db.select().from(schema.member)
      .where(and(eq(schema.member.organizationId, organization.id), eq(schema.member.userId, auth.user.id)))
      .limit(1)
  )

  if (row === undefined) return yield* notFound('Organization')

  return { organization, role: row.role }
})

const showOrganization = action(Effect.gen(function* () {
  const { organization, role } = yield* membership

  return yield* render('Organizations/Show', { organization: { id: organization.id, name: organization.name }, role })
}))

const inviteMember = action(Effect.gen(function* () {
  const { organization } = yield* membership
  const input = yield* validateRequest(S.Struct({ email, role: S.Literals(['member', 'admin']) }))

  yield* betterAuthCall('createInvitation', { body: { ...input, organizationId: organization.id } }, {
    errors: (error) => ({ email: error.message }),
  })

  return yield* redirect(paths.organization, { organization: organization.id })
}))

const acceptInvitation = action(Effect.gen(function* () {
  yield* authorize()
  const input = yield* validateRequest(S.Struct({ invitationId: requiredString }))
  const accepted = yield* betterAuthCall('acceptInvitation', { body: input })

  return yield* redirect(paths.organization, { organization: accepted.member.organizationId })
}))

const activateOrganization = action(Effect.gen(function* () {
  const { organization } = yield* membership

  return yield* betterAuthRedirect('setActiveOrganization', { body: { organizationId: organization.id } }, { redirectTo: paths.me })
}))

const banUser = action(Effect.gen(function* () {
  yield* authorize((auth) => auth.user.role === 'admin')
  const input = yield* validateRequest(S.Struct({ userId: requiredString }))
  yield* betterAuthCall('banUser', { body: input })

  return yield* redirect(paths.dashboard)
}))

const impersonateUser = action(Effect.gen(function* () {
  yield* authorize((auth) => auth.user.role === 'admin')
  const input = yield* validateRequest(S.Struct({ userId: requiredString }))

  return yield* betterAuthRedirect('impersonateUser', { body: input }, { redirectTo: paths.me })
}))

routes
  .provide(RequireGuestLayer)
  .get(paths.signIn, action(render('Auth/SignIn')))
  .post(paths.signIn, signIn)
  .post(paths.signUp, signUp)
  .get(paths.checkEmail, action(render('Auth/CheckEmail')))
  .post(paths.signInAcme, signInWithAcme)
  .post(paths.twoFactor, verifyTwoFactor)
  .post(paths.magicLink, sendMagicLink)
  .get(paths.magicLinkVerify, verifyMagicLink)

routes
  .provide(RequireAuthLayer)
  .provide(EnsureProfile)
  .get(paths.dashboard, action(render('Dashboard')))
  .get(paths.me, me)

routes
  .get(paths.home, action(render('Home')))
  .get(paths.verifyEmail, verifyEmail)
  .post(paths.enableTwoFactor, enableTwoFactor)
  .post(paths.organizations, createOrganization)
  .get(paths.organization, showOrganization)
  .post(paths.organizationInvitations, inviteMember)
  .post(paths.organizationActivate, activateOrganization)
  .post(paths.invitationAccept, acceptInvitation)
  .post(paths.banUser, banUser)
  .post(paths.impersonateUser, impersonateUser)
  .post(paths.signOut, betterAuthLogoutAction({ redirectTo: paths.home }))
  // Visitors set their time zone on the sign-up form, whose action checks it, not through Better Auth's API.
  .all(paths.authApi, betterAuthHandler({ settable: [] }))

// @ts-expect-error The registered Better Auth declares timeZone, which a visitor may set: settable names those the API may set.
void betterAuthHandler()
// @ts-expect-error settable names only the fields a visitor may set: role is the admin plugin's, never input.
void betterAuthHandler({ settable: ['role'] })
// @ts-expect-error phoneNumberVerified is the phone-number plugin's, never input.
void betterAuthHandler({ settable: ['phoneNumberVerified'] })
void betterAuthHandler({ settable: ['timeZone'] })
// A plugin's field a visitor may set, such as the phone-number plugin's, is named here too.
void betterAuthHandler({ settable: ['phoneNumber'] })
