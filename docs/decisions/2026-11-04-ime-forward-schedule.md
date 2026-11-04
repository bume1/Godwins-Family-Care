# The IME line keeps its own lane, and gets a forward schedule (owner, 2026-11-04)

**Owner decision:** the independent medical exam line stays **separate from clinical
scheduling and billing** — "IME payments will be billed and made to providers
different than standard claims." A vendor pays GFC for the exam and GFC pays the
examining provider; that is not a Medicare claim and must not travel through the
clinical billing path.

So IME scheduling is extended in its own lane (`veteran_roster`) rather than folded
into OpenEMR appointments. Two consequences fall out of that choice for free:

- **The enrollment gate never fires for IME.** Booking a clinical visit runs
  `enrollmentGate`, and a veteran is never "enrolled". Keeping IME out of the
  clinical booking route removes that problem rather than carving an exemption.
- **A veteran stays a roster row, not a patient record.** No client, no OpenEMR
  patient, no encounter. Unchanged from 2026-10-30.

## What was built

**A roster read is a WINDOW, and one exam day is the degenerate case.** Before this
the read was a single date (`examDate === date`), so there was no way to see a
forward schedule at all — a provider could only ask about one day at a time.

- **`veteranRoster.rosterRange(query, today)`** answers `{ from, to, capped }`.
  **No parameters still means today only**, which is what the exam-day screen asks
  for and must keep getting; `?date=` is still a single day; `?from`/`?to` open the
  window. Backward compatible by construction, and the route still returns `date`
  (equal to the window's start) so both existing screens are untouched.
- **`veteranRoster.rowsInRange(rows, range, { providerUserId })`** holds the date
  filter **and the provider scoping together, in one function, on purpose.** Those
  two split across two files is how a later caller surfaces one provider's veterans
  to another. A build guard asserts the route delegates to it and that the old
  inline filter has not come back beside it.
- **The window is capped at `RANGE_MAX_DAYS` (92) and SAYS it was capped.**
  Uncapped, a range is a way to pull the whole roster in one request. An inverted
  window (`to` before `from`) **collapses to one day rather than swapping the ends**:
  swapping would hand back a window nobody asked for and look like it worked.
- **An over-long or inverted window is clamped, never refused**, because both are
  slips in whatever asked, and a predictable single day beats an error.

**`addDays` went into the shared clock, not into this module.** The first draft of
this change wrote a second `addDays` inside `veteranRoster.js` while
`public/gfc-time.js` is the single source of the clock and is already required
server-side. That is the duplication this repo keeps paying for, so it was
consolidated before it shipped: `gfcTime.addDays` is the only copy, the browser
uses the same one, and a test fails the build if a second appears in the roster.
It is **UTC calendar arithmetic and deliberately never builds a local Date** —
"the day after the 28th" is a calendar statement, not an instant plus 24 hours,
which is the distinction that made the day-before reminders survive the November
clock change. It returns `''` for a date that does not exist (`2026-02-30`), so a
window cannot be built out of nonsense.

**The clinician view gained an Exam Day / Upcoming toggle**, not a second screen.
Same data, two lenses, one component, one row renderer.

- **Upcoming is READ-ONLY and that is the point.** Marking somebody Seen or No Show
  three weeks out is a mis-click, so the forward view carries no day-of buttons and
  each day group has an **Open day** header that carries you to the day where those
  buttons live. The shift board already made exactly this move from its calendar
  into its list; status is changed in one place.
- **Ordering is exam date first, then site, then surname** — the order a person
  reads a schedule in. Both the unit test and the render probe use fixtures whose
  surnames **fight** the dates, because a fixture where the two agree cannot tell a
  date-first sort from a surname-only one.
- **The day screen still polls every 30 seconds; the forward view does not.** The
  day board is live on an exam day; a planning view would only flicker.

## Deliberately NOT built

- **Nothing in the patient portal.** Veterans have no login, and the vendor does not
  let GFC contact them before the exam. There is no patient-facing IME surface.
- **No link to OpenEMR, the Google clinical calendar, or My Day.** Under decision B
  the lane stays separate. Merging the clinician's IME exams into My Day as a
  labelled, display-only read is the next piece and is not in this change.
- **IME exam documentation and vendor invoicing** are Track E / B7 and are untouched.

## Found and NOT fixed

`appointmentTypes.js` declares an `ime_exam` clinical appointment type
(90 minutes, in-person, `specialty: 'ime_examiner'`, `neverMedicare: true`) and
**nothing anywhere references it** — grepped `server.js`, `public/clinical.html` and
`clinicalNotes.js`, zero hits. Under decision B it is a dead declaration that *looks*
like the IME path and is not, which will mislead the next session. Left in place
rather than deleted as a drive-by; worth its own small change.

## Verified

- **`test/veteran_roster.test.js`: 21 tests, and 11 of 11 mutations each confirmed
  to turn a test red** — the default window becoming a range, the inverted window
  swapping, the cap removed, `capped` never reported, the provider scoping dropped,
  removed rows reappearing, a surname-only sort, the window ends made exclusive,
  `addDays` accepting a date that does not exist, the route re-inlining the filter,
  and the roster keeping its own `addDays`.
- **Two of those tests proved nothing on their first run and were rewritten rather
  than the catch claimed.** The ordering fixture sorted the same either way, and the
  range fixture had no row on either boundary, so a surname-only sort and exclusive
  window ends both sailed through. Both now fail when the code is broken.
- **`scripts/verify_veterans.js`: 36/36 through the real HTTP routes** (was 28/28),
  reading stored rows back — a window oldest-day-first, a provider's window carrying
  only their own veterans, no parameters still meaning today, a single named day, an
  over-long window reported as shortened, an inverted window, and a caregiver still
  refused.
- **`scripts/verify_veterans_render.js` (new): 16/16 in real Chromium at 1440px** —
  the day view with its buttons, Upcoming asking for a window and grouping it,
  the day-of buttons provably absent from the forward view, Open day returning to
  the right day with the buttons back, the nearer day beating the alphabet, and no
  page errors.
- **Full suite 2766, 0 failing** (1 skipped, pre-existing). `public/clinical.html`
  compiles; `server.js` syntax-checks.
- **An environment lesson re-bought:** the first full run reported **72 failures**,
  all of them `MODULE_NOT_FOUND` for `resend`, `express`, `pdf-lib`, `pg-mem`,
  `googleapis`, `pdfkit` and `@google/genai` in a freshly re-cloned container.
  `npm install` cleared every one. *A failing test is not evidence about the code
  until the environment has been confirmed able to run it* — confirmed by running
  it both ways rather than assumed.
