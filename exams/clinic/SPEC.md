# Physio clinic bookings

## What the owner asked for

> I run a small physio clinic. I want a website where my patients can sign up,
> see the appointment slots we've opened, book one, and cancel their bookings.
> My staff open the slots (when, and which physio) and need to see who booked
> each one. Staff sign up like anyone else but with their clinic email address,
> which ends in `@clinic.test`. Obviously one slot is one appointment.

## The surface the clinic's reviewer will test

The reviewer has their own test suite, which drives the application through
HTTP exactly as described here. Build everything else as you see fit.

### Test support

`src/test-support.ts` exports:

- `app`: the Hono application, with every route registered.
- `freshEnv(): Promise<unknown>`: the third argument of `app.request(...)`
  for a fresh application served at `http://localhost`: its bindings, with a
  newly created, migrated and empty database. Each call returns an
  independent one.

The reviewer's tests use `testBrowser(app, await freshEnv())` from
`@popcomputer/web/testing`, so every page is requested as an Inertia visit
(`X-Inertia: true`) and every form is posted urlencoded.

### Accounts

| Request | Fields | Answer |
| --- | --- | --- |
| `POST /register` | `name`, `email`, `password` (8+ characters) | `303` to `/slots`, signed in |
| `POST /login` | `email`, `password` | `303` to `/slots`, signed in |
| `POST /logout` | | `303` to `/login`, signed out |

A user is staff when their email ends in `@clinic.test`. A visitor who is not
signed in and requests any page below is redirected to `/login`.

### Pages and forms

Dates travel as ISO 8601 strings (`2030-05-01T09:00:00.000Z`).

| Request | Who | Answer |
| --- | --- | --- |
| `GET /slots` | anyone signed in | page `Slots/Index`, props `slots`: every slot that starts in the future, soonest first, each `{ id, startsAt, physio, booked }` (`booked` a boolean) |
| `POST /slots` | staff | fields `startsAt` (ISO 8601) and `physio` (non-empty); `303` to `/slots`. A field that is missing or invalid goes back with `errors.startsAt` or `errors.physio`. Anyone else: `403`. |
| `POST /slots/{slot}/book` | anyone signed in | books the slot for the visitor: `303` to `/bookings`. A slot already booked: back with `errors.slot`. |
| `GET /bookings` | anyone signed in | page `Bookings/Index`, props `bookings`: the visitor's own bookings, each `{ id, slotId, startsAt, physio }` |
| `POST /bookings/{booking}/cancel` | the patient who booked it | removes the booking, freeing the slot: `303` to `/bookings` |
| `GET /staff/slots/{slot}` | staff | page `Staff/Slot`, props `slot` (`{ id, startsAt, physio }`) and `patient` (`{ name, email }`, or `null` when the slot is free) |

The database is Cloudflare D1.
