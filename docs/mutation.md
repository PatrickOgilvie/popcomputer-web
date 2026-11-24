# Mutation testing

`AGENTS.md`'s rule 12 says a new test must fail when the behaviour it covers
is reverted: plant the bug, watch the test fail, restore the code. A test
that passes either way checks nothing. `popweb-mutate` plants those bugs
for you, one at a time, in the lines a change touches, and lists each one no
test catches. It takes minutes, a test run for each mutant, so run it when
the owner asks for it, not as a step before every change is finished.

```bash
bunx popweb-mutate
```

Run it from the repository's root, whose `src/` holds the application. It
runs under Bun, as `bun test` does, and reads the code with the
repository's TypeScript 7, the optional peer it needs.

## What it plants

Small bugs a slip makes, each where the code has one:

| Operator | Plants |
| --- | --- |
| `negate-eq` | `===` as `!==`, and back |
| `boundary` | `<` as `<=`, `>` as `>=`, and back |
| `logic` | `&&` as `\|\|`, and back |
| `drop-not` | `!x` as `x` |
| `bool` | `true` as `false`, and back |
| `skip-guard` | an `if` whose branch leaves its block, never taken |
| `some-every` | `.some` as `.every`, and back |
| `swallow-tag` | a function that returns an Effect recovering from a tagged error its type declares, and succeeding |

`swallow-tag` reads each function's `Effect<A, E, R>` through TypeScript's
checker and plants one bug for each tagged error in `E`. It survives where
no test makes the function fail that way, as when a test sends one message
through a queue but never a batch the queue refuses. It leaves out:

- an error a dependency declares, such as the framework's `DatabaseError` in
  an action: the package answers it, often for a failure no test of the
  application makes happen;
- a callback whose Effect the function around it returns through calls
  alone, whose failures flow out through that function's own.

Messages, templates and types are no behaviour a test pins down, so nothing
is planted in them.

## Which lines, and which tests

With no files it mutates the `src/` lines changed since `HEAD`, committed or
not, and the new files there; `--base <ref>` compares with another ref, such
as `main` for a branch. Given files, it mutates every line of them:

```bash
bunx popweb-mutate src/actions/projects.ts
```

Each test file, any `*.test.ts` or `*.test.tsx` outside `node_modules` and
`dist`, that imports a mutated file runs once with coverage; none of them is
mutated, even under `src/`. Each mutant then runs against the test files
whose coverage reaches its line, and those `package.json` declares reach its
file ([below](#tests-that-run-the-code-in-another-process)). A mutant on a
line no test reaches runs nothing: the report lists its lines apart, and the
score leaves it out. Its tests run in
copies of a snapshot of the working tree
taken when the run starts, so the checkout is never edited, and an edit to it
during the run reaches none of the run. Each copy is put back as the snapshot
has it before every test run, so no mutant's tests read what another's left. A
mutant really runs, so each copy has a temporary directory of its own, removed
with it: code that cleans up after itself cannot reach the machine's. Anything
else the code can reach, it still can, such as a real service a test forgets
to fake. A test file that fails with no mutant planted runs
again with nothing beside it, since a file can fail for the memory it lost to
the others. One that fails then too is left out, and the report says so
beside the score and lists it at its end: the score is partial, as a mutant
only that file would catch shows as a survivor.

A mutant is killed only when its tests' failure is its own: the test files
that failed run again at once with no mutant planted, and must pass. Ctrl-C,
`SIGTERM` or `SIGHUP` stops the run, its test runs with it, and removes its
copies; should the run be killed outright, a process it started does that
for it.

| Option | Does |
| --- | --- |
| `--base <ref>` | mutates the lines changed since that ref |
| `--fail-under <percent>` | exits 1 when the score is below it; otherwise it exits 0 |
| `--workers <n>` | test runs at once on the machine, other runs' included; by default one for each 4 GiB of memory, leaving a core free |
| `--timeout <seconds>` | how long a mutant's tests may take; twice their unmutated time, plus 10 seconds, by default |

Runs on one machine share it. Each test run takes one of the machine's
`--workers` slots, a file in `popweb-mutate.slots` in the temporary
directory, and gives it back when it ends, so a run started beside another,
as by a second agent in the same checkout, waits its turn rather than
starving both of memory, which crashes their mutants. A slot whose run was
killed is taken back. A run that has waited says so.

## Tests that run the code in another process

Coverage sees only what runs in the test's own process. A test that runs
`src/` files somewhere else, as the framework's lint test bundles its rules
and runs them inside Oxlint, or as a test that spawns a script or starts the
Worker in `workerd`, reaches lines its coverage shows as never run. Their
mutants would show as survivors no test reaches. Declare such a test in
`package.json`, under a glob of the files it runs:

```json
{
  "popweb-mutate": {
    "reachedBy": {
      "src/lint/**": ["tests/lint/lint.test.ts"]
    }
  }
}
```

Each declared test runs against every mutant of the files its glob matches,
beside the tests coverage finds, so each of those mutants is killed or
survives. A path that is not a test file in the repository stops the run, so
a declaration a moved test left behind cannot quietly leave those mutants
unreached again.

The tool does not guess these tests. The lint test imports
`src/lint/index.ts`, so Bun counts every line of the rules and sees none of
their bodies run, which is what it also says of a line no test reaches.
Running every test that imports a file against each of its unrun lines would
run unrelated test files against every such mutant, and hide the lines no
test reaches, which the report is there to show.

## Reading the report

```text
score 88%: 92 killed, 0 timed out, 12 survived
not scored: 40 mutants on lines no test reaches, listed at the end

survived: no test fails when this line changes
  src/effect/sign-in-limits.ts:392  boundary  < → <=
      count < limits.max ? 0 : Math.min(limits.windowMillis, ...)

not reached, not scored: no test runs these lines, so none ran; a test that loads them brings them into the score
  src/components/RequirementRow.tsx  12-30, 44, 51-60
```

Each survivor is a change no test notices. Write the test that fails with
it, as rule 12 asks, then run again. Some survivors change nothing a caller
can see, such as a guard the next line repeats; leave those, and say so
where the change is reviewed.

The score is of the mutants some test reaches, and `--fail-under` reads it.
The lines no test reaches are listed by file, as ranges, not one survivor
each: a page's component that no test renders, say. Leave them unless the
change is meant to be tested there; then start with a test that loads the
lines, or, when a test runs them in another process, declare that test as
the section above shows.

A mutant whose tests gave no answer is `crashed`, listed apart with the
reason and not counted as caught: a signal not its timeout ended them, as the
system does when memory runs out, or the files that failed fail with no
mutant planted too, as when a test reads something outside the copy that
changed during the run. Run again once the cause is gone, with fewer
`--workers` for memory.

Fuzz properties run here with their fixed seed, as `bun test` runs them, so
a mutant their cases miss survives: [Fuzzing at the limits](fuzz-limits.md)
puts their cases on a limit's edge.
