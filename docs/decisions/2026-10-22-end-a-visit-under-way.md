# The office ends — or adjusts — a visit that is under way

**Owner request, 2026-10-22:** *"give admin and manager the option of deleting
shifts or adjusting shifts that are in progress for caregivers."*

## What was actually missing

The ask splits into two halves, and only one of them was broken. Established by
running the real routes, not by reading them.

- **Adjusting an in-progress shift already worked.** `EDITABLE_SHIFT_STATUSES`
  has carried `in_progress` since PR #104, the board's Edit Shift button renders
  for every status but `cancelled`, and a probe confirmed `200` with the time log
  following the corrected schedule and the caregiver notified. Nothing needed
  building; it is now pinned so it cannot be lost.
- **Removing one was refused.** `409 SHIFT_IN_PROGRESS` on the single cancel
  route and on bulk-remove, and the board rendered **no cancel control at all**
  for an in-progress shift (the gate read
  `['open','claimed','assigned','confirmed']`). That is the half that was missing.

## ⚠️ Stopping the clock is the whole correctness of it

Allowing `in_progress → cancelled` **on its own would have been worse than the
refusal**. Clock-out requires `status === 'in_progress'`, so cancelling the shift
without closing its open time log leaves the caregiver:

- clocked in on a cancelled shift with **no way out** — their own clock-out
  refuses for ever;
- holding an open log that never gets a `total_minutes`;
- and therefore **unpaid for hours they actually worked**.

So the cancel and the clock-out are **one act**, through one writer. Care that was
given gets paid whatever the paperwork says — the same rule that keeps clock-in
and clock-out outside every gate in this system.

## The rules, and what each one costs if dropped

1. **One writer.** `schedulingRepository.closeOfficeEndedLog()` decides what a
   closed office-ended log looks like; `endOfficeVisit()` in
   `routes/scheduling.js` is the only caller, and both doors — the single cancel
   and bulk-remove — go through it. Two copies of this rule is how one door
   starts losing hours the other keeps. Build-enforced per route.
2. **The hours survive.** `clock_in_at` is never touched and `total_minutes` is
   computed to the moment the office ended it.
3. **No `early_clock_out`.** The caregiver did not leave early; somebody at the
   office stopped their clock. Awarding it is a mark on their record they did not
   earn. **`rederiveScheduleFlags` is guarded too** — a later schedule correction
   re-derives these flags and is exactly when the mark would quietly come back.
   A genuine early clock-out still earns it (pinned by a control assertion).
4. **It is never mistaken for a caregiver's own clock-out.** `ended_by_office`
   plus who, when and why ride on the row, because payroll and supervision read
   this row and "the caregiver went home" and "the office called the visit off"
   are different facts about who decided.
5. **No clock-out location is invented.** Nobody was standing anywhere when an
   administrator pressed a button, so `clock_out_gps` is null and the geofence
   verdict is `unverifiable` with its reason.
6. **The visit-log gate does NOT apply to the office.** A caregiver cannot clock
   out until they have documented the visit; the office is never blocked by
   documentation somebody else may never file — the client has gone to hospital
   and the shift has to come off the board now. The undocumented visit does not
   vanish quietly either: it is flagged `no_visit_log` for supervision.
   Build-enforced that `VISIT_LOG_REQUIRED` stays in exactly one place.
7. **A visit under way is never hard-deleted.** `isNeverHeld` requires `open`, so
   an in-progress shift always cancels with a tombstone, reason and caregiver
   intact. Bulk-remove's two outcomes stay distinct: a never-held pool shift is
   still deleted, a worked one is still cancelled.
8. **The caregiver is told at once, and told their hours are kept.** They are
   standing in the client's home with their clock stopped from under them, and
   the hours are the first thing anybody worries about. The notice also says they
   do not need to clock out themselves — otherwise they stand there trying to
   clock out of a cancelled shift. It gets its **own** message rather than the
   grouped "N shifts cancelled" email, which says a different thing.

