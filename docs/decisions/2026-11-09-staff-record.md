# One full record per employee in User Management (2026-11-09)

Owner-directed. Staff paperwork was split across three screens:
- **User Management:** account, role, licence, competencies, pay and payroll documents.
- **Caregiver Management:** document review, welcome packet, office-checked items and clearance.
- **Staff Onboarding:** checklist, credentialing, training and renewals.

The data was already in one place. Every staff file is in `caregiver_documents`, keyed by person, for all staff types. Only the screens were split.

## What changed
- **A staff member opens as a full-page record.** In `public/admin-hub.html`, opening any staff account (not a client or family contact) gives a page instead of the pop-up, at `/admin?view=users&person=<id>`.
  - It has a header with three at-a-glance chips: onboarding %, cleared for shifts, and documents waiting on review.
  - A section menu runs down the side.
  - The sections are:
    - **Account & Role:** the existing form, unchanged, rendered in place.
    - **Credentials** and **Pay:** anchors within that form.
    - **Documents:** uploads (for any staff type), Accept / Send Back in place, and what they signed.
    - **Onboarding & Clearance:** progress, "Open full onboarding", the welcome packet, the office-checked items and clearance.
    - **Bio & Headshot**.
    - **Activity:** caregivers only; counts of what they filed.
    - **Account Recovery:** Super Admin only.
  - Creating an account, and editing a client or family contact, keep the pop-up.
- **One function answers "what is on file for this person".** `documentsFor(person)` in `routes/staffPortal.js` is read by the person's own `GET /api/my/documents` and by the office's new `GET /api/my/admin/people/:userId/documents`. That route is open to the admin team (admin, manager, coordinator); a client or family id answers 404.
- **The office files a document for any staff member.** `POST /api/caregiver/documents` used to accept caregivers only, so a clinician's record could list files but not take an upload. It now takes any staff account and still refuses clients and family.
- **Caregiver onboarding belongs to the caregiver office, not only the Super Admin.**
  - The welcome-packet office routes checked `role === 'admin'`. A manager or coordinator opening Caregiver Management's Onboarding tab got a 403, which was a live bug.
  - They now use `accountTypes.isHomeCareOffice`.
  - A new one-person read, `GET /api/caregiver/admin/welcome-packets/:caregiverId`, shares its row builder (`queueRowFor`) with the queue.
  - The signed packet and attestation PDFs open to the office too.
- **Caregiver Management is a to-do list:**
  - "Documents to Review" shows only items waiting on review.
  - "Not Yet Cleared" shows only caregivers who aren't cleared.
  - Every row has **Open Record**.
  - The denial text now names the caregiver office.
- **Staff Onboarding** opens straight to one person at `/onboarding?person=<id>`.
- **Caregivers see what they filed, in full.** Under Logs & Messages, every visit log opens to the whole log as filed, using the server's labelled sections (`describeVisitLog`). A new "Concerns I Raised" list shows every escalation, open or resolved, with what was reported and the full status trail. It is read-only.
  - `publicEscalation` now carries `caregiverId`, so a record can count a caregiver's own.

## Notes
- **No audit gap after all.** The plan said the Super Admin's document reads skipped the audit. They don't: `/api/caregiver` and `/api/my` are PHI prefixes, so the audit middleware records every read. The new route also writes a `staff_record_documents_read` activity row.
- **Activity counts for a manager are partial.** For a manager, the escalation count shows only the escalations that manager is a recipient of. The escalation list route decides visibility per viewer, and only the Super Admin sees all.

## Next (decided, not built)
- **PR 2, care records:**
  - Visit logs and escalations move onto the client's record.
  - An Incident Log goes under Admin & Compliance.
  - Caregiver Management becomes Home Care Oversight.
  - Enrollment is renamed **Clients & Patients**.
- **PR 3, branding:** one shared style file, and white sidebars everywhere.

## Verification
- **Tests:** `test/staff_record.test.js` (10 tests) runs the real routes: the office reads exactly what the person sees; managers and coordinators run onboarding; caregivers and clients are refused.
- **Mutation checks:** 12 of 12 caught.
- **Existing tests:** four were repointed, not deleted:
  - `drive_storage`: now "files for any staff member, never a client or family account".
  - `caregiver_onboarding_queue`: scans `queueRowFor`; label "Not Yet Cleared".
  - `caregiver_app`: the handler slice is bounded to the route.
- **Full suite:** 3,398 pass, 0 fail.
- **Browser:** `scripts/verify_staff_record_render.js` passes 54/54 in Chromium at 1440 and 390. It checks a caregiver record, a nurse record, and the caregiver app's full visit log and concern trail, with no page errors.
