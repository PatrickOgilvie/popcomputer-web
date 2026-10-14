/**
 * Better Auth Fields Tests
 *
 * Better Auth's additionalFields come from the user table, so a user's fields
 * are declared once.
 */

import { describe, expect, test } from 'bun:test'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { betterAuthFields } from '../../src/effect/auth-fields.js'

const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  emailVerified: boolean('email_verified').notNull(),
  image: text('image'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  role: text('role', { enum: ['client', 'provider'] }).notNull().default('client'),
  timeZone: text('time_zone').notNull(),
  nickname: text('nickname'),
})

const fields = betterAuthFields(user, {
  role: { input: false },
  timeZone: { input: true },
  nickname: { input: true },
})

describe('betterAuthFields', () => {
  test('takes each field\'s type, enum values and requirement from its column', () => {
    expect(fields).toEqual({
      role: { type: ['client', 'provider'], required: false, input: false },
      timeZone: { type: 'string', required: true, input: true },
      nickname: { type: 'string', required: false, input: true },
    })
  })
})

// Better Auth types its sign-up input from the table: tsc checks this
// function's @ts-expect-error lines, and nothing calls it.
export function signUpInputIsTypedFromTheTable() {
  const auth = betterAuth({
    database: memoryAdapter({}),
    secret: 'better-auth-fields-test-secret-0123456789',
    emailAndPassword: { enabled: true },
    user: { additionalFields: fields },
  })

  type SignUpBody = NonNullable<Parameters<typeof auth.api.signUpEmail>[0]>['body']
  const signUp = (body: SignUpBody) => body

  signUp({ email: 'ada@example.com', password: 'password-123', name: 'Ada', timeZone: 'Europe/London' })
  // @ts-expect-error timeZone is required: its column is not null and has no default
  signUp({ email: 'ada@example.com', password: 'password-123', name: 'Ada' })
  // @ts-expect-error role is not an input: only the application sets it
  signUp({ email: 'ada@example.com', password: 'password-123', name: 'Ada', timeZone: 'UTC', role: 'provider' })
}
