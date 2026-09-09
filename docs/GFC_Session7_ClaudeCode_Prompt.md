# Session 7 — Claude Code Prompt
## Scheduling · availability · time tracking (PHCP)

**Prerequisite:** Sessions 3.x and 4.x merged. Independent of Sessions 6 and 9 — **all three run in parallel.**
**Model:** Opus.
**Spec:** `docs/GFC_App_Build_v2.md` §5 (PHCP), the shift/availability/time-log entries in §5.4 · staff shift-scheduling screens in `docs/prototype/phcp-portal-prototype.html`.
**Important:** TEST DATA ONLY.

---

## PARALLEL BUILD PROTOCOL — read before writing any code

Sessions 6, 7 and 9 run at the same time. Conflicts are avoided by **file ownership**.

**You own, exclusively:** `schedulingRepository.js` (new), `routes/scheduling.js` (new), the admin-facing scheduling UI in `public/admin-hub.html` (or a new `public/scheduling.html` if cleaner), `public/components/caregiver-schedule.js` (new — see below), `test/scheduling.test.js` (new).

**You must NOT create or edit:** `public/caregiver.html` (Session 6 owns it) or anything messaging (Session 9).

**Shared files — one line each:** `server.js` (single `require` + `app.use`) and `config.js` (append enums only, do not reorder).

**Your caregiver-facing deliverable is a component, not an edit.** Session 6 renders `<div id="gfc-mount-schedule">` as a disabled placeholder. You build `public/components/caregiver-schedule.js` — a self-contained module exporting a mount function that takes `(elementId, { caregiverId, authToken })` and renders: the caregiver's own schedule, the open-shift pool with claim, accept/decline for assigned shifts, availability submission, clock in/out, and their own time history. **Do not mount it.** A follow-up session wires it once both PRs merge. Document the contract at the top of the file.

---

## Paste this into Claude Code

```
You are continuing the GFC Care Platform build. Read CLAUDE.md first and honor
its prerequisite gate. Sessions 6 and 9 are running IN PARALLEL — read the
PARALLEL BUILD PROTOCOL in docs/GFC_Session7_ClaudeCode_Prompt.md and obey the
file-ownership rules exactly. TEST DATA ONLY.

Branch: session/07-scheduling (or harness-assigned)

Read first, in full:
- docs/GFC_Session7_ClaudeCode_Prompt.md — the parallel build protocol
- docs/GFC_App_Build_v2.md §5, §5.4 (data model)
- docs/GFC_Client_Care_Profile_Schema_v1.md — careTeam, careTier, schedule block
- docs/GFC_Caregiver_Profile_Schema_v1.md — licenseLevel, availability shape
- docs/prototype/phcp-portal-prototype.html — staff shift-scheduling screens
- The Session 4.2 clinical scheduling code — for the UX pattern ONLY. Its
  backend is OpenEMR; yours is the app store. Two scheduling systems by design.
  Do not share code paths or couple them.

ARCHITECTURE
PHCP caregiver scheduling lives entirely in the app store. It does NOT touch
OpenEMR. Clinical appointments (4.2) stay in OpenEMR. If you find yourself
importing openemr.js, stop — you are in the wrong lane.

SCOPE

A. Data model (app store, keyed for RDS migration)
- availability: caregiverId, days of week, time windows, blackout dates,
  submittedAt, effectiveFrom.
- shifts: clientId, caregiverId (nullable while open), start, end, careTier,
  status, createdBy, notes, plus the lifecycle timestamps below.
- time_logs: shiftId, caregiverId, clockInAt, clockInGps, clockOutAt,
  clockOutGps, flags, totalMinutes, editedBy/editReason when adjusted.
- shift_requests: clientId, requestedBy, date, time window, care needs, status.

B. Availability submission
- Caregivers and clinicians submit availability at least 30 days in advance.
  Enforce the 30-day rule SERVER-SIDE, not just in the form.
- Structured: days of week, time windows, blackout dates.
- Admin reviews submitted availability and posts schedules from it.

C. Shift posting and the two matching pathways
- Admin posts open shifts from client need + submitted availability. Open shifts
  are visible to eligible caregivers only (license level and assignment rules).
- Pathway A — caregiver self-select: client requests a shift from their portal →
  shift posted → caregiver claims → ADMIN APPROVES OR DECLINES → both parties
  notified on confirmation.
- Pathway B — admin assignment: admin assigns directly → caregiver accepts or
  declines → declined shifts return to the open pool → client notified on
  confirmation.
- Lifecycle, enforced as a state machine with timestamps:
  Open → Claimed/Assigned → Confirmed → In Progress → Completed.
  Reject illegal transitions with a specific error, do not silently coerce.

D. Time tracking
- Clock in and out only on a Confirmed shift. GPS captured on both.
- Geofence: default 150m radius around the client address, configurable per
  client. Out-of-radius clock-ins are FLAGGED to admin but NOT blocked — a
  caregiver may legitimately be transporting the client.
- Late clock-in and early clock-out flagged.
- Total hours computed per shift and per pay period.
- Admin may edit a time log ONLY with a mandatory reason note; every edit writes
  to the activity log with before/after values.
- Caregivers see their own time history only.
- CSV export for payroll, admin-only. Confirm the column set with Bianca before
  finalizing the header row — if unavailable, ship a documented default and say
  so in the PR.

E. The caregiver-schedule component (public/components/caregiver-schedule.js)
Self-contained, unmounted. Renders: own schedule, open-shift pool with claim,
accept/decline for assigned shifts, availability submission form, clock in/out,
own time history. Document the mount contract at the top of the file.

F. Admin scheduling UI
Post shifts, review availability, approve/decline claims, assign directly, view
the master calendar, review flagged clock-ins, export payroll CSV.

DO NOT
- Edit public/caregiver.html (Session 6) or anything messaging (Session 9).
- Touch OpenEMR or the 4.2 clinical scheduling code.
- Mount your own component — a follow-up session does that.
- Block an out-of-geofence clock-in. Flag it.
- Allow a time-log edit without a reason.
- Enter real PHI.

ACCEPTANCE
- Availability submitted fewer than 30 days out is rejected server-side. Prove
  by calling the API directly, not just the form.
- A caregiver whose license level does not match a shift's requirement does not
  see it in the open pool.
- Pathway A: claim does not confirm the shift until admin approves. Pathway B:
  decline returns the shift to open. Prove both.
- Every illegal lifecycle transition is rejected with a specific error.
- Clock-in outside the geofence succeeds AND is flagged. Clock-in on an
  unconfirmed shift is refused.
- A time-log edit without a reason is refused; with a reason it writes
  before/after to the activity log.
- A caregiver cannot read another caregiver's time history or shifts.
- Payroll CSV exports for a date range, admin-only, 403 for everyone else.
- caregiver-schedule.js loads standalone and is NOT mounted anywhere.
- App boots; Sessions 3.x and 4.x unaffected; no OpenEMR imports in your files.

Update CLAUDE.md AND docs/GFC_SESSION_PLAN.md per the running instruction
(steps 4-7). Open ONE PR titled "Session 7: PHCP scheduling, availability, time
tracking." Note in the PR that the caregiver component ships unmounted. Stop for
review.
```

---

## After this lands
The wiring session mounts `caregiver-schedule.js` into Session 6's `gfc-mount-schedule`. Session 8 (matching engine) then has the availability data it depends on.
