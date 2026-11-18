# A booked clinical visit shows on the patient's calendar (2026-11-18)

**Owner report:** viewing as a client, Appts showed today's caregiver visit and not the clinical visit booked with Bethel Godwins the same day, so there was no Join Video Visit button.

**Cause.** The portal only loaded clinical visits through the full clinical read, which needs the clinical service line, a linked chart AND consent to treatment on file. A client who fails any of those (a home care client booked for a clinical visit, or consent to treat not yet recorded) had the clinical visit silently dropped from Home, Care and Appts.

**Fix.**
- `patientRead.evaluateAppointmentReadAccess`: a linked chart, plus for family the release and sharing rules. Service line and consent to treat are not part of it, because when a visit is booked is scheduling, not the clinical record.
- `GET /api/gfc/clinical/appointments` serves the published visit list under that gate, from the published copy only (never OpenEMR). The portal calls it when the full clinical read is not available and feeds Home, Care and Appts from it.
- The video **join** route uses the same lighter gate, and still refuses with `CLINICAL_CONSENT_REQUIRED` and a plain sentence when consent to treatment is not on file, because a video visit is medical care.

**Unchanged:** the full clinical record (notes, meds, results) keeps its full gate.

**Verified:** `test/patient_appointments_access.test.js` (5), one guard in `patient_publish.test.js` repointed to the new prop, full suite 3976/0, portal compiles.
