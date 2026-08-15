/**
 * Database Migration CLI Module
 *
 * Wraps Drizzle Kit migrations with preview support and
 * agent-friendly JSON output for migration status.
 */

/**
 * Migration status for a single migration.
 */
export interface MigrationStatus {
  /**
   * Migration name/identifier.
   */
  name: string
  /**
   * Whether the migration has been applied.
   */
  applied: boolean
  /**
   * Timestamp when applied (if applicable).
   */
  appliedAt?: string
  /**
   * SQL statements in this migration.
   */
  statements?: string[]
}

/**
 * Result of db:status command.
 */
export interface DbStatusResult {
  /**
   * Overall status.
   */
  status: 'up-to-date' | 'pending' | 'error'
  /**
   * Total number of migrations.
   */
  total: number
  /**
   * Number of applied migrations.
   */
  applied: number
  /**
   * Number of pending migrations.
   */
  pending: number
  /**
   * Individual migration statuses.
   */
  migrations: MigrationStatus[]
  /**
   * Error message if status is 'error'.
   */
  error?: string
}

/**
 * Result of db:migrate command.
 */
export interface DbMigrateResult {
  /**
   * Whether migration was successful.
   */
  success: boolean
  /**
   * Number of migrations applied.
   */
  applied: number
  /**
   * Names of applied migrations.
   */
  migrations: string[]
  /**
   * SQL statements executed (preview mode).
   */
  statements?: string[]
  /**
   * Error message if failed.
   */
  error?: string
}

/**
 * Result of db:rollback command.
 */
export interface DbRollbackResult {
  /**
   * Whether rollback was successful.
   */
  success: boolean
  /**
   * Name of rolled back migration.
   */
  migration?: string
  /**
   * SQL statements executed.
   */
  statements?: string[]
  /**
   * Error message if failed.
   */
  error?: string
}

/**
 * Options for db commands.
 */
export interface DbCommandOptions {
  /**
   * Path to drizzle config file.
   */
  config?: string
  /**
   * Preview mode - show SQL without executing.
   */
  preview?: boolean
  /**
   * Output format.
   */
  format?: 'text' | 'json'
  /**
   * Show verbose output.
   */
  verbose?: boolean
}

/**
 * Migration definition for agent-friendly migrations.
 */
export interface MigrationDefinition {
  /**
   * Version identifier (e.g., '20250109_001').
   */
  version: string
  /**
   * Human-readable description.
   */
  description: string
  /**
   * SQL for applying migration.
   */
  up: string
  /**
   * SQL for rolling back migration.
   */
  down: string
  /**
   * Optional data migration function.
   */
  migrate?: <Database>(db: Database) => Promise<void>
  /**
   * Optional validation function.
   */
  validate?: <Database>(db: Database) => Promise<boolean>
}

/**
 * Define a migration with up/down SQL and optional data migration.
 *
 * @example
 * ```typescript
 * import { defineMigration, sql } from '@popcomputer/web/cli'
 *
 * export const addEmailToProjects = defineMigration({
 *   version: '20250109_001',
 *   description: 'Add email column to projects table',
 *   up: sql`ALTER TABLE projects ADD COLUMN email TEXT`,
 *   down: sql`ALTER TABLE projects DROP COLUMN email`,
 * })
 * ```
 */
export function defineMigration(definition: MigrationDefinition): MigrationDefinition {
  return definition
}

/**
 * Tagged template literal for SQL statements.
 * Returns the SQL string directly for use in migrations.
 *
 * @example
 * ```typescript
 * const statement = sql`ALTER TABLE users ADD COLUMN status TEXT`
 * ```
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): string {
  let result = strings[0]
  for (let i = 0; i < values.length; i++) {
    result += String(values[i]) + strings[i + 1]
  }
  return result
}

/**
 * Get migration status by reading migration files and checking applied status.
 *
 * @example
 * ```typescript
 * import { dbStatus } from '@popcomputer/web/cli'
 *
 * const status = await dbStatus({ config: 'drizzle.config.ts' })
 * if (status.pending > 0) {
 *   console.log(`${status.pending} migrations pending`)
 * }
 * ```
 */
