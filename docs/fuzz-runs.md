# Long fuzz runs

`bun test` runs a few hundred cases from a fixed seed, so a commit gate gives
the same answer each time. Thousands of cases from a random seed find what
those miss, but take minutes on a real application.

## When

Run them once at the end of a batch of work, not after each change:

```bash
FUZZ_RUNS=5000 FUZZ_SEED=random bun test tests/requests.test.ts
```

Each run covers cases the last did not, so what it adds comes from new seeds,
not from running it again after every edit. Fix a failure from its replay
token, `FUZZ_REPLAY='<token>' bun test -t '<name>'`, which runs that case
alone in moments, and run the thousands again once the batch is done.

## A failure that is not the input's

Shrinking assumes the input is what failed. Over a long run something else can
give way, a full disk, the memory, a Miniflare that stopped answering, and then
every case fails alike and shrinking lands on the smallest input there is,
which did nothing wrong. So `fuzz` prints the first failure as it happens, with
the stack of whatever threw, then runs that case again at once and then the
case before it. The run stops there, unshrunk, when:

- **the case held when run again**: the failure was a moment's, or left by an
  earlier case. The report keeps what failed first, since a replay may not
  reproduce it.
- **the case before it fails now too**: what broke is outside this input, and
  later cases would mean nothing.

Read the first failure, then look at the machine, not the route it names: free
disk and memory, and what else is running tests. A race, or what an earlier
case left, reads the same way, so a failure that comes back on a quiet machine
is the application's. Each case should start from fresh state, or an earlier
case can always be the cause.

## On PGlite

Share one database between the cases and empty it as each starts, with
`reusableDatabase()` from [A database for tests](test-database.md), rather
than starting one per case. Starting PGlite takes about a fifth of a second,
many times what a case's requests take, so a run of thousands with a database
per case spends nearly all of it starting databases. Emptying one takes a few
milliseconds and starts each case from the same rows.

## On D1

Share one database between the cases and empty it as each starts, with
`testD1`'s `databases.reusable()`, as
[A database for tests](test-database.md#one-d1-database-for-a-propertys-cases)
shows, rather than taking one per case with `fresh()`. A new database is
migrated again; `empty()` deletes what the last case left, in every table,
and restarts the ids, in one round trip to the database.

What a case costs on the D1 test database is how often it crosses from the
test to `workerd`, more than the SQL it runs: every `prepare`, every `bind`
and every run is a round trip of its own, about 1.3, 0.75 and 1.8 ms on a
busy laptop. There, Drizzle's `db.batch` of eleven deletes took 18 to 28 ms, and
one `exec` of the same eleven, a statement to a line, 1.4 to 2.6 ms. So a
case makes few statements: it seeds in one `batch`, and reads the rows its
rules compare in one statement.

On the landing template's request property, in the 2-vCPU, 4 GiB Cloudflare
container where hosted applications are checked, a case took about 64 ms
with a database of its own and 18.5 ms sharing one. Its 200 cases went from
12.8 s to 5.3 s, and `FUZZ_RUNS=5000`, about 320 s at the first rate, did
not finish before and took 92.7 s after. On a laptop the 200 went from 2.9 s
to 1.5 s, and the 5,000 from 66 s to 25 s.

A database per case, `await databases.fresh()`, is still the one to use
where `empty()` cannot give back what the migrations made. A migration may
insert rows the application needs, which `empty()` deletes with the rest. A
table may refuse a `DELETE`, as a full-text index that keeps no text of its
own does. And rows may refer to others of their table more than ten deep
with `ON DELETE CASCADE`: `workerd` runs foreign key actions ten deep and no
deeper, so the first of them cannot be deleted, in a test or in production.
`empty()` then rejects, saying why, and leaves the database as it was. A
database from `fresh()` is finished when its case ends, and its Miniflare
stops once all of its are, so a run of thousands holds one `workerd`. Keep
none of those for a later case.
