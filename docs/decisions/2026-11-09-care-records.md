# Care records live with the client; Home Care Oversight; an Incident Log (2026-11-09)

Owner decisions on 2026-11-09:
- Visit logs and escalations belong on the client's record.
- Incidents go in an Incident Log under Admin & Compliance, linked from the client and the caregiver.
- Caregiver Management becomes **Home Care Oversight**, showing only what is waiting.
- Enrollment is renamed **Clients & Patients**.
- The home care pages match the My GFC look.
- In the staff record, Bio & Headshot sits right before Pay.

## What changed
- **`GET /api/caregiver/clients/:clientId/care-history`** returns one client's visit logs (with review notes), escalations (with their trail) and incidents.
  - Gate: review staff, i.e. admin, manager or coordinator, licensed clinical staff, and case managers.
  - It returns **every** escalation for that client, not only those this viewer was notified on. A client record that hides some of the client's concerns is not a record.
- **Incidents have a lifecycle (open → closed).** Before this, they were written as open and nothing could close them.
  - `POST /api/caregiver/incidents/:id/close` is for the caregiver office.
  - Closing requires a follow-up note. A state report can be recorded with it; if one is, its date and agency are required.
  - Every close is appended to `incident_events` (PHI, registered in `COLLECTION_REGISTRY`).
  - A closed incident is final.
  - The activity log records that an incident was closed and whether it was reported, never the note.
  - `GET /api/caregiver/incidents` now carries the client name and the trail, and takes `?status=open|closed`.
- **The client record (`/admin/enrollment?client=<id>`) has a Care History section:**
  - visit logs open in full;
  - concerns show what was reported and the full trail;
  - incidents link to the Incident Log;
  - each row links to the caregiver's staff record.
- **Incident Log** (`/incidents`, new page, served by `routes/caregiver.js`):
  - Open and Closed views, oldest open first.
  - Close with a note and an optional state report.
  - Links to the client record and the caregiver's record.
  - It sits on the hub under Admin & Compliance: the Super Admin's existing area, and for managers and coordinators an area holding only the Incident Log.
- **Home Care Oversight** (`/caregivers`):
  - Opens on a **Waiting** list, oldest first: open concerns, visit logs to review, open incidents, documents to review, and caregivers not yet cleared. Each row opens the record it belongs to.
  - The other tabs stay as filtered views.
  - Escalation and visit-log rows gain **Open Client Record**.
  - **Feed post stays.** Managers and coordinators cannot reach the Admin Hub Inbox, so it is their only way to post to the caregiver feed.
  - **Fixed:** the Incidents tab read `type` and showed "Incident ·" with no client.
- **Renamed Enrollment to Clients & Patients** on:
  - the hub link;
  - the page title and headings;
  - the Clinical Workspace nav and back links ("Open Enrollment" → "Open Client Record").

  The URL stays `/admin/enrollment`.
- **New shared theme `public/css/gfc-theme.css`.** It is taken from My GFC: cream page, white 16px cards with the warm edge and soft shadow, Cormorant titles, and gold for the selected tab.
  - Home Care Oversight and Caregiver Scheduling load it after their own styles.
  - Their navy title bars become plain titles, since the shared staff bar is the navy bar now.
  - This is the start of the branding pass; the other older pages adopt the same file next.
- **Staff record:** Bio & Headshot now sits right before Pay in the section menu.

## Verification
- **Tests:**
  - `test/care_records.test.js` (10 tests) runs the real routes: client-scoped history; refusals for caregivers, clients and family; closing rules; the registry; the hub; the rename; the Waiting row builder, run against data; and the theme.
  - Four existing tests were repointed to the new names and areas.
- **Mutation checks:** 12 of 12 caught.
- **Full suite:** 3,450 pass, 0 fail.
- **Browser:**
  - `scripts/verify_care_records_render.js` passes 28/28 at 1440 and 390. It covers Care History with a full log opened, the Incident Log refusing an empty note and then closing an incident with a state report, and the Waiting list.
  - The scheduling board probe passes 46/46 and now serves the theme file.
  - The hub probe passes 38/38.
