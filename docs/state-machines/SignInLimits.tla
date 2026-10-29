---- MODULE SignInLimits ----
\* One account's password sign-ins under setupWeb's auth.signInLimits:
\* src/effect/sign-in-limits.ts withinSignInLimits and sweepSignInFailures.
\* Each request is two steps, as the code is: its check, then its answer,
\* Better Auth's call (which reads no row) and the write after it.
\* Design "code" is the source as it is: one conditional upsert counts the
\* sign-in before the call. Design "1.6" is release 1.6.0's, which read the
\* row, made the call, and wrote a failure after it: every rule must break on
\* it, which shows the rules can fail.
EXTENDS Naturals, Integers

CONSTANTS
  Max,       \* failures.max
  Cooldown,  \* failures.cooldown, in ticks
  Window,    \* failures.window, in ticks
  Horizon,   \* the last tick the model explores
  Attempts,  \* the most sign-ins the model starts
  Guessers,  \* requests that send a wrong password
  Owner,     \* the request that sends the right one
  Design     \* "code" or "1.6"

Procs == Guessers \cup {Owner}
NoRow == [present |-> FALSE, count |-> 0, last |-> 0]

RECURSIVE Pow2(_)
Pow2(k) == IF k = 0 THEN 1 ELSE 2 * Pow2(k - 1)
Min(a, b) == IF a < b THEN a ELSE b

\* cooldownAfter, and rowStates' cooldown: none below Max, then doubling up to the window.
CooldownAfter(n) == IF n < Max THEN 0 ELSE Min(Window, Cooldown * Pow2(n - Max))

VARIABLES
  now,        \* the clock (Clock.currentTimeMillis)
  row,        \* the account's rateLimit row
  pc,         \* each request: "idle", "checked" (its password is being checked), "in" (the owner, signed in)
  seenAt,     \* "1.6": the time each request read, which its write stamps
  seenRow,    \* "1.6": whether each request's read found a row
  started,    \* sign-ins started
  admitted,   \* wrong passwords let through to the check at this tick, since the owner last signed in
  cooled,     \* history: the account cooled down since the owner last signed in or a quiet window
  coolEnd,    \* history: when the latest cooldown the code gave ends
  resetEarly, \* history: a count past Max started again from 1 within a window of its cooldown's end
  ownerIn,    \* history: the owner has signed in
  sinceOwner  \* history: failures counted since the owner signed in

vars == <<now, row, pc, seenAt, seenRow, started, admitted, cooled, coolEnd, resetEarly, ownerIn, sinceOwner>>

TypeOK ==
  /\ now \in 0..Horizon
  /\ row \in [present : BOOLEAN, count : 0..Attempts, last : 0..Horizon]
  /\ pc \in [Procs -> {"idle", "checked", "in"}]
  /\ started \in 0..Attempts

Init ==
  /\ now = 0
  /\ row = NoRow
  /\ pc = [p \in Procs |-> "idle"]
  /\ seenAt = [p \in Procs |-> 0]
  /\ seenRow = [p \in Procs |-> FALSE]
  /\ started = 0
  /\ admitted = 0
  /\ cooled = FALSE
  /\ coolEnd = 0
  /\ resetEarly = FALSE
  /\ ownerIn = FALSE
  /\ sinceOwner = 0

\* What counting a guess as `count`, stamped `at`, does to the history.
Counted(count, at) ==
  /\ cooled' = (count >= Max \/ (cooled /\ count > 1))
  /\ coolEnd' = IF count >= Max THEN at + CooldownAfter(count) ELSE coolEnd
  /\ resetEarly' = (resetEarly \/ (cooled /\ count = 1 /\ at < coolEnd + Window))
  /\ sinceOwner' = IF ownerIn THEN sinceOwner + 1 ELSE sinceOwner

\* The owner's success deletes the row and clears the burst.
OwnerSignedIn ==
  /\ ownerIn' = TRUE
  /\ sinceOwner' = 0
  /\ cooled' = FALSE
  /\ admitted' = 0

\* ---------------- "code": count, then call ----------------

\* rowStates (sign-in-limits.ts 297-311): spent a window after its cooldown ends.
Spent == ~row.present \/ now >= row.last + CooldownAfter(row.count) + Window
Cooling == ~Spent /\ row.count >= Max /\ now < row.last + CooldownAfter(row.count)

\* withinSignInLimits 433-448: one upsert counts the sign-in unless the
\* account is cooling, when it returns no row and the sign-in is refused.
CheckCode(p) ==
  /\ pc[p] = "idle"
  /\ started < Attempts
  /\ started' = started + 1
  /\ IF Cooling
       THEN UNCHANGED <<pc, row, admitted, cooled, coolEnd, resetEarly, sinceOwner>>
       ELSE LET count == IF Spent THEN 1 ELSE row.count + 1
            IN /\ row' = [present |-> TRUE, count |-> count, last |-> now]
               /\ pc' = [pc EXCEPT ![p] = "checked"]
               /\ admitted' = IF p \in Guessers THEN admitted + 1 ELSE admitted
               /\ IF p \in Guessers
                    THEN Counted(count, now)
                    ELSE UNCHANGED <<cooled, coolEnd, resetEarly, sinceOwner>>
  /\ UNCHANGED <<now, seenAt, seenRow, ownerIn>>

