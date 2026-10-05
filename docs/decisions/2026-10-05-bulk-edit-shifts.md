# Editing a batch of shifts, and why bulk delete was already there

Owner request (2026-10-05): *"Can you add the option to bulk delete or bulk edit shifts already
released to the pool."*

---

## What was decided

- **BULK DELETE ALREADY EXISTED AND ALREADY HANDLED A POOL SHIFT CORRECTLY.** `POST
  …/shifts/bulk-remove` has shipped since PR #104, with its own selection mode on `/scheduling`,
  and `isNeverHeld` is what makes it right for the pool: a shift still open that nobody ever
  claimed is **deleted**, because that is a posting mistake, while one somebody claimed, accepted
  or worked is **cancelled** and keeps its tombstone and its reason. Forty tombstones for a
  mistake nobody saw buries the cancellations that matter. Nothing was rebuilt; a test now pins
  that behaviour from this file too, since this change touched its neighbour.

- **⚠️ A BATCH EDIT CANNOT TAKE AN ABSOLUTE START AND END, and that decides the whole shape.**
  Handing forty shifts one instant would stack all forty on the same moment — forty visits to one
  client at 9am on one Tuesday. What an office means by "these all move to 10 to 2" is a **time of
  day**, with every shift keeping its own calendar date. So the batch speaks `startTime`/`endTime`
  as `HH:MM`, exactly as the bulk POST form already does, and `start`/`end` are **refused by name**
  with the shape that works — never silently dropped.

