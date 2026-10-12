# Effect lint boundaries

Effect warnings are reviewed as code issues. Application workflows use typed
failures, Schema at data boundaries, Effect clocks for time-dependent behavior,
and explicit ownership of concurrent work. Tests control time and completion
through TestClock and Deferred.

The following exceptions describe the native APIs this library adapts. Inline
comments name the rule and the reason. They do not disable error typing, Schema
validation, clock checks inside effects, or promise-ownership checks.

| Boundary | Exception | Reason |
| --- | --- | --- |
| Bun test entrypoints and SDK/Hono fixtures | `async-function`, scoped to test modules | Bun runs native Promise callbacks. Fetch, Hono, Better Auth and Drizzle fixtures exercise those same Promise contracts. Effect programs inside the callbacks still use Effect services and typed errors. |
| Hono ingress, rendering and runtime teardown | `async-function`, scoped to individual declarations | The adapter must await `next()`, translate Effect exits into HTTP responses, and keep external background work alive through `waitUntil` or inline teardown. |
| Drizzle configuration adapters | `async-function`, scoped to individual declarations | These adapters own native module loading. Configuration defects reject at registration. |
| Native Date codecs and fixed SDK fixtures | `global-date`, scoped to individual expressions | Public codecs and Better Auth session values use native Date objects. Fixed fixtures and parsing supplied values do not read ambient time. |
| Diagnostic timestamps | `global-date`, scoped to individual expressions | These synchronous reporting boundaries record wall-clock ISO timestamps. The timestamps do not determine cache expiry. |
| Native event-loop teardown tests | `node-builtin-import`, on the scheduler import | These tests must let Hono's actual Promise chain reach teardown. Effect virtual time cannot advance native Promise work. |
| Throwing decoder and arbitrary-error tests | `schema-sync` or `global-error-in-effect-failure`, scoped to the tested expression | These tests intentionally verify the synchronous throwing API or failures that are not tagged errors. |

The async exception in a test module is not a reason to implement service logic
with unmanaged promises. Add service logic through Effect, then run it at the
test boundary.

## Changes callers should observe

- Numeric form values, numeric route bindings and persisted cache timestamps
  reject non-finite numbers.
- `nullableString` coerces scalars and rejects objects and arrays.
- `declined` accepts `0`, `"0"`, `"false"`, `"no"` and `"off"` as false.
- `TestCaptureService.get` is an Effect value: use `yield* capture.get`.
- `TestLayer.Auth.withUser` uses the provided Effect clock for session expiry.
- `createRequestTracker` optionally accepts a Clock service for deterministic
  request timestamps.

The lint package is still being run as a one-off. No permanent lint dependency
or repository-wide rule override is required for these exceptions.
