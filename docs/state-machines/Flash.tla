---- MODULE Flash ----
\* A failed form's field errors on their way to the page its redirect lands
\* on: src/flash.ts flashCookieTable and openFlash, the render in
\* src/middleware.ts, and src/response-output.ts finishResponse, which moves
\* the table on the answer actually sent and writes the cookie it gives.
\* Another request from the same browser overlaps it: an Inertia poll or
\* async reload, or a visit in another tab, which renders a page at OtherAt,
\* "form", the form page's own address, or "elsewhere".
\* Design "code" is the source as it is: the cookie names the address of the
\* page its errors are for, the one the redirect leads to; a page at another
\* address takes none of them, and writes the cookie only for what it changed.
\* "1.15", release 1.15.0, named no page: any page took the errors, and
\* wrote the cookie from what its request sent. TheFormShowsItsErrors holds
\* on the code when the other page is elsewhere, breaks when it is at the
\* form's own address, a limit docs/state-machines.md states, and breaks on
\* "1.15" either way.
EXTENDS Naturals

CONSTANTS
  Design,  \* "code" or "1.15"
  OtherAt  \* "form" or "elsewhere"

VARIABLES
  cookie,   \* the browser's flash cookie: "none" or "errors", for the form's page
  form,     \* the form's tab: "editing", "posted", "redirected", "shown"
  formSaw,  \* what the redirect's GET sent
  other,    \* the other request: "idle", "sent", "answered"
  otherSaw, \* what it sent
  shown     \* what the form's tab ended on: "none", "errors", "nothing"

vars == <<cookie, form, formSaw, other, otherSaw, shown>>

Init ==
  /\ cookie = "none"
  /\ form = "editing"
  /\ formSaw = "none"
  /\ other = "idle"
  /\ otherSaw = "none"
  /\ shown = "none"

\* The form posts and fails: its 303 carries the errors in the cookie, for
\* the address it leads to, the form's page.
YouSubmitTheForm ==
  /\ form = "editing"
  /\ form' = "posted"
  /\ cookie' = "errors"
  /\ UNCHANGED <<formSaw, other, otherSaw, shown>>

\* Inertia follows the 303 with the cookie the browser holds now.
InertiaFollowsTheRedirect ==
  /\ form = "posted"
  /\ form' = "redirected"
  /\ formSaw' = cookie
  /\ UNCHANGED <<cookie, other, otherSaw, shown>>

\* The page renders the errors it received and clears the cookie.
TheFormPageArrives ==
  /\ form = "redirected"
  /\ form' = "shown"
  /\ shown' = IF formSaw = "errors" THEN "errors" ELSE "nothing"
  /\ cookie' = IF formSaw = "errors" THEN "none" ELSE cookie
  /\ UNCHANGED <<formSaw, other, otherSaw>>

AnotherRequestLeaves ==
  /\ other = "idle"
  /\ other' = "sent"
  /\ otherSaw' = cookie
  /\ UNCHANGED <<cookie, form, formSaw, shown>>

\* It renders a page. On "1.15", one that received the errors takes them and
\* expires the cookie, whatever the browser holds by then. On the code, only
\* a page at the form's address takes them; one elsewhere writes nothing.
AnotherPageArrives ==
  /\ other = "sent"
  /\ other' = "answered"
  /\ cookie' = IF otherSaw = "errors" /\ (Design = "1.15" \/ OtherAt = "form") THEN "none" ELSE cookie
  /\ UNCHANGED <<form, formSaw, otherSaw, shown>>

Done == form = "shown" /\ other = "answered" /\ UNCHANGED vars

Next ==
  \/ YouSubmitTheForm \/ InertiaFollowsTheRedirect \/ TheFormPageArrives
  \/ AnotherRequestLeaves \/ AnotherPageArrives \/ Done

\* The form's errors show on the page its redirect lands on.
TheFormShowsItsErrors == shown # "nothing"
====
