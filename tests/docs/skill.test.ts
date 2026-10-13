import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderSkill, SKILL_PATH } from '../../scripts/build-skill.js'

test('skills/popcomputer-web/SKILL.md is generated from the current AGENTS.md', () => {
  const agents = readFileSync(join(import.meta.dir, '..', '..', 'AGENTS.md'), 'utf8')

  // Run `bun scripts/build-skill.ts` after changing AGENTS.md.
  expect(readFileSync(SKILL_PATH, 'utf8')).toBe(renderSkill(agents))
})
