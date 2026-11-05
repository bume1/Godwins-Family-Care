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
- **AN EXAM CARRIES A TIME SLOT, AND IT IS OPTIONAL.** See the second half of
  this file.
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

---

# Part two: a time slot on an exam

**Owner decision, 2026-11-04**, asked and answered in the same session: *"add a
time to the roster row."* The exam date was a date and nothing else — no time,
no calendar, no appointment — so an exam day was "these veterans, this clinic,
first come" and a clinician could not read their day in order.

## The rules, and why each one

- **⚠️ A TIME NEVER NARROWS THE SIGN-IN MATCH — the owner's own concern, raised
  before a line was written, and the thing most likely to break.** A veteran
  who arrives at 08:40 for a 09:00 exam, or an hour late, is the person we are
  expecting. Matching on the slot would turn an ordinary early arrival into
  "we don't have you down", at an iPad, with nobody standing there to ask.
  `candidatesFor` and `matchCheckin` stay keyed on the DAY; build-enforced that
  neither function may even mention the time, and a mutation that narrows the
  candidate pool by it fails the suite.
- **A SLOT IS OPTIONAL AND STAYS OPTIONAL.** Every row already on the roster has
  no time and is still a real booking, and a clinic that runs an exam day
  first-come has nothing to type. An untimed exam sorts **after** the timed ones
  — it happens "sometime today", and at the head of a timed list it reads as the
  8am appointment.
- **A TIME THAT WAS TYPED AND IS NOT A TIME IS A SLIP, NOT A BLANK**, so it is
  refused rather than dropped. A **length with no start time is refused by
  name** — storing it would show a length the day cannot place.
- **ONE PROVIDER CANNOT EXAMINE TWO VETERANS AT ONCE.** Refused at both write
  doors, **before the write** so a refused booking leaves no row behind, and
  the refusal **names the veteran already in the slot** — "that time is taken"
  without saying by whom is a refusal nobody can act on. Another provider at
  the same minute is another room and is allowed; a removed exam frees its slot;
  editing a row never clashes with itself.
- **A LENGTH IS NEVER GUESSED.** An exam with no length recorded is a **point in
  time**, not a default hour. Two untimed-length exams 30 minutes apart do not
  clash, because the app cannot know whether the first runs past the second and
  refusing a real booking on an invented number is the worse error. Two exams at
  the identical minute clash whether or not either records a length.
- **THE DAY READS IN ONE ORDER, AND IT IS A LIST OF POINTERS.** `myDay.buildAgenda`
  returns `{ kind, id, time }` and nothing else; the rows stay in `visits` and
  `ime.exams`. One copy of each, one ordering, and the page sorts nothing —
  build-enforced. That is what lets the two lines read as one day **without**
  sharing a data model.
- **ONE SLOT FORMATTER FOR BOTH SCREENS.** A 24-hour time on one screen and a
  12-hour on the other is how somebody turns up an hour out. Build-enforced that
  it exists once *and* that both the My Day row and the Veterans board call it —
  the second half was added after a mutation swapping the call for the raw
  stored value survived everything else.

## Verification (part two)

- **35 tests**, **16 of 16 mutations caught** — the sign-in match narrowed by
  the time, the day no longer sorted by time, untimed sorting first (in the
  roster and again in the agenda), the agenda carrying whole rows, a length with
  no start silently ignored, a typed non-time dropped, an impossible clock time
  accepted, a zero-length exam given an invented hour, two exams at one minute
  no longer clashing, a removed exam still holding its slot, each write door's
  clash check removed, an edit clashing with itself, the page re-sorting the
  served day, and the row bypassing the shared formatter.
- **A REAL ORDERING BUG, FOUND BY RUNNING IT RATHER THAN READING IT.** The first
  agenda used a `'~'` sentinel with `localeCompare`, on the reasoning that `~`
  sorts after digits. Under ICU collation punctuation sorts **before** them, so
  every untimed row landed at the head of the day — the exact opposite of the
  rule it was written to implement. Replaced with a plain comparison on a
  real-shaped `'99:99'` key.
- `scripts/verify_veterans.js` **54/54** over real HTTP, including the owner's
  case end to end: a veteran with an 11:00 slot signs in and the stored row goes
  to `arrived` with its slot untouched. **The response could not prove it** —
  the iPad deliberately never says whether we have you down — so the assertion
  reads the stored row, as every other assertion in that probe does.
- `scripts/verify_veterans_render.js` **30/30** in real Chromium: a 9am clinical
  visit, an 11:00 exam and a 2pm clinical visit read in that order, with the
  untimed exam last, and the same slot renders identically on both screens.
- Full suite **2921 passing, 0 failing, 1 skipped** (pre-existing).

## Deliberately NOT built

- **An IME on the Google clinical calendar.** Still open, and it waits on the
  calendar scope and the share-with-the-impersonated-account step that are
  already open on the owner's side.
- **Anything that books an IME through the clinical appointment routes.** That
  is the thing Option B rules out.
- **The dead `ime_exam` clinical appointment type**, which is still referenced
  nowhere. It belongs to the path Option B did not take; left in place and
  flagged rather than wired or removed in a scheduling change.
