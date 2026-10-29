---- MODULE DataCache ----
\* One cached value under one tag: src/cache.ts cache() (readTagGenerations
\* 90-106, the generation check 347-352, storeInCache 329-337), cacheGet
\* (408-440), cacheSet (454-485) and invalidateCacheTags (572-587), which a
\* route's purges and purgeCache run once its write has committed.
\* Design "code" is the source as it is: cacheSet records its tags'
\* generations and cacheGet checks them, as cache() does. "1.6", release
\* 1.6.0, did neither, and must break.
EXTENDS Naturals

CONSTANTS Design, Steps  \* Design: "code" or "1.6"

VARIABLES
  db,        \* the record's version in the database
  gen,       \* the tag's generation in the store, 0 for none
  entry,     \* the stored entry: [present, v (the db version it holds), g (generation, 0 for none)]
  reading,   \* a cache() computation in flight: [busy, g (generation it read), v (db version it read)]
  purgedAt,  \* the db version the latest purge followed
  stale,     \* history: a read returned a value older than a purge that followed its write
  steps

vars == <<db, gen, entry, reading, purgedAt, stale, steps>>

Count == steps < Steps /\ steps' = steps + 1

Init ==
  /\ db = 1
  /\ gen = 0
  /\ entry = [present |-> FALSE, v |-> 0, g |-> 0]
  /\ reading = [busy |-> FALSE, g |-> 0, v |-> 0]
  /\ purgedAt = 0
  /\ stale = FALSE
  /\ steps = 0

\* What a read hands back: stale when the value predates the latest purge.
Returns(v) == stale' = (stale \/ v < purgedAt)

\* cache(): the tag's generation is read, created when it has none, before the value is computed.
CacheStarts ==
  /\ Count
  /\ ~reading.busy
  /\ LET g == IF gen = 0 THEN 1 ELSE gen
     IN /\ gen' = g
        /\ IF entry.present /\ entry.g = g
             THEN /\ Returns(entry.v)
                  /\ UNCHANGED reading
             ELSE /\ reading' = [busy |-> TRUE, g |-> g, v |-> db]
                  /\ UNCHANGED stale
  /\ UNCHANGED <<db, entry, purgedAt>>

\* cache(): the computed value is stored with the generation read before it,
\* and returned to the request that computed it, which read before any later write.
CacheStores ==
  /\ Count
  /\ reading.busy
  /\ entry' = [present |-> TRUE, v |-> reading.v, g |-> reading.g]
  /\ reading' = [busy |-> FALSE, g |-> 0, v |-> 0]
  /\ UNCHANGED <<db, gen, purgedAt, stale>>

\* cacheGet: "1.6" returns any entry; "code" treats one whose tag moved on as absent.
CacheGetReads ==
  /\ Count
  /\ entry.present
  /\ IF Design = "1.6" \/ entry.g = gen
       THEN Returns(entry.v)
       ELSE UNCHANGED stale
  /\ UNCHANGED <<db, gen, entry, reading, purgedAt>>

\* cacheSet with the tag: "1.6" stores no generation; "code" stores the tag's.
CacheSetWrites ==
  /\ Count
  /\ LET g == IF gen = 0 THEN 1 ELSE gen
     IN IF Design = "1.6"
          THEN /\ entry' = [present |-> TRUE, v |-> db, g |-> 0]
               /\ UNCHANGED gen
          ELSE /\ entry' = [present |-> TRUE, v |-> db, g |-> g]
               /\ gen' = g
  /\ UNCHANGED <<db, reading, purgedAt, stale>>

\* An action writes the record and its route purges the tag once it commits.
TheRecordChanges ==
  /\ Count
  /\ db < 3
  /\ db' = db + 1
  /\ purgedAt' = db + 1
  /\ gen' = IF gen = 0 THEN 0 ELSE gen + 1
  /\ UNCHANGED <<entry, reading, stale>>

Done == steps = Steps /\ UNCHANGED vars

Next == CacheStarts \/ CacheStores \/ CacheGetReads \/ CacheSetWrites \/ TheRecordChanges \/ Done

TypeOK ==
  /\ db \in 1..3
  /\ entry \in [present : BOOLEAN, v : 0..3, g : Nat]

\* Once a write's purge has run, no read returns the value from before it.
NoReadAfterPurgeReturnsTheOldValue == ~stale
====
