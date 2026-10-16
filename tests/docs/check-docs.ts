/**
 * Type-check every TypeScript code fence in README.md, AGENTS.md, UPGRADING.md
 * and docs/*.md, and check the links between them.
 *
 * Agents copy these examples verbatim, so each one must compile against the
 * package as an application installs it: the declarations in `dist`, which
 * `bun run build` emits. Types that depend on an application's augmentations
 * (WebRouteBindingsType, WebAuthUserType, ...) must survive declaration emit,
 * and only a check against `dist` sees that. The fences of every document are
 * assembled into one small application:
 *
 * - A fence whose first line is `// src/<path>.ts` becomes that file, exactly
 *   as written. It must import everything it uses.
 * - Any other fence is a fragment. It gets a one-line prelude importing every
 *   entrypoint's public values, common Effect modules, the Quick start's `app` and the
 *   stubs in `app/src/doc-stubs.ts`, minus names the fragment declares or
 *   imports itself. A fragment that uses `yield*` outside a generator is
 *   wrapped in `Effect.gen`.
 *
 * Diagnostics are reported against document line numbers.
 *
 * Before type-checking, every relative link must name a file that exists and,
 * with `#anchor`, one of its headings; every file in docs/ must be linked from
 * the README and hold at most MAX_DOC_LINES lines, so an agent reads one task
 * in one fetch.
 *
 * Run: bun run build && bun tests/docs/check-docs.ts
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { rules as lintRules } from '../../src/lint/index.js'

const repoRoot = join(import.meta.dir, '..', '..')
const docs = readdirSync(join(repoRoot, 'docs'))
  .filter((file) => file.endsWith('.md'))
  .sort()
  .map((file) => `docs/${file}`)
const documents = ['README.md', 'AGENTS.md', 'UPGRADING.md', ...docs]
/** The most lines a file in docs/ may hold. */
const MAX_DOC_LINES = 250
const stubAppDir = join(import.meta.dir, 'app')
const outDir = join(import.meta.dir, '.generated')

interface Fence {
  readonly document: string
  /** 1-based document line of the fence's first code line. */
  readonly startLine: number
  readonly lines: ReadonlyArray<string>
}

interface OutputLine {
  readonly text: string
  /** Document location this output line came from; undefined for generated lines. */
  readonly source?: { readonly document: string; readonly line: number }
}

const FILE_HEADER = /^\/\/ (src\/[\w./-]+\.tsx?)$/

/** Package entrypoints and the built module each one serves, without extension. */
const ENTRYPOINTS: Readonly<Record<string, string>> = {
  '@popcomputer/web': 'index',
  '@popcomputer/web/effect': 'effect/index',
  '@popcomputer/web/schema': 'schema',
  '@popcomputer/web/auth': 'auth',
  '@popcomputer/web/cache': 'cache',
  '@popcomputer/web/testing': 'testing',
  '@popcomputer/web/react': 'react',
  '@popcomputer/web/paths': 'paths',
  '@popcomputer/web/endpoint': 'endpoint',
}
const dist = (module: string, extension: '.js' | '.d.ts') => join(repoRoot, 'dist', `${module}${extension}`)
const TS_LANGS = new Set(['ts', 'tsx', 'typescript'])

function readFences(document: string, markdown: string): Fence[] {
  const fences: Fence[] = []
  const lines = markdown.split('\n')
  let current: { lang: string; indent: string; startLine: number; lines: string[] } | undefined

  lines.forEach((line, index) => {
    // A fence may be indented, as one inside a list item is; its code is read without the indent.
    const fence = /^( *)```(\w*)\s*$/.exec(line)

    if (!fence) {
      current?.lines.push(line.startsWith(current.indent) ? line.slice(current.indent.length) : line)
      return
    }

    if (current) {
      if (TS_LANGS.has(current.lang)) {
        fences.push({ document, startLine: current.startLine, lines: current.lines })
      }
      current = undefined
      return
    }

    current = { lang: fence[2] ?? '', indent: fence[1] ?? '', startLine: index + 2, lines: [] }
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

  // Destructured: const { app, routes } = web.services(...)
  for (const match of source.matchAll(/(?:^|\s)(?:const|let|var)\s+\{([^}]*)\}\s*=/g)) {
    for (const binding of match[1].split(',')) {
      const name = binding.split(':').pop()?.split('=')[0]?.trim()
      if (name) names.add(name)
    }
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
  entrypointValues: ReadonlyMap<string, ReadonlyArray<string>>,
  stubNames: ReadonlyArray<string>
): OutputLine[] {
  const source = fence.lines.join('\n')
  const taken = localNames(source)
  const free = (names: ReadonlyArray<string>) => names.filter((name) => !taken.has(name))

  const effectNames = free(['Effect', 'Duration', 'Layer', 'Context'])
  const fromEffect = new Set([...effectNames, 'S'])
  const prelude =
    [...entrypointValues]
      .map(([entrypoint, names]) =>
        // A fragment's `web` is the application's, not the `web()` middleware.
        importLine(free(names).filter((name) => !fromEffect.has(name) && name !== 'web'), entrypoint)
      )
      .join('') +
    importLine(effectNames, 'effect') +
    (taken.has('S') ? '' : "import { Schema as S } from 'effect'; ") +
    (taken.has('app') ? '' : "import app from '../app'; ") +
    (taken.has('routes') ? '' : "import { routes } from '../app'; ") +
    (taken.has('web') ? '' : "import { web } from '../app'; ") +
    importLine(free(stubNames), '../doc-stubs')

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
    source: { document: fence.document, line: fence.startLine + index },
  })
  const imports = fence.lines.slice(0, bodyStart).map(toOutput)
  const body = fence.lines.slice(bodyStart).map((line, index) => toOutput(line, bodyStart + index))
  const needsGenerator = /yield\*/.test(source) && !/function\*/.test(source)

  return [
    { text: prelude },
    ...imports,
    ...(needsGenerator
      ? [
          { text: 'export const documentFragment = Effect.gen(function* () {' },
          ...body,
          { text: '})' },
        ]
      : body),
  ]
}

/** A heading's anchor as GitHub writes it: lower case, punctuation dropped, spaces as hyphens. */
function slug(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\- _]/gu, '').replaceAll(' ', '-')
}

/** The lines of a document outside its code fences, with their 1-based line numbers. */
function prose(markdown: string): Array<{ readonly line: number; readonly text: string }> {
  const lines: Array<{ readonly line: number; readonly text: string }> = []
  let inFence = false

  markdown.split('\n').forEach((text, index) => {
    if (/^ *```/.test(text)) {
      inFence = !inFence
      return
    }
    if (!inFence) lines.push({ line: index + 1, text })
  })

  return lines
}