- **THE SHIFT'S OWN DATE IS READ IN GEORGIA, NEVER IN UTC.** A 9pm Georgia shift is already
  tomorrow in UTC, so `shift.start.slice(0, 10)` would move it a day. `zonedParts` answers the
  date it is in Georgia. This is the same bug class as the availability matcher (2026-09-16), the
  calendar buckets (#104) and the payroll CSV — the fourth time, and the mutation that reinstates
  the slice fails two tests.

- **BOTH ENDS OF THE TIME OR NEITHER.** A batch holds shifts of different lengths: a 9–13 and a
  9–17 given only "start 10:00" would become 10–13 and 10–17, which is two different decisions
  from one instruction. One extra box removes the guess.

- **THE SPEC IS ALL-OR-NOTHING; THE SHIFTS ARE NOT.** A malformed licence level writes nothing at
  all, because the instruction itself is the mistake. But one shift of forty clashing with
  something its holder already has must not refuse the other thirty-nine: it is reported with the
  editor's own reason **and its hint** — "cancel the shift, or release the caregiver first" is the
  next step, and dropping it leaves somebody with a refusal and nothing to do. The rule bulk
  posting settled.

- **⚠️ ONE WRITER FOR A SHIFT'S TIME.** The route writes nothing itself: it loops `applyShiftEdit`,
  the same editor a hand-typed correction and an approved change request come through, so the
  holder's eligibility, the overlap check, the time log following the shift and the re-derived
  flags happen once in one place. Restating any of it is how the board and the timesheet start
  disagreeing about one visit. Build-enforced in both directions.

- **⚠️ SEQUENTIALLY, NEVER IN PARALLEL.** `applyShiftEdit` read-modify-writes the whole `shifts`
  blob, so concurrent calls would each read the list before the others wrote and the last would
  silently drop the rest — the reason the OpenEMR document backfill files one at a time. A
  `Promise.all` mutation fails fifteen tests.

- **ONE EMAIL PER PERSON PER CASE, NOT ONE PER SHIFT — and the three cases are never flattened.**
  Forty shifts edited one at a time would send a caregiver forty emails about one decision. But
  "4 of your shifts have moved" is an instruction about where to be: said over a batch that
  included last Tuesday it tells somebody they missed a visit, and said over an **offer** it tells
  them they are committed to work they never accepted. The single-shift editor already draws those
  three lines, so the batch groups by caregiver **and by case** — a mixed selection gets two short
  emails rather than one wrong one. `context.deferNotice` holds the per-shift email back and
  returns the facts; it changes nothing that is written.

- **THE CLIENT HEARS ONLY ABOUT UPCOMING VISITS THEY WERE PROMISED** — not a past one (false), not
  an open pool shift (never promised), not a correction to our own timesheet (nothing for them to
  do).

- **AN ABSENT KEY MEANS "LEAVE THIS ALONE".** A blank box is not sent at all, so changing the
  licence level cannot blank a note. A pay rate of `0` is a number somebody chose, so the page
  checks against empty rather than falsiness.

---

## What a later session must not undo

1. **The batch never takes `start`/`end`.** One instant stacks the whole selection on one moment.
2. **`buildBulkEditBody` reads the date with `zonedParts`.** A UTC slice moves evening shifts.
3. **The route loops `applyShiftEdit` and writes no shift itself**, sequentially.
4. **`deferNotice` gates only the notification block**, after the row, the time log and the audit
   entry are written — so a deferred notice cannot change what is stored.
5. **The three email cases stay separate.** Grouping by caregiver alone produces a wrong sentence.
6. **A refusal keeps the editor's `hint`.**

---

## How it was verified

- `test/bulk_shift_edit.test.js` — **34 tests**, and **23 mutations each confirmed to fail one**:
  the UTC slice reinstated, overnight flattened, one end of the time accepted alone, an absolute
  instant allowed, an empty spec allowed, every key copied so one field blanks another, the loop
  made parallel, `deferNotice` dropped, the cases flattened, one refusal refusing the batch, the
  spec left unchecked, the hint dropped, the client told about a past visit and about an open one,
  the manager gate removed, the cap removed, `deferNotice` moved ahead of the write, the activity
  count dropped, unchanged reported as updated, a refusal left unnamed, the page sending an
  absolute instant, a pay rate of 0 dropped by falsiness, and the two acts collapsed.
- **One of my own mutations survived and the test was fixed rather than the catch claimed.** The
  client-notice fixture's past shift was `completed`, so the status filter alone caught it and the
  test could not distinguish the two guards; it is now past **and still `confirmed`**, which is the
  ordinary state of last week's board. *A test that cannot distinguish two states proves nothing.*
- The route tests **mount the real scheduling router over HTTP** with the **real `config`** (a thin
  fake missing `config.ROLES` is a harness exercising a different function — the shape that cost
  this repo the cross-client leak, the Drive fake and `actorFromReq`) and **assert stored rows read
  back**, never a status code: three shifts each landing on their own Georgia date, the evening one
  staying on the 7th, a refused shift untouched, the time log's copy of the schedule moving while
  the geofence observation does not.
- Full suite **1984, 0 failing** (1 skipped, pre-existing). `scripts/verify_scheduling.js` **251/251**.
  The page compiles (esbuild); the app boots, `/scheduling` serves and the new route 401s
  unauthenticated.
- **Not run this pass:** the panel in a real browser. The page's behaviour rests on the compile and
  on build guards that pin the exact shapes, and a source scan cannot prove a line is reached —
  recorded rather than implied.

---

## Open for the owner

1. **Which fields a batch may change:** the times, who can take them, who can see them, and the pay
   rate on those shifts. **Notes and care tier are deliberately not on the panel** — a note is
   usually specific to one visit, and pushing one sentence onto forty shifts is more likely to
   destroy information than to save typing. The server accepts both if you want them added.
2. **The client is not emailed about a corrected past visit**, by the same rule the single-shift
   editor follows. Say if they should be; it needs its own wording.
3. **Pre-existing, flagged not fixed:** `public/scheduling.html` restates the four licence levels
   inline in three places now rather than reading a served catalog — the pattern the competency
   editor and the intake fields moved away from. This change matched the existing shape rather than
   widening scope. Collapsing all three onto one served list is a small, separate pass.
