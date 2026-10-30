import { Effect } from 'effect'
import { action, json } from '@popcomputer/web/effect'
import { signedIn, testEnv } from '@popcomputer/web/testing' // expect: no-testing-in-production
import type { TestBrowser } from '@popcomputer/web/testing'
import { type TestClock } from '@popcomputer/web/testing'
export { testD1 } from '@popcomputer/web/testing' // expect: no-testing-in-production
export type { TestEnvOptions } from '@popcomputer/web/testing'
import { fuzz } from '@popcomputer/web/fuzz' // expect: no-testing-in-production
import type { FuzzRequest } from '@popcomputer/web/fuzz'

const faked = require('@popcomputer/web/testing') // expect: no-testing-in-production

export const dashboard = action(Effect.gen(function* () {
  const testing = yield* Effect.promise(() => import('@popcomputer/web/testing')) // expect: no-testing-in-production
  void [signedIn, testEnv, faked, testing, fuzz]
  return yield* json({ ok: true })
}))

export type Clocks = [TestBrowser, TestClock, FuzzRequest]