/** The anchors a document's headings give, numbered as GitHub numbers repeats. */
function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>()
  const result = new Set<string>()

  for (const { text } of prose(markdown)) {
    const heading = /^#{1,6} (.+)$/.exec(text)
    if (!heading) continue

    const base = slug(heading[1])
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    result.add(count === 0 ? base : `${base}-${count}`)
  }

  return result
}

/**
 * Every relative link names a file that exists, and an anchor names one of
 * its headings; every file in docs/ is linked from the README; and no file in
 * docs/ holds more than MAX_DOC_LINES lines.
 */
function checkLinks(): number {
  const failures: string[] = []
  const anchorCache = new Map<string, Set<string>>()
  const anchorsOf = (file: string) => {
    if (!anchorCache.has(file)) anchorCache.set(file, anchors(readFileSync(join(repoRoot, file), 'utf8')))
    return anchorCache.get(file)!
  }
  const linkedFromReadme = new Set<string>()

  for (const document of documents) {
    const markdown = readFileSync(join(repoRoot, document), 'utf8')

    for (const { line, text } of prose(markdown)) {
      // Code spans can hold text that looks like a link.
      const withoutCode = text.replace(/`[^`]*`/g, '``')

      for (const match of withoutCode.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = match[1]
        if (/^[a-z]+:/.test(target)) continue

        const [path, anchor] = target.split('#') as [string, string | undefined]
        const file = path === '' ? document : relative(repoRoot, resolve(repoRoot, dirname(document), path))

        if (!existsSync(join(repoRoot, file))) {
          failures.push(`${document}:${line}: ${target} links to ${file}, which does not exist.`)
          continue
        }
        if (document === 'README.md') linkedFromReadme.add(file)
        if (anchor !== undefined && !(file.endsWith('.md') && anchorsOf(file).has(anchor))) {
          failures.push(`${document}:${line}: ${target} links to #${anchor}, which no heading of ${file} gives.`)
        }
      }
    }
  }

  for (const document of docs) {
    const lines = readFileSync(join(repoRoot, document), 'utf8').trimEnd().split('\n').length

    if (!linkedFromReadme.has(document)) {
      failures.push(`${document}: README.md's documentation list does not link to it.`)
    }
    if (lines > MAX_DOC_LINES) {
      failures.push(`${document}: ${lines} lines. A file in docs/ holds one task in at most ${MAX_DOC_LINES}, so split it.`)
    }
  }

  if (failures.length > 0) {
    console.error(failures.join('\n'))
    return 1
  }

  console.log(`${documents.length} documents: every link resolves, and every file in docs/ is linked and at most ${MAX_DOC_LINES} lines.`)
  return 0
}

