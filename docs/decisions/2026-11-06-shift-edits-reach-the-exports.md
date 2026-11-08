# A shift corrected after it started or concluded now reaches the payroll and billing exports

**Owner report, 2026-11-06.** Changes management makes to a caregiver's shift
time were not carrying across to the payroll sheet, and a caregiver had been
overpaid. The follow-up narrowed it: *"changes to shifts worked AFTER they have
started or have concluded [must] match with payroll and billing exports. Right
now those sheets dont match."*

## What was actually true

Established by driving the real export routes before anything was changed, not
by reading them. Three defects, and **all three are the same shape: the
correction IS recorded on the time log and NEITHER export read it.**

1. **The correction stamp was written and never read.** `applyShiftEdit` does
   move the time log's `scheduled_start`/`scheduled_end` and does stamp
   `schedule_corrected_at` and `schedule_corrected_by_name`. No export read
   either stamp, so a visit whose schedule had been corrected read exactly like
   one that never was.
2. **Nothing said when the pay and the schedule disagreed.** Hours come from the
   clock, never the schedule — that rule is right, you pay for time worked — but
   a shift corrected on the board and not on the clock went on paying the old
   figure in silence. That is the overpayment shape, and it is invisible.
   Worse: re-deriving the flags **removes** `late_clock_out`, so correcting the
   schedule deleted the one visible hint that the clock had run past the shift.
3. **A visit that happened and was never clocked into was in NEITHER sheet.**
   Both exports are built from `time_logs`, so a shift the board calls
   `completed` with no log at all produced no row anywhere: the caregiver
   unpaid, the client unbilled, and nothing on either sheet to say a visit was
   missing. Billing additionally dropped any **completed** visit whose log had
   no clock-out, so a caregiver forgetting to clock out left the client
   unbilled in silence.

A reproduction of all three is in the commit's test file; each was confirmed
against the real routes before a line changed.

## What changed

**Nothing about what is PAID. The clock still decides the money.** The change
makes the disagreement visible and closes the hole.

- **`Scheduled Hours` and `Hours vs Schedule`** on both sheets. The second
  answers in words a payroll run can act on — `match`, `over by 2.88 h`,
  `under by 1.00 h`, `no hours recorded`, or empty when there is no schedule to
  compare against. The grace is the lateness flags' own, so a row reading
  `match` is a row that earned no lateness flag either; two different answers to
  one question is how a sheet stops being trusted.
- **`Schedule Corrected` and `Corrected By`** on payroll, `Schedule Corrected`
  on billing — the stamps that already existed and nothing read.
- **A visit with no time log is a ROW**, on both sheets, dated by the shift's
  own Georgia date, carrying the scheduled hours so the size of the gap is
  visible and **no actual hours at all**, because nothing was recorded and a
  number there would be an invention. `Source` reads `No time recorded` and the
  row carries a `no_time_log` flag.
- **A completed visit with no clock-out is listed on billing** with its
  Billable Hours cell **empty**. The original rule — a half-open visit must
  never carry a number onto an invoice — stands; the protection was never the
  missing row. A visit still **in progress** is still not listed: it has not
  failed to produce hours yet.
- **A caregiver's own hours file gains `Scheduled Hours` and their own
  unrecorded visits**, because a caregiver finding their own unpaid work is the
  cheapest control there is. Deliberately **not** the `Hours vs Schedule`
  column: "under by 0.50 h" on somebody's personal record reads as an
  accusation, and that file exists for their files, not for a dispute.

## Decisions a later session must not undo

- **A ROW IS DATED BY WHEN THE WORK WAS DONE, NEVER BY A CORRECTED SCHEDULE.**
  Moving a concluded shift onto a different calendar day does **not** re-file
  its row: re-bucketing would move real hours into the wrong pay period. The
  row keeps the day it was worked and is **flagged `schedule_date_moved`**
  instead, because either the date edit was wrong or the clock was, and both
  want a person to look rather than a silent move.
- **A GAP ROW INVENTS NOTHING.** `pseudoLog` is the one place such a row is
  built, shared by all three exports, and it sets `total_minutes: null`. Giving
  it the scheduled length would put hours nobody worked onto a payslip and an
  invoice.
- **`scheduledMinutes` REJECTS EMPTIES BEFORE CONSTRUCTING A DATE.** ⚠️ `new
  Date(null)` is the epoch and the epoch is finite, so the repo's own
  `totalMinutes(null, null)` answers **0**, not null. A scheduled window read as
  "0 hours" would report every log with no schedule as an overpayment of its
  entire length. **Fourth occurrence of that trap in this repo** (the
  availability matcher, the shift-edit flag re-derivation, the stale-clock
  check, now here). A control assertion pins `totalMinutes(null, null) === 0`,
  so the guard is load-bearing rather than decorative.
- **THE SCREEN RENDERS WHATEVER COLUMNS THE SERVER SENDS.** `PayView` reads
  `data.columns`, so these columns reached the manager's on-screen view with no
  page change. Pinned, so a later edit cannot hardcode a column list and quietly
  drop the correction columns from the screen.
