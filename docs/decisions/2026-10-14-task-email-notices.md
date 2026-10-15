# The clinical workspace emails you about a to-do

Owner, 2026-10-14, asked whether the person a to-do is assigned to is told. They
were not: the to-do was written to the record and that was it — the assignee
found out by opening the workspace, and the person who wrote it had no way to
know it had landed. The 2026-10-13 build note had flagged exactly this and left
it open.

The instruction: **"email every time a task is assigned, due, overdue (one email
about task a day) and then marked completed."** This builds all four.

**Four notices, in `notifications.js` with the other eighteen** — so they inherit
the house template, the unsubscribe honour, the duplicate check and the
transport-aware detail rule rather than growing a second copy of any of them:

| Notice | Goes to | When |
|---|---|---|
| `clinical_task_assigned` | the assignee | somebody else hands them a to-do, and on a later reassignment |
| `clinical_task_due` | the assignee | **at the to-do's own due time**; 9am Eastern when it has none |
| `clinical_task_overdue` | the assignee | 9am Eastern each day it stays open past the date |
| `clinical_task_completed` | the **author** | somebody else marks it done |

## Must not undo

- **WHO IS EMAILED IS `canSee` AND NOTHING WIDER.** A to-do is visible only to
  its assignee and its author (owner rule, 2026-10-13), so only those two are
  ever addressed — never admin, never the rest of the team, never the patient.
  Emailing a third person would hand out by push exactly what the read gate
  refuses. Build-enforced: the notice block may not reach `staffRecipients`, and
  the only user lookups in it are the assignee's and the author's.
- **A TO-DO'S TITLE IS PHI.** It is free text about a named patient's
  healthcare — the to-do's own history already refuses to store it for that
  reason. The detailed wording names the patient and the title, is marked
  `{ phi: true }` and sends only on a BAA-covered transport; otherwise the
  notice says a to-do is waiting and nothing else. **The title stays out of the
  subject line even when detail is allowed**, because a subject shows on a lock
  screen; the subject carries at most the patient's name, which is the line the
  staff message notice already draws.
- **ONE EMAIL ABOUT A TO-DO A DAY, HELD BY THE KEY RATHER THAN THE CADENCE.**
  The reminder's `relatedEntityId` is `<task>:<kind>:<Georgia date>`. The queue's
  20-hour cooldown is not what caps this — a date key cannot be defeated by a
  restart, a changed scan interval or three scans in one morning, and the next
  calendar day is a new key rather than a swallowed duplicate. Proven live by
  running the scanner three times and getting one email.
- **A TO-DO CARRIES A TIME, AND THE EMAIL GOES OUT AT IT** (owner, 2026-10-15:
  *"task email needs to be sent during the exact time the task is due.. 9 am et
  is default when no time added"*). `dueTime` is `HH:MM` in Georgia — the
  practice clock, like every other time this app shows, with no zone
  travelling with it. A to-do with no time keeps the 9am default, so nothing
  already written changes and no migration was needed.
- **THE SWEEP HAS ITS OWN ONE-MINUTE TICK, and that REVERSES the "rides the
  existing scanner, no second timer" call made on 2026-10-14.** The reason
  changed under it: the notification scanner runs every **30 minutes**, which
  was invisible when every to-do went out at 9am and is a broken promise the
  moment a to-do names its own hour — a 2pm to-do emailed at 2:29 is not "at
  the time it is due". The tick is one collection read plus the cached users
  read, which is why it is affordable every minute where the full scan is not.
  **Exactly one caller**, build-enforced: the scanner no longer runs it.
- **THE OVERDUE CHASE IS THE NEXT MORNING, NOT A RE-RUN OF YESTERDAY'S CLOCK.**
  A to-do due at 2pm yesterday is chased at 9am today, not at 2pm today: its
  time has already passed, and somebody planning their day wants it at the
  start of the day. The due notice follows the to-do's clock; the overdue
  chase follows the morning.
- **A DUE TIME HANGS OFF A DUE DATE**, judged on the row **as it lands** rather
  than on the fields that arrived — so setting a time on an already-dated
  to-do works, while a time on an undated one is refused by name
  (`TASK_DUE_TIME_WITHOUT_DATE`) instead of being stored as a reminder that can
  never fire. Clearing the date clears the time.
- **A WALL-CLOCK TIME IS FORMATTED FROM ITS OWN DIGITS, never through a
  `Date`** — in the email and on the page alike. It carries no date and no
  zone, so running it through `Date` renders an invention; the same rule
  `fmtClock` already sets for availability windows.
- **SWEPT, NOT SCHEDULED — the opposite of the visit reminders, and the
  difference is the data.** A visit reminder is written at booking time because
  nothing may read OpenEMR's calendar in the background (per-clinician OAuth,
  Session 5.2). A to-do lives in this app's own store and **its due date can be
  edited after the fact**, so a row scheduled at write time would chase the old
  date. The sweep re-derives from the to-do as it stands now. It rides the
  existing scanner; no second timer.
