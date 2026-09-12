/**
 * Effect Action Composables
 *
 * Composable helpers for building Effect-based request handlers.
 * Actions are fully opt-in - yield* only what you need.
 */

import { Effect, Schema as S } from 'effect'
import type { Redirect } from './errors.js'
import {
  DatabaseConstraintViolation,
  DatabaseMutationFailed,
  DatabaseTransactionFailed,
} from './errors.js'
import type { Validated, Trusted } from './validation.js'

declare const MutationScopeBrand: unique symbol

/**
 * Semantic wrapper for Effect actions.
 *
 * This is a minimal wrapper that marks an Effect as an action.
 * All capabilities are opt-in via yield* inside your handler.
 *
 * @example
 * const createProject = action(
 *   Effect.gen(function* () {
 *     // Opt-in to authorization
 *     const auth = yield* authorize()
 *
 *     // Opt-in to validation
 *     const input = yield* validateRequest(S.Struct({ name: requiredString }))
 *
 *     // Opt-in to database
 *     const db = yield* DatabaseService
 *
 *     yield* dbMutation(db, async (tx) => {
 *       await tx.insert(projects).values(asTrusted({ ...input, userId: auth.user.id }))
 *     })
 *     return new Redirect({ url: '/projects', status: 303 })
 *   })
 * )
 */
export function action<R, E>(
  handler: Effect.Effect<Response | Redirect, E, R>
): Effect.Effect<Response | Redirect, E, R> {
  return handler
}

/**
 * Run a database mutation with a safe wrapper.
 * Writes only accept validated or trusted inputs for insert/update/execute params.
 *
 * @example
 * const input = yield* validateRequest(CreateProjectSchema)
 * const db = yield* DatabaseService
 * yield* dbMutation(db, async (db) => {
 *   await db.insert(projects).values(asTrusted({ ...input, userId: auth.user.id }))
 * })
 *
 * @example
 * // Scoped mutation input: writes only accept values from txInput inside callback
 * const txInput = asTrusted({
 *   createProject: { name: input.name, userId: auth.user.id },
 * })
 *
 * yield* dbMutation(db, txInput, async (db, txInput) => {
 *   await db.insert(projects).values(txInput.createProject)
 * })
 */
export function dbMutation<DB, T>(
  db: DB,
  operation: (db: SafeTx<DB>) => Promise<T>
): Effect.Effect<T, DatabaseMutationFailed | DatabaseConstraintViolation>

export function dbMutation<DB, I, T>(
  db: DB,
  input: Validated<I> | Trusted<I>,
  operation: <Scope extends symbol>(
    db: ScopedSafeTx<DB, Scope>,
    input: MutationInput<Scope, I>
  ) => Promise<T>
): Effect.Effect<T, DatabaseMutationFailed | DatabaseConstraintViolation>

export function dbMutation<DB, I, T>(
  db: DB,
  inputOrOperation: (Validated<I> | Trusted<I>) | ((db: SafeTx<DB>) => Promise<T>),
  maybeOperation?: <Scope extends symbol>(
    db: ScopedSafeTx<DB, Scope>,
    input: MutationInput<Scope, I>
  ) => Promise<T>
): Effect.Effect<T, DatabaseMutationFailed | DatabaseConstraintViolation> {
  if (inputOrOperation instanceof Function) {
    const operation = inputOrOperation

    // SAFETY: The surrounding adapter established this value's runtime invariant before restoring the precise TypeScript contract.
    return Effect.tryPromise({
      try: (): Promise<T> => operation(db as SafeTx<DB>),
      catch: (cause) => classifyDatabaseFailure(cause, 'mutation'),
    })
  }

  if (!maybeOperation) {
    return Effect.die(
      new Error('dbMutation scoped mode requires an operation callback')
    )
  }

  // SAFETY: The surrounding adapter established this value's runtime invariant before restoring the precise TypeScript contract.
  return Effect.tryPromise({
    try: (): Promise<T> =>
      maybeOperation(
        db as ScopedSafeTx<DB, symbol>,
        inputOrOperation as MutationInput<symbol, I>
      ),
    catch: (cause) => classifyDatabaseFailure(cause, 'mutation'),
  })
}

type SafeInput<A> = Validated<A> | Trusted<A>

type SafeValues<V> =
  V extends Array<infer E>
    ? Array<SafeInput<E>> | SafeInput<E> | SafeInput<V>
    : V extends ReadonlyArray<infer E>
      ? ReadonlyArray<SafeInput<E>> | SafeInput<E> | SafeInput<V>
      : SafeInput<V>

type SafeParam<P> =
  P extends ReadonlyArray<unknown>
    ? SafeValues<P>
    : P extends Array<unknown>
      ? SafeValues<P>
      : P extends object
        ? SafeInput<P>
        : P

