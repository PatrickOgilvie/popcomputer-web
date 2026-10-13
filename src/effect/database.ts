/**
 * Database operations for actions.
 *
 * Each operation reads the request's client from `DatabaseService`, so an
 * action that touches the database requires the service its route checks for.
 * Callbacks receive the application's own Drizzle client, as setupWeb's
 * `database` declares it, so columns, rows and `.returning()` keep Drizzle's
 * types.
 *
 * Failures are typed: a write that breaks a constraint fails with
 * `DatabaseConstraintViolation`, naming the constraint kind and, when the
 * driver reports them, its columns; anything else fails with `DatabaseError`.
 */

import { Cause, Effect, Exit, Result, Schema as S } from 'effect'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type { SQLiteRaw } from 'drizzle-orm/sqlite-core/query-builders/raw'
import { DatabaseService, type DatabaseType } from './services.js'
import { DatabaseConstraintViolation, DatabaseError, ValidationError } from './errors.js'

type Operation = DatabaseError['operation']
type Constraint = DatabaseConstraintViolation['constraint']

/** How a write can fail. */
export type DatabaseWriteError = DatabaseError | DatabaseConstraintViolation

/**
 * Read with the request's database. Pass a schema to decode the result into
 * the application's types, such as a status column into its literal union; a
 * result the schema rejects fails with DatabaseError.
 *
 * @example
 * const recent = yield* dbQuery((db) =>
 *   db.select().from(projects).where(eq(projects.userId, auth.user.id)).limit(10)
 * )
 *
 * const claims = yield* dbQuery((db) => db.select().from(claimsTable), S.Array(Claim))
 */
export function dbQuery<A>(
  query: (db: DatabaseType) => A
): Effect.Effect<Awaited<A>, DatabaseError, DatabaseService>
export function dbQuery<A, T>(
  query: (db: DatabaseType) => A,
  schema: S.Codec<T, unknown, never, never>
): Effect.Effect<T, DatabaseError, DatabaseService>
export function dbQuery<A, T>(
  query: (db: DatabaseType) => A,
  schema?: S.Codec<T, unknown, never, never>
): Effect.Effect<Awaited<A> | T, DatabaseError, DatabaseService> {
  const rows = run('query', query, (cause) => Effect.fail(new DatabaseError({ operation: 'query', cause })))

  return schema === undefined
    ? rows
    : Effect.flatMap(rows, (result) =>
        S.decodeUnknownEffect(schema)(result).pipe(
          Effect.mapError((cause) => new DatabaseError({ operation: 'query', cause }))
        )
      )
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
): Effect.Effect<DatabaseResult<Awaited<A>>, DatabaseWriteError, DatabaseService> {
  // SAFETY: DatabaseResult only renames a result typed `any`; the value is the write's.
  return run('mutation', write, (cause) => classifyFailure(cause, 'mutation')) as Effect.Effect<
    DatabaseResult<Awaited<A>>,
    DatabaseWriteError,
    DatabaseService
  >
}

/**
 * Run an Effect in an interactive transaction. Inside it, `DatabaseService`
 * is the transaction, so every `dbQuery` and `dbMutation` the Effect runs,
 * including those of the services it calls, takes part. The transaction
 * commits when the Effect succeeds; when it fails, the transaction rolls back
 * and the Effect's own failure, typed, is the result.
 *
 * Needs a driver whose transactions are asynchronous, such as Postgres, MySQL
 * or libsql: Cloudflare D1 and synchronous drivers are a type error. Use
 * `dbBatch` on D1.
 *
 * @example
 * yield* dbTransaction(Effect.gen(function* () {
 *   const claim = yield* claims.lockForDecision(claimId)
 *   const decision = yield* approvals.decide(claim, auth.user)
 *   yield* dbMutation((db) => db.insert(auditLog).values(decision.audit))
 * }))
 */
