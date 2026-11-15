# Email for staff onboarding and credentialing

Owner, 2026-11-09: *"Please review repo and recent branches and make sure email
notifications updates accordingly. Esp for new employees who need onboarding or
credentialing reminders."*

## What the review found

A whole onboarding and credentialing system shipped between 2026-11-06 and
2026-11-08 — Chapters A to H, `onboarding/renewals.js`, a staff portal at
`/my`, 35 routes — and **none of it sent an email**. Every notice in the app
was about patients, visits, messages or to-dos. No unmerged branch was doing
it either; the newest was eight weeks old.

Three things were being computed and shown to nobody who was obliged to look:

- A new hire learned what she owed by opening the app. Nothing told her it was
  there, and nothing reminded her.
- `renewals.js` already warned 60 days before a licence, DEA registration,
  malpractice policy, TB result, BLS card, driver's licence or certificate of
  insurance expired, and already tracked recurring duties and spaced
  re-checks. All of it was a number on a screen.
- **The office returning an item REQUIRES a reason, stored it, and told her
  nothing.** That is the same defect the client document rejection had, where
  "a client told nothing sends the same blurry photo again."

## Owner decisions, 2026-11-09

- **Her nudge is DAILY.** Asked between weekly and daily, the owner chose daily.
- **A credential reaches BOTH her and the office.** She renews it; the office
  verifies it and may have to take her off shifts.
- **The office gets a weekly roll-up AND an immediate notice when she submits**
  (both options, not one).

## The six notices

| Notice | Goes to | When |
|---|---|---|
| `staff_onboarding_started` | the new hire | the office opens her track, once |
| `staff_onboarding_returned` | the new hire | an item comes back, **with the reason** |
| `staff_item_submitted` | the office | she submits something to verify |
| `staff_onboarding_digest` | the new hire | daily at 9am ET while anything is outstanding |
| `staff_credential_expiring` | the office | at 30, 14, 7 and 1 days, and daily once lapsed |
| `staff_onboarding_weekly` | the office | Monday roll-up |

## Must not undo

- **IT RESTATES NO RULE.** `onboarding/notices.js` reads the track
  `track.buildTrack` already builds, so the office overview, her own portal and
  these emails share one set of numbers: a rule narrowed in `track.js` or
  `renewals.js` narrows the email on the next sweep. The 60-day and 14-day
  warning windows stay in `renewals.js`; build-enforced that they are not
  copied here.
- **HER DIGEST IS ONE EMAIL, AND HER CREDENTIALS RIDE IN IT.** A new hire
  carries dozens of open items; one email per item would be forty on a Monday
  and the next would be filtered unread. Expiring credentials are a section of
  the daily digest rather than a second email the same morning.
- **AN EMPTY DIGEST IS NEVER SENT.** A daily email that says "nothing to do" is
  how a daily email stops being read.
- **ONE A DAY AND ONE A WEEK ARE HELD BY THE KEY**, not by the sweep's cadence
  and not by a stored sent-flag a restart would lose:
  `onbdigest:<user>:<Georgia date>` and `onbweekly:<user>:<ISO week>`.
- **A CREDENTIAL IS ANNOUNCED AT MILESTONES, NOT EVERY MORNING.** 30, 14, 7, 1
  — so a licence 30 days out is announced once at 30 and again at 14. **Once
  lapsed the key carries the date**, so a stop-work condition repeats daily
  instead of being announced once and dropped.
- **NOTHING HERE IS PHI, and that is a fact about the data rather than a
  shortcut:** an onboarding item is employment and credentialing data about a
  member of staff, which is what the welcome packet's own collection entry
  already records. So the detail sends on any transport and
  `transportAllowsDetail` is deliberately not consulted — a notice that went
  vague here would say "something is waiting" about a licence that lapses on
  Friday. **The other side is enforced, not trusted: a patient never appears in
  one.** Build-enforced that the decision module knows nothing about clients,
  and the probe checks the roster that no client or family account is ever a
  recipient.
- **WHO IS TOLD IS THE PERSON AND THE OFFICE** — an admin or a manager, read
  through the same `isOffice` the route gate uses, so a role narrowed there
  narrows who is emailed on the next send. Never the rest of the team.
