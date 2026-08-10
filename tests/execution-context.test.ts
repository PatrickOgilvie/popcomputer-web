import { describe, it, expect, mock } from 'bun:test'
import { Effect, Layer } from 'effect'
import {
  ExecutionContextService,
  type ExecutionContextClient,
} from '../src/effect/index'

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a test ExecutionContext that captures background tasks.
 * This allows tests to verify what work was scheduled and await completion.
 */
const makeTestExecutionContext = (): {
  layer: Layer.Layer<ExecutionContextService>
  backgroundTasks: Promise<unknown>[]
  awaitAll: () => Promise<void>
} => {
  const tasks: Promise<unknown>[] = []

  const client: ExecutionContextClient = {
    isAvailable: true,
    waitUntil: (promise) => {
      tasks.push(promise)
    },
    runInBackground: (effect) =>
      Effect.flatMap(Effect.context<any>(), (context) =>
        Effect.sync(() => {
          const promise = Effect.runPromise(
            effect.pipe(
              Effect.provide(context),
              Effect.catchAllCause(() => Effect.void)
            )
          )
          tasks.push(promise)
        })
      ),
    schedule: (_operation, effect) =>
      Effect.flatMap(Effect.context<any>(), (context) =>
        Effect.sync(() => {
          const promise = Effect.runPromise(
            effect.pipe(
              Effect.provide(context),
              Effect.catchAllCause(() => Effect.void)
            )
          )
          tasks.push(promise)
        })
      ),
  }

  return {
    layer: Layer.succeed(ExecutionContextService, client),
    backgroundTasks: tasks,
    awaitAll: () => Promise.all(tasks).then(() => {}),
  }
}

/**
 * Create a no-op ExecutionContext for testing unavailable scenarios.
 */
