/**
 * Classes of bug the framework does not yet guard against, from other
 * frameworks' advisories. Each `todo` names what a test will check once the
 * guard exists.
 */

import { describe, test } from 'bun:test'

describe('not yet guarded', () => {
  // Django CVE-2022-28346 and CVE-2024-42005, Drizzle CVE-2026-39356, Kysely CVE-2026-32763.
  test.todo('the lint rules report sql.identifier(), .as() or orderBy given a value the request sent')
})
