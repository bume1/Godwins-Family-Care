# A clock nobody stopped is not hours worked

**Owner report, 2026-10-22:** *"something is wrong with the payroll export, it is
reflecting days incorrectly after this last update such as the 10/12 shift for
our caregiver showing as a 10/14 shift."*

**This is a defect I introduced in PR #211, merged the same day.** It is recorded
plainly because it would have overpaid a caregiver.

## The export was innocent; the data was wrong

First instinct was the date handling — PR #158 had rewritten every date cell in
`payroll.csv` onto Georgia's clock. It was checked and it is correct. A probe
drove the real route with four 10/12 shifts (morning, evening, overnight, and one
crossing midnight UTC) and every one reported **Shift Date 10/12/2026**, with the
pay period 10/12–10/25. `zonedParts` uses `'2-digit'`, so `isoDate` is padded; an
early suspicion that it was not was checked and withdrawn rather than "fixed".

The bug was in `closeOfficeEndedLog`, which PR #211 added:

```js
total_minutes: totalMinutes(log.clock_in_at, endedAt)   // endedAt = now
```

A caregiver clocks in 10/12 at 9am for a four-hour shift and never clocks out.
The shift stays `in_progress`. The office notices on 10/14 and presses **End
Visit**. The clock-out is stamped 10/14 and the hours measured to it:

| | before | after |
|---|---|---|
| Hours | **49.25** | *(blank)* |
| Gross at $22/hr | **$1,083.50** | *(blank)* |
| Clock Out | 10/14 10:15 AM | 10/14 10:15 AM |
| Shift Date | 10/12/2026 | 10/12/2026 |

That row — 10/12 Shift Date, 10/14 Clock Out — is the "10/12 shift showing as a
10/14 shift", and the real damage was the 49 hours, not the date.

## What PR #211 got wrong

Its rule 1 said **"the hours worked are a fact and they survive."** That is true
when the office ends a visit that is *actually happening* — the client has gone
to hospital and the caregiver is standing in the hall. It is **not** true when
the office is closing out a clock the caregiver left running: "now" is when an
administrator pressed a button, not when the caregiver went home. The rule was
right for the case it was written against and was never qualified for the other.

## The fix, and why a blank rather than a guess

`isStaleClock()` asks whether the clock was still running long after the visit
should have finished, measured against **the shift's own scheduled end** — which
the time log already carries its own copy of, precisely so payroll never has to
go and look it up. With no schedule, an implausibly long single clock answers the
same question.

- **Not stale** → unchanged. The hours are real and are paid.
- **Stale** → `total_minutes: null` and the row is flagged `hours_need_review`.

The total is a **blank, never a guess and never a zero**. Capping it at the
scheduled end would assert the caregiver left exactly on time, which nobody
knows; zero would assert they did not work, which is false. A blank asks payroll
a question and a number answers it — the rule the pay-rate column already
follows ("an unset rate prints EMPTY, never 0.00"), and the one `totalMinutes`
already follows for an impossible interval. The CSV's gross-pay cell already
goes blank on a null total, so no export code changed.

**The clock is still stopped either way.** That is not negotiable: clock-out
requires `status === 'in_progress'`, so leaving it open would strand the
caregiver exactly as PR #211 was written to prevent.

Two constants, one declaration each: `STALE_CLOCK_AFTER_MINUTES` (120 — two
hours over a planned end is a long visit, two days is a forgotten clock) and
`MAX_PLAUSIBLE_SHIFT_MINUTES` (16 hours).

## ⚠️ The epoch trap, for the third time in this repo

The first version of `isStaleClock` read:

```js
const end = new Date(log && log.scheduled_end).getTime();
if (isFinite(end) && isFinite(stopped)) { ... }
```

`new Date(null)` is **the epoch, and the epoch is finite**. A log with no
schedule therefore measured itself against 1970, read as stale at three hours,
and silently dropped the hours of a visit nobody did anything wrong on — the
same fix causing a different wrong number. Caught by testing the no-schedule
case, not by reading the code. Empties are now rejected before a `Date` is
constructed.

This repo has recorded that trap twice before (the re-derived flags in PR #104;
the Eastern formatter printing "12/31/1969"). Third time. The comment in
`isStaleClock` names it so a later simplification does not reopen it.

## Verified

- 7 new tests in `test/end_visit_in_progress.test.js` (25 in the file).
- **8 mutations, 8 caught**: the original bug restored, the flag dropped, the
  epoch trap reopened, the grace removed, the window widened to never fire, the
  no-schedule fallback removed, the flag undeclared, staleness never detected.
- `scripts/verify_end_visit.js` **60/60** (new section G drives the stale case
  through the real cancel route and reads the stored log back).
- Full suite **2661, 0 failing**; `verify_scheduling.js` 251/251; board render
  probe 24/24.
- The payroll CSV itself was rendered before and after through the real route;
  the table above is read off that output, not predicted.

## What was NOT changed

The payroll export's own date logic, which was checked and found correct. The
`Shift Date` column still derives from `clock_in_at` — right for every case seen
here, and changing it would widen a payroll fix on no evidence.

## Open for the owner

- **Was your box actually running #211?** It merged minutes before the report and
  needs a container rebuild to go live. If it was not, this fix is still correct
  and still needed, but something else produced what you saw — send the CSV row.
- **Who works the `hours_need_review` rows?** A blank total is deliberate and
  needs a person to settle the hours with the caregiver. That is the same
  unanswered ownership question as the overdue-orders list.
