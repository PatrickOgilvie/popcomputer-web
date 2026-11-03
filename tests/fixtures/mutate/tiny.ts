/** A tiny module for tests/mutate.test.ts to plant bugs in. */

export function isAdult(age: number): boolean {
  return age >= 18
}

export function firstNegative(values: readonly number[]): number | undefined {
  for (const value of values) {
    if (value < 0) return value
  }
  return undefined
}

export function allowed(role: string, roles: readonly string[]): boolean {
  if (!roles.some((each) => each === role)) throw new Error(role === '' ? 'No role given' : 'Not allowed')
  return true
}

export function digits(value: number): number {
  let count = 0
  let rest = Math.abs(value)
  while (true) {
    count++
    rest = Math.floor(rest / 10)
    if (rest === 0) break
  }
  return count
}

export function plural(count: number): string {
  if (count > 1) {
    return count === 2 ? 'a pair' : 'many'
  }
  return 'one'
}

type On = true
export const label = (on: On | false, hours: number) => (on ? `on for ${hours < 1 ? 'minutes' : 'hours'}` : 'off')
