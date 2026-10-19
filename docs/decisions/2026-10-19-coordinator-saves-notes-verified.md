# Care Coordinators save notes: verified end to end (owner ask, 2026-10-19)

"Make sure care coordinators have appropriate permissions like saving notes."

- **Checked, not assumed.** `scripts/verify_note_lifecycle.js` had no coordinator in it, so nothing proved the 2026-10-14 role actually saves a note over the real routes. Section 18 now drives a coordinator account exactly as `accountTypes` stores it (`role: user`, `isManager: true`, `clinicalRole: coordinator`).
- **What it proves (14/14):** the coordinator is served `canDocument: true, canWrite: false`; saves a scratch draft; saves a new note (app + OpenEMR, under their name); reopens and edits it; is refused sign, co-sign and prescribing; a clinician picks up the same draft, signs it, and the coordinator shows as "Prepared by", never as a signer; once signed the note is locked to the coordinator too.
- **No server change was needed.** The note, draft, calendar, screening, home-visit and telehealth-check routes already sit on `requireClinicalDocumenter`.
- **One screen fix.** On the chart's Documents list the "Shared with Patient / Hidden from Patient" toggle read `canWrite` only, so a coordinator saw a static label while the server's share route (admin, manager, clinician) already lets them, since a coordinator is stored as a manager. The toggle now shows for anyone who can document. Both hooks are called unconditionally.
- **Pre-existing and left alone:** 5 failures in the same probe on `main` too. Its "read-only case manager" fixture is turned into an LMSW at boot (every case manager is an LMSW since 2026-10-15), so the three "read-only cannot …" checks no longer describe a real account. The fixture needs updating, not the code.
- **Verified:** probe 191 pass, the 5 above failing identically on main; full suite 2534, 0 failing; `clinical.html` compiles.
