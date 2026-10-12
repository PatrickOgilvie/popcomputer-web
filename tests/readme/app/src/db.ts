// The application database factory the README examples import as `./db`.
import { drizzle } from 'drizzle-orm/bun-sqlite'
import * as schema from './schema'

export function createDb(url: string) {
  return drizzle(url, { schema })
}

export type Database = ReturnType<typeof createDb>
