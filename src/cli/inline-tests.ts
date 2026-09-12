/* oxlint-disable effecttsgo/global-console, effecttsgo/node-builtin-import -- This CLI adapter owns native Node/Bun IO and raw command output; preserve the stdout/stderr format. */
/**
 * Inline Tests Runner Generator
 *
 * Generates a single test file that imports all action/feature modules
 * so colocated inline tests run under bun test.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface GenerateInlineTestsRunnerOptions {
  /**
   * Output path for the runner file.
   */
  output?: string
  /**
   * Directories to scan (relative to project root).
   */
  scanDirs?: string[]
}

export interface GenerateInlineTestsRunnerResult {
  /**
   * Output file path.
   */
  path: string
  /**
   * File content for the runner.
   */
  content: string
}

export interface GenerateInlineTestsRunnerCliOptions {
  /**
   * Output path for the runner file.
   */
  output?: string
  /**
   * Directories to scan (comma-separated in CLI usage).
   */
  scanDirs?: string[]
  /**
   * Preview content without writing a file.
   */
  preview?: boolean
  /**
   * Output JSON instead of text.
   */
  json?: boolean
}

const DEFAULT_OUTPUT = 'tests/inline-actions.test.ts'

const DEFAULT_SCAN_DIRS = ['src/actions', 'src/features']

/**
 * Generate a runner that loads all colocated inline tests.
 */
export function generateInlineTestsRunner(
  options: GenerateInlineTestsRunnerOptions = {}
): GenerateInlineTestsRunnerResult {
  const output = options.output ?? DEFAULT_OUTPUT
  const scanDirs = options.scanDirs ?? DEFAULT_SCAN_DIRS

  const content = `/**
 * Colocated Inline Tests Runner
 *
 * Loads action/feature modules so inline tests register with Bun.
 */

import { readdirSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testsDir = fileURLToPath(new URL('.', import.meta.url))
const projectRoot = resolve(testsDir, '..')
const scanDirs = ${JSON.stringify(scanDirs)}
const validExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

const files: string[] = []

const walk = (dir: string) => {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const fullPath = join(dir, entry.name)

    if (entry.isDirectory()) {
      walk(fullPath)
      continue
    }

    if (!entry.isFile()) continue
    if (entry.name.endsWith('.d.ts')) continue
    if (entry.name.includes('.test.') || entry.name.includes('.spec.')) continue
    if (!validExts.has(extname(entry.name))) continue

    files.push(fullPath)
  }
}

for (const dir of scanDirs) {
  walk(resolve(projectRoot, dir))
}

await Promise.all(files.map((file) => import(pathToFileURL(file).href)))
`

  return { path: output, content }
}

/**
 * Parse CLI arguments for inline tests runner generation.
 */
export function parseGenerateInlineTestsRunnerArgs(
  args: string[]
): GenerateInlineTestsRunnerCliOptions {
  const options: GenerateInlineTestsRunnerCliOptions = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    switch (arg) {
      case '--output':
      case '-o':
        options.output = args[++i]
        break
      case '--scan':
        options.scanDirs = args[++i]?.split(',').filter(Boolean)
        break
      case '--preview':
        options.preview = true
        break
      case '--json':
        options.json = true
        break
    }
  }

  return options
}

/**
 * Get help text for inline tests runner generation.
 */
export function generateInlineTestsRunnerHelp(): string {
  return `
popweb generate:tests-runner - Generate inline tests runner

USAGE:
  popweb generate:tests-runner [OPTIONS]

OPTIONS:
  -o, --output   Output file path (default: tests/inline-actions.test.ts)
  --scan         Directories to scan (comma-separated)
  --preview      Preview output without writing file
  --json         Output as JSON (machine-readable)

EXAMPLES:
  popweb generate:tests-runner
  popweb generate:tests-runner --scan src/actions,src/features
  popweb generate:tests-runner --preview
`.trim()
}

/**
 * Run the inline tests runner generation from CLI arguments.
 */
export function runGenerateInlineTestsRunner(args: string[] = []): void {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(generateInlineTestsRunnerHelp())

    return
  }

  const cliOptions = parseGenerateInlineTestsRunnerArgs(args)

  const result = generateInlineTestsRunner({
    output: cliOptions.output,
    scanDirs: cliOptions.scanDirs,
  })

  if (cliOptions.json) {
    console.log(JSON.stringify(result, null, 2))

    return
  }

  if (cliOptions.preview) {
    console.log(`Preview: ${result.path}`)
    console.log('-'.repeat(50))
    console.log(result.content)

    return
  }

  mkdirSync(dirname(result.path), { recursive: true })
  writeFileSync(result.path, result.content, 'utf-8')

  console.log(`Generated: ${result.path}`)
  console.log('Inline tests will run when you execute: bun test')
}