export function dbTransaction<A, E, R>(
  transaction: Effect.Effect<A, E, R> & TransactionSupport
): Effect.Effect<A, E | DatabaseWriteError, R | DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* DatabaseService
    const context = yield* Effect.context<R>()
    // SAFETY: TransactionSupport admits the call only when DatabaseType has an
    // asynchronous `transaction(run)`.
    const transactional = db as unknown as AsyncTransactions<DatabaseType>

    const outcome = yield* Effect.tryPromise({
      try: (signal) =>
        transactional.transaction((tx) =>
          Effect.runPromiseExitWith(context)(
            Effect.provideService(transaction, DatabaseService, tx),
            { signal }
          ).then((exit) => Exit.isSuccess(exit) ? exit.value : Promise.reject(new RolledBack(exit.cause)))
        ),
      catch: (cause) => cause,
    }).pipe(Effect.result)

    if (Result.isSuccess(outcome)) return outcome.success

    // The Effect failed, and its failure rolled the transaction back.
    if (outcome.failure instanceof RolledBack) {
      // SAFETY: RolledBack carries the cause `transaction` failed with, whose
      // errors are E.
      return yield* Effect.failCause(outcome.failure.cause as Cause.Cause<E>)
    }

    return yield* classifyFailure(outcome.failure, 'transaction')
  }).pipe(Effect.withSpan(SPANS.transaction))
}

/** Carries a failed transaction Effect's cause out of the driver's rollback. */
class RolledBack {
  constructor(readonly cause: Cause.Cause<unknown>) {}
}

/**
 * Run statements as one atomic batch: all of them apply, or none. This is
 * how Cloudflare D1 makes several writes atomic; libsql and Neon's HTTP
 * driver support it too. Each statement's result comes back in order.
 *
 * A list built at run time, such as one statement per line of a form, is a
 * batch too: its results are a list, and an empty list runs nothing.
 *
 * @example
 * yield* dbBatch((db) => [
 *   db.delete(tasks).where(eq(tasks.projectId, project.id)),
 *   db.delete(projects).where(eq(projects.id, project.id)),
 * ])
 * yield* dbBatch((db) => lines.map((line) => db.update(stock).set(...).where(...)))
 */
export function dbBatch<const Items extends BatchArgument>(
  statements: (db: DatabaseType) => Items & CheckedBatchItems<Items>
): Effect.Effect<BatchResults<Items>, DatabaseWriteError, DatabaseService>
export function dbBatch<Item extends BatchStatement>(
  statements: (db: DatabaseType) => ReadonlyArray<Item> & CheckedBatchItems<ReadonlyArray<Item>>
): Effect.Effect<ReadonlyArray<DatabaseResult<Awaited<Item>>>, DatabaseWriteError, DatabaseService>
export function dbBatch(
  statements: (db: DatabaseType) => ReadonlyArray<unknown>
): Effect.Effect<unknown, DatabaseWriteError, DatabaseService> {
  return run(
    'batch',
    (db) => {
      const items = statements(db)

      if (items.length === 0) return Promise.resolve([])

      // SAFETY: BatchArgument is an error type unless DatabaseType has a
      // `batch(statements)` method, whose results Drizzle returns in order;
      // the list is not empty.
      const batching = db as unknown as Batches<ReadonlyArray<unknown>>

      return batching.batch(items)
    },
    (cause) => classifyFailure(cause, 'batch')
  )
}

/** Unique constraints `uniqueFieldErrors` reports by name, with the form field each belongs to. */
export interface UniqueFieldErrorsOptions<Field extends string> {
  /**
   * Unique constraints whose violation belongs on a field, each named as the
   * database reports it: by name, as Postgres names an index on an expression
   * such as `lower(email)`, which reports no columns; or by its columns joined
   * with commas, as SQLite and D1 report a composite key such as
   * `'org_id,user_id'` that belongs on another field. Columns match in any
   * order, in the schema's camelCase or the database's snake_case.
   */
  readonly constraints?: Readonly<Record<string, Field>>
}

/**
 * Report a unique violation on any of the given columns as field errors, so
 * a form shows the message beside the field instead of an error page. Keys
 * are column names, in the schema's camelCase or the database's snake_case;
 * `constraints` names unique constraints by the field they belong on. Other
 * failures pass through unchanged.
 *
 * @example
 * yield* dbMutation((db) => db.insert(pages).values(page)).pipe(
 *   uniqueFieldErrors({ slug: 'A page with this slug already exists.' })
 * )
 * yield* dbMutation((db) => db.insert(contacts).values(contact)).pipe(
 *   uniqueFieldErrors({ email: 'A contact has this email.' }, { constraints: { contacts_email_lower_unique: 'email' } })
 * )
 * yield* dbMutation((db) => db.insert(memberships).values(member)).pipe(
 *   uniqueFieldErrors({ email: 'Already a member.' }, { constraints: { 'org_id,user_id': 'email' } })
 * )
 */
