# The OpenEMR record number (MRN) reaches the patient record

Owner request, 2026-10-23: "patients in the chart get unique identifiers being added to the records." Owner chose OpenEMR's own chart number over a GFC-issued one.

**The defect:** the chart banner has shown an MRN slot since 4.12, reading `client.openEmrRecordNumber`. Nothing ever wrote that field, so every chart showed no MRN.

**What was built:**
- `openemr.getRecordNumber(puuid)` reads the standard-API patient row (FHIR does not reliably carry it) and returns `{ pid, pubpid }`. Audited like every EMR read.
- `clinicalRepository.recordNumberOf(row)`: `pubpid` (the "Patient ID" OpenEMR prints) when set, else the numeric `pid`, else null. Never invented.
- `ensureRecordNumber(client, actor)` in `server.js` stores `openEmrRecordNumber` plus `openEmrRecordNumberFor` (the uuid it was read for). Runs at link time, on chart open and on the pre-visit packet, so existing linked patients fill in the first time anyone opens their chart. Best-effort: a failed read shows no MRN and never blocks the chart.
- Relinking to a different OpenEMR patient drops the old number before reading the new one.
- The Patients list shows "MRN n" in place of "Linked", and an exact MRN typed into the search finds the patient.

**Must not undo:** the number is keyed to the uuid it was read for, so a relink can never show another chart's MRN. No MRN is ever guessed.

**Verification:** `test/patient_record_number.test.js`, 5 tests, 8 of 8 mutations caught (one survived first; the assertion was tightened). Full suite 2659, 0 failing.

**Not proven here:** a live OpenEMR returning `pubpid`. If OpenEMR leaves `pubpid` blank on API-created patients, the internal pid shows instead, which is still unique.
