// Import every entrypoint in package.json `exports` from the built dist/ under
// plain Node. Bun resolves extensionless and TypeScript-only paths that Node's
// ESM loader rejects, so this catches packaging mistakes the Bun suite cannot.
//
// Run after `bun run build`: node tests/package-imports.mjs
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const failures = []

for (const subpath of Object.keys(pkg.exports)) {
  const specifier = subpath === '.' ? pkg.name : `${pkg.name}${subpath.slice(1)}`

  try {
    const module = await import(specifier)
    console.log(`${specifier}: ${Object.keys(module).length} exports`)
  } catch (error) {
    failures.push(`${specifier}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