export function uniqueFieldErrors<const Field extends string>(
  messages: Readonly<Record<Field, string>>,
  options: UniqueFieldErrorsOptions<Field> = {}
): <A, E, R>(
  self: Effect.Effect<A, E, R>
) => Effect.Effect<A, E | ValidationError, R> {
  return <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.catch(self, (error): Effect.Effect<never, E | ValidationError> => {
      if (!(error instanceof DatabaseConstraintViolation) || error.constraint !== 'unique') {
        return Effect.fail(error)
      }

      const violated = error.columns.length === 0 ? undefined : columnsKey(error.columns)
      const named = Object.entries<Field>(options.constraints ?? {}).find(([key]) =>
        key === error.constraintName || (violated !== undefined && columnsKey(key.split(',')) === violated)
      )?.[1]
      const errors = Object.fromEntries(
        Object.entries<string>(messages).filter(([field]) =>
          field === named || error.columns.includes(field) || error.columns.includes(snakeCase(field))
        )
      )

      return Effect.fail(Object.keys(errors).length === 0 ? error : new ValidationError({ errors }))
    })
}

/**
 * Report a violation of a named constraint of any kind, such as a `CHECK`,
 * an exclusion constraint or a trigger's `RAISE(ABORT, 'name')`, as field
 * errors, so a form shows the rule beside the fields it covers. A violation
 * of a constraint the map does not name, or one the database reports without
 * a name, passes through unchanged. `uniqueFieldErrors` covers unique keys by
 * their columns.
 *
 * @example
 * yield* dbMutation((db) => db.insert(leases).values(lease)).pipe(
 *   constraintFieldErrors({ leases_no_overlap: { startDate: 'Another lease covers these dates.' } })
 * )
 */
export function constraintFieldErrors(
  byConstraint: Readonly<Record<string, Readonly<Record<string, string>>>>
): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E | ValidationError, R> {
  return <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.catch(self, (error): Effect.Effect<never, E | ValidationError> => {
      const errors = error instanceof DatabaseConstraintViolation && error.constraintName !== undefined
        ? Object.hasOwn(byConstraint, error.constraintName) ? byConstraint[error.constraintName] : undefined
        : undefined

      return Effect.fail(errors === undefined ? error : new ValidationError({ errors: { ...errors } }))
    })
}

// ---------------------------------------------------------------------------
// Driver capabilities, read from the application's Drizzle client type
// ---------------------------------------------------------------------------

/** Shown where batch statements are expected when the driver cannot batch. */
interface BatchNotSupported {
  readonly __error: 'This database client has no batch() method.'
  readonly __hint: 'Use dbTransaction, or a driver with batches (Cloudflare D1, libsql, Neon HTTP).'
}

type TransactionMethod = DatabaseType extends { transaction: infer Method } ? Method : never

/** The driver client Drizzle keeps as `$client`, when the database type exposes it. */
type DriverClient = DatabaseType extends { $client: infer Client } ? Client : never

/**
 * Whether the driver is Cloudflare D1, whose client prepares, executes and
 * batches statements but has no transactions. The SQLite drivers with
 * transactions (bun:sqlite, better-sqlite3, libsql) expose `transaction`.
 */
type IsD1 = IsD1Client extends true ? true : IsD1RunResult

type IsD1Client = [DriverClient] extends [never]
  ? false
  : DriverClient extends { prepare: unknown; exec: unknown; batch: unknown }
    ? DriverClient extends { transaction: unknown } ? false : true
    : false

/**
 * Whether the database is Drizzle's D1 database by its run result, for a
 * database type without `$client`, such as `DrizzleD1Database<typeof schema>`:
 * D1's results carry `success` and `meta`, which libsql's and the others' do
 * not. Unknown when Cloudflare's types are missing and the result is `any`.
 */
type IsD1RunResult = DatabaseType extends BaseSQLiteDatabase<'async', infer Run, infer _Full, infer _Schema>
  ? 0 extends 1 & Run
    ? false
    : Run extends { readonly success: unknown; readonly meta: unknown } ? true : false
  : false

/**
 * The client `transaction(run)` passes to its callback, when the driver
 * awaits the callback before committing, or an error type naming why it
 * cannot. A synchronous driver's `transaction` returns the callback's result
 * instead of a promise. The error types are written inline, so a type error
 * at `dbTransaction` prints their text.
 */