type WrapExecuteArgs<A extends unknown[]> =
  A extends [infer Q, infer P, ...infer Rest]
    ? [Q, SafeParam<P>, ...Rest]
    : A

type WrapSecondArg<A extends unknown[]> =
  A extends [infer First, infer Second, ...infer Rest]
    ? [First, SafeParam<Second>, ...Rest]
    : A

type WrapMethod<I, K extends string> =
  I extends Record<K, (...args: infer A) => infer R>
    ? Omit<I, K> & { [P in K]: (...args: WrapExecuteArgs<A>) => R }
    : I

type WrapBuilder<I> = WrapMethod<WrapMethod<WrapMethod<I, 'execute'>, 'run'>, 'query'>

type WrapValues<I> = I extends { values: (values: infer V) => infer R }
  ? WrapBuilder<Omit<I, 'values'> & { values: (values: SafeValues<V>) => R }>
  : WrapBuilder<I>

type WrapSet<I> = I extends { set: (values: infer V) => infer R }
  ? WrapBuilder<Omit<I, 'set'> & { set: (values: SafeValues<V>) => R }>
  : WrapBuilder<I>

type SafeInsert<Tx> = Tx extends { insert: (...args: infer A) => infer I }
  ? Omit<Tx, 'insert'> & { insert: (...args: WrapSecondArg<A>) => WrapValues<I> }
  : Tx

type SafeUpdate<Tx> = Tx extends { update: (...args: infer A) => infer I }
  ? Omit<Tx, 'update'> & { update: (...args: WrapSecondArg<A>) => WrapSet<I> }
  : Tx

type SafeDelete<Tx> = Tx extends { delete: (...args: infer A) => infer I }
  ? Omit<Tx, 'delete'> & { delete: (...args: WrapSecondArg<A>) => WrapBuilder<I> }
  : Tx

export type SafeTx<Tx> = WrapBuilder<SafeDelete<SafeUpdate<SafeInsert<Tx>>>>

type ScopedMarker<Scope extends symbol> = { readonly [MutationScopeBrand]: Scope }

/**
 * Deeply branded mutation object used by scoped dbMutation/dbTransaction overloads.
 * The database wrapper only accepts values carrying this exact scope brand.
 */
export type MutationInput<Scope extends symbol, A> =
  A extends Array<infer E>
    ? Array<MutationInput<Scope, E>> & ScopedMarker<Scope>
    : A extends ReadonlyArray<infer E>
      ? ReadonlyArray<MutationInput<Scope, E>> & ScopedMarker<Scope>
      : A extends object
        ? { [K in keyof A]: MutationInput<Scope, A[K]> } & ScopedMarker<Scope>
        : A

type UnscopedMutationInput<A> =
  A extends ReadonlyArray<infer E>
    ? ReadonlyArray<UnscopedMutationInput<E>>
    : A extends Array<infer E>
      ? Array<UnscopedMutationInput<E>>
      : A extends object
        ? {
          [K in keyof A as K extends typeof MutationScopeBrand ? never : K]:
            UnscopedMutationInput<A[K]>
        }
        : A

type NoExtraKeys<Actual, Allowed> =
  Actual & Record<Exclude<keyof Actual, keyof Allowed>, never>

type MergedMutationInput<
  Scoped extends MutationInput<symbol, object>,
  Patch extends Partial<UnscopedMutationInput<Scoped>>
> = Omit<Scoped, keyof Patch> & {
  [K in keyof Patch]-?: NonNullable<Patch[K]>
}

/**
 * Merge fields into a scoped mutation input while preserving its scope brand.
 *
 * Patch keys must already exist on the scoped input shape. This allows adding
 * transaction-derived values (e.g. generated IDs) only when they were reserved
 * in the transaction schema (typically as optional fields). Patched keys are
 * narrowed to required, non-nullable values in the returned type.
 */
export function mergeMutationInput<
  Scoped extends MutationInput<symbol, object>,
  Patch extends Partial<UnscopedMutationInput<Scoped>>
>(
  base: Scoped,
  patch: NoExtraKeys<Patch, Partial<UnscopedMutationInput<Scoped>>>
): MergedMutationInput<Scoped, Patch> {
  // SAFETY: The surrounding adapter established this value's runtime invariant before restoring the precise TypeScript contract.
  return {
    ...base,
    ...patch,
  } as MergedMutationInput<Scoped, Patch>
}

type ScopedSafeValues<Scope extends symbol, V> =
  V extends Array<infer E>
    ? Array<MutationInput<Scope, E>> | MutationInput<Scope, E> | MutationInput<Scope, V>
    : V extends ReadonlyArray<infer E>
      ? ReadonlyArray<MutationInput<Scope, E>> | MutationInput<Scope, E> | MutationInput<Scope, V>
      : MutationInput<Scope, V>

