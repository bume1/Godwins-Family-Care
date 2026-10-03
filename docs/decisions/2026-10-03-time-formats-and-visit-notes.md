# Eastern clock on the exports and the rota, and a visit note you can read and keep

Owner request (2026-10-03): *"Okay fix 1 to 3 you posed above. Then I need you to fix the formatting
for our billing and payroll spreadsheets. And for the scheduling app. It is in military time and idk
what the time format is for the spreadsheets."*

"1 to 3" is the standing visit-notes offer: render the full visit log on `/caregivers`, add a
download for a visit note, and decide whether managers get read access on the supervision routes.

---

## What was decided

- **THE SPREADSHEETS WERE NOT "ODDLY FORMATTED". THEY CARRIED RAW UTC INSTANTS.** Every time cell in
  the payroll, client-billing and caregiver-hours CSVs was the stored ISO string
  (`2026-10-04T01:00:00.000Z`), which is both unreadable and four or five hours wrong for a Georgia
  reader. They now read `10/3/2026` and `9:00 PM` through `public/gfc-time.js`, the one clock this
  app has. **A clock-out that lands on the next day carries its date** (`10/4 2:00 AM`), because an
  overnight shift's bare `2:00 AM` beside a 9 PM start reads as fifteen hours of nothing.

- **⚠️ A LIVE BUG UNDERNEATH IT: THE ROW'S DATE, THE DATE FILTER AND THE PAY PERIOD WERE ALL THE UTC
  DATE.** All three were `iso.slice(0, 10)`. A 9 PM Georgia shift is already **tomorrow** in UTC, so
  it filed under the wrong day, could fall outside a payroll date range the office had typed
  correctly, and — because `payPeriodFor` reads that same value — **could be paid in the wrong
  period**. `sched.csvLocalDate()` answers Georgia's date. This is the availability-matcher bug of
  2026-09-16 and the calendar-bucketing bug of PR #104 in a third place: *a UTC date is not a local
  date, and money is where it costs most.*

- **`fmtClock` IS A PURE STRING CONVERSION AND DELIBERATELY NEVER BUILDS A `Date`.** An availability
  window is `HH:MM` with **no date and no zone** — "Tue 18:00–23:00" means those hours on any
  Tuesday. Running it through `Date` invents a date and a zone the value does not have and then
  renders whatever that invention happened to mean. A stored instant goes through `fmtTime`; a typed
  wall-clock string goes through `fmtClock`; **the two are not interchangeable** and the module
  comment says so. A value that is not `HH:MM` is shown as-is rather than reformatted into a guess.

- **THREE RENDERS WERE OURS AND ARE FIXED; THE `<input type="time">` WIDGET IS NOT OURS.** The
  shift-request row and the availability line on `/scheduling`, and the availability line in the
  caregiver's own schedule component, printed our own `HH:MM` verbatim. The **picker's** 12- or
  24-hour display is decided by the browser and the operating system's locale and **cannot be set
  from this app**; the `value` attribute is required by the HTML spec to be `HH:MM` and was left
  exactly as it is. Changing it would break the control.

- **A MANAGER READS THE SUPERVISION QUEUE AND MAY ADD A REVIEW NOTE (owner item 3, answered).**
  `isReviewStaff` now admits `isManager`, grounded in `isScheduleManager`: a manager already posts,
  edits, assigns, approves and cancels shifts, and the three things that stay admin's alone on the
  board — the money, the client record, the compliance overrides — are not on this surface at all.
  **The two inline restatements of that predicate now call it**, so the grant could not reach one
  door and miss two; the repo's own comment had claimed they branched through it and nothing
  enforced that.

- **THE VISIT LOG RENDERS IN FULL, AND THE IDS ARE RESOLVED ON THE SERVER.** `describeVisitLog`
  turns stored task ids into labelled sections against the existing catalogs, so the page names no
  task of its own. A task marked not-done that carries a note is **kept** (that note is the reason);
  one with neither is dropped. A blank measurement is dropped rather than printed empty, and an id
  the catalog does not carry is left out rather than guessed at.

- **A VISIT NOTE DOWNLOADS AS A PDF, AND IT CARRIES NO MONEY AND NO SURVEILLANCE.** No pay rate, no
  gross pay, no geofence verdict and no distance: it is the clinical and care record of a visit, and
  it is routinely handed to people for whom what we pay a caregiver and where their phone was are
  neither relevant nor theirs. Review notes are appended, since a note that was reviewed and a note
  that was not are different documents. **The token goes in the Authorization header, never the
  URL** (the PR #103 rule), the browser gets a blob rather than a tab (mobile Safari blocks
  `window.open` after an `await`), and the filename is read back off the response so RFC 6266 is not
  undone from this end.