\* Line 452: a 401 is already counted; a success deletes the row.
AnswerCode(p) ==
  /\ pc[p] = "checked"
  /\ IF p \in Guessers
       THEN /\ pc' = [pc EXCEPT ![p] = "idle"]
            /\ UNCHANGED <<row, ownerIn, sinceOwner, cooled, admitted>>
       ELSE /\ row' = NoRow
            /\ pc' = [pc EXCEPT ![p] = "in"]
            /\ OwnerSignedIn
  /\ UNCHANGED <<now, seenAt, seenRow, started, coolEnd, resetEarly>>

\* sweepSignInFailures 463-477 deletes spent rows.
SweepCode ==
  /\ row.present
  /\ Spent
  /\ row' = NoRow
  /\ UNCHANGED <<now, pc, seenAt, seenRow, started, admitted, cooled, coolEnd, resetEarly, ownerIn, sinceOwner>>

\* ---------------- "1.6": read, call, then write ----------------

CoolingAt16 ==
  /\ row.present
  /\ row.last + Window > now
  /\ row.last + CooldownAfter(row.count) > now

Check16(p) ==
  /\ pc[p] = "idle"
  /\ started < Attempts
  /\ started' = started + 1
  /\ IF CoolingAt16
       THEN UNCHANGED <<pc, seenAt, seenRow, admitted>>
       ELSE /\ pc' = [pc EXCEPT ![p] = "checked"]
            /\ seenAt' = [seenAt EXCEPT ![p] = now]
            /\ seenRow' = [seenRow EXCEPT ![p] = row.present]
            /\ admitted' = IF p \in Guessers THEN admitted + 1 ELSE admitted
  /\ UNCHANGED <<now, row, cooled, coolEnd, resetEarly, ownerIn, sinceOwner>>

Answer16(p) ==
  /\ pc[p] = "checked"
  /\ IF p \in Guessers
       THEN LET at == seenAt[p]
                count == IF ~row.present \/ row.last <= at - Window THEN 1 ELSE row.count + 1
            IN /\ row' = [present |-> TRUE, count |-> count, last |-> at]
               /\ Counted(count, at)
               /\ pc' = [pc EXCEPT ![p] = "idle"]
               /\ UNCHANGED <<ownerIn, admitted>>
       ELSE /\ row' = IF seenRow[p] THEN NoRow ELSE row
            /\ pc' = [pc EXCEPT ![p] = "in"]
            /\ OwnerSignedIn
            /\ UNCHANGED <<coolEnd, resetEarly>>
  /\ seenAt' = [seenAt EXCEPT ![p] = 0]
  /\ seenRow' = [seenRow EXCEPT ![p] = FALSE]
  /\ UNCHANGED <<now, started>>

Sweep16 ==
  /\ row.present
  /\ row.last < now - Window
  /\ row' = NoRow
  /\ UNCHANGED <<now, pc, seenAt, seenRow, started, admitted, cooled, coolEnd, resetEarly, ownerIn, sinceOwner>>

\* ---------------- both ----------------

Tick ==
  /\ now < Horizon
  /\ now' = now + 1
  /\ admitted' = 0
  /\ UNCHANGED <<row, pc, seenAt, seenRow, started, cooled, coolEnd, resetEarly, ownerIn, sinceOwner>>

Done == now = Horizon /\ UNCHANGED vars

YouSignIn(p) == IF Design = "code" THEN CheckCode(p) ELSE Check16(p)
BetterAuthAnswers(p) == IF Design = "code" THEN AnswerCode(p) ELSE Answer16(p)
CronSweeps == IF Design = "code" THEN SweepCode ELSE Sweep16

Next ==
  \/ \E p \in Procs : YouSignIn(p)
  \/ \E p \in Procs : BetterAuthAnswers(p)
  \/ CronSweeps
  \/ Tick
  \/ Done

\* ---------------- rules ----------------

\* However many guesses arrive together, at most Max reach the password
\* check, unless the owner signs in between them, which clears the count.
AtMostMaxGuessesAtOnce == admitted <= Max

\* Once the account has cooled down, its count starts again from 1 only
\* after a whole window with no guess, counted from the end of the cooldown.
NoFreshBudgetAfterCooldown == ~resetEarly

\* After the owner signs in, only failures after that count.
OwnerSignInClearsCount == ownerIn => (row.present => row.count <= sinceOwner)
====
