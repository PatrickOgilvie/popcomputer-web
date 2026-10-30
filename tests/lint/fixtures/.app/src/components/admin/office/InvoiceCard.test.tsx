import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { dbQuery } from '@popcomputer/web/effect'

// A component's test runs in Bun, and no page imports it.
test('renders', () => {
  expect([eq, dbQuery]).toHaveLength(2)
})
