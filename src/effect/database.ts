/**
 * Database operations for actions.
 *
 * Each operation reads the request's client from `DatabaseService`, so an
 * action that touches the database requires the service its route checks for.
 * Callbacks receive the application's own Drizzle client, typed by
 * `WebDatabaseType`, so columns, rows and `.returning()` keep Drizzle's types.
 *
 * Failures are typed: a write that breaks a constraint fails with
 * `DatabaseConstraintViolation`, naming the constraint kind and, when the
 * driver reports them, its columns; anything else fails with `DatabaseError`.
 */

import { Effect } from 'effect'
import { DatabaseService, type DatabaseType } from './services.js'
import { DatabaseConstraintViolation, DatabaseError, ValidationError } from './errors.js'

type Operation = DatabaseError['operation']
type Constraint = DatabaseConstraintViolation['constraint']

/** How a write can fail. */
export type DatabaseWriteError = DatabaseError | DatabaseConstraintViolation

/**
 * Read with the request's database.
 *
 * @example
 * const recent = yield* dbQuery((db) =>
 *   db.select().from(projects).where(eq(projects.userId, auth.user.id)).limit(10)
 * )
 */
export function dbQuery<A>(
  query: (db: DatabaseType) => A
): Effect.Effect<Awaited<A>, DatabaseError, DatabaseService> {
  return run('query', query, (cause) => Effect.fail(new DatabaseError({ operation: 'query', cause })))
}

/**
 * Write with the request's database: one statement, or several that need not
 * be atomic. Use `dbTransaction` or `dbBatch` when they must succeed together.
 *
 * @example
 * const [project] = yield* dbMutation((db) =>
 *   db.insert(projects).values({ ...input, userId: auth.user.id }).returning()
 * )
 */
export function dbMutation<A>(
  write: (db: DatabaseType) => A
): Effect.Effect<Awaited<A>, DatabaseWriteError, DatabaseService> {
  return run('mutation', write, (cause) => classifyFailure(cause, 'mutation'))
}

/**
 * Run writes in an interactive transaction, which rolls back when the
 * callback rejects. Needs a driver whose transactions are asynchronous, such
 * as Postgres, MySQL or libsql. Cloudflare D1 has no interactive transactions:
 * use `dbBatch` there.
 *
 * @example
 * yield* dbTransaction(async (tx) => {
 *   await tx.delete(tasks).where(eq(tasks.projectId, project.id))
 *   await tx.delete(projects).where(eq(projects.id, project.id))
 * })
 */
export function dbTransaction<A>(
  write: (tx: TransactionClient) => Promise<A>
): Effect.Effect<A, DatabaseWriteError, DatabaseService> {
  return run(
    'transaction',
    (db) => {
      // SAFETY: TransactionClient is an error type unless DatabaseType has an
      // asynchronous `transaction(run)` whose callback receives it.
      const transactional = db as unknown as AsyncTransactions<TransactionClient>

      return transactional.transaction(write)
    },
    (cause) => classifyFailure(cause, 'transaction')
  )
}

/**
 * Run statements as one atomic batch: all of them apply, or none. This is
 * how Cloudflare D1 makes several writes atomic; libsql and Neon's HTTP
 * driver support it too. Each statement's result comes back in order.
 *
 * @example
 * yield* dbBatch((db) => [
 *   db.delete(tasks).where(eq(tasks.projectId, project.id)),
 *   db.delete(projects).where(eq(projects.id, project.id)),
 * ])
 */
export function dbBatch<const Items extends BatchArgument>(
  statements: (db: DatabaseType) => Items
): Effect.Effect<BatchResults<Items>, DatabaseWriteError, DatabaseService> {
  return run(
    'batch',
    (db) => {
      // SAFETY: BatchArgument is an error type unless DatabaseType has a
      // `batch(statements)` method, whose results Drizzle returns in order.
      const batching = db as unknown as Batches<Items>

      return batching.batch(statements(db))
    },
    (cause) => classifyFailure(cause, 'batch')
  )
}

/**
 * Report a unique violation on any of the given columns as field errors, so
 * a form shows the message beside the field instead of an error page. Keys
 * are column names, in the schema's camelCase or the database's snake_case.
 * Other failures pass through unchanged.
 *
 * @example
 * yield* dbMutation((db) => db.insert(pages).values(page)).pipe(
 *   uniqueFieldErrors({ slug: 'A page with this slug already exists.' })
 * )
 */
export function uniqueFieldErrors(
  messages: Readonly<Record<string, string>>
): <A, E, R>(
  self: Effect.Effect<A, E, R>
) => Effect.Effect<A, E | ValidationError, R> {
  return <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.catch(self, (error): Effect.Effect<never, E | ValidationError> => {
      if (!(error instanceof DatabaseConstraintViolation) || error.constraint !== 'unique') {
        return Effect.fail(error)
      }

      const errors = Object.fromEntries(
        Object.entries(messages).filter(([field]) =>
          error.columns.includes(field) || error.columns.includes(snakeCase(field))
        )
      )

      return Effect.fail(Object.keys(errors).length === 0 ? error : new ValidationError({ errors }))
    })
}

