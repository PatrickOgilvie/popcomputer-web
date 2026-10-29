---- MODULE MagicLink ----
\* Better Auth's magic link, as the template serves it: docs/auth-plugins.md
\* 18-26 and tests/better-auth/app.ts showMagicLink and verifyMagicLink
\* (159-169, 276-277). Better Auth consumes the token on its first
\* verification and creates a session (better-auth/dist/plugins/magic-link/
\* index.mjs 43-46, 195). Design "code" serves a page on GET whose button
\* posts the token; "1.6", release 1.6.0's fixture, verified on the GET, and
\* must break.
CONSTANTS Design  \* "code" or "1.6"

VARIABLES token, sessions, memberDone

vars == <<token, sessions, memberDone>>

Init ==
  /\ token = "unused"
  /\ sessions = {}
  /\ memberDone = FALSE

Verify(who) ==
  IF token = "unused"
    THEN /\ token' = "used"
         /\ sessions' = sessions \cup {who}
    ELSE UNCHANGED <<token, sessions>>

\* A mail scanner or a link preview fetches the emailed link; it presses no button.
AScannerFetchesTheLink ==
  /\ "scanner" \notin sessions
  /\ IF Design = "1.6" THEN Verify("scanner") ELSE UNCHANGED <<token, sessions>>
  /\ UNCHANGED memberDone

\* The member follows the link (and, with the page, presses its button).
TheMemberFollowsTheLink ==
  /\ ~memberDone
  /\ memberDone' = TRUE
  /\ Verify("member")

Done == memberDone /\ UNCHANGED vars

Next == AScannerFetchesTheLink \/ TheMemberFollowsTheLink \/ Done

\* No one but the member signs in with the member's link.
OnlyTheMemberSignsIn == sessions \subseteq {"member"}

\* The member who follows an unexpired link is signed in.
TheMemberSignsIn == memberDone => "member" \in sessions
====
