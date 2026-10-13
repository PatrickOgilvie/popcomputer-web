/**
 * The README's Better Auth tables, for Postgres and for Cloudflare D1, have
 * every column the README's Better Auth configuration needs, and the one
 * `auth.signInLimits` counts in. A Better Auth release that adds a column
 * fails here before an application copies tables without it.
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSchema } from 'better-auth/db'

const repoRoot = join(import.meta.dir, '..', '..')
const outDir = join(import.meta.dir, '.generated')
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')

/** The README's TypeScript fence whose first line is `firstLine`. */
function fence(firstLine: string): string {
  const fences = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1] ?? '')
  const found = fences.find((code) => code.startsWith(`${firstLine}\n`))

  if (found === undefined) throw new Error(`README.md has no fence starting "${firstLine}".`)

  return found
}

async function readmeTables(name: string, firstLine: string): Promise<Record<string, unknown>> {
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, `${name}.ts`)
  writeFileSync(file, fence(firstLine))

  return import(file)
}

// The README's `createAuth`: email and password, with Better Auth's own
// limits in memory.
const needed = getSchema({ emailAndPassword: { enabled: true }, rateLimit: { enabled: true, storage: 'memory' } })

/** The models and columns `needed` names that `tables` lacks, by Better Auth's names. */
function missingFrom(tables: Record<string, unknown>): string[] {
  const missing: string[] = []
  const required: Array<readonly [string, ReadonlyArray<string>]> = [
    ...Object.entries(needed).map(([model, { fields }]) => [model, Object.keys(fields)] as const),
    // auth.signInLimits counts each account's failures in Better Auth's rateLimit table.
    ['rateLimit', ['key', 'count', 'lastRequest']],
  ]

  for (const [model, fields] of required) {
    const table = tables[model]

    if (!(table instanceof Object)) {
      missing.push(model)
      continue
    }

    for (const field of ['id', ...fields]) {
      if (!(field in table)) missing.push(`${model}.${field}`)
    }
  }

  return missing
}

describe("the README's Better Auth tables", () => {
  test('on Postgres', async () => {
    expect(missingFrom(await readmeTables('auth-schema.pg', '// src/auth-schema.ts'))).toEqual([])
  })

  test('on Cloudflare D1', async () => {
    expect(missingFrom(await readmeTables('auth-schema.d1', '// src/auth-schema.ts on Cloudflare D1, in place of the Postgres one'))).toEqual([])
  })
})
