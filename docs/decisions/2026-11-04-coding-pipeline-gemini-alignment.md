# The AI coding pipeline, brought in line with the Gemini rules

Owner request, 2026-11-04: fix the places where `GFC_AI_Coding_Pipeline_ClaudeCode_Spec.md` conflicts with the Gemini rules in `2026-10-12-gemini-and-meet.md`. Stacked on the Phase 1 and Phase 2 work (`2026-11-04-claim-scrub-phase-1.md`, `2026-11-04-mdm-fact-extraction-phase-2.md`).

**1. A counted fact comes from this visit's note, never the chart's lists.** (Changed in code.)
- Only the note and the encounter's own fields count as this visit's documentation (`section.documentation: true`). The problem and medication lists are still sent as context, but a quote found only there is dropped and counted as `notFromNote`. A problem sitting on the list that nobody addressed today must not raise the level.
- The model's instruction says the same, and the server enforces it after the model regardless.
- Nothing is kept "unverified" any more. Every fact that survives was found word for word in the note.

**2. Documents attached to the visit are not sent for coding.** (Changed in code.)
- Coding is payment, not treatment. An attached document is where a 42 CFR Part 2 record received for treatment would sit, and the chart review's Part 2 allowance covers treatment only.
- They could not supply a counted fact anyway, because their words cannot be checked against the note. If the note says an outside record was reviewed, the note's own sentence is the quote.
- **Open for the owner:** the problem list can carry a diagnosis that came from a Part 2 record. It is context only and cannot be quoted, but confirm with counsel that sending it for a payment purpose is covered by the patient's consent.

**3. Billing staff never run the model; signing starts it.** (Changed in code.)
- The Gemini rules let only licensed clinicians run the model. A biller (admin or manager) cannot.
- So a **billable** signature (a provider's or LCSW's sign, or the clinician addendum on an RN or LMSW author note) starts the extraction automatically, with the signing clinician as the actor. An author signature does not. The addendum does.
- It is best-effort and silent. The model being off, or any failure, never touches the signature, and nothing about it appears on the clinician's screen. The row records `trigger: 'signed'` or `'manual'`.
- The button route stays for a re-run, and both go through one `startMdmExtraction`, so the refusals cannot drift.

**4. The 180-day purge must not take the audit defense with it.** (A rule for Phase 3; nothing to change yet.)
- The raw extraction is a model draft. It stays in `ai_reviews` and is purged at 180 days like every review.
- **Phase 3 must not ship without this:** when the clinician confirms, the extracted facts (copied from the draft), the confirmed facts, the derived and final level, who confirmed, when, and any override go into their own durable coding-audit record. That record is kept for as long as claim records are kept, never on the AI purge schedule. Medicare can look back years, not six months.

**5. Phase 4.1 (diagnosis suggestion) changes design.** (Spec change; Phase 4 is not built.)
- As written, 4.1 has Gemini propose ICD-10 codes. That is code selection, which decision 9 forbids, and the spec's own claim that Phase 4 does not depend on the decision change was wrong for 4.1.
- **Instead:** Gemini extracts diagnosis wording with a quote from the note, under the same note-only rule as above. The app looks the wording up in OpenEMR's ICD-10 table without a model, and the clinician picks the code. The model still never names a code, and 4.1 then needs no decision change.

**Must not undo:** the note-only quote rule, documents left out of coding, the model never run as billing staff, and the separate durable audit record in Phase 3.

**Verified:** `test/mdm_extraction.test.js` 26 tests, with six new ones on these rules. Five mutations, each caught: lists counted as the note, the note not marked as documentation, the sign hook disabled, the addendum hook removed, and documents sent again. Full suite 2,825 passing and 0 failing. `scripts/verify_note_lifecycle.js` 223/223 over real HTTP. **Not proven here:** Gemini's actual output on a real note, since no Google credential reaches this sandbox.