export type TransactionClient = [TransactionMethod] extends [never]
  ? {
      readonly __error: 'This database client has no transaction() method.'
      readonly __hint: 'Use dbBatch for atomic writes, or a driver with transactions.'
    }
  : IsD1 extends true
    ? {
        readonly __error: 'Cloudflare D1 has no interactive transactions: it rejects BEGIN and SAVEPOINT.'
        readonly __hint: 'Use dbBatch((db) => [...statements]) to apply several writes atomically.'
      }
  : TransactionMethod extends (run: (tx: infer Tx) => infer _, ...config: infer _Config) => infer Result
    ? Result extends PromiseLike<unknown>
      ? Tx
      : {
          readonly __error: 'This database driver runs transactions synchronously, so awaited writes run after it commits.'
          readonly __hint: 'Use an asynchronous driver (libsql, Postgres, MySQL), or dbBatch for atomic writes.'
        }
    : {
        readonly __error: 'This database client has no transaction() method.'
        readonly __hint: 'Use dbBatch for atomic writes, or a driver with transactions.'
      }

/**
 * What `dbTransaction` adds to its argument's type: nothing for a driver with
 * asynchronous transactions, or the error type naming why the driver has none.
 */
export type TransactionSupport = TransactionClient extends { readonly __error: string } ? TransactionClient : unknown

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

/** One statement the database's batch takes. */
export type BatchStatement = BatchArgument extends ReadonlyArray<infer Item> ? Item : never

/** Each batched statement's result, in order. */
export type BatchResults<Items> = { -readonly [K in keyof Items]: DatabaseResult<Awaited<Items[K]>> }

/** Shown in place of a database result whose type is `any`. */
export interface UntypedDatabaseResult {
  readonly __error: "This result's type is any: the driver's types name a global type the program cannot find."
  readonly __hint: "For Cloudflare D1, add '@cloudflare/workers-types', or the file `wrangler types` writes, to tsconfig's compilerOptions.types."
}

/**
 * A database operation's result, or UntypedDatabaseResult when its type is
 * `any`, so code that reads it, such as `result.meta.changes`, is a type
 * error instead of unchecked.
 */
export type DatabaseResult<A> = 0 extends 1 & A ? UntypedDatabaseResult : A

/**
 * Shown in place of `db.run(sql)` in a D1 batch, which Drizzle cannot run
 * there. A string, so the compiler's message includes it.
 */
export type RawStatementInD1Batch =
  'Drizzle cannot run db.run(sql) with parameters in a Cloudflare D1 batch, where it fails at runtime: write the statement with the query builder, such as db.insert(table).select(...), or run it alone with dbMutation.'

/** The statements, with each raw statement in a D1 batch replaced by an error type. */
export type CheckedBatchItems<Items> = IsD1 extends true
  ? { readonly [K in keyof Items]: [Extract<Items[K], SQLiteRaw<unknown>>] extends [never] ? Items[K] : RawStatementInD1Batch }
  : unknown

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
  // An exclusion constraint, such as no two bookings of a room overlapping.
  ['23P01', 'exclusion'],
  // A trigger's RAISE(ABORT, 'name'), how SQLite states such a rule.
  ['SQLITE_CONSTRAINT_TRIGGER', 'trigger'],
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
  [/\bSQLITE_CONSTRAINT_TRIGGER\b/, 'trigger'],
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
  // A trigger's RAISE(ABORT, 'name') reports the name as the message, which
  // D1 wraps: `D1_ERROR: name: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`.
  const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value
  const d1Trigger = /^D1_ERROR: (.+?): SQLITE_CONSTRAINT \(extended: SQLITE_CONSTRAINT_TRIGGER\)/.exec(message)

  if (d1Trigger) return { columns: [], constraintName: d1Trigger[1] }
  if (code === 'SQLITE_CONSTRAINT_TRIGGER') return { columns: [], constraintName: message }

  // `UNIQUE constraint failed: index 'user_handle_lower_unique'`, for an
  // index on an expression, such as lower(handle), which has no columns
  const sqliteIndex = /(?:UNIQUE|NOT NULL) constraint failed: index '([^']+)'/.exec(message)

  if (sqliteIndex) {
    return { columns: [], constraintName: sqliteIndex[1] }
  }

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

/** A constraint's columns as one key, in snake_case and sorted: `'userId, orgId'` is `org_id,user_id`. */
function columnsKey(columns: ReadonlyArray<string>): string {
  return columns.map((column) => snakeCase(column.trim())).sort().join(',')
}
