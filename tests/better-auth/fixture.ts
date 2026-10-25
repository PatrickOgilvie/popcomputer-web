/* oxlint-disable effecttsgo/async-function -- Better Auth's callbacks and the test database are native Promise contracts. */
/**
 * A Better Auth application as docs/ builds one, with the plugins
 * power users reach for: organizations, two-factor, magic links, email and
 * phone one-time codes, an OAuth provider (which tests stand in for), bearer
 * tokens and admin. Its tables are docs/auth-tables.md's D1 tables
 * with the plugins' columns, on SQLite through Drizzle, as on D1.
 */

import { Database } from 'bun:sqlite'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin, bearer, emailOTP, genericOAuth, magicLink, organization, phoneNumber, twoFactor } from 'better-auth/plugins'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { betterAuthFields } from '../../src/auth.js'
import { testOAuthProvider } from '../../src/testing.js'
import { getTableConfig, index, integer, sqliteTable, text, type SQLiteTable } from 'drizzle-orm/sqlite-core'

const createdAt = () => integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date())
const updatedAt = () => integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date())

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  // twoFactor()
  twoFactorEnabled: integer('two_factor_enabled', { mode: 'boolean' }).default(false),
  // admin()
  role: text('role'),
  banned: integer('banned', { mode: 'boolean' }).default(false),
  banReason: text('ban_reason'),
  banExpires: integer('ban_expires', { mode: 'timestamp_ms' }),
  // phoneNumber()
  phoneNumber: text('phone_number').unique(),
  phoneNumberVerified: integer('phone_number_verified', { mode: 'boolean' }),
  // The application's own field, which a visitor chooses when signing up.
  timeZone: text('time_zone'),
})

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    // organization()
    activeOrganizationId: text('active_organization_id'),
    // admin()
    impersonatedBy: text('impersonated_by'),
  },
  (table) => [index('session_user_id_idx').on(table.userId)]
)

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const rateLimit = sqliteTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: integer('last_request').notNull(),
})

export const organizationTable = sqliteTable('organization', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  createdAt: createdAt(),
  metadata: text('metadata'),
})

export const member = sqliteTable('member', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizationTable.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  createdAt: createdAt(),
})

export const invitation = sqliteTable('invitation', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizationTable.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role'),
  status: text('status').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: createdAt(),
  inviterId: text('inviter_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
})

export const twoFactorTable = sqliteTable('two_factor', {
  id: text('id').primaryKey(),
  secret: text('secret').notNull(),
  backupCodes: text('backup_codes').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  verified: integer('verified', { mode: 'boolean' }).default(true),
  failedVerificationCount: integer('failed_verification_count').default(0),
  lockedUntil: integer('locked_until', { mode: 'timestamp_ms' }),
})

/** The application's own record for each user, which Better Auth never writes. */
export const profile = sqliteTable('profile', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
  createdAt: createdAt(),
})

export const schema = {
  user,
  session,
  account,
  verification,
  rateLimit,
  organization: organizationTable,
  member,
  invitation,
  twoFactor: twoFactorTable,
  profile,
}

/** CREATE TABLE statements for SQLite tables, from their Drizzle declarations. */
export function createTableStatements(tables: ReadonlyArray<SQLiteTable>): string[] {
  return tables.map((table) => {
    const config = getTableConfig(table)
    const columns = config.columns.map((column) => {
      const parts = [`"${column.name}"`, column.getSQLType()]
      if (column.primary) parts.push('PRIMARY KEY')
      if (column.notNull) parts.push('NOT NULL')
      if (column.isUnique) parts.push('UNIQUE')

      const fallback: unknown = column.default
      if (typeof fallback === 'boolean') parts.push(`DEFAULT ${fallback ? 1 : 0}`)
      if (typeof fallback === 'number') parts.push(`DEFAULT ${fallback}`)

      return parts.join(' ')
    })

    return `CREATE TABLE "${config.name}" (${columns.join(', ')})`
  })
}

export function createDatabase() {
  const sqlite = new Database(':memory:')

  for (const statement of createTableStatements(Object.values(schema))) sqlite.run(statement)

  return drizzle(sqlite, { schema })
}

export type TestDatabase = ReturnType<typeof createDatabase>

