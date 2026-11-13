/**
 * When the running request or job began, on the clock its Effects read. A
 * value the work holds was read after this, so a change made before it is
 * one the value already shows, and one made after it may not be.
 *
 * @internal
 */
import { Clock, Context, Effect, Layer, Option } from 'effect'

export const WorkBegan = Context.Reference<Option.Option<number>>('@popcomputer/web/WorkBegan', {
  defaultValue: () => Option.none(),
})

/**
 * The time the work begins, read once as its services are built, before any
 * of them reads data: a route's records load after it. `given` holds the
 * services a test gives, whose clock the work's Effects read.
 */
export const workBeganLayer = (given: Context.Context<never> | undefined): Layer.Layer<never> => {
  const began = Layer.effect(WorkBegan, Effect.map(Clock.currentTimeMillis, Option.some))

  return given === undefined ? began : began.pipe(Layer.provide(Layer.succeedContext(given)))
}
