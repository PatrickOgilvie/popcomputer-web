let created = 0
const rows = new Map<string, number>()

export function create(name: string) {
  created += 1
  rows.set(name, created)
}
