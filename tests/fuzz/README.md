# Fuzz tests

Each file states a property the framework must keep for any input, and
checks it on inputs Effect generates (`effect/Arbitrary`). `bun test` runs
every property for a few hundred cases from a fixed seed, so the commit gate
is repeatable. `bun run fuzz` runs many more cases from a random seed:

```bash
bun run fuzz
FUZZ_RUNS=100000 FUZZ_SEED=random bun test tests/fuzz
```

A failure names the shrunk input, why the property refused it, and a replay
token: `FUZZ_REPLAY='<token>' bun test tests/fuzz -t '<property>'` runs that
case again. Once the bug is fixed, keep its case as a plain test beside the
property, as `links.test.ts` keeps the two it found.

Before it lands, a property must fail on code with the bug it covers. Each
of these finds again a bug one of the security audits found, on the release
that had it:

| File | Property | Finds again |
| --- | --- | --- |
| `form-fields.test.ts` | `nestFields` never writes to the realm's built-ins, and holds no list longer than the fields sent allow | run-1 C1 and C4, on 1.4.2 |
| `links.test.ts` | `href`, `sameOriginReferer` and `intendedUrl` give only URLs a browser keeps on this site and on their route | run-1 C17 and N9 on 1.4.2, run-2 F16 on 1.5.0 |
| `better-auth-body.test.ts` | `bodyOf` reads the body Better Auth's own parser reads, or none | run-2 N2, on 1.5.0 |
| `database-errors.test.ts` | a failed write's constraint never depends on the request text its error quotes | run-1 C10 on 1.4.2, run-2 F9 on 1.5.0 |
| `validators.test.ts` | every validator answers any input, decodes its own encoding to the same value, and no text makes it slow | run-1 C5, on 1.4.2 |

A property whose bug leaves lasting changes, such as one written onto
`Object.prototype`, puts the realm right after each case, as
`form-fields.test.ts`'s `realmGuard` does: otherwise every later case fails
too, and shrinking cannot find the input that made the change.
