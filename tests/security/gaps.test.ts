/**
 * Classes of bug the framework does not yet guard against, from other
 * frameworks' advisories. Each `todo` names what a test will check once the
 * guard exists.
 */

import { describe, test } from 'bun:test'

describe('not yet guarded', () => {
  // Starlette CVE-2024-47874 and CVE-2026-54283, Hono CVE-2026-44456, SvelteKit CVE-2026-40073.
  test.todo('a JSON or form body over the configured limit is refused with 413 before an action reads it, chunked or not')

  // Django CVE-2022-28346 and CVE-2024-42005, Drizzle CVE-2026-39356, Kysely CVE-2026-32763.
  test.todo('the lint rules report sql.identifier(), .as() or orderBy given a value the request sent')
})
