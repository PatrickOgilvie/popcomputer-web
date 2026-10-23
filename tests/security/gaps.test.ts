/**
 * Classes of bug the framework does not yet guard against, from other
 * frameworks' advisories. Each `todo` names what a test will check once the
 * guard exists.
 */

import { describe, test } from 'bun:test'

describe('not yet guarded', () => {
  // Starlette CVE-2024-47874 and CVE-2026-54283, Hono CVE-2026-44456, SvelteKit CVE-2026-40073:
  // validateRequest reads within setupWeb's bodyLimit (sizes.test.ts), but betterAuthHandler
  // reads a sign-in's body, and Better Auth reads every body it is handed, whole.
  test.todo("a body over the limit sent to betterAuthHandler is refused with 413 before it or Better Auth reads it")

  // Django CVE-2022-28346 and CVE-2024-42005, Drizzle CVE-2026-39356, Kysely CVE-2026-32763.
  test.todo('the lint rules report sql.identifier(), .as() or orderBy given a value the request sent')
})
