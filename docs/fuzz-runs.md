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

## On D1

Give each case a database of its own, `await databases.fresh()` from `testD1`,
so a case that deletes a person leaves the next one its seed. A database a case
asked for is finished when the case ends, and its Miniflare stops once all of
its are, so a run of thousands holds one `workerd`. Keep none for a later
case. [A database for tests](test-database.md) says more.
