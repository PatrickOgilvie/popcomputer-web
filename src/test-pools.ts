/**
 * The directories `testD1` keeps its databases in, and what a killed run
 * leaves of them. Not an entrypoint.
 *
 * The sweep here removes directories and stops processes for real, so a bug
 * planted in it does too. Test it on a directory of the test's own, and plant
 * one through `popweb-mutate`, whose runs each have a temporary directory of
 * their own, never by hand before a test that sweeps the real one.
 */
import { Predicate } from 'effect'

export const POOL_DIRECTORY = 'popweb-test-d1-'

/** The process that made a pool's directory, whose name records it: none in a directory an older version made. */
const POOL_OWNER = new RegExp(`^${POOL_DIRECTORY}(\\d+)-`)

/** How old a pool's directory with no owner in its name must be to count as abandoned. */
const OWNERLESS_POOL_MILLIS = 24 * 60 * 60 * 1000

/**
 * Remove the pool's directory, resolving once it is gone. Miniflare is still
 * removing its own directory inside it, unawaited, and a removal that finds
 * entries vanishing under it can resolve leaving their parent: try again until
 * nothing is left.
 */
export async function removePoolDirectory(path: string): Promise<void> {
  const { rm, stat } = await import('node:fs/promises')

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await rm(path, { recursive: true, force: true })

    if (!(await stat(path).then(() => true, () => false))) return

    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Whether a process is running: one that only refuses the signal is. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return !(Predicate.hasProperty(error, 'code') && error.code === 'ESRCH')
  }
}

/**
 * Stop the `workerd` processes holding files in a directory. `lsof` itself
 * picks them, so what this stops is only ever a `workerd` with a file open
 * there: another application's, or one a running `wrangler dev` started, holds
 * none. Where lsof is missing or finds none, it stops nothing.
 */
async function stopWorkerdsIn(directory: string): Promise<void> {
  const { execFile } = await import('node:child_process')
  const { realpath } = await import('node:fs/promises')
  const path = await realpath(directory)
  const holders = await new Promise<string>((resolve) => {
    execFile('lsof', ['-a', '-c', 'workerd', '-t', '+D', path], (_error, stdout) => resolve(stdout))
  })

  for (const orphan of holders.match(/\d+/g) ?? []) {
    try {
      process.kill(Number(orphan), 'SIGKILL')
    } catch {
      // It has already exited.
    }
  }
}

/**
 * Remove what a run left in `root` that was killed before it could
 * `dispose()`: exit handlers cannot see a SIGKILL, so its `workerd` outlives
 * it, and its databases stay on disk. A directory's name says which process
 * made it, so a run beside this one keeps its own, and nothing but a pool's
 * directory is touched.
 */
export async function sweepAbandonedPools(root: string): Promise<void> {
  const { readdir, stat } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const abandoned = new Set<string>()

  for (const name of await readdir(root)) {
    if (!name.startsWith(POOL_DIRECTORY)) continue

    const owner = POOL_OWNER.exec(name)?.[1]
    // One another sweep has just removed has no age, and is gone from the list.
    const modified = owner === undefined ? (await stat(join(root, name)).catch(() => undefined))?.mtimeMs : undefined
    const gone = owner === undefined
      ? modified !== undefined && Date.now() - modified > OWNERLESS_POOL_MILLIS
      : !isRunning(Number(owner))

    if (gone) abandoned.add(name)
  }

  for (const name of abandoned) {
    await stopWorkerdsIn(join(root, name))
    await removePoolDirectory(join(root, name))
  }
}
