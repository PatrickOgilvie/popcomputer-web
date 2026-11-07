import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { DOC_PATH, renderDoc } from '../../scripts/machine-docs.js'

test('docs/state-machines.md holds the tables the code holds', () => {
  const doc = readFileSync(DOC_PATH, 'utf8')

  // Run `bun scripts/machine-docs.ts` after changing a machine's table.
  expect(doc).toBe(renderDoc(doc))
})