const makeNoopExecutionContext = (): {
  layer: Layer.Layer<ExecutionContextService>
} => {
  const client: ExecutionContextClient = {
    isAvailable: false,
    waitUntil: () => {},
    runInBackground: () => Effect.void,
    schedule: () => Effect.void,
  }

  return {
    layer: Layer.succeed(ExecutionContextService, client),
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('ExecutionContextService', () => {
  describe('when available', () => {
    it('reports isAvailable as true', async () => {
      const { layer } = makeTestExecutionContext()

      await Effect.gen(function* () {
        const ctx = yield* ExecutionContextService
        expect(ctx.isAvailable).toBe(true)
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('captures waitUntil promises', async () => {
      const { layer, backgroundTasks, awaitAll } = makeTestExecutionContext()
      let completed = false

      await Effect.gen(function* () {
        const ctx = yield* ExecutionContextService

        ctx.waitUntil(
          new Promise<void>((resolve) => {
            setTimeout(() => {
              completed = true
              resolve()
            }, 10)
          })
        )
      }).pipe(Effect.provide(layer), Effect.runPromise)

      expect(backgroundTasks.length).toBe(1)
      expect(completed).toBe(false) // Not yet completed

      await awaitAll()
      expect(completed).toBe(true) // Now completed
    })

    it('runs Effects in background via runInBackground', async () => {
      const { layer, awaitAll } = makeTestExecutionContext()
      let sideEffect = 0

      await Effect.gen(function* () {
        const ctx = yield* ExecutionContextService

        yield* ctx.runInBackground(
          Effect.sync(() => {
            sideEffect = 42
          })
        )
      }).pipe(Effect.provide(layer), Effect.runPromise)

      // Effect was scheduled but may not have run yet
      await awaitAll()
      expect(sideEffect).toBe(42)
    })

    it('catches errors in background tasks without crashing', async () => {
      const { layer, awaitAll } = makeTestExecutionContext()
      let afterError = false

      await Effect.gen(function* () {
        const ctx = yield* ExecutionContextService

        yield* ctx.runInBackground(
          Effect.gen(function* () {
            yield* Effect.fail(new Error('Background task failed'))
          })
        )

        yield* ctx.runInBackground(
          Effect.sync(() => {
            afterError = true
          })
        )
      }).pipe(Effect.provide(layer), Effect.runPromise)

      // Both tasks should complete - error in first shouldn't affect second
      await awaitAll()
      expect(afterError).toBe(true)
    })

    it('preserves context in background tasks', async () => {
      const { layer, awaitAll } = makeTestExecutionContext()
      let capturedValue: string | null = null

      // Create a test service to verify context is preserved
      const TestService = Effect.Tag<{ value: string }>()('TestService')
      const testLayer = Layer.succeed(TestService, { value: 'from-context' })

      await Effect.gen(function* () {
        const ctx = yield* ExecutionContextService

        yield* ctx.runInBackground(
          Effect.gen(function* () {
            const test = yield* TestService
            capturedValue = test.value
          })
        )
      }).pipe(Effect.provide(Layer.merge(layer, testLayer)), Effect.runPromise)

      await awaitAll()
      expect(capturedValue).toBe('from-context')
    })

    it('can schedule multiple background tasks', async () => {
      const { layer, backgroundTasks, awaitAll } = makeTestExecutionContext()
      const results: number[] = []

      await Effect.gen(function* () {
        const ctx = yield* ExecutionContextService

        yield* ctx.runInBackground(Effect.sync(() => results.push(1)))
        yield* ctx.runInBackground(Effect.sync(() => results.push(2)))
        yield* ctx.runInBackground(Effect.sync(() => results.push(3)))
      }).pipe(Effect.provide(layer), Effect.runPromise)

      expect(backgroundTasks.length).toBe(3)
      await awaitAll()
      expect(results).toContain(1)
      expect(results).toContain(2)
      expect(results).toContain(3)
    })
  })

  describe('when unavailable', () => {
    it('reports isAvailable as false', async () => {
      const { layer } = makeNoopExecutionContext()

      await Effect.gen(function* () {
        const ctx = yield* ExecutionContextService
        expect(ctx.isAvailable).toBe(false)
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('silently ignores waitUntil calls', async () => {
      const { layer } = makeNoopExecutionContext()

      // Should not throw
      await Effect.gen(function* () {
        const ctx = yield* ExecutionContextService
        ctx.waitUntil(Promise.resolve('ignored'))
      }).pipe(Effect.provide(layer), Effect.runPromise)
    })

    it('returns Effect.void for runInBackground', async () => {
      const { layer } = makeNoopExecutionContext()
      let executed = false

      await Effect.gen(function* () {
        const ctx = yield* ExecutionContextService

        // The effect passed to runInBackground should NOT be executed
        yield* ctx.runInBackground(
          Effect.sync(() => {
            executed = true
          })
        )
      }).pipe(Effect.provide(layer), Effect.runPromise)

      expect(executed).toBe(false)
    })
  })

  describe('conditional background work pattern', () => {
    it('only runs background work when available', async () => {
      let executedInAvailable = false
      let executedInUnavailable = false

      const conditionalBackgroundWork = (value: boolean) =>
        Effect.gen(function* () {
          const ctx = yield* ExecutionContextService

          if (ctx.isAvailable) {
            yield* ctx.runInBackground(
              Effect.sync(() => {
                if (value) executedInAvailable = true
                else executedInUnavailable = true
              })
            )
          }
        })

      // Test with available context
      const { layer: availableLayer, awaitAll } = makeTestExecutionContext()
      await conditionalBackgroundWork(true).pipe(
        Effect.provide(availableLayer),
        Effect.runPromise
      )
      await awaitAll()
      expect(executedInAvailable).toBe(true)

      // Test with unavailable context
      const { layer: unavailableLayer } = makeNoopExecutionContext()
      await conditionalBackgroundWork(false).pipe(
        Effect.provide(unavailableLayer),
        Effect.runPromise
      )
      expect(executedInUnavailable).toBe(false)
    })
  })
})
