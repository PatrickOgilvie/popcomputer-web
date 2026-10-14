/* oxlint-disable effecttsgo/async-function -- Better Auth's callbacks and the test database are native Promise contracts. */
/**
 * A Better Auth application as the README builds one, with the plugins
 * power users reach for: organizations, two-factor, magic links, an OAuth
 * provider (which tests stand in for), bearer tokens and admin. Its tables are the README's D1 tables
 * with the plugins' columns, on SQLite through Drizzle, as on D1.
 */

import { Database } from 'bun:sqlite'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin, bearer, genericOAuth, magicLink, organization, twoFactor } from 'better-auth/plugins'
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
  readonly magicLinks: Array<{ readonly email: string; readonly token: string }>
  readonly invitations: Array<{ readonly id: string; readonly email: string }>
}

export const newOutbox = (): Outbox => ({ magicLinks: [], invitations: [] })

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
  readonly session?: { readonly updateAge?: number; readonly cookieCache?: { readonly enabled: boolean; readonly maxAge?: number } }
}

export function createAuth(options: CreateAuthOptions) {
  return betterAuth({
    database: drizzleAdapter(options.db, { provider: 'sqlite', schema }),
    baseURL: 'http://localhost',
    secret: 'better-auth-seam-test-secret-with-enough-entropy-0123',
    emailAndPassword: { enabled: true },
    user: { additionalFields: betterAuthFields(user, { timeZone: { input: true } }) },
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
        sendMagicLink: async ({ email, token }) => {
          options.outbox.magicLinks.push({ email, token })
        },
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
