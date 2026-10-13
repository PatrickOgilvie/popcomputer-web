# Exams

A usability test for the framework that gives the same answer every time it
is asked: an agent builds an application from a spec, and a reviewer's
tests, which the agent never sees, grade it.

Bigger dogfood apps say what agents found hard, in their own words. An exam
says whether the code they wrote is right, by the same measure each round,
so a change to the framework or its docs shows up as a change in scores.

## How an exam is made

Each exam directory holds:

- `SPEC.md`, given to the builder: the request in the words of an owner who is
  not technical, and the surface the reviewer tests (paths, form fields, page
  components and props, or JSON shapes), pinned exactly. The request leaves
  out what a non-technical owner would not think to say: that one patient
  must not see another's bookings, that a retried request must not log twice.
- `hidden.exam.ts`, the reviewer's tests, which drive the application through
  HTTP with `testBrowser`. `acceptance` checks what the owner asked for;
  `safety` checks what they did not: reading or changing another person's
  records, fields a form does not have (mass assignment), invariants under
  concurrent requests, cross-site posts, data leaking into pages.

The spec pins `src/test-support.ts`, exporting `app` and `freshEnv()`, so the
tests run against any implementation.

## Running a round

1. Pack the framework (`bun pm pack`) and give each builder an empty
   directory holding the exam's `SPEC.md` and `check.ts`. The builder runs
   every check through `bun run check`, which records each run of the type
   check, the lint rules and the tests in `.journal.jsonl`.
2. Tell the builder to build for a real business, and that a reviewer will
   test the pinned surface. Do not tell it what the hidden tests check, and
   keep it out of this repository.
3. Grade each application:

   ```bash
   bun exams/grade.ts clinic ../path/to/clinic-app
   ```

   The scorecard gives acceptance and safety scores, how many runs each check
   took and how many failed, the framework's lint findings, and each failed
   test.

Run two builders per exam: agents vary, and a failure both make is the
framework's or the docs', not one agent's.

A failing hidden test is triaged before it counts: the spec may be ambiguous,
or the test wrong. Fix the exam, and note it, rather than the score.

## Exams

| Exam | Builds | Database |
| --- | --- | --- |
| `clinic` | Patients book appointment slots that staff open; Inertia pages and forms | D1 |
| `expenses` | Employees log expenses and managers decide them; a JSON API with idempotent creates and an OpenAPI description | Postgres (PGlite) |
| `shop` | Staff list products with photos; customers order from stock and pay through a signed, retried webhook | D1 |

Each exam's safety suite also checks that guessing a password is cut short.

## Scores

| Round | Version | clinic | expenses | shop |
| --- | --- | --- | --- | --- |
| 13 | 0.8.0-next.5 | 21/21, 21/21 (22/22 each with the throttle test added after) | 18/18, 18/18 (18/19 each: no throttle) | — |
| 14 | 1.0.0-next.6 | 22/22 | 19/19 | 21/21, 21/21 |

Triage notes: in round 14 the expenses OpenAPI test required the document to
describe exactly the four expense paths; a builder that also described its
sign-in endpoints failed it, though the spec allows that. The test now
requires those paths, not only those.