/** What Better Auth sent: the emails an application would deliver. */
export interface Outbox {
  readonly verifications: Array<{ readonly email: string; readonly token: string }>
  readonly magicLinks: Array<{ readonly email: string; readonly token: string; readonly url: string }>
  readonly invitations: Array<{ readonly id: string; readonly email: string }>
  /** One-time codes, emailed or texted: `to` is the address or the phone number. */
  readonly codes: Array<{ readonly to: string; readonly code: string }>
}

export const newOutbox = (): Outbox => ({ verifications: [], magicLinks: [], invitations: [], codes: [] })

/** Acme, an OAuth provider the application signs people in with, which tests stand in for. */
const ACME = {
  authorizationUrl: 'https://acme.example/authorize',
  tokenUrl: 'https://acme.example/token',
  userInfoUrl: 'https://acme.example/userinfo',
}

export const acme = testOAuthProvider({ ...ACME, client: { id: 'acme-client', secret: 'acme-secret' } })

export interface CreateAuthOptions {
  readonly db: TestDatabase
  readonly outbox: Outbox
  /** The origin emailed links name: the application's declared APP_URL, as docs/setup.md gives it. */
  readonly baseURL?: string
  readonly session?: { readonly updateAge?: number; readonly cookieCache?: { readonly enabled: boolean; readonly maxAge?: number } }
}

/** The application's Better Auth secret, which signs its session cookies whatever its template. */
export const SECRET = 'better-auth-seam-test-secret-with-enough-entropy-0123'

export function createAuth(options: CreateAuthOptions) {
  return betterAuth({
    database: drizzleAdapter(options.db, { provider: 'sqlite', schema }),
    baseURL: options.baseURL ?? 'http://localhost',
    secret: SECRET,
    // docs/auth.md's createAuth: a password signs in only once its address is
    // proven, and following the link signs nobody in.
    emailAndPassword: { enabled: true, requireEmailVerification: true },
    emailVerification: {
      sendVerificationEmail: async ({ user, token }) => {
        options.outbox.verifications.push({ email: user.email, token })
      },
    },
    // A member may move their account to another address, which its emailed link proves.
    user: { additionalFields: betterAuthFields(user, { timeZone: { input: true } }), changeEmail: { enabled: true } },
    session: options.session,
    rateLimit: { enabled: false },
    logger: { disabled: true },
    plugins: [
      organization({
        sendInvitationEmail: async (data) => {
          options.outbox.invitations.push({ id: data.id, email: data.email })
        },
      }),
      twoFactor({ skipVerificationOnEnable: true }),
      magicLink({
        sendMagicLink: async ({ email, token, url }) => {
          options.outbox.magicLinks.push({ email, token, url })
        },
      }),
      emailOTP({
        sendVerificationOTP: async ({ email, otp }) => {
          options.outbox.codes.push({ to: email, code: otp })
        },
      }),
      phoneNumber({
        sendOTP: async ({ phoneNumber, code }) => {
          options.outbox.codes.push({ to: phoneNumber, code })
        },
        // A first verified code makes the user, as a phone-only sign-up does.
        signUpOnVerification: { getTempEmail: (phone) => `${phone.replace(/\D/g, '')}@phone.example` },
      }),
      bearer(),
      admin(),
      genericOAuth({
        config: [{
          providerId: 'acme',
          clientId: 'acme-client',
          clientSecret: 'acme-secret',
          ...ACME,
          pkce: true,
        }],
      }),
    ],
  })
}

export type TestAuth = ReturnType<typeof createAuth>

/**
 * Better Auth loaded on first use, as an application wraps it to keep it out
 * of a Worker's startup: `auth.api`'s endpoints are functions that load it,
 * without the endpoints' own properties, such as their `path`.
 */
export function loadedOnFirstUse(load: () => TestAuth): TestAuth {
  let instance: TestAuth | undefined
  const auth = () => (instance ??= load())
  const api = new Proxy({}, {
    // `then` stays undefined, or `await auth.api` would treat it as a promise.
    get: (_target, name) => name === 'then'
      ? undefined
      : (...args: ReadonlyArray<unknown>) => Reflect.apply(Reflect.get(auth().api, name), auth().api, args),
  })

  // SAFETY: the wrapper answers every endpoint and request as the instance does; it lacks only the endpoints' own properties, which is the case under test.
  return { api, handler: (request: Request) => auth().handler(request) } as unknown as TestAuth
}
