# Patient to-dos and a daily digest in the clinician workspace

Owner request, 2026-10-13: "edit the task management area of the clinician workspace … easiest to manage patient related to-do's related to their healthcare and a daily digest from the clinical space that lets us know pending tasks vs upcoming."

Before this, Tasks listed only the four queues the app builds itself (unsigned notes, results, referrals, overdue orders). There was nowhere to write "call the daughter about PT" or "recheck BP Friday".

**Owner answers that shape it (2026-10-13):**
- The digest is **on screen only**. Nothing is emailed.
- Licensed clinicians, admin, managers **and case managers** can write, complete and be assigned a to-do.
- **A to-do is seen only by the person it is assigned to and the person who wrote it.** Not admin, not the rest of the team.

**What was built:**
- `clinicalTasks.js` holds the rules: fields, validation, `canSee`, the due-date buckets and `buildDigest`. New PHI collection `clinical_tasks`, registered in `dataMigration.js`.
- `clinicalRoles.canManageTasks` (same people as `canEditOrderDestination`). Served to the page as `access.canManageTasks`; the page decides nothing itself. A case manager stays read-only on the rest of the chart.
- Routes, all behind `requireTaskManager`: `GET /api/clinical/tasks` (scope `mine` / `assigned_by_me` / `all`, optional `clientId`, `includeClosed`), `POST /api/clinical/tasks`, `PUT /api/clinical/tasks/:taskId` (`action`: edit, done, cancel, reopen), `GET /api/clinical/digest`.
- Screens: **Tasks** now opens on **My To-Dos** (Overdue · Today · Next 7 Days · Later · No Date; Assigned to Me / I Assigned / All Mine; Add To-Do; tick to finish), with the old **Work Queues** as the second tab, unchanged. **My Day** shows a **Today's Digest** card. The patient **Overview** has a **To-Dos** card for that patient.

**Must not undo:**
- **Visibility is `canSee` and nothing else.** A hidden to-do answers **404, never 403**, so a refusal does not confirm it exists. Admin does not see other people's to-dos (owner rule).
- **Every to-do names a patient** (`TASK_CLIENT_REQUIRED`). The assignee must also be someone who can hold a to-do; a caregiver or a client is refused by name.
- **The audit trail and the to-do's own history carry ids and field names, never the title or details.** Those are PHI.
- **Buckets come from the server, judged on Georgia's date** (`practiceToday()`), so a to-do due today does not turn overdue at 8pm Eastern. The page does no date math.
- **The digest is the viewer's own work only:** my to-dos, inbox items actionable by me (`clinicalInbox.buildInbox`, reused), results routed to me, my overdue orders (`orderReq.buildOverdueList`, reused), my referrals still waiting, and visits on **my own** calendar. Someone with no calendar of their own (admin, case manager) gets no visits rather than the whole practice's, and the card does not pretend that is an empty week.
- Cancelling needs a reason. Nothing is ever deleted.

**Verification:**
- `test/clinical_tasks.test.js`, 14 tests; **16 of 16 mutations caught** (visibility widened, case managers dropped, digest filters dropped, buckets moved, history carrying values, cancel reason optional, the 404 check removed, the audit carrying the title, and more).
- `test/patient_clinical_read.test.js` route-guard test **repointed** to accept `requireTaskManager`; the rule it protects (every clinical route carries a named gate) stands.
- `scripts/verify_clinical_tasks.js`: **32/32 through the real HTTP routes**, reading stored rows back, including another provider and admin not seeing the to-do and a case manager writing and closing one.
- `scripts/verify_tasks_render.js`: **12/12 in Chromium** with the real module behind a stubbed API, at 1440px and 390px, no page errors.
- Full suite 2350, 0 failing.

**Not proven here:** upcoming visits in the digest, because the calendar is OpenEMR's and none is reachable from a sandbox.

**Open for the owner:**
- `/api/clinical/work-queues` (the Work Queues tab) is still practice-wide, not per person. Left as is; say if it should narrow to "mine".
- No reminder or email when someone hands you a to-do; it shows on your list and in your digest. Say if an in-app notice is wanted.
