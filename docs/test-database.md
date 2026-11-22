# A database for tests

Test against the database family production uses, so transactions, batches
and constraint errors behave the same:

- **Postgres** (including through Hyperdrive): an in-process
  [PGlite](https://pglite.dev) database with `drizzle-orm/pglite`. Apply the
  migrations drizzle-kit generates with `applyMigrations('./drizzle', (sql) =>
  client.exec(sql))`, and pass the Drizzle client as `testEnv`'s `database`. It
  replaces setupWeb's `database` factory for that request, so the database
  operations, route model binding and Better Auth all use it. PGlite runs one
  transaction at a time, so a test of concurrent requests passes even when
  the code races; test locking against a real Postgres, passing a postgres.js
  Drizzle client as `database` the same way, in a test that runs when a
  database URL is set.
- **Cloudflare D1**: Miniflare's real D1 runs under Bun, in process.
  `testD1({ migrations })` from `@popcomputer/web/testing` hands
  out D1 databases, each newly created, migrated with drizzle-kit's
  migrations in one batch, and empty. Point it at the folder wrangler applies
  migrations from, `wrangler.jsonc`'s `migrations_dir` (`migrations` unless it
  says otherwise), with drizzle-kit's `out` set to the same folder. The
  databases are typed as the application's D1 binding:
  `testEnv({ ...testBindings, DB: await databases.fresh() })`, which returns
  each binding passed to it with its type, so a test reads rows no page
  shows from `env.DB`, not `env.DB?.`. Starting
  Miniflare takes a moment, so one holds many databases and another starts
  when they run out. Stop them once, after every test file, with
  `afterAll(() => databases.dispose())` in a file `bunfig.toml`'s
  `[test] preload` names: a Miniflare left running keeps its `workerd`
  process alive after `bun test` exits, and Bun shares modules between test
  files, so an `afterAll` in the module that creates the databases stops them
  while other files still use them. A database a `fuzz` case asked for with
  `fresh()` is finished when the case ends, and a Miniflare stops once it has
  handed out all of its and they are finished, so a run of thousands holds
  one `workerd` at a time, and the last stops at `dispose()`. A case must
  keep none of those for a later one: cases that share a database take it
  from `reusable()`, [below](#one-d1-database-for-a-propertys-cases). A
  database made outside a case, as in `beforeAll`, stays until `dispose()`. A
  loop of your own that makes thousands may call `dispose()` between rounds:
  the next `fresh()` starts again. A run killed before it could `dispose()`
  leaves its `workerd` and its folder in the temporary directory, which the
  next run's first database removes as it goes on: each folder's name holds
  its run's process id, so a run still going keeps its own, and only a
  `workerd` holding a file in an abandoned folder is stopped. A test that
  runs past its timeout takes its Miniflare down with it, so every later test
  on those databases fails with `ECONNREFUSED`: look for the first timeout,
  not the refusals.
  Miniflare's `getKVNamespace` and
  `getR2Bucket` give the other bindings; their types differ slightly from
  `@cloudflare/workers-types`', so provide a KV store to the data cache as
  `kvCache(kv)` in the test layer rather than as a binding, and type a binding
  an application service reads by the methods it calls (`KVNamespaceLike`
  from `@popcomputer/web/cache`, or a small interface of the R2 methods), so
  both objects fit.

```ts
// src/test-d1.ts
import { join } from 'node:path'
import { testD1 } from '@popcomputer/web/testing'

// Each test that asks gets a D1 database of its own.
export const databases = testD1({ migrations: join(import.meta.dir, '../migrations') })
```

`bun:sqlite` is a synchronous driver: it can stand in for neither, since
`dbTransaction` and `dbBatch` are type errors for it.

An application on D1 adds Cloudflare's types to `tsconfig.json`'s
`compilerOptions.types` (`"@cloudflare/workers-types"`, or the file
`wrangler types` writes), or imports a type from them, such as
`import type { D1Database } from '@cloudflare/workers-types'` in `src/env.ts`. Drizzle's D1 results name them, and without them a
result is `any`, which the database operations report as a type error.

```ts
// src/test-db.ts
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { applyMigrations } from '@popcomputer/web/testing'
import type { Database } from './db'
import * as schema from './schema'

const client = new PGlite()
await applyMigrations('./drizzle', (sql) => client.exec(sql))

export const testDb: Database = drizzle(client, { schema })
```

```ts
const env = testEnv(signedIn({ id: 'user-1' }), testBindings, { database: testDb })
```

One database shared by every test means each test seeds rows the others can
see. For a fresh database per test, migrate once and start each test from a
copy: PGlite saves a database's files with `dumpDataDir` and opens a copy with
`loadDataDir`, which takes a fraction of the time migrating a new one does.

```ts
// src/test-databases.ts
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { applyMigrations } from '@popcomputer/web/testing'
import * as schema from './schema'

const migrated = new PGlite()
await applyMigrations('./drizzle', (sql) => migrated.exec(sql))
const snapshot = await migrated.dumpDataDir('none')

// A database of its own for one test, migrated, and how to close it.
export function freshDatabase() {
  const client = new PGlite({ loadDataDir: snapshot })

  return { db: drizzle(client, { schema }), close: () => client.close() }
}

// Every table the migrations made, in any schema, emptied with its ids counting from 1 again.
const tables = await migrated.query<{ name: string }>(
  `select format('%I.%I', schemaname, tablename) as name from pg_tables where schemaname not in ('pg_catalog', 'information_schema')`
)
const emptyAll = `truncate ${tables.rows.map((table) => table.name).join(', ')} restart identity cascade`

// One database for a fuzz property's cases, how to empty it as each starts, and how to close it.
export function reusableDatabase() {
  const client = new PGlite({ loadDataDir: snapshot })

  return { db: drizzle(client, { schema }), empty: () => client.exec(emptyAll), close: () => client.close() }
}
```

A test opens one in `beforeEach`, passes `db` as `testEnv`'s `database`, and
calls `close()` in `afterEach`.

A `fuzz` property runs hundreds of cases, and starting PGlite takes about a
fifth of a second, many times what a case's requests take. Its cases share
one database from `reusableDatabase()`, and each calls `empty()` before it
seeds: that empties every table, those no rule watches too, and restarts
their ids, in a few milliseconds, so each case starts as a new copy would.
Empty it as a case starts, not as it ends, so a case that throws leaves the
next nothing. [Fuzzing](fuzzing.md#requests-to-the-application) shows one.

## One D1 database for a property's cases

On D1 the cases share the database `databases.reusable()` gives. It is new
and migrated, and kept until `dispose()` wherever it was asked for, inside
the first case or outside any, with the Miniflare it runs in.

```ts
// One database for every case of the property, and how to empty it.
const { database, empty } = await databases.reusable()

// The seed, prepared once: every prepare is a round trip to the database.
const seedRows = [
  database.prepare(`INSERT INTO user (id, name, email) VALUES ('ada', 'Ada', 'ada@example.com'), ('grace', 'Grace', 'grace@example.com')`),
  database.prepare(`INSERT INTO projects (id, user_id, name, slug) VALUES ('p-ada', 'ada', 'Apollo', 'apollo'), ('p-grace', 'grace', 'Gemini', 'gemini')`),
]

// A case starts from the seed in two round trips: one empties, one seeds.
async function seed() {
  await empty()
  await database.batch(seedRows)
}
```

Each case calls `seed()` as it starts, then sends its requests with
`testEnv({ ...testBindings, DB: database })`, as
[Fuzzing](fuzzing.md#requests-to-the-application) does with PGlite's.

`empty()` deletes every row of every table the migrations made, those no
rule watches too, and restarts their ids, AUTOINCREMENT's among them, so
each case starts as a new database would. The tables, indexes and triggers
stay as they were. It is one batch, prepared when the database was made, so
it crosses to the database once, and Miniflare runs a batch as one
transaction: the database is emptied or, where a table refuses, left as it
was, and `empty()` rejects, saying why. The transaction defers the foreign
keys, so the tables' order does not matter, and no trigger fires, as none
does for `truncate` on Postgres. A row a migration inserted goes with the
rest, so a seed that needs one writes it again.

On the D1 test database every `prepare`, every `bind` and every run is a
round trip from the test to `workerd`, a millisecond or two each on a busy
laptop, and they are most of what a case costs. A statement prepared, bound
and run alone crosses six times, and one bound into a `batch`, as Drizzle's
`db.batch([...])` binds each of its, three; the statements above, prepared
once, cross with their batch and not again. Make few statements: seed in
one `batch`, read the rows a rule compares in one statement, and never
delete table by table. [Long fuzz runs](fuzz-runs.md#on-d1) has the
measurements, and says when a database per case is still the one to use.

A test whose visitors sign in through the application, as a `testBrowser`
does, needs no layer: `testEnv(testBindings, { database: testDb })`.

A request built with `testEnv` renders failures with their development
details unless its bindings set `ENVIRONMENT`; pass `ENVIRONMENT: 'production'`
to test the production error page. The `app` layer of `web.services` is
built once per test process, from the first request's bindings: replace an application service in
a test with a layer in `testEnv` rather than different bindings. A failed
build is retried by the next request.
