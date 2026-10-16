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
  `testEnv({ ...testBindings, DB: await databases.fresh() })`. Starting
  Miniflare takes a moment, so one holds many databases and another starts
  when they run out. Stop them once, after every test file, with
  `afterAll(() => databases.dispose())` in a file `bunfig.toml`'s
  `[test] preload` names: a Miniflare left running keeps its `workerd`
  process alive after `bun test` exits, and Bun shares modules between test
  files, so an `afterAll` in the module that creates the databases stops them
  while other files still use them. Miniflare's `getKVNamespace` and
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
```

A test opens one in `beforeEach`, passes `db` as `testEnv`'s `database`, and
calls `close()` in `afterEach`.

A test whose visitors sign in through the application, as a `testBrowser`
does, needs no layer: `testEnv(testBindings, { database: testDb })`.

A request built with `testEnv` renders failures with their development
details unless its bindings set `ENVIRONMENT`; pass `ENVIRONMENT: 'production'`
to test the production error page. The `app` layer of `web.services` is
built once per test process, from the first request's bindings: replace an application service in
a test with a layer in `testEnv` rather than different bindings. A failed
build is retried by the next request.
