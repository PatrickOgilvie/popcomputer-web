/**
 * Type-check every test file, each in its own program.
 *
 * Bun strips types without checking them, so a test can compile in Bun and
 * still contradict the package's types, and agents copy patterns from tests.
 * Test files augment the package's types differently (WebDatabaseType,
 * WebAuthUserType, ...), so each file is checked with the sources alone.
 *
 * Run: bun tests/typecheck-tests.ts [test files...]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..')
const configDir = join(import.meta.dir, '.typecheck')
const tsc = join(repoRoot, 'node_modules', '.bin', 'tsc')

const requested = process.argv.slice(2)

const files = requested.length > 0
  ? requested
  : (await Array.fromAsync(new Bun.Glob('tests/**/*.ts').scan({ cwd: repoRoot })))
      // Lint fixtures are source text for the lint rules, not programs.
      .filter((file) => !file.startsWith('tests/docs/') && !file.startsWith('tests/.') && !file.startsWith('tests/lint/fixtures/'))
      .sort()

function check(file: string): Promise<{ file: string; ok: boolean; output: string }> {
  const config = join(configDir, `${file.replaceAll('/', '_')}.json`)

  writeFileSync(config, JSON.stringify({
    extends: join(repoRoot, 'tsconfig.type-tests.json'),
    compilerOptions: { rootDir: repoRoot, typeRoots: [join(repoRoot, 'node_modules', '@types')] },
    include: [join(repoRoot, 'src', '**', '*'), join(repoRoot, file)],
    exclude: [],
  }))

  return new Promise((resolve) => {
    const child = spawn(tsc, ['-p', config, '--pretty', 'false'], { cwd: repoRoot })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('close', (code) => resolve({ file, ok: code === 0, output: output.trim() }))
  })
}

rmSync(configDir, { recursive: true, force: true })
mkdirSync(configDir, { recursive: true })

const results: Array<{ file: string; ok: boolean; output: string }> = []
const width = Math.max(1, availableParallelism() - 1)

for (let index = 0; index < files.length; index += width) {
  results.push(...(await Promise.all(files.slice(index, index + width).map(check))))
}

rmSync(configDir, { recursive: true, force: true })

const failed = results.filter((result) => !result.ok)

for (const result of failed) {
  console.error(`\n${result.file}\n${result.output}`)
}

console.log(`${results.length - failed.length}/${results.length} test files type-check.`)
process.exit(failed.length === 0 ? 0 : 1)
