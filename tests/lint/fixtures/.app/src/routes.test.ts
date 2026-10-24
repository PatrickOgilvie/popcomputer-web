import { expect, test } from 'bun:test'

// A test file runs once, outside the Worker.
let calls = 0
const sent: string[] = []

test('counts', () => {
  calls += 1
  sent.push('mail')
  expect(calls).toBe(1)
})
