---- MODULE Flash ----
\* A failed form's field errors on their way to the page its redirect lands
\* on: src/flash.ts openFlash (outgoing 94-107, take 131-143, commit 149-173)
\* and the render in src/middleware.ts 164. Another request from the same
\* browser overlaps it: an Inertia poll or async reload, or a visit in
\* another tab, which renders a page. TheFormShowsItsErrors breaks on the
\* code, a limit docs/state-machines.md accepts: the flash cookie is one
\* value per browser, and each answer writes it from what its request sent.
EXTENDS Naturals

VARIABLES
  cookie,   \* the browser's flash cookie: "none" or "errors"
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

\* The form posts and fails: its 303 carries the errors in the cookie.
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

\* It renders a page: one that received the cookie takes the errors and
\* expires it, whatever the browser holds by then.
AnotherPageArrives ==
  /\ other = "sent"
  /\ other' = "answered"
  /\ cookie' = IF otherSaw = "errors" THEN "none" ELSE cookie
  /\ UNCHANGED <<form, formSaw, otherSaw, shown>>

Done == form = "shown" /\ other = "answered" /\ UNCHANGED vars

Next ==
  \/ YouSubmitTheForm \/ InertiaFollowsTheRedirect \/ TheFormPageArrives
  \/ AnotherRequestLeaves \/ AnotherPageArrives \/ Done

\* The form's errors show on the page its redirect lands on.
TheFormShowsItsErrors == shown # "nothing"
====