- **A CAREGIVER ASKING FOR SOMEONE ELSE'S NOTE GETS 404, NOT 403.** A 403 confirms the row exists.

---

## What a later session must not undo

1. **`fmtClock` must not start parsing dates.** A wall-clock string has no date and no zone.
2. **`csvLocalDate` is the date filter and the pay period, not just a column.** Replacing it with
   `.slice(0, 10)` silently moves evening shifts into the wrong pay period.
3. **The `<input type="time">` `value` stays `HH:MM`.** It is the spec's wire format, not a display
   choice.
4. **`isReviewStaff` is called, never restated.** Three doors, one predicate.
5. **The visit-note PDF carries no pay, no gross and no geofence.** It leaves the building.
6. **The download sends its token in the header.** Not in the query string.

---

## How it was verified

- `test/time_formats_and_visit_notes.test.js` — **26 tests**, and **25 mutations each confirmed to
  fail one**: `fmtClock` building a `Date`, midnight rendering as 0:00 and noon as 12:00 AM, a
  malformed value reformatted, the three CSV filters back on the UTC slice, a CSV column back to the
  raw instant, the overnight clock-out losing its date, the manager grant removed, either inline
  restatement reinstated, `describeVisitLog` keeping a blank measurement or a note-less undone task
  or an uncatalogued id, the PDF carrying pay or a geofence verdict, the download answering 403 on
  another caregiver's row, the audit row dropped, and the token moved into the URL.
- **Two of my own guards proved nothing on the first pass and were fixed rather than claimed as
  catches.** A `>= 3` count of `csvLocalDate(l.clock_in_at)` could not notice one route reverting,
  because the column formatting uses the same call repeatedly — it is now a per-route assertion that
  the filter line is not the UTC slice. And `/v\.detail/.test(page)` matched with the render wrapped
  in `{false && …}` — *a source scan cannot prove a line is reached*, so it now pins the exact
  `{showAll && <DetailSections d={v.detail} />}` shape and the toggle beside it. A browser render is
  the stronger check and was not run this pass; recorded rather than implied.
- **A fixture of mine invented task ids** (`bathing`, `cooking`; the real ones are `bath`, `cook`)
  and the test reported a bug that was the fixture's. Repointed, with a deliberately invented id kept
  to assert catalog-only output. *A probe that seeds the wrong world reports on a world that is not
  production.*
- **The existing route guard was strengthened, not widened.** It now reads each inline-guarded
  handler's body and asserts it branches through `isReviewStaff(`, and that the number of such
  handlers it checked matches the list — so a renamed path cannot silently stop being checked.
- Two end-to-end tests mount the **real** scheduling router over HTTP and read the actual CSV cells:
  `10/3/2026`, `9:00 PM`, `10/4 2:00 AM`, a blank clock-out for an open shift, and **no ISO instant
  anywhere in the file**. The DST boundary is pinned in both directions with the test process in
  UTC, because running it in Eastern would prove nothing.
- Full suite **1976, 0 failing** (1 skipped, pre-existing). Both edited pages compile (esbuild); the
  app boots, both pages serve, and the new route 401s unauthenticated. A real PDF was rendered and
  its `%PDF-` header read back.

---

## Open for the owner

1. **The time picker's 12/24-hour display is a device setting.** If the office wants AM/PM in the
   boxes you type into, that is each machine's regional format (Windows: Settings → Time & language →
   Language & region → Regional format; macOS: System Settings → General → Date & Time → 24-hour
   time). The app cannot override it, and a hand-built replacement picker would be a worse control
   than the browser's own.
2. **The Hours column is still a plain number** (`5`, not `5:00` or `5.00`). Say if payroll wants it
   fixed to two decimals or as hours and minutes — it is one formatter.
3. **Whether a visit-note PDF should ever be shared outside GFC**, and if so whether it needs the
   client's consent recorded the way a faxed visit summary does.
4. **Pre-existing, not fixed here and flagged:** `public/caregivers.html` still appends `?token=`
   to caregiver document links — the same pattern PR #103 removed from the enrollment page. It is a
   live session token in a URL, so it lands in browser history and access logs. Small, separate
   change.
