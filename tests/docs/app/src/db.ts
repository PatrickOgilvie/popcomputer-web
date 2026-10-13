// The application database factory the README examples import as `./db`.
// The examples only type-check, against an asynchronous SQLite driver, so
// they may use dbTransaction as an application on Postgres or libsql would.
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import * as schema from './schema'

export function createDb(_url: string) {
  return drizzle(async () => ({ rows: [] }), { schema })
}

export type Database = ReturnType<typeof createDb>
