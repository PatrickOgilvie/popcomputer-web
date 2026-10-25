import { afterAll } from 'bun:test'
import { testD1 } from '@popcomputer/web/testing'

// bunfig.toml preloads this file for bun test alone.
export const databases = testD1({ migrations: './migrations' })
let stopped = false

afterAll(() => {
  stopped = true
  return databases.dispose()
})

export const isStopped = () => stopped
