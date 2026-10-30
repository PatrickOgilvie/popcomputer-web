// A component's hook runs in one visitor's browser: its module's state is that visitor's alone.
let listeners = 0
const ticks = new Map<string, number>()

export function useOfficeClock(id: string) {
  listeners += 1
  ticks.set(id, listeners)
  return ticks.size
}