- **EVERY EXPORT ROW CARRIES ITS OWN `rowKey`.** A gap row has no time log, so
  `timeLogId` is null on it, and the screen keyed its table rows on that. Found
  by reading what the page does with these rows. **Stated at the limit of the
  evidence:** reverting the page to `key={r.timeLogId}` raised no React warning
  at all — React treats a null key as absent and falls back to the index — so no
  visible defect was reproduced in this static table. Keying on a stable id is
  still correct (the index fallback reuses DOM and state across reorders); the
  fix stands, the claim does not go further.

## Two existing guards were REPOINTED, not deleted — and both got stricter

- `test/scheduling.test.js`'s billing guard asserted `!l.clock_out_at → return
  false`, which is the behaviour that dropped a completed visit with missing
  hours. It now asserts the replacement rule **and** that `concluded` means
  exactly `completed`, **anchored on the whole return statement**: a mutation
  widening it to `|| 'in_progress'` still contained the old substring, so the
  looser assertion could not tell a half-open visit being kept off an invoice
  from one being put on it. Its bare `/verification/` check was likewise
  satisfied by a hardcoded `verification: 'inside'`; it now pins the read of the
  stored verdict and forbids asserting one that was never observed.
- `test/time_formats_and_visit_notes.test.js` pinned the filter as
  `csvLocalDate(l.clock_in_at)`. The filter now goes through `exportRowDate`,
  which is the clock's Georgia date falling back to the schedule. The UTC-slice
  protection the guard exists for is re-asserted on `exportRowDate` itself, one
  level up.

## Verified

- **17 new tests** in `test/export_shift_edits.test.js`, **mostly driven
  through the shipped Express router over real HTTP**, reading the sheets back.
  The pure helpers alone cannot prove a column is *populated* — a helper that
  answers correctly and a builder that never calls it look identical to them,
  which is exactly the defect being fixed.
- **42 mutations, every one confirmed to fail a test.** Among them: the epoch
  guard removed, the grace zeroed, the direction dropped from `over`/`under`,
  the schedule fallback removed from the row date, the schedule preferred over
  the clock, each new column removed from each sheet, the correction stamp
  unread, the scheduled window unread, the moved-day flag dropped, each sheet's
  gap rows removed, billing back to requiring a clock-out, billing listing
  in-progress visits as gaps, cancelled shifts treated as owing hours, a gap row
  inventing hours, a gap row reporting the shift's licence requirement instead
  of the holder's, the row key dropped, and the screen hardcoding its columns.
  Plus **12 more against the two repointed guards**, each confirmed to still
  catch the bug it was originally written for.
- **Three of my own tests proved nothing on their first run and were rewritten
  rather than counted as catches.** (1) The caregiver-copy test asserted only
  the CSV *header*, which comes from the column definition — dropping the
  populated cell left it green; it reads the cell now. (2) The in-progress test
  seeded a shift that *has* a log, so widening billing's gap statuses changed
  nothing it could see; a second case covers it. (3) A probe assertion on
  React's duplicate-key warning could not fail at all, and was replaced with one
  that can. *An assertion that cannot distinguish two states proves nothing* —
  seventh, eighth and ninth occurrences in this repo.
- **Rendered in Chromium**: `scripts/verify_scheduling_board_render.js` runs
  **46/46**, with a new section J that plays the manager who reads these sheets
  on screen and asserts the corrected figures, the gap rows and the stamps are
  actually drawn. Its own first run rendered nothing, because the on-screen
  views belong to a manager and the fixture was an admin, who downloads files
  instead — *a fixture that seeds the wrong world reports on a world that is not
  production.*
- Full suite **3245, 0 failing** (1 skipped, pre-existing). `test/pages_compile`
  had been failing on `main` for a missing sandbox dependency
  (`@babel/standalone`), not for any code reason — confirmed by running it
  against `main` and then installing the dependency, after which it passes.

## Open for the owner

1. **THE CODE FIX DOES NOT REPAIR A PAYMENT ALREADY MADE.** Re-run the payroll
   export for the affected pay periods and look at the new **Hours vs Schedule**
   column: any row reading `over by …` is one where the hours paid exceed the
   corrected schedule, and `Corrected By` names who changed it. Those are the
   rows to check against what was actually paid.
2. **Rows reading `no hours recorded` are visits nobody was paid for and no
   client was billed for.** They were invisible before this change, so there may
   be a backlog. Each needs either a manual hours entry or a decision that the
   visit did not happen.
3. **`schedule_date_moved` in the Flags column** means a shift was corrected
   onto a different day than it was clocked on. Either the date edit or the
   clock is wrong; the row stays on the day it was worked until somebody decides
   which.
4. **None of this is live until the container is rebuilt** on the EC2 box.
   `git pull` alone changes nothing.

## Flagged, not fixed — out of scope here

- `public/scheduling.html` puts the session token in the URL
  (`?token=`) for both CSV downloads. That is the pattern PR #103 removed from
  the enrollment page, for PHI-adjacent documents: a URL lands in browser
  history and access logs. Pre-existing, and a separate change.
- `public/scheduling.html` restates the four licence levels inline in three
  places rather than reading the served catalog.
