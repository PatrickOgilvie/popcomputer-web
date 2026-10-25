import { testD1 } from '@popcomputer/web/testing'

export const databases = testD1({ migrations: './migrations' })

export let seeded = false

export function seed() {
  seeded = true
}
