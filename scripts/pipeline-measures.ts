/**
 * The measures plans/request-pipeline.md tracks, read from src/ as text.
 *
 * Each step of the refactor runs it before and after, so a step that claims
 * to remove a runtime, a context field or a copy of a rule shows it. The
 * counts are textual: a field "read" is a property access on a value that
 * came from openWebContext or webContext, found by name, not by type.
 *
 * Run: bun scripts/pipeline-measures.ts
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = join(import.meta.dir, '..')
const src = join(root, 'src')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) return sourceFiles(path)

    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

const files = sourceFiles(src).map((path) => ({ path: relative(root, path), text: readFileSync(path, 'utf8') }))
const text = (path: string): string => files.find((file) => file.path === path)?.text ?? ''
const count = (pattern: RegExp, scope: (path: string) => boolean = () => true): number =>
  files.filter((file) => scope(file.path)).reduce((total, file) => total + (file.text.match(pattern)?.length ?? 0), 0)

/** The lines from `start` to the brace that closes the first one after it, skipping strings and comments. */
function blockLines(source: string, start: RegExp): number {
  const from = source.search(start)

  if (from === -1) return 0

  let depth = 0
  let opened = false
  let index = source.indexOf('{', from)

  for (; index < source.length; index++) {
    const character = source[index]
    const next = source[index + 1]

    if (character === '/' && next === '/') index = source.indexOf('\n', index)
    else if (character === '/' && next === '*') index = source.indexOf('*/', index) + 1
    else if (character === "'" || character === '"' || character === '`') {
      for (index++; index < source.length && source[index] !== character; index++) {
        if (source[index] === '\\') index++
      }
    } else if (character === '{') {
      depth++
      opened = true
    } else if (character === '}') {
      depth--
      if (opened && depth === 0) break
    }
  }

  return source.slice(from, index).split('\n').length
}

const contextSource = text('src/request-context.ts')
const contextInterface = contextSource.slice(contextSource.indexOf('export interface WebRequestContext'))
const contextBody = contextInterface.slice(0, contextInterface.indexOf('\n}\n'))
const fields = [...contextBody.matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1])

const readers = files.filter((file) => file.path !== 'src/request-context.ts' && /\b(?:open)?[wW]ebContext\(/.test(file.text))
const read = new Set<string>()
// Read outside web-setup.ts, whose setupOf reads the copied settings only for
// a stack composed by hand.
const readElsewhere = new Set<string>()
const written = new Set<string>()

for (const file of readers) {
  const holders = [...file.text.matchAll(/(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*(?:open)?[wW]ebContext\(/g)].map((match) => match[1])
  const receivers = [...holders.map((name) => `\\b${name}`), '(?:open)?[wW]ebContext\\([^)]*\\)']

  for (const field of fields) {
    const access = new RegExp(`(?:${receivers.join('|')})\\??\\.${field}\\b(\\s*(?:\\?\\?|\\|\\||&&)?=(?!=))?`, 'g')

    for (const match of file.text.matchAll(access)) {
      if (match[1] === undefined) {
        read.add(field)
        if (file.path !== 'src/web-setup.ts') readElsewhere.add(field)
      } else {
        written.add(field)
      }
    }
  }

  for (const match of file.text.matchAll(/const\s*\{([^}]+)\}\s*=\s*(?:open)?[wW]ebContext\(/g)) {
    for (const name of match[1].split(',').map((part) => part.trim().split(/[:\s]/)[0])) {
      if (fields.includes(name)) {
        read.add(name)
        if (file.path !== 'src/web-setup.ts') readElsewhere.add(name)
      }
    }
  }
}

const inEffect = (path: string) => path.startsWith('src/effect/')

const measures: ReadonlyArray<readonly [string, number | string]> = [
  ['ManagedRuntime.make sites', count(/ManagedRuntime\.make\(/g)],
  ['createHandler lines', blockLines(text('src/effect/routing.ts'), /private createHandler</)],
  ['web() middleware lines', blockLines(text('src/middleware.ts'), /export function web\(/)],
  ['WebRequestContext fields', fields.length],
  ['  read by src/', read.size],
  ['  read outside web-setup.ts', readElsewhere.size],
  ['  written by src/', written.size],
  ['  read nowhere', fields.filter((field) => !read.has(field)).join(', ') || '-'],
  ['openWebContext calls', count(/\bopenWebContext\(/g, (path) => path !== 'src/request-context.ts')],
  ['failRun calls', count(/\bfailRun\(/g, (path) => path !== 'src/effect/routing.ts') + count(/[^n] failRun\(/g, (path) => path === 'src/effect/routing.ts')],
  ['throw in src/effect', count(/\bthrow\b/g, inEffect)],
  ['async in src/effect', count(/\basync\b/g, inEffect)],
  ['Reflect.get in src/', count(/Reflect\.get\(/g)],
  ['oxlint-disable in src/', count(/oxlint-disable/g)],
]

const width = Math.max(...measures.map(([name]) => name.length))

for (const [name, value] of measures) console.log(`${name.padEnd(width)}  ${value}`)
