---- MODULE DataCache ----
\* One cached value under one tag: src/cache.ts cache() (readTagGenerations
\* 91-111, the generation check in cache()), cacheGet, cacheSet (the
\* generations read first; given a value, the check against WorkBegan) and
\* invalidateCacheTags with writeTagGenerations, which a route's purges and
\* purgeCache run once its write has committed, and which write a new
\* generation whether or not the store shows one.
\* Design "code" is the source as it is: cacheSet records its tags'
\* generations and cacheGet checks them, as cache() does. "1.6", release
\* 1.6.0, did neither, and must break. CacheSetGiven is how the application
\* calls cacheSet: "read", given the Effect that reads the value, which it
\* runs after reading the generations; or "value", given a value its caller
\* read earlier, in a step of its own, in a request or job that began
\* before it (src/effect/work-began.ts). Given a value, the code stores
\* nothing once the tag's generation was made after the work began, unless
\* cacheSet made it itself: a generation's name starts with when it was made.
EXTENDS Integers

CONSTANTS
  Design,         \* "code" or "1.6"
  CacheSetGiven,  \* "read" or "value"; "1.6" had only "value"
  Steps

VARIABLES
  db,        \* the record's version in the database
  gen,       \* the tag's generation in the store, 0 for none
  entry,     \* the stored entry: [present, v (the db version it holds), g (generation, 0 for none),
            \*   late (cacheSet stored a value a purge had already replaced)]
  held,      \* the db version read to give cacheSet, 0 for none
  captured,  \* the generation cacheSet read before running its read, 0 for none
  begun,     \* the tag's generation when the work that gives cacheSet a value began, -1 before it begins
  reading,   \* a cache() computation in flight: [busy, g (generation it read), v (db version it read)]
  purgedAt,  \* the db version the latest purge followed
  stale,     \* history: a read returned a value older than a purge that followed its write
  storedLate, \* history: cacheSet stored a value a purge had already replaced
  steps

vars == <<db, gen, entry, reading, held, captured, begun, purgedAt, stale, storedLate, steps>>

Count == steps < Steps /\ steps' = steps + 1

Init ==
  /\ db = 1
  /\ gen = 0
  /\ entry = [present |-> FALSE, v |-> 0, g |-> 0, late |-> FALSE]
  /\ held = 0
  /\ captured = 0
  /\ begun = -1
  /\ storedLate = FALSE
  /\ reading = [busy |-> FALSE, g |-> 0, v |-> 0]
  /\ purgedAt = 0
  /\ stale = FALSE
  /\ steps = 0

\* What a read of the entry hands back: stale when the value predates the
\* latest purge, unless cacheSet stored it so, which CacheSetStoresOnlyCurrentValues reports.
Returns(e) == stale' = (stale \/ (e.v < purgedAt /\ ~e.late))

\* cache(): the tag's generation is read, created when it has none, before the value is computed.
CacheStarts ==
  /\ Count
  /\ ~reading.busy
  /\ LET g == IF gen = 0 THEN 1 ELSE gen
     IN /\ gen' = g
        /\ IF entry.present /\ entry.g = g
             THEN /\ Returns(entry)
                  /\ UNCHANGED reading
             ELSE /\ reading' = [busy |-> TRUE, g |-> g, v |-> db]
                  /\ UNCHANGED stale
  /\ UNCHANGED <<db, entry, held, captured, begun, purgedAt, storedLate>>

\* cache(): the computed value is stored with the generation read before it,
\* and returned to the request that computed it, which read before any later write.
CacheStores ==
  /\ Count
  /\ reading.busy
  /\ entry' = [present |-> TRUE, v |-> reading.v, g |-> reading.g, late |-> FALSE]
  /\ reading' = [busy |-> FALSE, g |-> 0, v |-> 0]
  /\ UNCHANGED <<db, gen, held, captured, begun, purgedAt, stale, storedLate>>

\* cacheGet: "1.6" returns any entry; "code" treats one whose tag moved on as absent.
CacheGetReads ==
  /\ Count
  /\ entry.present
  /\ IF Design = "1.6" \/ entry.g = gen
       THEN Returns(entry)
       ELSE UNCHANGED stale
  /\ UNCHANGED <<db, gen, entry, reading, held, captured, begun, purgedAt, storedLate>>

