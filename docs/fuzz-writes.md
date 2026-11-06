# Reaching every write

An application that refuses everything keeps every rule of
[Fuzzing](fuzzing.md), so a fuzz test must also show that its writes happen,
and that its rules could have seen them go wrong.

## One request for each write

Chance cannot show it. Each case picks one route, one person and one record,
and a failed form's 303 back reaches nothing, so among a hundred routes a
given write comes up a few times in thousands of cases, or not at all. A count
of the writes reached then fails at random, more often with each route added.
Give `fuzz` one request for each write as `examples`. They are checked on every
run, by the same property and rules, before the generated cases and however
few `FUZZ_RUNS` asks for:

```ts
// src/writes.test.ts
import { expect, test } from 'bun:test'
import { fuzz, fuzzTimeout, type FuzzRequest, type Refusal } from '@popcomputer/web/fuzz'
import { href } from '@popcomputer/web/paths'
import { Arbitrary } from 'effect'
import { paths } from './paths'

type Person = 'ada' | 'grace'

// The generator, and the property of the test beside them, counting in `reached` what each answer did.
declare const requests: Arbitrary.Arbitrary<FuzzRequest<Person>>
declare const reached: Readonly<Record<string, number>>
declare function send(sent: FuzzRequest<Person>): Promise<Refusal>

// As a browser on the site sends it.
const headers = { origin: 'http://localhost', 'x-inertia': 'true' }

// One request that makes each write happen, from someone allowed to make it.
const writes: ReadonlyArray<FuzzRequest<Person>> = [
  { person: 'ada', method: 'PUT', path: href(paths.project, { project: 'p-ada' }), query: '', headers, body: { as: 'json', fields: ['name=Renamed'] } },
  { person: 'ada', method: 'DELETE', path: href(paths.project, { project: 'p-ada' }), query: '', headers, body: { as: 'none' } },
]

test('any request keeps the rules, and each write happens', async () => {
  await fuzz(requests, send, { runs: 200, examples: writes })

  expect(Object.entries(reached).filter(([, count]) => count === 0).map(([write]) => write)).toEqual([])
}, fuzzTimeout)
```

A refused example says which it was and shows itself, and needs no replay
token, since it runs each time. The examples prove themselves alone, with one
generated case beside them:

```bash
FUZZ_RUNS=1 bun test -t 'each write happens'
```

Run that once whenever the list changes. A count it leaves at zero is a write
no example makes, however many generated cases happened on it.

## Whole rows

`strangerWrites` and `refusedWrites` compare the rows they are given. A watcher
that picks columns, `db.select({ id, userId })`, keeps those rules while a
stranger changes any other column, and the run reports them as holding. Watch
`db.select().from(table)`, as [Fuzzing](fuzzing.md)'s example does, and a
table for each kind of record the application lets someone change.
