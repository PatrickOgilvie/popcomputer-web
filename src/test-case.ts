/**
 * The bounds of one fuzz case, for what a case makes for itself. `fuzz` runs
 * each case here, and `testD1` hears when a case took a database, so a run of
 * thousands of cases stops each Miniflare as its cases finish, while a
 * database made outside a case, or one the cases share from `reusable()`,
 * stays until `dispose()`. Not an entrypoint.
 */
import type { AsyncLocalStorage } from 'node:async_hooks'

/** What a case asked to have done when it ends, and whether it has. */
interface CaseEnds {
  readonly ends: Array<() => Promise<void>>
  ended: boolean
}

let cases: AsyncLocalStorage<CaseEnds> | undefined

/**
 * A case's ends that failed, reported beside the case's own outcome rather
 * than over it: the case answers with what it returned or threw.
 */
function reportEnds(failures: ReadonlyArray<unknown>): void {
  if (failures.length === 0) return

  // oxlint-disable-next-line effecttsgo/global-console -- A test tool reports cleanup that failed after the case had answered, outside any Effect.
  console.error('What a test case asked to have done when it ended failed:', ...failures)
}

/** Run every end, each once, and report the ones that fail. */
async function runEnds(ends: ReadonlyArray<() => Promise<void>>): Promise<void> {
  const settled = await Promise.allSettled(ends.map((end) => end()))

  reportEnds(settled.flatMap((outcome) => outcome.status === 'rejected' ? [outcome.reason] : []))
}

/**
 * Run one case, then whatever it asked to have done when it ended. The case
 * answers with its own outcome: an end that fails is reported beside it.
 */
export async function inTestCase<A>(run: () => A | Promise<A>): Promise<A> {
  const { AsyncLocalStorage } = await import('node:async_hooks')
  const store: CaseEnds = { ends: [], ended: false }

  cases ??= new AsyncLocalStorage()

  try {
    return await cases.run(store, run)
  } finally {
    store.ended = true
    await runEnds(store.ends.splice(0))
  }
}

/**
 * Do `end` when the case running now ends, or at once when work the case
 * started asks after it has ended, and answer true. Outside a case, nothing
 * ever does it, and it answers false.
 */
export function whenTestCaseEnds(end: () => Promise<void>): boolean {
  const store = cases?.getStore()

  if (store === undefined) return false
  if (!store.ended) {
    store.ends.push(end)

    return true
  }

  // oxlint-disable-next-line no-floating-promises -- runEnds never rejects: it reports a failed end.
  runEnds([end])

  return true
}

/** Bun's `onTestFinished`, where `bun test` runs this: undefined elsewhere, as under Node. */
let finishedHook: Promise<((end: () => Promise<void>) => void) | undefined> | undefined

/**
 * Do `end` once the `bun test` test running now has finished, and answer
 * true. Outside a test, as at a file's top level, in a `beforeAll`, or after
 * the test has finished, or under another runner, nothing does it, and it
 * answers false.
 */
export async function whenTestEnds(end: () => Promise<void>): Promise<boolean> {
  finishedHook ??= import('bun:test').then((bun) => bun.onTestFinished, () => undefined)

  const onTestFinished = await finishedHook

  if (onTestFinished === undefined) return false

  try {
    onTestFinished(end)

    return true
  } catch {
    // Called outside a test: Bun refuses it.
    return false
  }
}
