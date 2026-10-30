# Fuzz tests

Each file states a property the framework must keep for any input, and
checks it on inputs Effect generates (`effect/Arbitrary`), in three layers:
functions that read or write a visitor's text; whole requests through
`setupWeb`, to `app.ts` and to endpoint contracts (`requests.test.ts`,
`endpoints.test.ts`); and sequences of steps over state that lasts between
requests, the data cache, the page cache, flash, an account's sign-in count
and Inertia's history, which run the code of the lifecycles
`docs/state-machines.md` models. `bun test` runs
every property for a few hundred cases from a fixed seed, so the commit gate
is repeatable. `bun run fuzz` runs many more cases from a random seed:

```bash
bun run fuzz
FUZZ_RUNS=100000 FUZZ_SEED=random bun test tests/fuzz
```

A failure names the shrunk input, why the property refused it, and a replay
token: `FUZZ_REPLAY='<token>' bun test tests/fuzz -t '<property>'` runs that
case again. Once the bug is fixed, keep its case as a plain test beside the
property, as `links.test.ts` and `endpoints.test.ts` keep the bugs they found.

Before it lands, a property must fail on code with the bug it covers. Each
of these finds again a bug the framework had, most of them found by the
security audits, on the release that had it:

| File | Property | Finds again |
| --- | --- | --- |
| `form-fields.test.ts` | `nestFields` never writes to the realm's built-ins, and holds no list longer than the fields sent allow | run-1 C1 and C4, on 1.4.2 |
| `links.test.ts` | `href`, `sameOriginReferer` and `intendedUrl` give only URLs a browser keeps on this site and on their route | run-1 C17 and N9 on 1.4.2, run-2 F16 on 1.5.0 |
| `better-auth-body.test.ts` | `bodyOf` reads the body Better Auth's own parser reads, or none | run-2 N2, on 1.5.0 |
| `database-errors.test.ts` | a failed write's constraint never depends on the request text its error quotes | run-1 C10 on 1.4.2, run-2 F9 on 1.5.0 |
| `validators.test.ts` | every validator answers any input, decodes its own encoding to the same value, and no text makes it slow | run-1 C5, on 1.4.2 |
| `requests.test.ts` | any request to `app.ts`, from a visitor, ada or grace, is answered without a defect or a write it refused, shows and changes no one's private record but its owner's, refuses another site's writes, keeps signed-in answers from shared caches, and answers a JSON client in the envelope | 1.4.2's cross-site check, which ran after route lookup and answered a write to an unrouted path 404 |
| `endpoints.test.ts` | an endpoint carries any value of its types through `call` and back, answers any other body before its handler runs, and with `auth: true` answers 401 before reading input | three `call` bugs it found after 1.6.0 |
| `data-cache.test.ts` | over any steps, held computations among them, no read that starts after a purge returns a value from before its write, and `cache` returns nothing stored longer ago than its `ttl` | 1.6.0's `cacheSet`, which stored no tags (`DataCache.tla`'s counterexample) |
| `page-cache.test.ts` | over any requests from a guest, a guest with a cookie and two members, the default page cache answers as a fresh render does, and stores no page a guard, middleware or sign-in decides for | run-1 C6 and C12 on 1.4.2, run-2 F11 on 1.5.0 |
| `flash.test.ts` | over any posts and visits from two browsers, a page shows only its own browser's flash and errors, each at most once | a flash cookie never expired, planted by hand: no release had one |
| `page-html.test.ts` | for any page data, the HTML document parses into an empty page's elements, and its data element back into the page | the escaping of `/` alone that `fdd3f31` replaced before 1.0.0, planted on main |
| `sign-in-limits.test.ts` | over any guesses sent together, the owner's sign-ins and time passing, at each password door and spelling, a sign-in during a cooldown is refused before its password is checked, and each row holds the count the rules give | 1.6.0's count, which spent its cooldown toward the window (`SignInLimits.tla`'s counterexample), planted on main |
| `history.test.ts` | over any visits, Back, sign-ins, sign-outs, expiries, prefetches and session refetches in two tabs, Back never shows another person's page from history, under `history.encrypt`'s default and `true` | 1.6.0's page version, the assets' alone (`HistoryClear.tla`'s counterexample), planted on main |

A property whose bug leaves lasting changes, such as one written onto
`Object.prototype`, puts the realm right after each case, as
`realm.ts`'s `realmGuard` does: otherwise every later case fails
too, and shrinking cannot find the input that made the change.