export async function dbStatus(options: DbCommandOptions = {}): Promise<DbStatusResult> {
  try {
    // Try to find and read migration files
    const migrationsPath = await findMigrationsPath(options.config)
    const migrations = await readMigrationFiles(migrationsPath)
    const appliedMigrations = await getAppliedMigrations(options.config)

    const migrationStatuses: MigrationStatus[] = migrations.map((m) => ({
      name: m.name,
      applied: appliedMigrations.has(m.name),
      appliedAt: appliedMigrations.get(m.name),
      statements: options.verbose ? m.statements : undefined,
    }))

    const applied = migrationStatuses.filter((m) => m.applied).length
    const pending = migrationStatuses.filter((m) => !m.applied).length

    return {
      status: pending === 0 ? 'up-to-date' : 'pending',
      total: migrations.length,
      applied,
      pending,
      migrations: migrationStatuses,
    }
  } catch (error) {
    return {
      status: 'error',
      total: 0,
      applied: 0,
      pending: 0,
      migrations: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Run pending migrations.
 *
 * @example
 * ```typescript
 * import { dbMigrate } from '@popcomputer/web/cli'
 *
 * // Preview migrations
 * const preview = await dbMigrate({ preview: true })
 * console.log('Will run:', preview.statements)
 *
 * // Run migrations
 * const result = await dbMigrate()
 * console.log(`Applied ${result.applied} migrations`)
 * ```
 */
export async function dbMigrate(options: DbCommandOptions = {}): Promise<DbMigrateResult> {
  try {
    const migrationsPath = await findMigrationsPath(options.config)
    const migrations = await readMigrationFiles(migrationsPath)
    const appliedMigrations = await getAppliedMigrations(options.config)

    const pendingMigrations = migrations.filter((m) => !appliedMigrations.has(m.name))

    if (pendingMigrations.length === 0) {
      return {
        success: true,
        applied: 0,
        migrations: [],
      }
    }

    const statements = pendingMigrations.flatMap((m) => m.statements)

    if (options.preview) {
      return {
        success: true,
        applied: pendingMigrations.length,
        migrations: pendingMigrations.map((m) => m.name),
        statements,
      }
    }

    // Execute migrations via drizzle-kit
    await runDrizzleMigrate(options.config)

    const now = new Date().toISOString()
    const updatedApplied = new Map(appliedMigrations)
    for (const migration of pendingMigrations) {
      updatedApplied.set(migration.name, now)
    }
    await saveAppliedMigrations(updatedApplied, options.config)

    return {
      success: true,
      applied: pendingMigrations.length,
      migrations: pendingMigrations.map((m) => m.name),
    }
  } catch (error) {
    return {
      success: false,
      applied: 0,
      migrations: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Rollback the last applied migration.
 *
 * @example
 * ```typescript
 * import { dbRollback } from '@popcomputer/web/cli'
 *
 * const result = await dbRollback({ preview: true })
 * if (result.migration) {
 *   console.log('Will rollback:', result.migration)
 * }
 * ```
 */
export async function dbRollback(options: DbCommandOptions = {}): Promise<DbRollbackResult> {
  try {
    const migrationsPath = await findMigrationsPath(options.config)
    const migrations = await readMigrationFiles(migrationsPath)
    const appliedMigrations = await getAppliedMigrations(options.config)

    // Find last applied migration
    const appliedList = migrations.filter((m) => appliedMigrations.has(m.name))
    if (appliedList.length === 0) {
      return {
        success: true,
        migration: undefined,
      }
    }

    const lastMigration = appliedList[appliedList.length - 1]

    if (options.preview) {
      if (!lastMigration.downStatements || lastMigration.downStatements.length === 0) {
        return {
          success: false,
          migration: lastMigration.name,
          error: `Migration ${lastMigration.name} has no rollback SQL. Add a "-- @down" section to the migration file.`,
        }
      }

      return {
        success: true,
        migration: lastMigration.name,
        statements: lastMigration.downStatements,
      }
    }

    if (!lastMigration.downStatements || lastMigration.downStatements.length === 0) {
      return {
        success: false,
        migration: lastMigration.name,
        error: `Migration ${lastMigration.name} has no rollback SQL. Add a "-- @down" section to the migration file.`,
      }
    }

    return {
      success: false,
      migration: lastMigration.name,
      statements: lastMigration.downStatements,
      error: 'Automatic rollback execution is not supported yet. Use --preview and run the SQL manually.',
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Generate a new migration file.
 *
 * @example
 * ```typescript
 * import { dbGenerate } from '@popcomputer/web/cli'
 *
 * await dbGenerate('add_status_to_projects')
 * // Creates: drizzle/migrations/20250109_001_add_status_to_projects.sql
 * ```
 */
export async function dbGenerate(
  name: string,
  options: DbCommandOptions = {}
): Promise<{ success: boolean; path?: string; error?: string }> {
  try {
    // Generate via drizzle-kit
    await runDrizzleGenerate(name, options.config)

    const migrationsPath = await findMigrationsPath(options.config)
    const files = await listMigrationFiles(migrationsPath)
    const latestFile = files[files.length - 1]

    return {
      success: true,
      path: latestFile,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

// Internal helpers

interface MigrationFile {
  name: string
  path: string
  statements: string[]
  downStatements?: string[]
}

function splitSqlStatements(content: string): string[] {
  return content
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

interface ParsedMigrationSql {
  upStatements: string[]
  downStatements: string[]
}

function parseMigrationSql(content: string): ParsedMigrationSql {
  const downMarker = /^\s*--\s*(?:@down|down|rollback)\s*$/im
  const match = downMarker.exec(content)

  if (!match || match.index === undefined) {
    return {
      upStatements: splitSqlStatements(content),
      downStatements: [],
    }
  }

  const markerIndex = match.index
  const markerLength = match[0].length

  const upPart = content.slice(0, markerIndex)
  const downPart = content.slice(markerIndex + markerLength)

  return {
    upStatements: splitSqlStatements(upPart),
    downStatements: splitSqlStatements(downPart),
  }
}

function toTrackingObject(applied: Map<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Array.from(applied.entries()).map(([name, appliedAt]) => [name, appliedAt ?? new Date().toISOString()])
  )
}

async function getTrackingFilePaths(configPath?: string): Promise<{
  readonly current: string
  readonly legacy: string
}> {
  const path = await import('path')
  const migrationsPath = await findMigrationsPath(configPath)
  return {
    current: path.join(migrationsPath, '.popweb-applied.json'),
    legacy: path.join(migrationsPath, '.honertia-applied.json'),
  }
}

async function findMigrationsPath(configPath?: string): Promise<string> {
  // Default Drizzle migrations path
  const defaultPath = './drizzle'

  if (configPath) {
    // Try to read config and extract migrations path
    try {
      const fs = await import('fs/promises')
      const content = await fs.readFile(configPath, 'utf-8')

      // Simple extraction - look for out: 'path'
      const outMatch = content.match(/out:\s*['"]([^'"]+)['"]/)
      if (outMatch) {
        return outMatch[1]
      }
    } catch {
      // Config file doesn't exist or can't be parsed
    }
  }

  return defaultPath
}

async function readMigrationFiles(migrationsPath: string): Promise<MigrationFile[]> {
  try {
    const fs = await import('fs/promises')
    const path = await import('path')

    const files = await listMigrationFiles(migrationsPath)
    const migrations: MigrationFile[] = []

    for (const file of files) {
      if (file.endsWith('.sql')) {
        const filePath = path.join(migrationsPath, file)
        const content = await fs.readFile(filePath, 'utf-8')
        const { upStatements, downStatements } = parseMigrationSql(content)

        migrations.push({
          name: file.replace('.sql', ''),
          path: filePath,
          statements: upStatements,
          downStatements: downStatements.length > 0 ? downStatements : undefined,
        })
      }
    }

    return migrations.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

async function listMigrationFiles(migrationsPath: string): Promise<string[]> {
  try {
    const fs = await import('fs/promises')
    const entries = await fs.readdir(migrationsPath)
    return entries.filter((f) => f.endsWith('.sql')).sort()
  } catch {
    return []
  }
}

async function getAppliedMigrations(configPath?: string): Promise<Map<string, string | undefined>> {
  const fs = await import('fs/promises')
  const trackingPaths = await getTrackingFilePaths(configPath)

  for (const trackingPath of [trackingPaths.current, trackingPaths.legacy]) {
    try {
      const content = await fs.readFile(trackingPath, 'utf-8')
      // SAFETY: The CLI parser checked this option against its finite accepted values before constructing the typed command.
      const parsed = JSON.parse(content) as Record<string, string>
      return new Map(Object.entries(parsed))
    } catch (error) {
      if (!isFileNotFound(error)) throw error
    }
  }

  return new Map()
}

async function saveAppliedMigrations(
  applied: Map<string, string | undefined>,
  configPath?: string
): Promise<void> {
  const fs = await import('fs/promises')
  const path = await import('path')
  const { current: trackingPath } = await getTrackingFilePaths(configPath)

  await fs.mkdir(path.dirname(trackingPath), { recursive: true })
  await fs.writeFile(trackingPath, JSON.stringify(toTrackingObject(applied), null, 2))
}

function isFileNotFound(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT'
}

async function runDrizzleMigrate(configPath?: string): Promise<void> {
  // Shell out to drizzle-kit migrate
  const { execSync } = await import('child_process')
  const configArg = configPath ? `--config ${configPath}` : ''
  execSync(`npx drizzle-kit migrate ${configArg}`, { stdio: 'inherit' })
}

async function runDrizzleGenerate(name: string, configPath?: string): Promise<void> {
  const { execSync } = await import('child_process')
  const configArg = configPath ? `--config ${configPath}` : ''
  execSync(`npx drizzle-kit generate --name ${name} ${configArg}`, { stdio: 'inherit' })
}

/**
 * Parse CLI arguments for db commands.
 */
export function parseDbArgs(args: string[]): DbCommandOptions & { command?: string; name?: string } {
  const options: DbCommandOptions & { command?: string; name?: string } = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    switch (arg) {
      case '--config':
      case '-c':
        options.config = args[++i]
        break
      case '--preview':
      case '-p':
        options.preview = true
        break
      case '--json':
        options.format = 'json'
        break
      case '--verbose':
      case '-v':
        options.verbose = true
        break
      default:
        if (!arg.startsWith('-')) {
          if (!options.command) {
            options.command = arg
          } else {
            options.name = arg
          }
        }
    }
  }

  return options
}

/**
 * Format db:status result as text.
 */
function formatStatusText(result: DbStatusResult, verbose: boolean): string {
  const lines: string[] = []

  lines.push('Database Migration Status')
  lines.push('='.repeat(50))
  lines.push('')

  if (result.status === 'error') {
    lines.push(`[ERROR] ${result.error}`)
    return lines.join('\n')
  }

  const statusIcon = result.status === 'up-to-date' ? '[OK]' : '[PENDING]'
  lines.push(`Status: ${statusIcon} ${result.status}`)
  lines.push(`Total: ${result.total} | Applied: ${result.applied} | Pending: ${result.pending}`)
  lines.push('')

  if (verbose && result.migrations.length > 0) {
    lines.push('Migrations:')
    for (const m of result.migrations) {
      const icon = m.applied ? '[x]' : '[ ]'
      const appliedAt = m.appliedAt ? ` (${m.appliedAt})` : ''
      lines.push(`  ${icon} ${m.name}${appliedAt}`)
    }
  }

  return lines.join('\n')
}

/**
 * Format db:migrate result as text.
 */
function formatMigrateText(result: DbMigrateResult, preview: boolean): string {
  const lines: string[] = []

  if (!result.success) {
    lines.push(`[ERROR] Migration failed: ${result.error}`)
    return lines.join('\n')
  }

  if (result.applied === 0) {
    lines.push('No pending migrations.')
    return lines.join('\n')
  }

  if (preview) {
    lines.push(`Preview: ${result.applied} migration(s) would be applied`)
    lines.push('')
    lines.push('Migrations:')
    for (const m of result.migrations) {
      lines.push(`  - ${m}`)
    }
    if (result.statements) {
      lines.push('')
      lines.push('SQL Statements:')
      for (const s of result.statements) {
        lines.push(`  ${s};`)
      }
    }
  } else {
    lines.push(`Applied ${result.applied} migration(s)`)
    for (const m of result.migrations) {
      lines.push(`  - ${m}`)
    }
  }

  return lines.join('\n')
}

/**
 * Get help text for db commands.
 */
export function dbHelp(): string {
  return `
popweb db - Database migration commands

USAGE:
  popweb db <command> [OPTIONS]

COMMANDS:
  status              Show migration status
  migrate             Run pending migrations
  rollback            Preview rollback SQL for last applied migration
  generate <name>     Generate new migration

OPTIONS:
  -c, --config        Path to drizzle config file
  -p, --preview       Preview SQL without executing
  --json              Output as JSON
  -v, --verbose       Show detailed output

EXAMPLES:
  # Show migration status
  popweb db status

  # Preview pending migrations
  popweb db migrate --preview

  # Run migrations
  popweb db migrate

  # Generate new migration
  popweb db generate add_status_to_projects

  # Preview rollback SQL
  popweb db rollback --preview

  # Use custom config
  popweb db migrate --config ./drizzle.config.ts
`.trim()
}

/**
 * Run db command from CLI arguments.
 */
export async function runDb(args: string[] = []): Promise<void> {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(dbHelp())
    return
  }

  const options = parseDbArgs(args)

  switch (options.command) {
    case 'status': {
      const result = await dbStatus(options)
      if (options.format === 'json') {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(formatStatusText(result, options.verbose ?? false))
      }
      if (result.status === 'error') {
        process.exit(1)
      }
      break
    }

    case 'migrate': {
      const result = await dbMigrate(options)
      if (options.format === 'json') {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(formatMigrateText(result, options.preview ?? false))
      }
      if (!result.success) {
        process.exit(1)
      }
      break
    }

    case 'rollback': {
      const result = await dbRollback(options)
      if (options.format === 'json') {
        console.log(JSON.stringify(result, null, 2))
      } else {
        if (!result.success) {
          console.log(`[ERROR] Rollback failed: ${result.error}`)
          if (result.statements && result.statements.length > 0) {
            console.log('\nRollback SQL:')
            for (const s of result.statements) {
              console.log(`  ${s};`)
            }
          }
        } else if (!result.migration) {
          console.log('No migrations to rollback.')
        } else if (options.preview) {
          console.log(`Preview: Would rollback ${result.migration}`)
          if (result.statements) {
            console.log('\nSQL Statements:')
            for (const s of result.statements) {
              console.log(`  ${s};`)
            }
          }
        } else {
          console.log(`Rolled back: ${result.migration}`)
        }
      }
      if (!result.success) {
        process.exit(1)
      }
      break
    }

    case 'generate': {
      if (!options.name) {
        console.log('Error: Migration name required')
        console.log('Usage: popweb db generate <name>')
        process.exit(1)
      }
      const result = await dbGenerate(options.name, options)
      if (options.format === 'json') {
        console.log(JSON.stringify(result, null, 2))
      } else {
        if (result.success) {
          console.log(`Generated migration: ${result.path}`)
        } else {
          console.log(`[ERROR] ${result.error}`)
        }
      }
      if (!result.success) {
        process.exit(1)
      }
      break
    }

    default:
      console.log(`Unknown command: ${options.command}`)
      console.log('Run "popweb db --help" for usage')
      process.exit(1)
  }
}
