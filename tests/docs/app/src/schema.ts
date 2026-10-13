// Drizzle tables the README examples refer to as `./schema`. The examples'
// database is Postgres, as `src/db.ts` in the README creates it.
import { sql } from 'drizzle-orm'
import { boolean, check, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),
  userId: text('user_id').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  title: text('title').notNull(),
})

// The README's patterns: stock a CHECK constraint keeps from going negative,
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

// Better Auth's user table, as `npx @better-auth/cli generate` writes it.
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull(),
  image: text('image'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
})

// The README's memberships pattern: a role per user and organization.
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
