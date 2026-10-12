/**
 * Type-check every TypeScript code fence in README.md.
 *
 * Agents copy README examples verbatim, so each one must compile against the
 * current source. The fences are assembled into a small application:
 *
 * - A fence whose first line is `// src/<path>.ts` becomes that file, exactly
 *   as written. It must import everything it uses.
 * - Any other fence is a fragment. It gets a one-line prelude importing the
 *   package's public values, common Effect modules, the README's `app` and the
 *   stubs in `app/src/readme-stubs.ts`, minus names the fragment declares or
 *   imports itself. A fragment that uses `yield*` outside a generator is
 *   wrapped in `Effect.gen`.
 *
 * Diagnostics are reported against README.md line numbers.
 *
 * Run: bun tests/readme/check-readme.ts
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const repoRoot = join(import.meta.dir, '..', '..')
const readmePath = join(repoRoot, 'README.md')
const stubAppDir = join(import.meta.dir, 'app')
const outDir = join(import.meta.dir, '.generated')

interface Fence {
  /** 1-based README line of the fence's first code line. */
  readonly startLine: number
  readonly lines: ReadonlyArray<string>
}

interface OutputLine {
  readonly text: string
  /** README line this output line came from; undefined for generated lines. */
  readonly readmeLine?: number
}

const FILE_HEADER = /^\/\/ (src\/[\w./-]+\.tsx?)$/
const TS_LANGS = new Set(['ts', 'tsx', 'typescript'])

