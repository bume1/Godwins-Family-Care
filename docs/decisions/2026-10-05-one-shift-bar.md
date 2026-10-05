# One bar on the shift board: a range selector, status filters, edit and remove

**Date:** 2026-10-05
**Owner-directed.** Follows the bulk-edit build (PR #159) and replaces its UI.

## What was reported

> "fix this scheduling issue it does not suffice. what is this? There is no
> multiselector and instead of a separate ui for edit shift together or delete
> or whatever, just add the multiselect and delete to the same group time entry
> bar. Ie one button or check box that selects all shifts between x and y date
> range to edit in bulk or delete in bulk. Additionally we should be able to
> filter out those completed, confirmed and pending."

Three separate faults, and the first is the one that made the feature useless:

1. **Ticking forty rows by hand is not a multiselect.** There was no way to take
   a date range in one action — the thing somebody actually wants when they are
   moving a month of shifts.
2. **A mode switch with nothing behind it.** "Select shifts" opened a bar whose
   only job was to ask whether you meant *Edit together* or *Take off the board*,
   and then show one of two panels. Two clicks before any work could start, to
   answer a question the forms themselves already answer.
3. **No status filter at all**, so the board was every shift ever posted,
   completed and cancelled ones included.

## What it is now

**One card.** Date range → status filters → select-all → the edit boxes →
Update → Remove with its reason. Nothing is behind a mode and nothing is behind
a second click.

- **THE FILTER IS THE SELECTOR.** `Shifts from` / `Shifts to` plus the seven
  status toggles narrow the board; **Select all N shown** then takes exactly
  what is left. "Every confirmed shift in October" is a range, two toggles and
  one tick. That is the owner's "one checkbox that selects all shifts between x
  and y".
- **The range buckets by the day it is in GEORGIA** (`easternDayKey`), never by
  a UTC slice off the stored instant. An 8pm Tuesday shift is Wednesday in UTC,
  so a slice would file the evening shifts under the wrong day and drop them out
  of a range that should hold them. Same trap `isSameDay` was fixed for on
  2026-09-16.
- **THE BOARD'S RANGE IS NOT THE PAYROLL RANGE.** `boardFrom`/`boardTo` are
  their own state. `from`/`to` drive the time-log fetch and the payroll and
  billing exports, so reusing them would mean narrowing the board quietly
  changed what a payroll run covers. Build-enforced in both directions: the
  board filter may not read `from`/`to`, and the payroll export must still read
  its own.
- **NOTHING THE FILTER HAS HIDDEN CAN BE ACTED ON.** `actOn` is the selection
  intersected with what is on screen, and both handlers post that, never the raw
  selection. A tick survives the filter being narrowed and comes back when it is
  widened, so no work is lost — but a shift nobody can see is never edited or
  taken off the board, which is the whole hazard of a selection outliving its
  filter. The bar says so in words when it is holding ticks it will not act on.
- **The status filter names the state machine's own statuses**, not a friendlier
  grouping. The chip on every row already shows these words; a filter labelled
  "Pending" that silently means two of them is a filter nobody can reconcile
  with what they are looking at.
- **Tick boxes are permanent on the list.** There is no "Select shifts" step.
- **The calendar still opens a shift on click** and still shades a selected one
  (`.picked`), so select-all is visible there too. Individual ticking is a list
  act, because a checkbox cannot be nested inside the button a calendar chip is.

## The two acts are still told apart — by what each asks for, not by a mode

Removing keeps its own red button and its own **required reason**; it will not
fire without one. The line above it still says what removal means: a shift
somebody claimed, accepted or worked is **cancelled** and keeps its tombstone,
while an open shift nobody ever held is **removed outright**, because that is a
posting mistake rather than care that was called off.

The guard that used to assert the mode switch was **repointed, not deleted**.
The rule it protected (these are two different acts and must be distinguishable)
is unchanged; what changed is how, and the guard now reads that instead.

## Server

**Nothing changed.** `POST …/shifts/bulk-edit` and `POST …/shifts/bulk-remove`
already take a list of shift ids; the range and the filters are how the browser
decides what goes in that list. `applyShiftEdit` is still the one writer for a
shift's time.

## Verification

- **`scripts/verify_scheduling_board_render.js` — NEW, 14 assertions, run in a
  real Chromium against the real page** with the API stubbed. Compiling the JSX
  proves none of this: that a tick box exists without a mode, that select-all
  takes what the filter left, that the status toggles narrow the board, that the
  time boxes and the Remove button are in the one card — and, the one that
  matters, **that a shift ticked and then filtered out is absent from the POST
  body**, read off the request the page actually sent.
- **6 of 6 mutations caught** on that probe (the visibility scoping dropped, the
  status filter dropped, the range dropped, select-all removed, tick boxes put
  back behind a mode, Remove moved out of the card).
- **3 guards in `test/bulk_shift_edit.test.js`** — one repointed, two new — and
  **8 of 8 mutations caught** (the mode switch restored, the required reason
  dropped, the range reading a UTC slice, the board borrowing the payroll range,
  either handler posting the raw selection, `actOn` no longer intersecting,
  select-all no longer following the board).
- Full suite **2012, 0 failing** (1 pre-existing skip); `verify_scheduling.js`
  **251/251**; the page compiles.

**The probe's own first run found a real fault in its fixture, not in the page:**
the stubbed `/caregivers` response had no `clients`, and the tab strip counts the
clients with no coordinates — so the page threw before it rendered. *A fake
missing what production supplies exercises a different function.*

## Not done, and deliberately

- Ticking an individual shift inside the calendar grid. The chip is a `<button>`
  and a checkbox cannot be nested in one; rebuilding it as a div would put the
  calendar's whole layout at risk for an action the list already carries.
- Any change to what the server accepts.
