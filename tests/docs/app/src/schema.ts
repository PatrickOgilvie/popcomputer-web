// Drizzle tables the README examples refer to as `./schema`. The examples'
// database is Postgres, as `src/db.ts` in the README creates it.
import { pgTable, text } from 'drizzle-orm/pg-core'

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),
  userId: text('user_id').notNull(),
})

export const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  title: text('title').notNull(),
})
