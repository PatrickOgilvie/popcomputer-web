# Constraints keep invariants that concurrent requests would break

A rule the database can state is safest stated there: a `CHECK (stock >= 0)`
on the stock column, a unique index on an order's idempotency key, a unique
event id for a webhook. A write that would break one fails with
`DatabaseConstraintViolation`, whose `constraint` says which kind
(`'unique'`, `'check'`, `'foreign-key'`, `'not-null'`, `'exclusion'`,
`'trigger'`) and `constraintName` which one, and the whole `dbTransaction`,
or the whole `dbBatch` on Cloudflare D1, is undone. A rule no `CHECK` or
unique index can state, such as no two interviews of one interviewer
overlapping, is an exclusion constraint on Postgres (`EXCLUDE USING gist`,
which on a text or uuid column needs `CREATE EXTENSION IF NOT EXISTS
btree_gist` in a custom drizzle-kit migration, and PGlite in tests
`new PGlite({ extensions: { btree_gist } })` from
`@electric-sql/pglite/contrib/btree_gist`) and a trigger on SQLite and D1
(`SELECT RAISE(ABORT, 'interviewer_double_booked')`, in a migration from
`drizzle-kit generate --custom`; a time window it counts compares the rows'
own timestamps with the new row's, `NEW.created_at`, rather than
`unixepoch()`, so the test clock moves it), whose raised text is
the `constraintName`. `constraintFieldErrors({ leases_no_overlap: {
startDate: 'Another lease covers these dates.' } })` shows a named rule of any
kind beside the fields it covers. The same action works on both, with no
count-then-write race:

```ts
import { eq, sql } from 'drizzle-orm'
import { positiveInt, requiredString } from '@popcomputer/web/schema'
import { orders, products } from '../schema'

const Order = S.Struct({ productId: requiredString, quantity: positiveInt })

export const placeOrder = action(Effect.gen(function* () {
  const auth = yield* authorize()
  const request = yield* RequestService
  const input = yield* validateRequest(Order)
  // The client sends one key per checkout, so a double submit repeats it.
  const idempotencyKey = request.header('Idempotency-Key') ?? crypto.randomUUID()

  return yield* dbTransaction(Effect.gen(function* () {
    yield* dbMutation((db) => db.insert(orders).values({
      id: crypto.randomUUID(),
      userId: auth.user.id,
      idempotencyKey,
      ...input,
    }))
    yield* dbMutation((db) =>
      db.update(products)
        .set({ stock: sql`${products.stock} - ${input.quantity}` })
        .where(eq(products.id, input.productId))
    )
  })).pipe(
    Effect.andThen(flash('success', 'Order placed.')),
    Effect.andThen(redirect(paths.dashboard)),
    Effect.catchTag('DatabaseConstraintViolation', (violation) => Effect.gen(function* () {
      if (violation.constraint === 'check') {
        return yield* invalid({ quantity: 'There are not that many left.' })
      }

      // The first submit already placed this order.
      if (violation.constraint === 'unique') return yield* redirect(paths.dashboard)

      return yield* violation
    }))
  )
}))
```

A handler whose branches end differently, as this one does, branches inside
`Effect.gen`: TypeScript combines the branches of one generator, but not a
plain function that returns a different Effect from each branch.

`columns` names the columns as the database reports them: snake_case SQL
names on D1 (`['idempotency_key']`), which `uniqueFieldErrors` matches against
the schema's camelCase keys too. An index on an expression, such as
`lower(email)`, reports no columns, only its name: `uniqueFieldErrors({ email:
'A contact has this email.' }, { constraints: { contacts_email_lower_unique:
'email' } })` puts it on its field. SQLite and D1 report a constraint by its
columns instead, so name a composite key that belongs on another field by
them, in any order and in either case: `{ constraints: { 'org_id,user_id':
'email' } }`. A composite key reports each of its columns, so a message keyed
by one of them, `{ sku: 'Taken.' }` for a key on `(company_id, sku)`, already
matches; `constraints` is for a field that is not one of them. In
development, the error page of a violation no mapping matched shows the
`constraints` entry that would map it. The kind, columns and name come from
the database's own report, never from the statement's values, which Drizzle's
error repeats: a submitted value that reads like a constraint message changes
none of them. On SQLite, only a constraint's report counts, a
`SQLITE_CONSTRAINT` code or D1's message ending in that result: its other
errors, such as a JSON path or a search it rejects, quote the value and stay
a `DatabaseError`.

