/* oxlint-disable effecttsgo/async-function -- Test entrypoints and Hono/SDK fixtures retain native Promise contracts; inner Effect programs remain composable. */
/**
 * CLI Database Migration Tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
// oxlint-disable-next-line effecttsgo/node-builtin-import -- These integration tests use real temporary files and native paths to verify the Node CLI filesystem boundary.
import { mkdir, writeFile, rm } from 'fs/promises'
// oxlint-disable-next-line effecttsgo/node-builtin-import -- These integration tests use real temporary files and native paths to verify the Node CLI filesystem boundary.
import { join } from 'path'
import {
  defineMigration,
  sql,
  dbStatus,
  dbMigrate,
  dbRollback,
  parseDbArgs,
  dbHelp,
} from '../../src/cli/index.js'

describe('defineMigration', () => {
  test('returns the migration definition unchanged', () => {
    const migration = defineMigration({
      version: '20250109_001',
      description: 'Add status column',
      up: 'ALTER TABLE projects ADD COLUMN status TEXT',
      down: 'ALTER TABLE projects DROP COLUMN status',
    })

    expect(migration.version).toBe('20250109_001')
    expect(migration.description).toBe('Add status column')
    expect(migration.up).toBe('ALTER TABLE projects ADD COLUMN status TEXT')
    expect(migration.down).toBe('ALTER TABLE projects DROP COLUMN status')
  })

  test('supports optional migrate function', () => {
    const migrateFn = async () => {}

    const migration = defineMigration({
      version: '20250109_001',
      description: 'Test',
      up: 'SELECT 1',
      down: 'SELECT 1',
      migrate: migrateFn,
    })

    expect(migration.migrate).toBe(migrateFn)
  })

  test('supports optional validate function', () => {
    const validateFn = async () => true

    const migration = defineMigration({
      version: '20250109_001',
      description: 'Test',
      up: 'SELECT 1',
      down: 'SELECT 1',
      validate: validateFn,
    })

    expect(migration.validate).toBe(validateFn)
  })
})

describe('sql template literal', () => {
  test('returns plain SQL string', () => {
    const result = sql`ALTER TABLE users ADD COLUMN email TEXT`
    expect(result).toBe('ALTER TABLE users ADD COLUMN email TEXT')
  })

  test('interpolates values', () => {
    const tableName = 'projects'
    const columnName = 'status'
    const result = sql`ALTER TABLE ${tableName} ADD COLUMN ${columnName} TEXT`
    expect(result).toBe('ALTER TABLE projects ADD COLUMN status TEXT')
  })

  test('handles multiple interpolations', () => {
    const result = sql`CREATE TABLE ${'users'} (id ${'UUID'}, name ${'TEXT'})`
    expect(result).toBe('CREATE TABLE users (id UUID, name TEXT)')
  })
})

describe('dbStatus', () => {
  const testDir = join(process.cwd(), 'test-drizzle')

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test('returns error when no migrations directory', async () => {
    const result = await dbStatus({ config: './nonexistent.config.ts' })

    // Should return empty migrations (no directory exists)
    expect(result.status).toBe('up-to-date')
    expect(result.total).toBe(0)
    expect(result.migrations).toEqual([])
  })

  test('reads migration files from directory', async () => {
    // Create test migration files
    await writeFile(
      join(testDir, '0001_create_users.sql'),
      'CREATE TABLE users (id UUID);'
    )
    await writeFile(
      join(testDir, '0002_create_projects.sql'),
      'CREATE TABLE projects (id UUID);'
    )

    // Create a config file pointing to our test directory
    const configPath = join(testDir, 'drizzle.config.ts')
    await writeFile(
      configPath,
      `export default { out: '${testDir}' }`
    )

    const result = await dbStatus({ config: configPath })

    expect(result.total).toBe(2)
    expect(result.migrations.length).toBe(2)
    expect(result.migrations[0].name).toBe('0001_create_users')
    expect(result.migrations[1].name).toBe('0002_create_projects')
  })

  test('marks all migrations as pending when none applied', async () => {
    await writeFile(
      join(testDir, '0001_test.sql'),
      'SELECT 1;'
    )

    const configPath = join(testDir, 'drizzle.config.ts')
    await writeFile(configPath, `export default { out: '${testDir}' }`)

    const result = await dbStatus({ config: configPath })

    expect(result.status).toBe('pending')
    expect(result.pending).toBe(1)
    expect(result.applied).toBe(0)
    expect(result.migrations[0].applied).toBe(false)
  })

  test('recognizes migration state written by the former package name', async () => {
    await writeFile(join(testDir, '0001_test.sql'), 'SELECT 1;')
    await writeFile(
      join(testDir, '.honertia-applied.json'),
      JSON.stringify({ '0001_test': '2026-08-10T00:00:00.000Z' })
    )

    const configPath = join(testDir, 'drizzle.config.ts')
    await writeFile(configPath, `export default { out: '${testDir}' }`)

    const result = await dbStatus({ config: configPath })

    expect(result.status).toBe('up-to-date')
    expect(result.applied).toBe(1)
    expect(result.pending).toBe(0)
  })

  test('includes statements in verbose mode', async () => {
    await writeFile(
      join(testDir, '0001_test.sql'),
      'CREATE TABLE test (id UUID);\nINSERT INTO test VALUES (1);'
    )

    const configPath = join(testDir, 'drizzle.config.ts')
    await writeFile(configPath, `export default { out: '${testDir}' }`)

    const result = await dbStatus({ config: configPath, verbose: true })

    expect(result.migrations[0].statements).toBeDefined()
    expect(result.migrations[0].statements?.length).toBe(2)
    expect(result.migrations[0].statements?.[0]).toContain('CREATE TABLE')
  })

  test('reports malformed migration tracking values instead of trusting JSON types', async () => {
    await writeFile(join(testDir, '0001_test.sql'), 'SELECT 1;')
    await writeFile(join(testDir, '.popweb-applied.json'), '{"0001_test":{"token":"private"}}')
    const configPath = join(testDir, 'drizzle.config.ts')
    await writeFile(configPath, `export default { out: '${testDir}' }`)

    const result = await dbStatus({ config: configPath })

    expect(result.status).toBe('error')
    expect(result.error).toBe('Invalid applied migration tracking data')
  })

  test('reports migration read failures instead of treating them as an empty history', async () => {
    await mkdir(join(testDir, '0001_unreadable.sql'))
    const configPath = join(testDir, 'drizzle.config.ts')
    await writeFile(configPath, `export default { out: '${testDir}' }`)

    const result = await dbStatus({ config: configPath })

    expect(result.status).toBe('error')
    expect(result.error).toBeDefined()
  })

  test('returns up-to-date when no pending migrations', async () => {
    // Empty directory = no migrations = up to date
    const configPath = join(testDir, 'drizzle.config.ts')
    await writeFile(configPath, `export default { out: '${testDir}' }`)

    const result = await dbStatus({ config: configPath })

    expect(result.status).toBe('up-to-date')
    expect(result.pending).toBe(0)
  })
})

describe('dbMigrate', () => {
  const testDir = join(process.cwd(), 'test-drizzle-migrate')

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test('returns success with zero applied when no pending', async () => {
    const configPath = join(testDir, 'drizzle.config.ts')
    await writeFile(configPath, `export default { out: '${testDir}' }`)

    const result = await dbMigrate({ config: configPath })

    expect(result.success).toBe(true)
    expect(result.applied).toBe(0)
    expect(result.migrations).toEqual([])
  })

  test('preview mode returns pending migrations without executing', async () => {
    await writeFile(
      join(testDir, '0001_test.sql'),
      'CREATE TABLE test (id UUID);'
    )

    const configPath = join(testDir, 'drizzle.config.ts')
    await writeFile(configPath, `export default { out: '${testDir}' }`)

    const result = await dbMigrate({ config: configPath, preview: true })

    expect(result.success).toBe(true)
    expect(result.applied).toBe(1)
    expect(result.migrations).toContain('0001_test')
    expect(result.statements).toBeDefined()
    expect(result.statements?.length).toBeGreaterThan(0)
  })

  test('preview includes SQL statements', async () => {
    await writeFile(
      join(testDir, '0001_create_table.sql'),
      'CREATE TABLE users (id UUID PRIMARY KEY);'
    )

    const configPath = join(testDir, 'drizzle.config.ts')
    await writeFile(configPath, `export default { out: '${testDir}' }`)

    const result = await dbMigrate({ config: configPath, preview: true })

    expect(result.statements).toBeDefined()
    expect(result.statements?.[0]).toContain('CREATE TABLE users')
  })
})

describe('dbRollback', () => {
  const testDir = join(process.cwd(), 'test-drizzle-rollback')

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test('returns success with no migration when none applied', async () => {
    const configPath = join(testDir, 'drizzle.config.ts')
    await writeFile(configPath, `export default { out: '${testDir}' }`)

    const result = await dbRollback({ config: configPath })

    expect(result.success).toBe(true)
    expect(result.migration).toBeUndefined()
  })
})

describe('parseDbArgs', () => {
  test('parses command', () => {
    const options = parseDbArgs(['status'])
    expect(options.command).toBe('status')
  })

  test('parses migrate command', () => {
    const options = parseDbArgs(['migrate'])
    expect(options.command).toBe('migrate')
  })

  test('parses --config option', () => {
    const options = parseDbArgs(['--config', 'custom.config.ts', 'status'])
    expect(options.config).toBe('custom.config.ts')
    expect(options.command).toBe('status')
  })

  test('parses -c shorthand', () => {
    const options = parseDbArgs(['-c', 'drizzle.config.ts', 'migrate'])
    expect(options.config).toBe('drizzle.config.ts')
  })

  test('parses --preview flag', () => {
    const options = parseDbArgs(['migrate', '--preview'])
    expect(options.command).toBe('migrate')
    expect(options.preview).toBe(true)
  })

  test('parses -p shorthand', () => {
    const options = parseDbArgs(['migrate', '-p'])
    expect(options.preview).toBe(true)
  })

  test('parses --json flag', () => {
    const options = parseDbArgs(['status', '--json'])
    expect(options.format).toBe('json')
  })

  test('parses --verbose flag', () => {
    const options = parseDbArgs(['status', '-v'])
    expect(options.verbose).toBe(true)
  })

  test('parses generate command with name', () => {
    const options = parseDbArgs(['generate', 'add_status_column'])
    expect(options.command).toBe('generate')
    expect(options.name).toBe('add_status_column')
  })

  test('parses multiple options', () => {
    const options = parseDbArgs([
      '-c', 'drizzle.config.ts',
      'migrate',
      '--preview',
      '--json',
    ])

    expect(options.config).toBe('drizzle.config.ts')
    expect(options.command).toBe('migrate')
    expect(options.preview).toBe(true)
    expect(options.format).toBe('json')
  })
})

describe('dbHelp', () => {
  test('includes usage information', () => {
    const help = dbHelp()

    expect(help).toContain('popweb db')
    expect(help).toContain('USAGE')
    expect(help).toContain('COMMANDS')
    expect(help).toContain('OPTIONS')
    expect(help).toContain('EXAMPLES')
  })

  test('documents all commands', () => {
    const help = dbHelp()

    expect(help).toContain('status')
    expect(help).toContain('migrate')
    expect(help).toContain('rollback')
    expect(help).toContain('generate')
  })

  test('documents all options', () => {
    const help = dbHelp()

    expect(help).toContain('--config')
    expect(help).toContain('--preview')
    expect(help).toContain('--json')
    expect(help).toContain('--verbose')
  })
})

describe('MigrationDefinition type', () => {
  test('allows full migration definition', () => {
    const migration = defineMigration({
      version: '20250109_001',
      description: 'Add email column to users table',
      up: sql`ALTER TABLE users ADD COLUMN email TEXT`,
      down: sql`ALTER TABLE users DROP COLUMN email`,
      migrate: async (_db) => {
        // Data migration logic
      },
      validate: async (_db) => {
        // Validation logic
        return true
      },
    })

    expect(migration.version).toBe('20250109_001')
    expect(migration.description).toBe('Add email column to users table')
    expect(migration.up).toContain('ALTER TABLE')
    expect(migration.down).toContain('DROP COLUMN')
    expect(migration.migrate).toBeInstanceOf(Function)
    expect(migration.validate).toBeInstanceOf(Function)
  })
})

describe('DbStatusResult type', () => {
  test('has correct structure for up-to-date status', async () => {
    const result = await dbStatus()

    expect(result).toHaveProperty('status')
    expect(result).toHaveProperty('total')
    expect(result).toHaveProperty('applied')
    expect(result).toHaveProperty('pending')
    expect(result).toHaveProperty('migrations')

    expect(['up-to-date', 'pending', 'error']).toContain(result.status)
    expect(result.total).toEqual(expect.any(Number))
    expect(result.applied).toEqual(expect.any(Number))
    expect(result.pending).toEqual(expect.any(Number))
    expect(Array.isArray(result.migrations)).toBe(true)
  })
})

describe('DbMigrateResult type', () => {
  test('has correct structure', async () => {
    const result = await dbMigrate({ preview: true })

    expect(result).toHaveProperty('success')
    expect(result).toHaveProperty('applied')
    expect(result).toHaveProperty('migrations')

    expect(result.success).toEqual(expect.any(Boolean))
    expect(result.applied).toEqual(expect.any(Number))
    expect(Array.isArray(result.migrations)).toBe(true)
  })
})
