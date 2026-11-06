/**
 * The bounds of one fuzz case, for what a case makes for itself. `fuzz` runs
 * each case here, and `testD1` hears when a case took a database, so a run of
 * thousands of cases stops each Miniflare as its cases finish, while a
 * database made outside a case stays until `dispose()`. Not an entrypoint.
 */
import type { AsyncLocalStorage } from 'node:async_hooks'

type CaseEnds = Array<() => Promise<void>>

let cases: AsyncLocalStorage<CaseEnds> | undefined

/** Run one case, then whatever it asked to have done when it ended. */
export async function inTestCase<A>(run: () => A | Promise<A>): Promise<A> {
  const { AsyncLocalStorage } = await import('node:async_hooks')
  const ends: CaseEnds = []

  cases ??= new AsyncLocalStorage()

  try {
    return await cases.run(ends, run)
  } finally {
    await Promise.all(ends.map((end) => end()))
  }
}

/** Do `end` when the case running now ends. Outside a case, nothing ever does it. */
export function whenTestCaseEnds(end: () => Promise<void>): void {
  cases?.getStore()?.push(end)
}