// ---------------------------------------------------------------------------
// Driver capabilities, read from the application's Drizzle client type
// ---------------------------------------------------------------------------

/** Shown where a transaction client is expected when the driver has none. */
interface TransactionsNotSupported {
  readonly __error: 'This database client has no transaction() method.'
  readonly __hint: 'Use dbBatch for atomic writes, or a driver with transactions.'
}

/** Shown where a transaction client is expected for a synchronous driver. */
interface SynchronousTransactionsNotSupported {
  readonly __error: 'This database driver runs transactions synchronously, so awaited writes run after it commits.'
  readonly __hint: 'Use an asynchronous driver (libsql, Postgres, MySQL), or dbBatch for atomic writes.'
}

/** Shown where batch statements are expected when the driver cannot batch. */
interface BatchNotSupported {
  readonly __error: 'This database client has no batch() method.'
  readonly __hint: 'Use dbTransaction, or a driver with batches (Cloudflare D1, libsql, Neon HTTP).'
}

type TransactionMethod = DatabaseType extends { transaction: infer Method } ? Method : never

/**
 * The client `transaction(run)` passes to its callback, when the driver
 * awaits the callback before committing. A synchronous driver's
 * `transaction` returns the callback's result instead of a promise.
 */
export type TransactionClient = [TransactionMethod] extends [never]
  ? TransactionsNotSupported
  : TransactionMethod extends (run: (tx: infer Tx) => infer _, ...config: infer _Config) => infer Result
    ? Result extends PromiseLike<unknown>
      ? Tx
      : SynchronousTransactionsNotSupported
    : TransactionsNotSupported

interface AsyncTransactions<Tx> {
  transaction<A>(run: (tx: Tx) => Promise<A>): Promise<A>
}

type BatchMethod = DatabaseType extends { batch: infer Method } ? Method : never

/** The statements the driver's `batch` accepts. */
export type BatchArgument = [BatchMethod] extends [never]
  ? readonly [BatchNotSupported]
  : BatchMethod extends (statements: infer Statements, ...rest: infer _Rest) => unknown
    ? Statements
    : readonly [BatchNotSupported]

/** Each batched statement's result, in order. */
export type BatchResults<Items> = { -readonly [K in keyof Items]: Awaited<Items[K]> }

interface Batches<Items> {
  batch(statements: Items): Promise<BatchResults<Items>>
}

// ---------------------------------------------------------------------------
// Running and classifying
// ---------------------------------------------------------------------------

/**
 * Run a database callback. Its result is awaited, so a callback may return a
 * promise, a Drizzle query builder, or a synchronous driver's plain value; a
 * synchronous throw fails the same way as a rejection.
 */
function run<A, E>(
  operation: Operation,
  execute: (db: DatabaseType) => A,
  classify: (cause: unknown) => Effect.Effect<never, E>
): Effect.Effect<Awaited<A>, E, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* DatabaseService

    return yield* Effect.tryPromise({
      // oxlint-disable-next-line effecttsgo/async-function -- Drivers return promises, thenable query builders or plain values; awaiting one normalizes all three at this adapter seam.
      try: async (): Promise<Awaited<A>> => await execute(db),
      catch: (cause) => cause,
    }).pipe(Effect.catch(classify))
  }).pipe(Effect.withSpan(SPANS[operation]))
}

const SPANS: Readonly<Record<Operation, string>> = {
  query: 'Web.dbQuery',
  mutation: 'Web.dbMutation',
  transaction: 'Web.dbTransaction',
  batch: 'Web.dbBatch',
}

/**
 * Classify a failed write. A failure that only interactive transactions cause
 * on D1 is a programming error, so it becomes a defect naming the fix.
 */
function classifyFailure(
  cause: unknown,
  operation: Exclude<Operation, 'query'>
): Effect.Effect<never, DatabaseWriteError> {
  const chain = causeChain(cause)

  if (operation === 'transaction' && chain.some(isUnsupportedTransactionStatement)) {
    return Effect.die(new Error(
      'This database does not run interactive transactions (Cloudflare D1 rejects BEGIN and SAVEPOINT). ' +
        'Use dbBatch((db) => [...statements]) to apply several writes atomically.',
      { cause }
    ))
  }

  const classified = chain.map(classifyError)
  const constraint = classified.find((kind) => kind !== undefined && kind !== 'unknown')
    ?? classified.find((kind) => kind !== undefined)

  if (constraint === undefined) {
    return Effect.fail(new DatabaseError({ operation, cause }))
  }

  const details = chain.map(readConstraintDetails)

  return Effect.fail(new DatabaseConstraintViolation({
    operation,
    constraint,
    columns: details.find((detail) => detail.columns.length > 0)?.columns ?? [],
    constraintName: details.find((detail) => detail.constraintName !== undefined)?.constraintName,
    cause,
  }))
}