type ScopedSafeParam<Scope extends symbol, P> =
  P extends ReadonlyArray<unknown>
    ? ScopedSafeValues<Scope, P>
    : P extends Array<unknown>
      ? ScopedSafeValues<Scope, P>
      : P extends object
        ? MutationInput<Scope, P>
        : P

type ScopedWrapExecuteArgs<Scope extends symbol, A extends unknown[]> =
  A extends [infer Q, infer P, ...infer Rest]
    ? [Q, ScopedSafeParam<Scope, P>, ...Rest]
    : A

type ScopedWrapSecondArg<Scope extends symbol, A extends unknown[]> =
  A extends [infer First, infer Second, ...infer Rest]
    ? [First, ScopedSafeParam<Scope, Second>, ...Rest]
    : A

type ScopedWrapMethod<Scope extends symbol, I, K extends string> =
  I extends Record<K, (...args: infer A) => infer R>
    ? Omit<I, K> & { [P in K]: (...args: ScopedWrapExecuteArgs<Scope, A>) => R }
    : I

type ScopedWrapBuilder<Scope extends symbol, I> =
  ScopedWrapMethod<Scope, ScopedWrapMethod<Scope, ScopedWrapMethod<Scope, I, 'execute'>, 'run'>, 'query'>

type ScopedWrapValues<Scope extends symbol, I> = I extends { values: (values: infer V) => infer R }
  ? ScopedWrapBuilder<Scope, Omit<I, 'values'> & { values: (values: ScopedSafeValues<Scope, V>) => R }>
  : ScopedWrapBuilder<Scope, I>

type ScopedWrapSet<Scope extends symbol, I> = I extends { set: (values: infer V) => infer R }
  ? ScopedWrapBuilder<Scope, Omit<I, 'set'> & { set: (values: ScopedSafeValues<Scope, V>) => R }>
  : ScopedWrapBuilder<Scope, I>

type ScopedInsert<Scope extends symbol, Tx> = Tx extends { insert: (...args: infer A) => infer I }
  ? Omit<Tx, 'insert'> & { insert: (...args: ScopedWrapSecondArg<Scope, A>) => ScopedWrapValues<Scope, I> }
  : Tx

type ScopedUpdate<Scope extends symbol, Tx> = Tx extends { update: (...args: infer A) => infer I }
  ? Omit<Tx, 'update'> & { update: (...args: ScopedWrapSecondArg<Scope, A>) => ScopedWrapSet<Scope, I> }
  : Tx

type ScopedDelete<Scope extends symbol, Tx> = Tx extends { delete: (...args: infer A) => infer I }
  ? Omit<Tx, 'delete'> & { delete: (...args: ScopedWrapSecondArg<Scope, A>) => ScopedWrapBuilder<Scope, I> }
  : Tx

type ScopedSafeTx<Tx, Scope extends symbol> =
  ScopedWrapBuilder<Scope, ScopedDelete<Scope, ScopedUpdate<Scope, ScopedInsert<Scope, Tx>>>>

/**
 * Error type shown when database doesn't support transactions.
 */
interface TransactionNotSupported {
  readonly __error: 'Database client does not support transactions. Ensure your database exposes a transaction() method.'
  readonly __hint: 'Expected signature: db.transaction((tx) => Promise<T>) => Promise<T>. See https://github.com/patrickogilvie/popcomputer-web#validation-and-safe-writes'
}

interface TransactionDatabase<Tx> {
  transaction<Result>(fn: (tx: Tx) => Promise<Result>): Promise<Result>
}

type TransactionClient<DB> =
  DB extends TransactionDatabase<infer Tx> ? Tx : TransactionNotSupported

/**
 * Run multiple database operations in a transaction.
 * Automatically rolls back on any failure.
 *
 * The transaction client is wrapped as `SafeTx` so writes only accept
 * validated or trusted inputs for insert/update/execute params.
 *
 * @example
 * const input = yield* validateRequest(CreateUserSchema)
 * const balanceUpdate = asTrusted({ balance: 100 })
 * const db = yield* DatabaseService
 * yield* dbTransaction(db, async (tx) => {
 *   await tx.insert(users).values(input)
 *   await tx.update(accounts).set(balanceUpdate).where(eq(accounts.userId, id))
 *   return { success: true }
 * })
 *
 * @example
 * // Scoped transaction input: writes only accept values from txInput inside callback
 * const txInput = asTrusted({
 *   createOrder: { userId: auth.user.id, status: 'pending' as const },
 *   createItem: { productId: input.productId, quantity: input.quantity },
 * })
 *
 * const order = yield* dbTransaction(db, txInput, async (tx, scoped) => {
 *   const [created] = await tx.insert(orders).values(scoped.createOrder).returning()
 *   const itemInsert = mergeMutationInput(scoped.createItem, { orderId: created.id })
 *   await tx.insert(orderItems).values(itemInsert)
 *   return created
 * })
 */
