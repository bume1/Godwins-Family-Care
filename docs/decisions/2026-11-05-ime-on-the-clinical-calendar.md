# An IME exam goes on the clinical calendar, and never on OpenEMR's

**Date:** 2026-11-05
**Owner decision:** *"the OpenEMR calendar [holds] ONLY scheduled clinical appointments, so IME appointments should not show on OpenEMR but should show on the clinical calendar… when the veteran is added to the vet board, their appointment time should be added to the calendar and My Day."*

Stacked on the provider-invite change, which it reuses.

## What this does

Adding a veteran to the Veterans board now puts their exam on the **Google
clinical calendar**, and invites the assigned provider the same PHI-free way a
clinical visit does. Moving the exam moves the event; taking the veteran off
the roster takes the event off with them.

My Day already showed the day's exams beside the clinical visits, in time
order, so the three surfaces — board, calendar, My Day — now agree.

## The rules, and why each one

- **⚠️ THE EXAM NEVER REACHES OPENEMR, and it is build-enforced.** OpenEMR's
  calendar holds clinical appointments only. An IME is billed to the
  contracting vendor and GFC then pays the examining provider, which is not a
  claim — the reason the exam line keeps its own record at all. A mutation
  that writes one to OpenEMR fails the suite.
- **THE CLINICAL CALENDAR IS INSIDE THE BAA, so the event names the veteran**,
  as a clinical visit names its patient. The provider's own copy is the same
  PHI-free invite, because their mailbox usually is not covered.
- **AN EXAM WITH NO TIME GETS NO EVENT.** The roster has always allowed an
  untimed booking and a clinic that runs first-come has nothing to enter.
  Placing one at a guessed hour would put a clinician somewhere nobody said to
  be.
- **⚠️ CLEARING A TIME TAKES THE EVENT OFF AND WITHDRAWS THE INVITATION.**
  Leaving the event would show an hour nobody is holding, and leaving the
  invite would leave the provider holding a slot that no longer exists.
  `buildInvite` refuses to make a timeless one, so without this the stale
  invitation simply sits there — found by a mutation, not by reading.
- **AN UNTIMED EXAM THAT NEVER HAD A TIME IS A NO-OP**, not a delete: the
  remove path only runs when an event actually exists for that row.
- **EXAM EVENTS ARE THEIR OWN MAP.** An exam has no OpenEMR appointment, so
  putting a roster row id in a field named `eid` would be a lie in the data a
  later reader acts on. `google_calendar_exam_events` is keyed on `examId`.
- **BEST-EFFORT, like every other Google write here.** A calendar failure
  never undoes a roster row.
- **STATUS IS NOT MIRRORED.** Seen and no-show are marked on the Veterans
  board, which is the record. The calendar answers "when is this exam", not
  "did they turn up", and a second writer of attendance is how the two start
  disagreeing.

## Verification

- **17 tests** in `test/google_calendar.test.js` (5 new), **12 of 12 mutations
  each confirmed to fail one** — an untimed exam placed at a guessed hour, a
  cleared time leaving the event or deleting another exam's, a move creating a
  second event, the veteran's name dropped, exam events sharing the visit map,
  each of the three roster writes no longer mirroring, the invite handed the
  veteran's name, **the exam written to OpenEMR**, and an untimed exam still
  inviting.
- **A GUARD OF MINE FROM EARLIER THE SAME DAY WAS REPOINTED, NOT DELETED.** It
  asserted "exactly one invite writer", which was right when only visits sent
  invites and wrong the moment exams did too. The rule it protected was *nobody
  restates what an invite is* — so it now asserts every caller goes through the
  one shared writer, `server.js` assembles no invite body of its own, and
  `buildInvite` is defined once.
- Full suite **3045 passing, 0 failing, 1 skipped**; `scripts/verify_veterans.js`
  **54/54** over real HTTP.
- `google_calendar_exam_events` registered in `dataMigration.js`.

**NOT proven from a sandbox:** that Google accepts the event. Only a real
booking against the live calendar shows that.

## Open for the owner

Nothing new beyond the invite change's own setup: exams use the **clinical**
calendar that is already configured, and the provider's invitation uses the
invite calendar that change asks for.

## Deliberately NOT built

- **Any OpenEMR write for an exam** — the thing this decision rules out.
- **Mirroring seen / no-show onto the calendar** (see above).
- **Reading Google back** — still write-only; that is the next piece.
