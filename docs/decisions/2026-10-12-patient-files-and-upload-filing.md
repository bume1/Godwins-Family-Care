# Patient uploads reach OpenEMR, and one clean Documents screen

**Date:** 2026-10-12 · **Owner-directed** ("documents they upload need to file into
open emr", "there still remains a couple duplications in how consents show. Can you
create a cleaner files view for the patients?")

## Uploads file into OpenEMR
- **Why they never did:** `attemptEmrFiling` asked OpenEMR as whoever uploaded. A
  patient, POA or the no-login link has no OpenEMR identity (Session 5.2), so every
  patient upload failed and nothing tried again except linking the chart.
- **Now:** if the uploader has no OpenEMR sign-in, the upload is stamped
  `emrFilingWaitingSince` and returns `WAITING_FOR_CLINICIAN` (no call to OpenEMR).
  It files with a real person's sign-in the next time either happens:
  - a licensed clinician or admin **opens the patient's chart** (`fileWaitingUploads`,
    best-effort, not awaited), or
  - an admin **accepts** the document.
  Refresh portal chart and linking the chart still file too. A read-only viewer
  (case manager) files nothing.
- The chart shows **"Filing to EMR"** on a waiting upload; it turns into "In EMR".
- **Must not undo:** no system login was added to make this work. Filing is always
  attributed to the staff member whose sign-in carried it.
- Not proven live: a real OpenEMR accepting the file (the probes stub OpenEMR).

## One Documents screen for patients
- The screen drew from two lists that overlap (`/api/gfc/documents` and the chart
  index), so every signed consent and every upload showed twice, and the packet PDF
  and ZIP were two rows for the same signatures.
- `public/patient-files.js` (pure, tested) builds ONE list: each document once, in
  groups **Signed forms · Care plans · Test results · Sent by you · From your care
  team · Record releases**, with filter pills. The packet is one row with the ZIP as
  a second link. Consents come only from `signedConsents`; uploads from the
  checklist; a chart upload row stays only if the checklist does not list it.
- On top: **We still need** (required or asked-for items with nothing on file, with
  any rejection reason). Optional items sit under "Send something else".
- No server or permission change: the same two routes, the same gates.

## Verified
- `test/patient_files_view.test.js` (7). Mutations: consent dedupe removed, upload
  dedupe removed, rejected files listed, chart-open filing removed, the sign-in
  check disabled, the waiting chip forced off: each caught.
- Two `bug_sweep_0929` guards repointed to the same rules in the new screen.
- Probes: document routing 57/57 and visibility 44/44 (both now model a patient
  with no OpenEMR sign-in, which the old probes did not), upload link 53/53, portal
  render 22/22 including a new Documents check in Chromium. Full suite 0 failing.