function readFences(markdown: string): Fence[] {
  const fences: Fence[] = []
  const lines = markdown.split('\n')
  let current: { lang: string; startLine: number; lines: string[] } | undefined

  lines.forEach((line, index) => {
    const fence = /^```(\w*)\s*$/.exec(line)

    if (!fence) {
      current?.lines.push(line)
      return
    }

    if (current) {
      if (TS_LANGS.has(current.lang)) {
        fences.push({ startLine: current.startLine, lines: current.lines })
      }
      current = undefined
      return
    }

    current = { lang: fence[1], startLine: index + 2, lines: [] }
  })

  return fences
}

/** Names a fragment brings into scope itself, which the prelude must not import. */
function localNames(source: string): Set<string> {
  const names = new Set<string>()

  for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from/g)) {
    for (const specifier of match[1].split(',')) {
      const name = specifier.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim()
      if (name) names.add(name)
    }
  }

  for (const match of source.matchAll(/import\s+(?:type\s+)?(?:\*\s+as\s+)?(\w+)\s+from/g)) {
    names.add(match[1])
  }

  for (const match of source.matchAll(
    /(?:^|\s)(?:const|let|var|function\*?|class|type|interface|enum)\s+(\w+)/g
  )) {
    names.add(match[1])
  }

  return names
}

function exportedNames(source: string): string[] {
  const names = new Set<string>()

  for (const match of source.matchAll(
    /^export\s+(?:declare\s+)?(?:const|function|class|interface|type)\s+(\w+)/gm
  )) {
    names.add(match[1])
  }

  for (const match of source.matchAll(/^export\s+\{([^}]*)\}/gm)) {
    for (const name of match[1].split(',')) {
      if (name.trim()) names.add(name.trim())
    }
  }

  return [...names]
}

function importLine(names: ReadonlyArray<string>, from: string): string {
  return names.length > 0 ? `import { ${names.join(', ')} } from '${from}'; ` : ''
}

function buildFragment(
  fence: Fence,
  packageValues: ReadonlyArray<string>,
  stubNames: ReadonlyArray<string>
): OutputLine[] {
  const source = fence.lines.join('\n')
  const taken = localNames(source)
  const free = (names: ReadonlyArray<string>) => names.filter((name) => !taken.has(name))

  const effectNames = free(['Effect', 'Duration', 'Layer', 'Context'])
  const fromEffect = new Set([...effectNames, 'S'])
  const prelude =
    importLine(free(packageValues).filter((name) => !fromEffect.has(name)), '@popcomputer/web') +
    importLine(effectNames, 'effect') +
    (taken.has('S') ? '' : "import { Schema as S } from 'effect'; ") +
    (taken.has('app') ? '' : "import app from '../app'; ") +
    importLine(free(stubNames), '../readme-stubs')

  // Imports stay at module scope; everything after them may need wrapping.
  let bodyStart = 0
  let inImport = false

  fence.lines.forEach((line, index) => {
    if (/^import\b/.test(line)) inImport = true
    if (inImport) {
      bodyStart = index + 1
      if (/from\s+['"][^'"]+['"]/.test(line) || /^import\s+['"]/.test(line)) inImport = false
    }
  })

  const toOutput = (line: string, index: number): OutputLine => ({
    text: line,
    readmeLine: fence.startLine + index,
  })
  const imports = fence.lines.slice(0, bodyStart).map(toOutput)
  const body = fence.lines.slice(bodyStart).map((line, index) => toOutput(line, bodyStart + index))
  const needsGenerator = /yield\*/.test(source) && !/function\*/.test(source)

  return [
    { text: prelude },
    ...imports,
    ...(needsGenerator
      ? [
          { text: 'export const readmeFragment = Effect.gen(function* () {' },
          ...body,
          { text: '})' },
        ]
      : body),
  ]
}

async function main(): Promise<number> {
  const fences = readFences(readFileSync(readmePath, 'utf8'))
  const packageModule: Record<string, unknown> = await import(join(repoRoot, 'src', 'index.ts'))
  const packageValues = Object.keys(packageModule).filter((name) => name !== 'default')
  const stubNames = exportedNames(readFileSync(join(stubAppDir, 'src', 'readme-stubs.ts'), 'utf8'))

  rmSync(outDir, { recursive: true, force: true })
  cpSync(stubAppDir, outDir, { recursive: true })

  const sourceMaps = new Map<string, ReadonlyArray<OutputLine>>()

  for (const fence of fences) {
    const header = FILE_HEADER.exec(fence.lines[0] ?? '')
    const file = header ? header[1] : `src/readme/fence-${fence.startLine}.ts`
    const target = join(outDir, file)

    if (existsSync(target)) {
      console.error(`README.md:${fence.startLine}: ${file} is defined twice (by the README or by a stub in tests/readme/app).`)
      return 1
    }

    const output = header
      ? fence.lines.map((text, index) => ({ text, readmeLine: fence.startLine + index }))
      : buildFragment(fence, packageValues, stubNames)

    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, output.map((line) => line.text).join('\n') + '\n')
    sourceMaps.set(file, output)
  }

  const src = (path: string) => join(repoRoot, 'src', path)
  writeFileSync(
    join(outDir, 'tsconfig.json'),
    JSON.stringify(
      {
        extends: join(repoRoot, 'tsconfig.json'),
        compilerOptions: {
          noEmit: true,
          declaration: false,
          rootDir: repoRoot,
          paths: {
            '@popcomputer/web': [src('index.ts')],
            '@popcomputer/web/effect': [src('effect/index.ts')],
            '@popcomputer/web/schema': [src('schema.ts')],
            '@popcomputer/web/auth': [src('auth.ts')],
            '@popcomputer/web/cache': [src('cache.ts')],
            '@popcomputer/web/react': [src('react.ts')],
            '@popcomputer/web/cli': [src('cli/index.ts')],
          },
        },
        include: ['src/**/*'],
        exclude: [],
      },
      null,
      2
    )
  )

  const tsc = join(repoRoot, 'node_modules', '.bin', 'tsc')
  const result = spawnSync(tsc, ['-p', join(outDir, 'tsconfig.json'), '--pretty', 'false'], {
    encoding: 'utf8',
  })
  const diagnostics = `${result.stdout}${result.stderr}`.trim()

  if (result.status === 0) {
    console.log(`README.md: ${fences.length} TypeScript examples type-check.`)
    return 0
  }

  // Rewrite `src/file.ts(line,col): message` to point at README.md.
  const rewritten = diagnostics.split('\n').map((line) => {
    const match = /^(.+?)\((\d+),(\d+)\): (.*)$/.exec(line)
    if (!match) return line

    const file = relative(outDir, resolve(match[1]))
    const output = sourceMaps.get(file)
    const readmeLine = output?.[Number(match[2]) - 1]?.readmeLine

    return readmeLine === undefined
      ? `${file}(${match[2]},${match[3]}) [generated by tests/readme/check-readme.ts]: ${match[4]}`
      : `README.md:${readmeLine}:${match[3]}: ${match[4]}`
  })

  console.error(rewritten.join('\n'))
  console.error(`\nREADME.md examples failed to type-check. Generated sources: ${relative(repoRoot, outDir)}`)
  return 1
}

process.exit(await main())