export function dbTransaction<
  DB extends TransactionDatabase<unknown>,
  T
>(
  db: DB,
  operations: (tx: SafeTx<TransactionClient<DB>>) => Promise<T>
): Effect.Effect<T, DatabaseTransactionFailed | DatabaseConstraintViolation>

export function dbTransaction<
  DB extends TransactionDatabase<unknown>,
  I,
  T
>(
  db: DB,
  input: Validated<I> | Trusted<I>,
  operations: <Scope extends symbol>(
    tx: ScopedSafeTx<TransactionClient<DB>, Scope>,
    input: MutationInput<Scope, I>
  ) => Promise<T>
): Effect.Effect<T, DatabaseTransactionFailed | DatabaseConstraintViolation>

export function dbTransaction<
  DB extends TransactionDatabase<unknown>,
  I,
  T
>(
  db: DB,
  inputOrOperations:
    | (Validated<I> | Trusted<I>)
    | ((tx: SafeTx<TransactionClient<DB>>) => Promise<T>),
  maybeOperations?: <Scope extends symbol>(
    tx: ScopedSafeTx<TransactionClient<DB>, Scope>,
    input: MutationInput<Scope, I>
  ) => Promise<T>
): Effect.Effect<T, DatabaseTransactionFailed | DatabaseConstraintViolation> {
  if (inputOrOperations instanceof Function) {
    const operations = inputOrOperations

    // SAFETY: The surrounding adapter established this value's runtime invariant before restoring the precise TypeScript contract.
    return Effect.tryPromise({
      try: (): Promise<T> => db.transaction((tx) =>
        operations(tx as SafeTx<TransactionClient<DB>>)
      ),
      catch: (cause) => classifyDatabaseFailure(cause, 'transaction'),
    })
  }

  if (!maybeOperations) {
    return Effect.die(
      new Error('dbTransaction scoped mode requires an operations callback')
    )
  }

  // SAFETY: The surrounding adapter established this value's runtime invariant before restoring the precise TypeScript contract.
  return Effect.tryPromise({
    try: (): Promise<T> => db.transaction((tx) =>
      maybeOperations(
        tx as ScopedSafeTx<TransactionClient<DB>, symbol>,
        inputOrOperations as MutationInput<symbol, I>
      )
    ),
    catch: (cause) => classifyDatabaseFailure(cause, 'transaction'),
  })
}

type DatabaseOperation = 'mutation' | 'transaction'

function readDatabaseCode(cause: unknown): string | number | undefined {
  if (!(cause instanceof Object)) return undefined

  if ('code' in cause) {
    const code = cause.code

    if (S.is(S.String)(code) || S.is(S.Finite)(code)) return code
  }

  if ('errno' in cause && S.is(S.Finite)(cause.errno)) return cause.errno

  return undefined
}

function classifyConstraint(code: string | number | undefined):
  | DatabaseConstraintViolation['constraint']
  | undefined {
  if (code === undefined) return undefined
  const normalized = String(code).toUpperCase()

  if (normalized === '23505' || normalized === '1062' || normalized === 'ER_DUP_ENTRY') {
    return 'unique'
  }

  if (
    normalized === '23503' ||
    normalized === '1451' ||
    normalized === '1452' ||
    normalized === 'ER_NO_REFERENCED_ROW_2' ||
    normalized === 'ER_ROW_IS_REFERENCED_2'
  ) {
    return 'foreign-key'
  }

  if (normalized === '23502') return 'not-null'

  if (normalized === '23514') return 'check'

  if (normalized.startsWith('SQLITE_CONSTRAINT')) return 'unknown'

  return undefined
}

/** Classify an exception-style database dependency failure into a typed value. */
export function classifyDatabaseFailure(
  cause: unknown,
  operation: 'mutation'
): DatabaseMutationFailed | DatabaseConstraintViolation
export function classifyDatabaseFailure(
  cause: unknown,
  operation: 'transaction'
): DatabaseTransactionFailed | DatabaseConstraintViolation
export function classifyDatabaseFailure(
  cause: unknown,
  operation: DatabaseOperation
): DatabaseMutationFailed | DatabaseTransactionFailed | DatabaseConstraintViolation {
  const constraint = classifyConstraint(readDatabaseCode(cause))

  if (constraint) {
    return new DatabaseConstraintViolation({ operation, constraint, cause })
  }

  return operation === 'transaction'
    ? new DatabaseTransactionFailed({ operation, cause })
    : new DatabaseMutationFailed({ operation, cause })
}