async function main(): Promise<number> {
  if (checkLinks() !== 0) return 1

  const fences = documents.flatMap((document) =>
    readFences(document, readFileSync(join(repoRoot, document), 'utf8'))
  )
  const entrypointValues = new Map<string, ReadonlyArray<string>>()

  for (const [entrypoint, module] of Object.entries(ENTRYPOINTS)) {
    if (!existsSync(dist(module, '.d.ts'))) {
      console.error(`${entrypoint}: ${relative(repoRoot, dist(module, '.d.ts'))} is missing. Run \`bun run build\` first.`)
      return 1
    }
  }

  for (const [entrypoint, source] of Object.entries(ENTRYPOINTS)) {
    const module: Record<string, unknown> = await import(dist(source, '.js'))
    entrypointValues.set(entrypoint, Object.keys(module).filter((name) => name !== 'default'))
  }
  const stubNames = exportedNames(readFileSync(join(stubAppDir, 'src', 'doc-stubs.ts'), 'utf8'))

  rmSync(outDir, { recursive: true, force: true })
  cpSync(stubAppDir, outDir, { recursive: true })

  const sourceMaps = new Map<string, ReadonlyArray<OutputLine>>()

  for (const fence of fences) {
    const header = FILE_HEADER.exec(fence.lines[0] ?? '')
    const fragmentName = fence.document.replace(/\.md$/, '').toLowerCase().replaceAll('/', '-')
    const file = header ? header[1] : `src/fragments/${fragmentName}-${fence.startLine}.ts`
    const target = join(outDir, file)

    if (existsSync(target)) {
      console.error(`${fence.document}:${fence.startLine}: ${file} is defined twice (by a document or by a stub in tests/docs/app).`)
      return 1
    }

    const output = header
      ? fence.lines.map((text, index) => ({
          text,
          source: { document: fence.document, line: fence.startLine + index },
        }))
      : buildFragment(fence, entrypointValues, stubNames)

    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, output.map((line) => line.text).join('\n') + '\n')
    sourceMaps.set(file, output)
  }

  writeFileSync(
    join(outDir, 'tsconfig.json'),
    JSON.stringify(
      {
        extends: join(repoRoot, 'tsconfig.json'),
        compilerOptions: {
          noEmit: true,
          declaration: false,
          jsx: 'react-jsx',
          rootDir: repoRoot,
          paths: Object.fromEntries(
            Object.entries(ENTRYPOINTS).map(([entrypoint, module]) => [entrypoint, [dist(module, '.d.ts')]])
          ),
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
    console.log(`${documents.length} documents: ${fences.length} TypeScript examples type-check.`)
    return lintExamples(sourceMaps)
  }

  // Rewrite `src/file.ts(line,col): message` to point at the document.
  const rewritten = diagnostics.split('\n').map((line) => {
    const match = /^(.+?)\((\d+),(\d+)\): (.*)$/.exec(line)
    if (!match) return line

    const file = relative(outDir, resolve(match[1]))
    const output = sourceMaps.get(file)
    const source = output?.[Number(match[2]) - 1]?.source

    return source === undefined
      ? `${file}(${match[2]},${match[3]}) [generated by tests/docs/check-docs.ts]: ${match[4]}`
      : `${source.document}:${source.line}:${match[3]}: ${match[4]}`
  })

  console.error(rewritten.join('\n'))
  console.error(`\nDocumentation examples failed to type-check. Generated sources: ${relative(repoRoot, outDir)}`)
  return 1
}

/**
 * Lint the examples with the package's own rules: the code agents copy must
 * follow the rules the package asks them to run.
 */
function lintExamples(sourceMaps: ReadonlyMap<string, ReadonlyArray<OutputLine>>): number {
  const config = join(outDir, 'oxlintrc.json')
  const rules = Object.fromEntries(Object.keys(lintRules).map((name) => [`popcomputer-web/${name}`, 'error']))

  writeFileSync(config, JSON.stringify({
    categories: { correctness: 'off' },
    jsPlugins: [{ name: 'popcomputer-web', specifier: dist('lint/index', '.js') }],
    rules,
  }))

  const oxlint = join(repoRoot, 'node_modules', '.bin', 'oxlint')
  // Named one by one: Oxlint skips the files of a hidden directory it walks.
  const files = [...sourceMaps.keys()].filter((file) => /\.tsx?$/.test(file))
  const result = spawnSync(oxlint, ['--disable-nested-config', '--no-ignore', '--config', config, '--format', 'json', ...files], {
    cwd: outDir,
    encoding: 'utf8',
  })
  const report: { diagnostics?: ReadonlyArray<{ code: string; message: string; filename: string; labels: ReadonlyArray<{ span: { line: number } }> }> } =
    JSON.parse(result.stdout || '{}')
  const diagnostics = report.diagnostics ?? []

  if (report.diagnostics === undefined && result.status !== 0) {
    console.error(result.stderr)
    return 1
  }

  if (diagnostics.length === 0) {
    console.log(`${documents.length} documents: examples follow the package's lint rules.`)
    return 0
  }

  for (const diagnostic of diagnostics) {
    const line = diagnostic.labels[0]?.span.line ?? 0
    const source = sourceMaps.get(diagnostic.filename)?.[line - 1]?.source
    const where = source === undefined ? `${diagnostic.filename}:${line}` : `${source.document}:${source.line}`

    console.error(`${where}: ${diagnostic.code}: ${diagnostic.message}`)
  }

  console.error(`\nDocumentation examples break the package's lint rules. Generated sources: ${relative(repoRoot, outDir)}`)
  return 1
}

process.exit(await main())
