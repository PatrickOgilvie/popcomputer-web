// Drizzle tables the documents' examples refer to as `./schema`. The examples'
// database is Postgres, as `src/db.ts` in docs/setup.md creates it.
import { sql } from 'drizzle-orm'
import { boolean, check, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from './auth-schema'

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),
  userId: text('user_id').notNull().references(() => user.id),
  isPublic: boolean('is_public').notNull().default(false),
  archivedAt: timestamp('archived_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  title: text('title').notNull(),
})

// The documented patterns: stock a CHECK constraint keeps from going negative,
// orders with a unique idempotency key, and webhook events seen once.
export const products = pgTable(
  'products',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    stock: integer('stock').notNull(),
  },
  (table) => [check('stock_not_negative', sql`${table.stock} >= 0`)]
)

export const orders = pgTable('orders', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  productId: text('product_id').notNull(),
  quantity: integer('quantity').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  paidAt: timestamp('paid_at'),
})

export const webhookEvents = pgTable('webhook_events', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull(),
})

// Better Auth's tables, as docs/auth-tables.md's src/auth-schema.ts declares them.
export * from './auth-schema'

// docs/guards.md's memberships pattern: a role per user and organization.
export const organizations = pgTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
})

export const memberships = pgTable(
  'memberships',
  {
    organizationId: text('organization_id').notNull().references(() => organizations.id),
    userId: text('user_id').notNull().references(() => user.id),
    role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.userId] })]
)

// docs/sign-in.md's first-visit record: the application's own row for each user.
export const profiles = pgTable('profiles', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
})
