import { expect, test } from 'bun:test'
import { signedIn, testEnv } from '@popcomputer/web/testing'

// A test file runs once, outside the Worker.
let calls = 0
const sent: string[] = []

test('counts', () => {
  calls += 1
  sent.push('mail')
  expect(calls).toBe(1)
  expect(testEnv(signedIn({ id: 'user-1' }))).toBeDefined()
})
