import { afterAll } from 'bun:test'

// bunfig.toml preloads this file for bun test alone.
let stopped = false

afterAll(() => {
  stopped = true
})

export const isStopped = () => stopped