/**
 * The failure and the errors it wraps, outermost first. Drizzle wraps driver
 * errors (`Failed to run the query ...`) and keeps the driver's in `cause`.
 */
function causeChain(cause: unknown): ReadonlyArray<object> {
  const chain: object[] = []

  for (let current = cause; current instanceof Object && chain.length < 5; ) {
    chain.push(current)
    current = 'cause' in current ? current.cause : undefined
  }

  return chain
}

function readString(error: object, key: string): string | undefined {
  const value: unknown = Object.getOwnPropertyDescriptor(error, key)?.value

  return typeof value === 'string' ? value : undefined
}

function messageOf(error: object): string {
  return error instanceof Error ? error.message : ''
}

function isUnsupportedTransactionStatement(error: object): boolean {
  return /\b(BEGIN TRANSACTION|SAVEPOINT)\b|state\.storage\.transaction/i.test(messageOf(error))
}

/** Postgres SQLSTATE, MySQL errno and SQLite extended result codes. */
const CONSTRAINT_CODES = new Map<string, Constraint>([
  ['23505', 'unique'],
  ['1062', 'unique'],
  ['ER_DUP_ENTRY', 'unique'],
  ['23503', 'foreign-key'],
  ['1451', 'foreign-key'],
  ['1452', 'foreign-key'],
  ['ER_NO_REFERENCED_ROW_2', 'foreign-key'],
  ['ER_ROW_IS_REFERENCED_2', 'foreign-key'],
  ['23502', 'not-null'],
  ['23514', 'check'],
  ['SQLITE_CONSTRAINT_UNIQUE', 'unique'],
  ['SQLITE_CONSTRAINT_PRIMARYKEY', 'unique'],
  ['SQLITE_CONSTRAINT_FOREIGNKEY', 'foreign-key'],
  ['SQLITE_CONSTRAINT_NOTNULL', 'not-null'],
  ['SQLITE_CONSTRAINT_CHECK', 'check'],
  ['SQLITE_CONSTRAINT', 'unknown'],
])

/**
 * SQLite's constraint messages, for drivers such as D1 that report the
 * generic SQLITE_CONSTRAINT code or none.
 */
const SQLITE_CONSTRAINT_MESSAGES: ReadonlyArray<readonly [RegExp, Constraint]> = [
  [/\bUNIQUE constraint failed\b/, 'unique'],
  [/\bFOREIGN KEY constraint failed\b/, 'foreign-key'],
  [/\bNOT NULL constraint failed\b/, 'not-null'],
  [/\bCHECK constraint failed\b/, 'check'],
]

function classifyError(error: object): Constraint | undefined {
  const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value
    ?? Object.getOwnPropertyDescriptor(error, 'errno')?.value
  const byCode = typeof code === 'string' || typeof code === 'number'
    ? CONSTRAINT_CODES.get(String(code).toUpperCase())
    : undefined

  if (byCode !== undefined && byCode !== 'unknown') return byCode

  const message = messageOf(error)

  return SQLITE_CONSTRAINT_MESSAGES.find(([pattern]) => pattern.test(message))?.[1] ?? byCode
}

interface ConstraintDetails {
  readonly columns: ReadonlyArray<string>
  readonly constraintName?: string
}

/**
 * The columns and name of a violated constraint, as each driver reports them:
 * SQLite in its message, Postgres in `detail`/`column` and `constraint`
 * (`constraint_name` for postgres.js), MySQL in its message.
 */
function readConstraintDetails(error: object): ConstraintDetails {
  const message = messageOf(error)
  // `UNIQUE constraint failed: pages.workspace_id, pages.slug`
  const sqliteColumns = /(?:UNIQUE|NOT NULL) constraint failed: ((?:\w+\.)?\w+(?:, (?:\w+\.)?\w+)*)/.exec(message)

  if (sqliteColumns) {
    return { columns: sqliteColumns[1].split(', ').map((column) => column.split('.').pop() ?? column) }
  }

  // `CHECK constraint failed: title_not_blank`, for a named constraint
  const sqliteCheck = /CHECK constraint failed: (\w+)(?::|$)/.exec(message)

  if (sqliteCheck) {
    return { columns: [], constraintName: sqliteCheck[1] }
  }

  const constraintName = readString(error, 'constraint') ?? readString(error, 'constraint_name')
  const detail = /^Key \(([^)]+)\)=/.exec(readString(error, 'detail') ?? '')
  const column = readString(error, 'column') ?? readString(error, 'column_name')

  if (detail || column || constraintName) {
    return {
      columns: detail ? detail[1].split(',').map((name) => name.trim()) : column ? [column] : [],
      constraintName,
    }
  }

  const mysql = /for key '(?:[\w]+\.)?([\w]+)'/.exec(message)

  return { columns: [], constraintName: mysql?.[1] }
}

function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}