\* cacheSet given its read: it reads the tag's generation, created when it
\* has none, before it runs the read.
CacheSetStartsItsRead ==
  /\ Count
  /\ Design = "code" /\ CacheSetGiven = "read"
  /\ held = 0 /\ captured = 0
  /\ LET g == IF gen = 0 THEN 1 ELSE gen
     IN /\ captured' = g
        /\ gen' = g
  /\ UNCHANGED <<db, entry, reading, held, begun, purgedAt, stale, storedLate>>

\* The request or job that will give cacheSet a value begins: WorkBegan is
\* its clock's time, before any of its reads (src/effect/work-began.ts).
TheWorkBegins ==
  /\ Count
  /\ CacheSetGiven = "value"
  /\ held = 0 /\ begun = -1
  /\ begun' = gen
  /\ UNCHANGED <<db, gen, entry, reading, held, captured, purgedAt, stale, storedLate>>

\* The record is read: by cacheSet's read once it has the generation, or by
\* the work that gives cacheSet the value in a later step.
TheRecordIsRead ==
  /\ Count
  /\ held = 0
  /\ CacheSetGiven = "read" => captured # 0
  /\ CacheSetGiven = "value" => begun # -1
  /\ held' = db
  /\ UNCHANGED <<db, gen, entry, reading, captured, begun, purgedAt, stale, storedLate>>

\* cacheSet stores what was read: "1.6" with no generation; "code" with the
\* one its read began under, or, given a value, the tag's as it is now,
\* storing nothing when that generation was made after the work began and
\* not by this cacheSet, which makes one only for a tag that has none.
CacheSetWrites ==
  /\ Count
  /\ held # 0
  /\ LET g == IF CacheSetGiven = "read" THEN captured ELSE IF gen = 0 THEN 1 ELSE gen
         \* A replaced value where a read would find it: under the tag's current generation.
         late == held < db /\ (Design = "1.6" \/ g = IF CacheSetGiven = "read" THEN gen ELSE g)
         madeSinceBegun == Design = "code" /\ CacheSetGiven = "value" /\ gen # 0 /\ gen # begun
     IN IF madeSinceBegun
          THEN UNCHANGED <<entry, gen, storedLate>>
          ELSE /\ IF Design = "1.6"
                    THEN /\ entry' = [present |-> TRUE, v |-> held, g |-> 0, late |-> late]
                         /\ UNCHANGED gen
                    ELSE /\ entry' = [present |-> TRUE, v |-> held, g |-> g, late |-> late]
                         /\ gen' = IF CacheSetGiven = "read" THEN gen ELSE g
               /\ storedLate' = (storedLate \/ late)
  /\ held' = 0
  /\ captured' = 0
  /\ begun' = -1
  /\ UNCHANGED <<db, reading, purgedAt, stale>>

\* An action writes the record and its route purges the tag once it commits.
\* "code" writes a new generation whether or not the store shows one
\* (writeTagGenerations); "1.6" wrote one only over an existing one.
TheRecordChanges ==
  /\ Count
  /\ db < 3
  /\ db' = db + 1
  /\ purgedAt' = db + 1
  /\ gen' = IF Design = "code" THEN gen + 1 ELSE IF gen = 0 THEN 0 ELSE gen + 1
  /\ UNCHANGED <<entry, reading, held, captured, begun, stale, storedLate>>

Done == steps = Steps /\ UNCHANGED vars

Next ==
  \/ CacheStarts \/ CacheStores \/ CacheGetReads
  \/ CacheSetStartsItsRead \/ TheWorkBegins \/ TheRecordIsRead \/ CacheSetWrites
  \/ TheRecordChanges \/ Done

TypeOK ==
  /\ db \in 1..3
  /\ entry \in [present : BOOLEAN, v : 0..3, g : Nat, late : BOOLEAN]
  /\ held \in 0..3
  /\ captured \in Nat
  /\ begun \in Nat \cup {-1}

\* Once a write's purge has run, no read returns the value from before it,
\* but one cacheSet stored after the purge, which the next rule reports.
NoReadAfterPurgeReturnsTheOldValue == ~stale

\* cacheSet stores no value a purge has already replaced where a read would
\* find it, under the tag's current generation. Given its read, cacheSet
\* reads the generation first; given a value, it stores nothing once the
\* generation was made after its work began. "1.6" breaks it.
CacheSetStoresOnlyCurrentValues == ~storedLate
====
