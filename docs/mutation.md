# Mutation testing

`AGENTS.md`'s rule 12 says a new test must fail when the behaviour it covers
is reverted: plant the bug, watch the test fail, restore the code. A test
that passes either way checks nothing. `popweb-mutate` plants those bugs
for you, one at a time, in the lines a change touches, and lists each one no
test catches.

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
not; `--base <ref>` compares with another ref, such as `main` for a branch.
Given files, it mutates every line of them:

```bash
bunx popweb-mutate src/actions/projects.ts
```

Each test file, any `*.test.ts` or `*.test.tsx` outside `node_modules` and
`dist`, that imports a mutated file runs once with coverage; none of them is
mutated, even under `src/`. Each mutant then runs against the test files
whose coverage reaches its line, in copies of the working tree, so the
checkout is never edited. A mutant really runs, so each copy has a temporary
directory of its own, removed with it: code that cleans up after itself cannot
reach the machine's. Anything else the code can reach, it still can, such as
a real service a test forgets to fake. A test file that fails with no mutant planted runs
again with nothing beside it, since a file can fail for the memory it lost to
the others. One that fails then too is left out, and the report says so
beside the score and lists it at its end: the score is partial, as a mutant
only that file would catch shows as a survivor.

| Option | Does |
| --- | --- |
| `--base <ref>` | mutates the lines changed since that ref |
| `--fail-under <percent>` | exits 1 when the score is below it; otherwise it exits 0 |
| `--workers <n>` | copies of the tree run at once; by default one for each 4 GiB of memory, leaving a core free |
| `--timeout <seconds>` | how long a mutant's tests may take; twice their unmutated time, plus 10 seconds, by default |

## Reading the report

```text
score 88%: 92 killed, 0 timed out, 12 survived

survived: no test fails when this line changes
  src/effect/sign-in-limits.ts:392  boundary  < → <=
      count < limits.max ? 0 : Math.min(limits.windowMillis, ...)
```

Each survivor is a change no test notices. Write the test that fails with
it, as rule 12 asks, then run again. Some survivors change nothing a caller
can see, such as a guard the next line repeats; leave those, and say so
where the change is reviewed. A survivor that no test reaches says so:
start with a test that loads its line.

Fuzz properties run here with their fixed seed, as `bun test` runs them, so
a mutant their cases miss survives: [Fuzzing at the limits](fuzz-limits.md)
puts their cases on a limit's edge.
