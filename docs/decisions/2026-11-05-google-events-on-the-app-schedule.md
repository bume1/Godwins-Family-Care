# Anything added to the clinical calendar by hand shows on the app schedule

**Date:** 2026-11-05
**Owner:** *"I want that clinical appointments scheduled in Google also show on the app schedule available to [the] clinical team to see."*

Stacked on the invite, IME-calendar and attendee changes. The last of the four
asks in the 2026-11-05 scheduling message.

## The gap

`googleCalendar.js` only ever wrote. A visit put straight into the clinical
calendar reached nobody in the app, so the schedule and the calendar could
disagree and neither side knew. The operating rule has been "book clinical
visits in the app" — true, and it does not help the person who already didn't.

## The rules, and why each one

- **⚠️ ONLY EVENTS THE APP DID NOT WRITE COME BACK.** Everything it writes is
  stamped `gfcAppointmentEid` (a visit) or `gfcExamId` (an exam), and those
  are already on the schedule from OpenEMR and the roster — returning them as
  well would show **every visit twice**. The filter reads the STAMP, never a
  title or a shape: a hand-made event called "Home visit · Someone" is
  external, because it is.
- **THESE ROWS ARE READ-ONLY, AND THE ROW ITSELF SAYS SO** (`readOnly: true`,
  `reason: 'created_in_google'`). An event made in Google has no OpenEMR
  appointment, no patient record and no encounter, so it cannot be documented,
  rescheduled or cancelled from the app. The grid draws it as a dashed grey
  band that **does not open the appointment panel** — offering a button that
  fails is worse than offering none. Build-enforced.
- **AN ALL-DAY EVENT HAS NO START TIME AND IS NOT GIVEN ONE.** Google returns
  a bare date for one; reading that as 00:00 would pin a conference to
  midnight on the grid. It is reported as `allDay` and drawn at the top.
- **A FAILED READ IS SAID, NEVER SWALLOWED.** An unreachable calendar and a
  clear one look identical on screen and are opposite facts — the rule the My
  Day calendar banner already follows. "Not configured" is not shouted about:
  the mirror is simply off, which the boot log already says.
- **"NO APPOINTMENTS THIS WEEK" IS FALSE WITH EVENTS ON THE WEEK**, so the
  empty state narrows to say the entries came from Google.
- **ONLY THE WINDOW ON SCREEN IS ASKED FOR**, and a malformed range is refused
  rather than asking Google for all of time. `singleEvents: true`, or a weekly
  huddle appears once instead of every week.
- **NO NEW PERMISSION.** The `calendar.events` scope the writes already use
  covers reading.

## Verification

- **27 tests** in `test/google_calendar.test.js` (5 new), **13 of 13 mutations
  each confirmed to fail one** — app-written events returned (every visit
  twice), the exam stamp unrecognised, an empty stamp counted as app-written,
  an all-day block given midnight, a deleted event still shown, rows not
  read-only, a failed read reported as success, recurrence not expanded, a
  nonsense range asking for everything, the schedule no longer serving them, a
  failure swallowed, a Google event made clickable into the appointment panel,
  and the empty state claiming an empty week.
- **ONE OF MY OWN GUARDS SURVIVED AND WAS REWRITTEN.** It asserted the
  narrowed sentence *existed*, which proved nothing: with the condition
  dropped, that sentence and "No appointments this week" both render. It pins
  the condition now.
- Full suite **3055 passing, 0 failing, 1 skipped**; `verify_veterans.js`
  **54/54**; the page compiles.

**NOT proven from a sandbox:** that Google returns these events. The read is
driven against a stubbed client, so what is proven is the filtering, the
shaping, the ordering and the failure path — not that the live calendar
answers. Only opening the schedule against the real calendar shows that.

## Open for the owner

- **Everything on the clinical calendar appears, not only visits** — a staff
  meeting or a block shows as a grey band too. That is deliberate: deciding
  which hand-made events are "really" appointments would mean guessing from a
  title. Say if you would rather filter them.

## Deliberately NOT built

- **Writing a Google-made event back into OpenEMR.** It has no patient, no
  provider mapping and no visit type; creating a chart appointment out of a
  calendar entry would invent all three.
- **Reading RSVPs or changes to app-written events.** Those are the app's
  record and Google is the mirror, not the source.
