/**
 * Generate the agent skill from AGENTS.md.
 *
 * skills/popcomputer-web/SKILL.md is AGENTS.md with skill frontmatter and a
 * short preamble, so the skill and the package's rules cannot drift.
 * tests/docs/skill.test.ts fails when the committed file is stale.
 *
 * Run: bun scripts/build-skill.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..')

export const SKILL_PATH = join(repoRoot, 'skills', 'popcomputer-web', 'SKILL.md')

const FRONTMATTER = `---
name: popcomputer-web
description: Rules and a canonical action for building applications on @popcomputer/web (formerly honertia), the Effect-native, server-driven web framework on Hono, Inertia, Better Auth, Drizzle and Cloudflare Workers. Use whenever writing or changing code in a project whose package.json depends on @popcomputer/web or honertia - actions, routes, pages, validation, route model binding, auth, database writes, caching, background work or tests - and when the user mentions popcomputer, @popcomputer/web, popweb or honertia. Do not use for plain Hono APIs without Inertia or Effect projects without this framework.
---`

const PREAMBLE = `These rules are the package's \`AGENTS.md\`. When the project has
\`node_modules/@popcomputer/web/AGENTS.md\`, read that copy: it matches the
installed version. For a new application, follow the Quick start in
\`node_modules/@popcomputer/web/README.md\`.

A project on an earlier release, or one that imports from \`honertia\`, the
framework's former package, upgrades first: follow \`UPGRADING.md\`, in
\`node_modules/@popcomputer/web/\` once 1.2.1 or later is installed and at
https://github.com/PatrickOgilvie/popcomputer-web/blob/main/UPGRADING.md. It
also moves the project's own code from Effect 3 to Effect 4.`

/** The skill file for the given AGENTS.md text. */
export function renderSkill(agents: string): string {
  const lines = agents.split('\n')
  const title = lines[0]
  // Drop the paragraph telling applications how to reference AGENTS.md; the
  // skill is that reference.
  const body = lines
    .slice(1)
    .join('\n')
    .replace(/\nTo use this file, point[\s\S]*?\n\n/, '\n')
    .trim()

  return `${FRONTMATTER}\n\n${title}\n\n${PREAMBLE}\n\n${body}\n`
}

if (import.meta.main) {
  writeFileSync(SKILL_PATH, renderSkill(readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8')))
  console.log(`Wrote ${SKILL_PATH}`)
}
