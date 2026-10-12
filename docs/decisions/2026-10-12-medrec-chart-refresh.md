# The Medications list reloads after reconciliation (owner report, 2026-10-12)

**Report:** the chart's Medications list read "Nothing on file in OpenEMR" while the
reconciliation directly under it marked every medicine "Both".

**Cause:** both read the same OpenEMR list (FHIR MedicationRequest). "Both" means the
medicine IS in OpenEMR. The list at the top comes from the chart, which loads once when
the chart opens; Resolve writes to OpenEMR and reloaded only the reconciliation box.
The writes were landing; the screen above them was stale.

**Fix:** `MedRecTab` takes `onSaved`; `MedicationsTab` passes the chart reload to it, from
both the chart's Medications tab and the in-encounter lookup. No server change.

**Verified:** `test/medrec_chart_refresh.test.js` (3), one mutation (drop the reload) caught;
`test/social_work.test.js`'s signature guard repointed, rule unchanged. Full suite 2260, 0 failing.
Page compiles. Not proven live: a real Resolve against the deployed OpenEMR.

**Still open, not in this change:** iPrescribe has no link to the app. A prescription sent
there reaches OpenEMR and this chart only if someone records it here too. Discontinuing a
medication that was written as an OpenEMR prescription cannot end-date it there (8.4 has no
prescription update route).
