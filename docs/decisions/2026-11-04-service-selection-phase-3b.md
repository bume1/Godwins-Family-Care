# Service selection for the codes that are not level-based (AI coding pipeline, Phase 3b)

_2026-11-04 · owner-directed ("phase 3 entirely") · spec: GFC_AI_Coding_Pipeline_ClaudeCode_Spec.md, Phase 3b_

**What it is.** Deterministic rules, no model, for the codes that follow from what was done and how long it took. **One file per family under `serviceRules/`**, each holding its own thresholds, `verified: true`, `verifiedOn`, `verifiedAgainst` (the sources named in spec 3b.6) and `nextReviewDue: 2027-01-01`. A test fails if a family's codes appear in any other source file (the credential list in `clinicalRoles.js` excepted). Every file is a rule list checked against OpenEMR's catalog, **except RTM, which is loaded inactive.** Nursing facility codes have no file: if activated, they go into `emLevels.js`.

Families: psychotherapy (with crisis, diagnostic evaluation, interactive complexity, family and group), health behavior (with the neurobehavioral exam), advance care planning, annual wellness, transitional care, chronic care (CCM and APCM), behavioral integration (BHI and collaborative care), remote monitoring (RPM, and RTM labelled inactive).

**Must not undo:**
- **Whose time it is decides CCM.** Clinical staff minutes and the practitioner's own minutes are separate inputs; staff time never reaches 99491 or 99437.
- **The AWV history is read from GFC's records on the server, never typed**, and every AWV answer says another practice's claim will not appear and points at Palmetto eServices.
- **TCM counts business days** for the contact (the first business day after discharge is day one; weekends skipped; federal holidays not modelled) and calendar days from discharge for the face-to-face.
- **3b.5:** within five minutes of the next threshold up, the same `LEVEL_AMBIGUOUS` flag as Phase 3, naming the chosen code, the next code and its threshold, and the absence ("the record does not show more than N"). Never advice.
- **3b.4 cross-family rules block on the claim scrub:** APCM, CCM and TCM by the same practitioner for the same patient in the same month; an APCM behavioral add-on without a base APCM code that month; 99445 with 99454 and 98985 with 98977 (the calendar month stands in for the 30-day device period, which the app does not track by device); 99470 with 99457; and a psychotherapy add-on plus an E/M claiming more minutes than the encounter's total. **Psychotherapy minutes not recorded separately block as NOT CHECKED.** They are read from the visit's recorded timing.

**Derived, not quoted, and marked so in each file for the January review:** the add-on bands for 90833/90836/90838; the second and later 90840 units (each further 30 after 75); the first 96159-type add-on at 38 minutes and the 96116 first hour at 31 (the CPT midpoint rule); a second 99498 at 76; G2214 used when the month reaches 30 minutes but not the 99492/99493 threshold.

**Screens.** Billing's encounter card gains a **Code Helper**: the families and their inputs come from `GET /api/clinical/service-selection/families`, so the page names no code or threshold; `POST /api/clinical/service-selection` answers with the codes, the reason, any review flag and notes. It saves nothing. Both routes are billing's. The admin hub lists any rule file past its review date.

**Verified.** `test/service_rules.test.js` 23 tests: every family at each threshold and the minute before, the near-threshold flag at 5 and 6 minutes, the cross-family blocks, provenance, and the routes. 26 mutations, each caught (one first survived because the mutation itself changed no behaviour; replaced with the realistic bug, which is caught). `scripts/verify_note_lifecycle.js` 248/248 over real HTTP. Full suite 2871 pass, 0 fail.

**Open for the owner:** a coder should confirm the derived values above at the first audit, and the January review reconciles every file against the CPT book.
