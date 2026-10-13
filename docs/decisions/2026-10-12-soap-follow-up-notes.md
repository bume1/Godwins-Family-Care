# Follow-up notes are SOAP; the New Patient H&P stays (2026-10-12, owner-directed)

**Owner:** "the note breakdown for visits is confusing … The main new patient H&P is fine. Adjust the follow-up note layouts to reflect a SOAP style … and allow for telehealth notes to remain reflective of standard visits in person."

**What was wrong:** three screens wrote a note and none matched. Start visit opened the H&P screen for EVERY visit type and saved it as an H&P, so a telehealth follow-up would not sign without a blood pressure in both arms, showed the systems grid and the home-visit assessment, and stamped the patient's initial visit as done. The "Document a visit" popup was a fixed S/O/A/P form, and a saved follow-up opened in a third layout. Labels drifted (Reason vs Chief Complaint, Interval History vs Subjective).

**Decided:**
- **Follow-up, Acute / Sick and Psych Follow-up share one SOAP core, titled exactly:** Chief Complaint · Subjective · Objective (Medication Reconciliation, Vitals, Physical Exam) · Assessment · Plan (then Orders/Rx pointer, Follow-up, MDM or Total Time). One helper, `soapCore()` in `appointmentTypes.js`, builds the core so the three cannot drift; each row carries a `group` (`cc`/`s`/`o`/`a`/`p`/`extra`).
- **Then that visit's own questions, under "<type> — additional".** Follow-up: none. Acute: Pertinent ROS, Return / ER precautions (both required). Psych Follow-up: medication adherence, mental status exam, risk assessment (required); screening scores, psychotherapy time (optional); safety plan (required when risk is positive).
- **Required sets did not tighten.** Med rec is required on Follow-up, optional on Acute and Psych FU, as before. Vitals and exam are required in person on Follow-up and Acute, optional on Psych FU.
- **Telehealth is the same layout.** Vitals and exam are shown and optional, labelled "patient-reported on a video visit" / "observed by video".
- **⚠️ THE NOTE KIND COMES FROM THE VISIT TYPE, ON THE SERVER.** Each type carries `noteForm` (`hp` for New Patient, Psych Initial, IME; `followup` for the rest). `sanitizeNote` forces `kind: 'followup'` for a follow-up type, and `checkNoteForSigning` re-derives it (`effectiveNoteKind`), so a draft already mis-saved as `hp` signs without the two-arm BP and never stamps the initial visit. **H&P blocks already typed into such a draft are kept**, not dropped, and shown under "More of this note".
- **One SOAP screen whichever button starts the visit** (`soapBlock` shared by `HpTab` and `FollowUpNoteEditor`). New Patient, Psych Initial and IME keep the H&P screen exactly as before.
- **The popup is a short starter:** visit type (defaults to Follow-up), how it happened, location, date, Chief Complaint, carry forward. The note itself is written on the encounter. Build-enforced that S/O/A/P boxes, vitals and coding do not come back into it.
- **Med rec sits in OpenEMR's Objective** (`OBJECTIVE_SECTIONS`), matching the screen. The old `intervalHistory` key stays valid so stored notes still read.

**Verified:** `test/soap_notes.test.js` (18, `noteLayout` lifted from the page and run); three existing guards repointed, not deleted; 14 of 14 mutations caught; `scripts/verify_note_lifecycle.js` 169/169 through the real routes (new section 17: a telehealth follow-up sent as `hp` with no BP saves as a follow-up, signs, and stamps no initial visit); `scripts/verify_soap_note_render.js` 15/15 in Chromium; full suite 2278, 0 failing; the page compiles.

**Open for the owner:**
- Psych Initial Evaluation still saves as an H&P, so a telehealth one still needs a two-arm BP to sign. Left as is on instruction.
- AWV and TCM keep their own templates but now save as follow-ups (fixes the same BP block). They are not SOAP-grouped.
- The three social work types and the phone call are unchanged.
- The popup now requires a location for an in-person or video visit.
- The time statement could be pre-filled from the Start/End visit stamps later.
