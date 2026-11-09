# Approve enrollment waits on the clinical checklist's pre-visit steps (owner, 2026-11-09)

Owner ask: block "Approve enrollment" for clinical clients until the clinical enrollment checklist is done.

- **Why not all six steps:** two of them (the first H&P visit and the co-signed care plan) need a visit, and a clinical visit cannot be booked until the client is enrolled. Requiring all six would lock the client out of the visit that completes them.
- **What Approve now needs for an IHPC or BOTH client:** payer verification, the records release, NPA confirmation and the three clinical consents, on top of the existing consents and fields. One list, `clinicalRepository.PRE_APPROVAL_CHECKLIST_STEPS`. Home-care-only clients are unchanged.
- **Activate still needs all six.** Approve gets the client into scheduling; Activate is the final clinical stamp.
- **The existing override still works**, with a required reason. Missing clinical steps are frozen onto the override record and shown on the page, the same as missing consents.
- **The refusal names each missing step** ("Clinical enrollment: Payer verification").
- **Verified:**
  - `test/approve_clinical_checklist.test.js`, 5 tests.
  - 7 of 7 deliberate breaks caught.
  - Full suite: 3,583 tests, 0 failing.
  - The page compiles.
