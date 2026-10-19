# The face sheet is staff-only, on the patient banner (owner, 2026-10-19)

Owner: "move it from the patient to the staff side … add it to their EHR info area, the downloadable face sheet for all clinical EHR users."

Before this, the Client Information Face Sheet could only be opened by the patient or POA, from the portal's Documents screen (`GET /api/gfc/face-sheet.pdf`). Staff had no way to it.

**What changed:**
- **Removed from the patient side:** the `/api/gfc/face-sheet.pdf` route, the `faceSheet` entry the documents route sent, and the "Face sheet" row in `public/patient-files.js`.
- **Added for staff:** `GET /api/clinical/patients/:clientId/face-sheet.pdf` on `requireClinicalRead`, the same gate and the same `loadClinicalClient` lookup as every chart read. That covers admin, clinicians (incl. care coordinators), case managers and billing. Same generator (`pdfGenerator.generateFaceSheetPDF`), built fresh from the record.
- **Where:** the patient banner's **More** menu, beside Contact Details, as **Face Sheet**. It is a read, so it is not behind `canWrite`.

**Must not undo:**
- The PDF is fetched with the token in the header and opened as a blob; never a link carrying the session.
- The audit row (`face_sheet_downloaded`) carries the client id and `by: 'staff'`, never names or contact details.
- Home-care-only clients answer 409, matching the chart (the clinical workspace only lists clinical-line patients).

**Verification:** `test/face_sheet_staff.test.js` (4; the shipped route is lifted out of `server.js` and run, and the PDF read back as text), 2 existing guards repointed; 7 of 7 mutations caught. Real server: admin, provider, case manager and care coordinator 200 `%PDF-`; patient and POA 403; old patient URL 404. Real `clinical.html` in Chromium: More → Face Sheet opens the PDF, no page errors. Full suite 0 failing.

**Open for the owner:** several signed consents say details are "recorded once on your Client Information Face Sheet." Patients can no longer download it themselves; staff can print one for them. Worth a look by counsel with the rest of the consent wording.