An update of a row that is not there changes nothing and fails nothing: read
`meta.changes` on D1, or `.returning()`, to tell. SQLite checks a `CHECK`
before an upsert's conflict, so `INSERT ... ON CONFLICT DO UPDATE` whose
inserted values break the check fails even when the row exists; insert a
starting row with `onConflictDoNothing()` and update it after, in the same
batch.

On D1, write the same statements as one `dbBatch((db) => [...])`. They run
in order and the first that breaks a constraint undoes the batch, so it is
the one whose violation the action sees: put the statement a retry depends
on, such as an optimistic lock's unique sequence, first. A violation the
action does not map answers 409. A batch can also be a list
built at run time, such as one statement per line of a form,
`dbBatch((db) => lines.map((line) => db.update(...)))`, whose results are a
list; a helper that returns statements for a batch takes the `db` the batch
passes it, typed `DatabaseType` from `@popcomputer/web/effect`, and types them
`BatchStatement`. A batch
cannot branch on an earlier statement's result, so a write that depends on
one carries its condition in its own `WHERE`: an insert selects its row,
`rowOf(table, values)` from `@popcomputer/web/drizzle`, from a query that
returns no row when the condition fails, and an update adds
`WHERE EXISTS (...)`. `rowOf` gives every column of the table in its order,
the values given bound as their columns encode them, and the columns left out
their defaults, so a misnamed column is a type error; a value may be SQL or
a column of the table the insert selects from. An inserting
statement's `.returning()`, or an update's `meta.changes`, tells the action
whether it applied:

```ts
import { and, eq, lt, sql } from 'drizzle-orm'
import { rowOf } from '@popcomputer/web/drizzle'
import { tasks } from '../schema'

// Adds the task only while its project holds fewer than 100; returns no row otherwise.
const addTaskIfRoom = (projectId: string, title: string) =>
  dbMutation((db) =>
    db.insert(tasks).select(
      db.select(rowOf(tasks, { id: crypto.randomUUID(), projectId, title }))
        .from(projects)
        .where(and(
          eq(projects.id, projectId),
          lt(sql`(select count(*) from ${tasks} where ${tasks.projectId} = ${projects.id})`, 100)
        ))
    ).returning({ id: tasks.id })
  )
```

When a limit cannot be a constraint, a guarded update such as
`UPDATE ... WHERE (SELECT count(*) ...) < 100` that changed no row
(`meta.changes === 0`) is the limit refusing it. A statement can depend on
the one before it through SQLite's `changes()`, the rows the previous
statement changed: ``sql`changes() = 1` `` in an insert-select's `WHERE`
writes a log row only after an update that applied, in the same batch.

A value the database computes, such as the next ticket number in an
organization, belongs in the insert:
``sql`(SELECT coalesce(max(number), 0) + 1 FROM tickets WHERE organization_id = ${organizationId})` ``.
Pass the outer row's value as a parameter, as here: in a select list Drizzle
writes a column without its table, so ``${organizations.id}`` inside that
subquery names the subquery's own table and silently computes the wrong
value. Name it in full, ``${organizations}.${sql.identifier('id')}``, when it
must be a column; in a `WHERE` Drizzle qualifies columns itself. Write every
statement with the query builder: Drizzle's D1 batch fails at runtime on
`db.run(sql)` with parameters, which is a type error there. D1
binds at most 100 parameters to a statement, so an `IN (...)` over many ids,
or an insert of many rows, goes in chunks.
