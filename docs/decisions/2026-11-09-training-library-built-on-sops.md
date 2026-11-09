# The Training Library is built on real SOPs

**Date:** 2026-11-09 · **Owner-directed** · Branch `claude/eager-brown-2pzrt0`

## Why

The owner asked for the Training Library to be "built honestly, as in actual SOPs" and did not know which modules were linked to the SOP document in Drive.

Checked against Drive on 2026-11-09. `GFC_Clinical_SOPs_Set1_v1.2.docx` holds eight written procedures (SYS-01, ESC-01, VIS-01, DOC-01, ORD-01, ORD-02, RX-01, EXM-01), each with check questions. Set 2 (ten procedures) exists only as a "Planned" table. No Set 2 document exists anywhere in Drive. Of the 43 modules, 13 teach a written SOP, 10 wait on an unwritten Set 2 SOP, and 20 have no SOP at all.

## What was locked in

- **A module is open to staff only when something real is behind it:** a written SOP found in the Drive document, or material the office added (links or files). Otherwise staff see it greyed out as "Coming Soon", with nothing to press. The complete route refuses it (`MODULE_NO_MATERIAL`), so this is enforced on the server, not just hidden on the page.
- **"SOP not written" is the office's to see, never staff's** (owner). Staff get `{ ready: false }` and nothing else.
- **Four states, worked out in one place** (`onboarding/trainingMaterial.js`): `SOP_WRITTEN`, `MATERIAL_ADDED`, `SOP_NOT_WRITTEN`, `NO_MATERIAL`. A fifth, `SOP_MISSING_FROM_DRIVE`, is reported only when the document was read and the procedure the catalog names is not in it.
- **A Drive outage never greys out a written procedure.** An unreadable SOP document means "unknown", not "missing". The module stays open, and the material view says the text could not be read and links the document.
- **The module shows the SOP itself**, read live from Drive (`sourceParsers.sopSections`) and cut off before its check questions. The answers stay out, because check questions are switched on separately.
- **The office adds material per module** from Training Library → Manage Material: https-only links (video, document, link), file uploads to the Drive folder "GFC Training Material", and a note for staff. Removing a link or file keeps the row with who removed it and when, so the record of what someone learned from survives. Drive ids never leave the server.
- **Office sign-off is not gated.** The office can still sign off a module with no material, such as a 30-day review meeting, because those are meetings rather than reading.
- New collection `onboarding_training_materials` (not PHI), registered in `dataMigration.js`.

## Verified

12 new tests through the real router plus the pure logic. 7 mutations each confirmed caught: gate removed, staff gating removed, office state leaked to staff, https check dropped, Drive presence ignored, unknown treated as known, and check answers leaking into the training text. One existing test was repointed rather than deleted: it completed TRN-001, which has no SOP, and now completes TRN-003, which teaches SOP-SYS-01. Full suite 3458 pass, 0 fail. `pages_compile` and `no_orphan_routes` pass.

**Not proven from the sandbox:** the page rendered in a browser against the live Drive document. The parser was checked against the real document's structure (read through the Drive connector), not against the live server.

## Open for the owner

- Ten Set 2 SOPs are still unwritten. The modules that teach them stay greyed until each one is written or material is added.
- Writing a Set 2 SOP into the Set 1 document, or a new Set 2 file, needs the app pointed at it. Today the app reads Set 1 only. A Set 2 document needs one entry in `onboarding/sources.js`.
- Twenty modules are reviews, shadowing or live sessions with no SOP. Decide which ones get material and which are simply signed off by the office.