- **THE OFFICE'S CTA IS `/onboarding`, NOT `/my`.** Pointing an office notice
  at `/my` would send an admin to their own checklist to verify somebody
  else's licence. Both destinations are named in `appLinks`, and both pages
  resolve `#onboarding` and fall back to their home view rather than rendering
  a dead tab (a caregiver is redirected to `/caregiver#onboarding`, which is in
  `TAB_IDS`).
- **IT RIDES THE NOTIFICATION SCANNER, with no timer of its own.** That is the
  opposite call to the to-do reminders, and the reason is the precision each
  needs: a to-do names its own MINUTE, so a 30-minute scan is a broken promise
  there. A morning digest and a Monday roll-up are coarser than the scan.
- **THE SWEEP TAKES THE DATE AND HOUR**, defaulting to Georgia's clock. A test
  that had to run at 9am Eastern to mean anything would be a test that mostly
  means nothing.
- **A NOTICE FAILURE NEVER UNDOES THE ACTION IT RODE ON**, and **a missing
  notifier is LOUD** — "nothing was emailed" and "nobody needed emailing" are
  different facts.
- **A SECOND RETURN OF THE SAME ITEM IS ITS OWN EMAIL.** She resubmitted and it
  came back again; a shared key would let the queue drop it silently.
- **AN ITEM THAT COMPLETES OUTRIGHT DOES NOT ASK THE OFFICE TO VERIFY IT.**
  "Ready to verify" about an item with nothing to verify is a false errand.

## Verified

- `test/staff_onboarding_notices.test.js`, **24 tests; 25 of 25 mutations
  caught.** Four survived the first pass and all four were genuine holes in my
  own tests, now closed: the returned-item fixture had no `waitingOnHer` so
  listing it twice could not show; only one return was ever driven, so the
  shared-key bug was invisible; no case completed an item outright, so
  "ready to verify" fired either way; and the empty-digest case had no track at
  all, so the route's own guard was never reached (it now stands in for
  `digestFor` on the shared module object to exercise the route).
- **The existing `test/onboarding_routes.test.js` harness omitted `notify`**, so
  all fourteen of its tests exercised a router where nobody is ever emailed.
  The notifier is injected now — the "a harness missing what production
  supplies exercises a different function" trap, for the fourth time in this
  repo.
- `scripts/verify_staff_onboarding_notices.js`: **21/21 through the real HTTP
  routes**, reading the queued notification back. **2 sections report as
  SKIPPED** rather than passing: it ran at 01:00 ET and nothing goes out before
  09:00, so the digest and credential milestones were out of reach through the
  full server. Those paths are driven over HTTP in the test file, which hands
  the sweep the date and hour instead of waiting for them. Re-run the probe
  after 09:00 ET to close that half.
- All six messages rendered and read. **Reading them caught two defects no
  assertion had:** the office notices said "Open staff onboarding" while
  pointing at *her* portal, and `**bold**` section labels printed as literal
  asterisks because `renderGfcEmail` escapes paragraph text.
- Full suite **3512 passing, 0 failing** (1 skipped, pre-existing).

## Found on the way, not fixed here

- **`test/pages_compile.test.js` was failing on `main` for a missing
  `@babel/standalone`** — a declared dependency absent from the sandbox, not a
  code fault. `npm install` fixed it and the page check passes 22/22.
- **⚠️ The `strip()` helper several test files use on `server.js` destroys 44%
  of the file.** A `/*` inside a string literal opens a bogus block comment
  that runs to a later `*/`, so `strip(SERVER_SRC)` returns 970k of 1.72M
  characters. Any guard built on it may pass or fail for reasons unrelated to
  the code it names — it cost one false failure in this session. This file uses
  a line-based strip instead. **The other test files that use it are untouched
  and worth a pass of their own.**

## Open for the owner

- **Volume.** Her digest is one email a day while anything is outstanding, as
  asked. For a long onboarding that is several weeks of daily email; weekly is
  one constant (`DIGEST_SEND_HOUR_ET` sits beside it) if it proves too much.
- **The 60-day window is `renewals.js`'s** and was not changed. The office
  hears at 30, 14, 7 and 1 days — say if it should start at 60.
- **A recurring duty or a due re-check reaches her but not the office**, except
  through the Monday roll-up's counts. Say if the office should hear per item.
- **Nothing emails on a determination or a service line opening.** Those are
  privileging decisions and were left out of this pass.
