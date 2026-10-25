import { applyMigrations } from '@popcomputer/web/testing'

// A test helper beside the application, named test-*.
export const migrate = (exec: (sql: string) => Promise<unknown>) => applyMigrations('./drizzle', exec)
