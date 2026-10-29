---
name: verify-state-machines
description: "Check a change to @popcomputer/web's stateful code against its TLA+ models: the sign-in limits, Inertia's history clear and page version, the data cache's tag purges, the template's magic link, and the flash cookie. Use before committing any change to src/effect/sign-in-limits.ts, src/middleware.ts, src/page-version.ts, src/flash.ts, src/page-cache.ts's version check, src/cache.ts, render in src/effect/responses.ts, the magic link in docs/auth-plugins.md or tests/better-auth/app.ts, or to the models in docs/state-machines/, and after upgrading @inertiajs/core or better-auth."
---

# Verify the state machines

The framework keeps state across requests: a count of sign-ins, a page's
version and the history's clear, a cache tag's generation, a link's one-time
token, the flash cookie. `docs/state-machines.md` lists every such
lifecycle and the rule each keeps. Five of them have TLA+ models in
`docs/state-machines/`, which TLC checks over every order of steps within
small bounds: concurrent requests, other tabs, a scanner's fetch, a purge in
the middle of a computation. Tests reach few of those orders; the models
reach all of them.

## Does the change touch a model?

Each model's actions name, in their comments, the function and lines they
describe. A change touches a model when it changes any of these:

| Model | Code it describes | Replay tests |
|---|---|---|
| `SignInLimits.tla` | `src/effect/sign-in-limits.ts`: `withinSignInLimits`, `rowStates`, `cooldownAfter`, `sweepSignInFailures`, `assertSignInLimitsConfig`; its callers in `src/effect/auth.ts` (`callEndpoint`, `betterAuthHandler`) | `tests/effect/sign-in-limits.test.ts` |
| `HistoryClear.tla` | `src/middleware.ts` `web()`: the render's `encryptHistory`, `clearHistory` and `version`, the 409 check, the clear raised after `next()`, `endsSession`, `startsSession`, `expiresTheCookie`; `src/page-version.ts`; the clear in `src/flash.ts`; `isCacheableRequest`'s version check in `src/page-cache.ts`; `renderPage` in `src/effect/responses.ts`; `@inertiajs/core`'s popstate and back-forward version checks | `tests/security/history.test.ts`, `tests/render-options.test.ts` |
| `DataCache.tla` | `src/cache.ts`: `cache`, `cacheGet`, `cacheSet` given its read or a value, `readTagGenerations`, `invalidateCacheTags` | `tests/cache.test.ts` (`cache tags`); `tests/fuzz/data-cache.test.ts` drives the same calls through random sequences |
| `MagicLink.tla` | the magic link in `docs/auth-plugins.md`; `showMagicLink`, `verifyMagicLink` and their routes in `tests/better-auth/app.ts`; `better-auth`'s magic-link plugin | `tests/better-auth/seam.test.ts` (`magic links`) |
| `Flash.tla` | `src/flash.ts` `openFlash`; the render's `flash.take()` in `src/middleware.ts` | none: its rule breaks, a known limit |

Also count as touching a model: a new function that writes the same state
(a `rateLimit` row, the flash cookie, a page's `version`, a tag's
generation), code that moved or was renamed, and an upgrade of
`@inertiajs/core` or `better-auth`.

The models were last confirmed to describe the code at commit `197689c`
(2026-10-29). Run `git diff 197689c -- <the files above>` to see what changed
since.

## Run the check

1. For each model, run each of its configs in `docs/state-machines/` with
   pstack's `/statechart` skill, which runs TLC and reports each broken rule
   as its shortest path in plain words. Read that skill for how to run it.
   Give it the model's view, `<Model>.view.mjs`, or
   `SignInLimits.chart.view.mjs` for `SignInLimits.chart.cfg`, and write its
   output to a new folder outside the repository.
2. Compare with what each config must give:
   - every `*.code.cfg`, `*.code.always.cfg` and `SignInLimits.chart.cfg`:
     every rule holds;
   - `DataCache.code.value.cfg`, `cacheSet` given a value read earlier:
     `CacheSetStoresOnlyCurrentValues` breaks, a known limit, and
     `NoReadAfterPurgeReturnsTheOldValue` holds;
   - `SignInLimits.1.6.cfg`: `AtMostMaxGuessesAtOnce`,
     `OwnerSignInClearsCount` and `NoFreshBudgetAfterCooldown` break;
   - `HistoryClear.1.6.cfg` and `HistoryClear.1.6.always.cfg`:
     `BackShowsNoOneElsesPage` breaks;
   - `DataCache.1.6.cfg`: `NoReadAfterPurgeReturnsTheOldValue` and
     `CacheSetStoresOnlyCurrentValues` break;
   - `MagicLink.1.6.cfg`: `OnlyTheMemberSignsIn` and `TheMemberSignsIn` break;
   - `Flash.cfg`: `TheFormShowsItsErrors` breaks.
   The `1.6` configs model release 1.6.0, the code before these rules held.
   A `1.6` config whose rule stops breaking means the model lost the ability
   to fail: find out why before trusting a pass.
3. Run the replay tests, which drive each bug path through the real app:
   `bun test tests/effect/sign-in-limits.test.ts tests/security/history.test.ts tests/render-options.test.ts tests/cache.test.ts tests/better-auth/seam.test.ts`.

## When the change touches a model

Update the model from the code before you run it, never from the result.
Keep one indivisible step in the code as one action in the model: a single
SQL statement is one step; an `await` or a `yield*` between a read and a
write makes two. Change the `"code"` design only; the `"1.6"` design stays
as release 1.6.0 was. Update the line numbers in the comments.

A rule that breaks on a `code` config is a bug or a modeling error. Replay
its path against the code, one step per action, as a test through the app
with `@popcomputer/web/testing`, as the replay tests do. If a step cannot
happen in the code, the model is wrong: fix it and say what was wrong. If
every step happens, it is a bug: report it with the path in the code's own
words, and do not weaken the rule or the model until it passes.

A change that alters a promise on purpose, such as a different cooldown
policy, changes the rule only with the evidence for it, in the change's
docs and CHANGELOG entry: write the rule's old and new wording in the
commit, and update `docs/state-machines.md`.

Once the models describe the code at a new commit and every config gives
what step 2 says, move the commit in "Does the change touch a model?" to
it, in the same change. For drift across many commits that skipped this
check, use pstack's `/maintain-formal-verification-skill`.

## What the check does not cover

The bounds are small: three guessers and eight ticks, two tabs and eight
steps, one value under one tag. The models leave out Cloudflare's Rate
Limiting binding, KV's eventual consistency, Inertia's prefetch cache, a
scanner that presses buttons, Back pressed before a tab asks for any page
after its session ended elsewhere, and every lifecycle in
`docs/state-machines.md` without a model.
