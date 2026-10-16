import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..')

// An application's agent reads the installed copies of these documents, which
// match the installed version, so the package ships every one.
test('the package ships the documents and every file in docs/', () => {
  const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })

  expect(pack.status).toBe(0)

  const [{ files }] = JSON.parse(pack.stdout) as [{ readonly files: ReadonlyArray<{ readonly path: string }> }]
  const shipped = new Set(files.map((file) => file.path))
  const docs = readdirSync(join(repoRoot, 'docs'))
    .filter((file) => file.endsWith('.md'))
    .map((file) => `docs/${file}`)
  const documents = ['README.md', 'AGENTS.md', 'UPGRADING.md', 'CHANGELOG.md', 'skills/popcomputer-web/SKILL.md', ...docs]

  expect(documents.filter((file) => !shipped.has(file))).toEqual([])
})