- **NOTHING GOES OUT BEFORE 9AM EASTERN** (`TASK_EMAIL_SEND_HOUR_ET`, one
  constant). The scanner runs every few minutes; without the gate a to-do
  created at 00:05 is emailed at 00:05.
- **THE DAY AND THE HOUR ARE GEORGIA'S** (`practiceTime.zonedParts`), never the
  container's. UTC is already tomorrow for four hours of every evening, so a
  to-do due today would turn overdue at 8pm and a 9am send would fire at 4am.
  `remindersDue` is pure — it is handed the date and the hour and reads no clock
  of its own, so the tests do not have to run in Eastern to mean anything.
- **NOBODY IS EMAILED ABOUT THEIR OWN ACTION.** No assignment notice for a to-do
  you wrote yourself; no completion notice for one you finished yourself.
- **THE SWEEP CHASES THE ASSIGNEE ONLY.** The author hears when it is finished,
  not daily about work that is not theirs to do.
- **EVERY NOTICE IS BEST-EFFORT AND NONE MAY THROW.** A to-do that is already
  written is never undone because an email failed.
- **The update route snapshots the row before the change** (`const before`)
  rather than aliasing the live one — the bug the shift editor paid for, where
  every "the previous time was…" line printed the new time.

## Also changed

- `appLinks.CLINICAL_TASKS` (`/clinical#queues`) and `tasksFor()`, so the
  destination lives in the one place that answers "where does this person go".
- **The clinical page honoured only `#inbox`**, so `#queues` would have landed
  every one of these emails on My Day. The fragment is now read against
  `NAV_VIEWS`; an unknown fragment still falls back to My Day rather than
  rendering a tab that does not exist.

## Verification

- `test/clinical_task_notices.test.js`, **30 tests; 42 of 42 mutations caught**
  across the two passes (25 for the notices, 17 for the due time).
  Four survived the first pass and are recorded honestly: two were **behavioural
  no-ops** (the sweep's `status !== 'open'` guard, which `bucketFor` already
  answers, and the midday-UTC date read, which the formatter's explicit
  `timeZone: 'UTC'` already answers) — both are now commented as belt-and-braces
  with the load-bearing guard named, and replaced by mutations that break the
  real one. The other two were **genuine holes in my tests**: the "future to-do"
  fixture was seven weeks out, so widening the due branch to the 7-day
  `upcoming` bucket sailed through; and both routes carry the identical
  `notifyTaskAssigned` call, so a regex that only had to match once still
  matched after the create route's was deleted. Both fixed.
- Two existing guards **repointed, not deleted** — `visit_reminders` A4 (which
  asserted the visit sweep was immediately followed by the scan's closing log
  line) and `clinical_workspace_412`'s landing-view guard (which asserted the
  old single-case hash expression). Both rules are unchanged and both repointed
  guards were mutation-checked to confirm they still bite.
- `scripts/verify_task_notices.js` through the real HTTP routes, reading the
  queued notification back — a to-do due later today sending nothing even well
  past 9am, one whose time has just passed sending on the next tick with the
  time in the words, a second tick sending nothing more, a closed to-do
  dropping out, and nobody outside the assignee and the author receiving
  anything. **It waits for the real one-minute tick rather than poking a
  route**, which is why it takes minutes: that the timer fires is the thing
  being proven, and an on-demand trigger would not prove it.
- All eight messages (four notices × both transports) were **rendered and read**,
  which is the only way every email defect in this repo has ever been found.
- Full suite **2491, 0 failing** (1 skipped, pre-existing). The page compiles;
  the app boots and the routes register.

**Not proven here:** that Google accepts and delivers them. Queueing is as far as
a sandbox reaches — `scripts/verify_email_transport.js` on the deployment is the
other half, and it has still never been run.

## Open for the owner

- **Volume.** This is literally one email per to-do per day, as asked. Somebody
  with eight overdue to-dos gets eight emails every morning until they clear
  them, and this repo's own house rule is that a notice which fires too often
  stops being read. Collapsing the daily due/overdue mail into **one digest
  email per person** is a change to the loop in `sendDueTaskReminders`; the
  assigned and completed notices would stay per-event. Say the word.
- **The author is not chased when a to-do they delegated goes overdue** — only
  the assignee is. Say if they should be copied.
- Nothing is sent for a **cancelled** to-do. The author is told when one is
  finished, not when the assignee cancels it with a reason.
- **A to-do due at 9am still sits under Today all day on screen**, not under
  Overdue at 9:01. The time drives the email; the on-screen buckets stay
  date-only, so nothing moves column mid-morning under someone's cursor. Say
  if the columns should follow the clock too.
- **The tick is a minute.** A to-do due at 2:00 is emailed between 2:00 and
  2:01. If that needs to be tighter the constant is `TASK_SWEEP_INTERVAL_MS`,
  at the cost of a read per tick.
