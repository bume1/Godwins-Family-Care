# My Day shows the day's IME exams beside the clinical visits

**Date:** 2026-11-04
**Owner decision:** Option B, 2026-11-04 — *"IME payments will be billed and made to providers different than standard claims."*

## The gap

The app had **two scheduling systems that had never met**. OpenEMR appointments
feed My Day, the clinician schedule, the patient portal's published copies,
Google Calendar, the day-before reminders and documentation. `veteran_roster` —
the IME exam line — was none of that: it had no link to a client or an OpenEMR
patient, it was on no calendar, and it appeared on no clinician's day. A
provider with three veterans booked for Thursday opened My Day on Thursday and
saw nothing about them.

## What was built

My Day now carries that day's IME exams **beside** the clinical visits,
labelled, grouped by site, with each veteran's status — and a link to the
Veterans board, which is where a status is marked.

## The rules, and why each one

- **⚠️ THE TWO LINES SHARE NO DATA MODEL. This is a join at the READ layer and
  nowhere else.** An IME is billed to the contracting vendor and GFC then pays
  the examining provider; that is not a claim, so the exam line keeps its own
  record. Nothing was moved into the clinical appointment model, nothing was
  booked through the clinical routes, and the enrollment gate — which a veteran
  could never satisfy, because a veteran is never *enrolled* — is never reached.
  Option B removes that problem rather than carving an exemption into it.
- **AN EXAM NEVER REACHES A CLINICAL FIGURE, and it is build-enforced.** Not
  `totals.visits`, not the mileage, not the plot, not the route proposal. A
  veteran has no coordinates, so an exam inside `visits` would be an unplaceable
  stop — which makes an accurate mileage total **report itself as partial** —
  and the route proposal would try to drive to somebody with no address. The
  exam counts live under `ime.totals` with their own names, so the two lines
  cannot start being added together.
- **AN EXAM HAS A DATE AND A SITE AND NO TIME OF DAY**, because the roster has
  no time field. They are therefore grouped by site rather than slotted into
  the timed list, which would invent a time nobody recorded.
- **READ ONLY.** Status is marked on the Veterans board and nowhere else, or
  this screen becomes a second writer of it — the mistake `applyShiftEdit` was
  extracted to stop on the scheduling side. The block carries no Mark Seen and
  no No Show; it carries **Open Board**, which goes to the one place that does.
- **WHO MAY SEE WHICH VETERAN IS ASKED OF `veteranRoster`, NOT RESTATED.** The
  office sees the whole exam day; anybody else sees only exams assigned to them,
  so a read-only case manager's My Day carries none. One rule for the Veterans
  board and this screen, or the two disagree. Widening it later is one edit to
  `vetRoster.isOffice` and both screens follow.
- **MY DAY'S EXAM ROW CARRIES NO DATE OF BIRTH AND NO ARRIVAL CONTACT DETAILS.**
  `examDayRow` is an allow-list, not a filtered copy of `publicRow`: the DOB is
  the identity-matching data the sign-in screen compares against, and the phone
  and email a veteran typed at the iPad are for whoever rings them back. A
  clinician reading their day needs none of the three, so they are **not put on
  the wire and then hidden**.
- **ONE SCOPE FILTER, NOT TWO.** `rowsInRange` gained `providerUserIds` — the
  same question asked of several ids, which is what My Day needs because an
  OpenEMR provider id can stand for more than one app user. It normalizes into
  the existing filter rather than adding a second. **An empty array means
  NOBODY, never everybody**, because the tempting bug is a narrowed scope
  falling through to the whole roster.
- **"No visits scheduled for this day" would be false on a day carrying exams**,
  so the sentence narrows to "No clinical visits scheduled for this day."

## Verification

- **28 tests** in `test/veteran_roster.test.js` (8 new), **15 of 15 mutations
  each confirmed to fail one** — the empty scope falling through to everybody,
  the scope ignored, id types unfolded, the DOB and the arrival phone back on
  the wire, the site grouping collapsed, a status counted on the wrong key,
  exams pushed into `visits`, an exam count in the clinical totals, the route
  using `publicRow`, the roster scoping rule dropped, the block nested inside
  `MyDayView`, the empty-day sentence un-narrowed, the block never rendered,
  and the block given a status write.
- **TWO OF MY OWN TESTS SURVIVED THE FIRST MUTATION RUN AND WERE REWRITTEN
  RATHER THAN THE CATCHES CLAIMED.** The id-folding test passed strings on both
  sides, so folding or not folding produced the same answer — only a mismatched
  pair can tell them apart. And the grouping test had all four exams at one
  site, so collapsing the groups into one flat list was indistinguishable from
  grouping them. *An assertion that cannot distinguish two states proves
  nothing*, pointed at my own tests for the second session running.
- `scripts/verify_veterans.js` **43/43** over real HTTP (7 new), reading stored
  rows back. Its My Day section **seeds its own rows** rather than reading what
  earlier sections left behind — the first draft assumed leftover state and
  reported a failure that was the fixture.
- `scripts/verify_veterans_render.js` **26/26** in real Chromium at 1440px (10
  new), with the `ime` block built by the **real** `veteranRoster` and `myDay`
  modules the way the route builds it. It proves the day-of buttons are
  *absent* and that Open Board reaches the board where they are.
  `GFC_PROBE_SHOT=<dir>` writes the rendered screen out for a human to look at.
- Full suite **2914 passing, 0 failing, 1 skipped** (pre-existing). The page
  compiles.

## Deliberately NOT built

- **An IME on a calendar, or with a time of day.** The roster is a day list —
  "these veterans, this day, this clinic". Whether an exam should get a real
  time slot, and whether it should appear on the Google clinical calendar, is
  an owner decision and is open.
- **Anything that books an IME through the clinical appointment routes.** That
  is the thing Option B rules out.
- **The dead `ime_exam` clinical appointment type**, which is still referenced
  nowhere. It belongs to the path Option B did not take; left in place and
  flagged rather than wired or removed in a scheduling change.
