/**
 * Reporting a failure no answer shows, such as failed background work or a
 * finalizer that died, through the services that can: the route's runtime,
 * then the request's own services, else none, where `observeOrLog` logs it.
 *
 * @internal
 */
import { Cause, Effect, Exit, type ManagedRuntime } from 'effect'
import type { Context as HonoContext, Env } from 'hono'
import { openWebContext } from '../request-context.js'
import { observeOrLog } from './error-observer.js'

/** A runtime a report can run through, whatever services it holds. */
export type ReportingRuntime = ManagedRuntime.ManagedRuntime<never, unknown>

/**
 * Run `report` through the first runtime that can: `runtime`, then the
 * request's own services. A runtime whose layers failed to build, or that
 * was disposed, cannot, so the next one runs it, and with neither it runs
 * with no services. It never rejects.
 */
// oxlint-disable-next-line effecttsgo/async-function -- Reports run at the Hono and Worker boundary, after an answer or a job's result, where no Effect runtime owns them.
export async function reportThrough<E extends Env>(
  c: HonoContext<E>,
  report: Effect.Effect<void>,
  runtime?: ReportingRuntime
): Promise<void> {
  if (runtime !== undefined && Exit.isSuccess(await runtime.runPromiseExit(report))) return

  const requestRuntime = openWebContext(c).requestRuntime?.()

  if (requestRuntime !== undefined && Exit.isSuccess(await requestRuntime.runPromiseExit(report))) return

  await Effect.runPromise(Effect.ignoreCause(report))
}

/** Report that releasing what a request or job held failed: a finalizer died. */
export function reportRelease<E extends Env>(c: HonoContext<E>, exit: Exit.Exit<unknown, unknown>): Promise<void> {
  if (Exit.isSuccess(exit)) return Promise.resolve()

  return reportThrough(c, observeOrLog({
    source: 'framework',
    handling: 'unhandled',
    kind: 'defect',
    error: Cause.squash(exit.cause),
    metadata: { operation: 'release' },
  }, 'Releasing a service failed'))
}