## On the screen

It is **End Visit**, not Cancel Shift. "Cancel Shift" reads as taking a future
visit off the board, which is a different decision from sending somebody home
mid-visit. The row says plainly what happens: *"Danielle Carter is clocked in.
Ending the visit clocks them out now, keeps the hours they have worked, and tells
them."* A reason is required, as it is for any cancel.

## What did not widen

- A **completed** shift is still refused, with its own `SHIFT_COMPLETED` wording.
- A **caregiver** cannot end their own visit this way (`requireScheduleManager`);
  they clock out, which still requires the visit log.
- A reason is still required, and a refused cancel leaves the clock running.
- An in-progress shift still cannot go backwards to open, claimed, assigned or
  confirmed.

## One existing guard repointed, not deleted

`test/scheduling.test.js` asserted `SHIFT_TRANSITIONS.in_progress === ['completed']`
— "an in-progress shift can only be completed", which is the rule the owner asked
to change. What it was really protecting survives: work cannot start from an
unconfirmed shift, and an in-progress shift never goes backwards. It now pins
exactly two ways out and no more.

## Verified

- `test/end_visit_in_progress.test.js` — 18 tests.
- **27 mutations, 27 caught.** The transition removed, the old refusal sentence
  restored, the clock never stopped, the hours lost, `early_clock_out` kept, the
  `ended_by_office` flag and its provenance dropped, `no_visit_log` always/never,
  a location invented, flags not deduped, the re-derive guard neutralised,
  `isNeverHeld`'s guard chain removed, the flags undeclared, either door ceasing
  to close the clock, the status peeked after the transition, the office writer
  refusing like the caregiver gate, the cancel opened to caregivers, the notifier
  removed or losing either sentence, the office-ended visit also getting the
  grouped email, and all three UI assertions.
  - **One mutation first came back as a HARNESS ERROR and one survived, and
    both are recorded rather than claimed.** `isNeverHeld` guards this in three
    redundant layers, so mutating any single one changes no behaviour. Each layer
    is now pinned on its own, with a control assertion that a genuinely untouched
    pool shift *is* deletable — otherwise the set would pass for a function that
    always says false.
  - **One guard of mine was wrong and was rewritten rather than loosened.** It
    anchored the shared-writer check on `\n await endOfficeVisit(` to prove the
    call was unconditional — but both call sites are *legitimately* guarded by
    `wasInProgress`, so there was nothing unconditional to anchor on. A source
    scan cannot prove a call is reached; the probe does that. The guard now
    asserts per route, so losing the call from one door is not covered by the
    other still having it.
- `scripts/verify_end_visit.js` — **53/53** through the real Express router over
  real HTTP, asserting stored values read back. Includes the stranded-caregiver
  case end to end: after the office ends the visit, the caregiver's own clock-out
  refuses, and that is harmless *only* because their log is already closed.
- `scripts/verify_scheduling_board_render.js` — extended to **24/24**, the real
  page in Chromium: End Visit present, Cancel Shift absent, Edit Shift still
  there, the warning sentence, the reason gate, and the request it posts.
- Full suite **2654, 0 failing** (1 skipped, pre-existing).
  `scripts/verify_scheduling.js` **251/251**. The page compiles.

## Not proven from the sandbox

Nothing here touches OpenEMR, Drive or email delivery. The notification is proven
as far as the queue accepts it; whether Google delivers it is
`scripts/verify_email_transport.js` on the deployment, unchanged.

## Open for the owner

- A visit the office ended with no visit log filed carries `no_visit_log`. That
  is a supervision item — **whose job it is to chase those is the same open
  question as the overdue orders list**, and nothing here answers it.
- Hours on an office-ended visit are kept in full, to the minute the office
  pressed the button. Say if a visit called off within the first few minutes
  should instead record zero.
