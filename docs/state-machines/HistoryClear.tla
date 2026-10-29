---- MODULE HistoryClear ----
\* Inertia's history in the browser's tabs, against what the server answers:
\* src/middleware.ts web()'s render (encryptHistory, clearHistory and
\* version, 191-216) and its raise of the clear after an answer that ends or
\* starts a session (297-304), the one-shot flag in src/flash.ts, the page's
\* version in src/page-version.ts, and @inertiajs/core 3.9.1's client: a page
\* with clearHistory drops the tab's key; Back decrypts the entry and shows it
\* only when its version is the current page's, and otherwise asks the
\* server (index.js 1749-1800, 1859-1878, 3283-3287).
\* Design "code" marks a signed-in page's version with its member; "1.6",
\* release 1.6.0, gave every page the assets' version, and must break.
EXTENDS Naturals, Sequences

CONSTANTS
  Tabs,      \* the browser's tabs
  Members,   \* people who sign in at this browser
  Encrypt,   \* setupWeb's history.encrypt: "signed-in" (the default) or "always"
  Design,    \* "code" or "1.6"
  Depth,     \* the most entries a tab's history keeps in the model
  Steps      \* the most steps the model takes

Guest == "guest"
People == Members \cup {Guest}

VARIABLES
  session,  \* whom the browser's session cookie signs in, or Guest
  flag,     \* the flash cookie's one-shot clearHistory
  key,      \* each tab's history key generation (sessionStorage)
  page,     \* each tab's current page: [who, enc, gen, ver]
  hist,     \* each tab's entries behind the current page, the latest last
  leak,     \* history: Back showed a member's page under someone else's, without the server
  steps

vars == <<session, flag, key, page, hist, leak, steps>>

Version(who) == IF Design = "code" THEN who ELSE "v"

GuestPage == [who |-> Guest, enc |-> FALSE, gen |-> 0, ver |-> Version(Guest)]

TypeOK ==
  /\ session \in People
  /\ flag \in BOOLEAN
  /\ key \in [Tabs -> Nat]
  /\ page \in [Tabs -> [who : People, enc : BOOLEAN, gen : Nat, ver : People \cup {"v"}]]

Init ==
  /\ session = Guest
  /\ flag = FALSE
  /\ key = [t \in Tabs |-> 0]
  /\ page = [t \in Tabs |-> GuestPage]
  /\ hist = [t \in Tabs |-> <<>>]
  /\ leak = FALSE
  /\ steps = 0

\* middleware.ts 191-210: what the server renders for the browser's session.
SignedIn == session # Guest
Encrypts == IF Encrypt = "always" THEN TRUE ELSE SignedIn
Clears == flag \/ (Encrypt = "signed-in" /\ ~SignedIn)

\* The tab applies a page the server rendered: a clear drops its key, so the
\* page and the ones after it are encrypted with a new one.
Rendered(t) ==
  LET gen == IF Clears THEN key[t] + 1 ELSE key[t]
  IN [who |-> session, enc |-> Encrypts, gen |-> gen, ver |-> Version(session)]

Apply(t) ==
  /\ key' = [key EXCEPT ![t] = IF Clears THEN @ + 1 ELSE @]
  \* A page that clears takes the one-shot flag (middleware.ts 216, flash.ts 131-143).
  /\ flag' = FALSE

Push(t, entry) ==
  hist' = [hist EXCEPT ![t] = IF Len(@) < Depth THEN Append(@, entry) ELSE Append(Tail(@), entry)]

Count == steps < Steps /\ steps' = steps + 1

\* You open another page in a tab: an Inertia visit, which the server renders.
YouOpenAPage(t) ==
  /\ Count
  /\ Apply(t)
  /\ Push(t, page[t])
  /\ page' = [page EXCEPT ![t] = Rendered(t)]
  /\ UNCHANGED <<session, leak>>

\* A member signs in, in any tab: the answer starts a session and raises the flag.
SomeoneSignsIn(m) ==
  /\ Count
  /\ session # m
  /\ session' = m
  /\ flag' = TRUE
  /\ UNCHANGED <<key, page, hist, leak>>

\* The member signs out: the answer ends the session and raises the flag.
TheMemberSignsOut ==
  /\ Count
  /\ SignedIn
  /\ session' = Guest
  /\ flag' = TRUE
  /\ UNCHANGED <<key, page, hist, leak>>

\* The session cookie expires in the browser: no answer sees it end.
TheSessionExpires ==
  /\ Count
  /\ SignedIn
  /\ session' = Guest
  /\ UNCHANGED <<flag, key, page, hist, leak>>

\* You press Back in a tab. Inertia decrypts the entry with the tab's key and
\* shows it when its version is the current page's; otherwise it asks the
\* server for that page, which renders it for the browser's session.
YouPressBack(t) ==
  /\ Count
  /\ hist[t] # <<>>
  /\ LET entry == hist[t][Len(hist[t])]
         readable == ~entry.enc \/ entry.gen = key[t]
         sameVersion == entry.ver = page[t].ver
     IN IF readable /\ sameVersion
          THEN /\ page' = [page EXCEPT ![t] = entry]
               /\ leak' = (leak \/ (entry.who # Guest /\ entry.who # page[t].who))
               /\ UNCHANGED <<key, flag>>
          ELSE /\ Apply(t)
               /\ page' = [page EXCEPT ![t] = Rendered(t)]
               /\ UNCHANGED leak
  /\ hist' = [hist EXCEPT ![t] = SubSeq(@, 1, Len(@) - 1)]
  /\ UNCHANGED session

Done == steps = Steps /\ UNCHANGED vars

Next ==
  \/ \E t \in Tabs : YouOpenAPage(t)
  \/ \E m \in Members : SomeoneSignsIn(m)
  \/ TheMemberSignsOut
  \/ TheSessionExpires
  \/ \E t \in Tabs : YouPressBack(t)
  \/ Done

\* Back never shows a member's page from history in a tab whose page is now
\* someone else's, or a guest's, without asking the server.
BackShowsNoOneElsesPage == ~leak
====
