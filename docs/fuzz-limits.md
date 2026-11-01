# Fuzzing at the limits

A limit set for production, ten failed sign-ins before a cooldown, fifty
items in a cart, a field name nested 32 deep, is one that generated inputs
seldom reach. A check one past its edge, `<` where `<=` belongs, then holds
for every case `fuzz` runs, and the bug ships. Fuzz each limit at its edge:
set it in the test from the input, so every case lands on it.

## Set the limit from the input

Take each limit as a parameter the test sets, with production's value as its
default, rather than a constant only production reads:

- the application's own limits, such as a page size, a cart's most items or
  a plan's seats;
- the framework's, such as `auth.signInLimits.failures: { max: 2 }` in the
  test's `setupWeb`, so a few guesses reach the cooldown.

Then generate the input first, and set the limit from what the input needs:
one less, exactly that, or one more, by adding `pick([0, -1, 1])` to it. Each
case sits on the edge or one step to either side of it, and a failure shrinks
toward the edge itself. A limit set low but fixed, such as a cart of three
items, also reaches its edge, though fewer cases land on it.

## Say what it keeps and what it refuses

A property that checks only that nothing passes the limit holds for a limit
that refuses everything. Check both sides: an input within the limit is kept
as it would be with no limit, and one past it is refused as the limit says.
The framework's own limits are fuzzed this way, its field nesting, flash
cookie and cache tags: of eleven off-by-one checks planted at them, the rest
of its suite caught three, and the limits property caught all eleven.

## Check at the real size

Once a small limit finds a failure, run the same case at production's limit,
with the input grown to match, so the fix covers the case production meets.
Keep that case as a plain test beside the property, as any fuzz failure is
kept ([Fuzzing](fuzzing.md)).
