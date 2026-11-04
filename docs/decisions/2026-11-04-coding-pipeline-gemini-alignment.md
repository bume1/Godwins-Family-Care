# The AI coding pipeline, brought in line with the Gemini rules

Owner request, 2026-11-04: fix the places where `GFC_AI_Coding_Pipeline_ClaudeCode_Spec.md` conflicts with the Gemini rules in `2026-10-12-gemini-and-meet.md`. Stacked on the Phase 1 and Phase 2 work (`2026-11-04-claim-scrub-phase-1.md`, `2026-11-04-mdm-fact-extraction-phase-2.md`).

**1. A fact can be quoted from any text section sent: the note, the encounter's fields, the problem list or the medication list.** (Owner decision, 2026-11-04. Changed in code.)
- An earlier pass in this branch counted only quotes from the note. The owner overruled that: list quotes count too.
- Each kept item carries `quoteSource` (`'note'` or `'list'`), so the confirmation screen and a coder can see which facts rest on the visit's own words. **The Phase 3 screen should show that label.**
- A quote found nowhere is still dropped as invented, and nothing is kept "unverified".
- The risk the owner accepted: MDM counts problems *addressed at the visit*. A list entry alone doesn't show it was addressed, and an auditor reads the note. The label is the safeguard.

**2. Documents attached to the visit are not sent for coding.** (Changed in code.)
- Coding is payment, not treatment. An attached document is where a 42 CFR Part 2 record received for treatment would sit, and the chart review's Part 2 allowance covers treatment only.
- They could not supply a counted fact anyway, because their words cannot be checked against the note. If the note says an outside record was reviewed, the note's own sentence is the quote.
- **Open for the owner:** the problem list can carry a diagnosis that came from a Part 2 record. It can now be quoted for coding, so confirm with counsel that sending it for a payment purpose is covered by the patient's consent.

**3. Billing staff never run the model; signing starts it.** (Changed in code.)
- The Gemini rules let only licensed clinicians run the model. A biller (admin or manager) cannot.
- So a **billable** signature (a provider's or LCSW's sign, or the clinician addendum on an RN or LMSW author note) starts the extraction automatically, with the signing clinician as the actor. An author signature does not. The addendum does.
- It is best-effort and silent. The model being off, or any failure, never touches the signature, and nothing about it appears on the clinician's screen. The row records `trigger: 'signed'` or `'manual'`.
- The button route stays for a re-run, and both go through one `startMdmExtraction`, so the refusals cannot drift.

**4. The app's own audit is the only record of what the model proposed.** (Changed in code.)
- Google-side request logging is off on purpose, so Google cannot reconstruct a proposal. The draft in `ai_reviews` is purged at 180 days and only ever held the facts that survived.
- New collection `coding_audit_events` (PHI, registered in `dataMigration.js`), append-only, with exactly one writer and **never on the AI purge**. Each extraction writes `mdm_extraction_proposed`: the full proposal exactly as the model returned it (dropped items included), what was kept, the drop counts, the source ids, the model id, the invocation id, the clinician and the time. It is written before the draft is marked done.
- **Phase 3 appends to the same collection:** the confirmed facts, the derived and final level, who confirmed, when, and any override. It is kept for as long as claim records are kept.

**5. Phase 4.1 (diagnosis suggestion) changes design.** (Spec change; Phase 4 is not built.)
- As written, 4.1 has Gemini propose ICD-10 codes. That is code selection, which decision 9 forbids, and the spec's own claim that Phase 4 does not depend on the decision change was wrong for 4.1.
- **Instead:** Gemini extracts diagnosis wording with a quote from the note, with a quote, under the same rule as above. The app looks the wording up in OpenEMR's ICD-10 table without a model, and the clinician picks the code. The model still never names a code, and 4.1 then needs no decision change.

**Must not undo:** the `quoteSource` label, documents left out of coding, the model never run as billing staff, and `coding_audit_events` staying append-only and off the purge.

**No change needed, for the record:** the $150/month budget was sized for chart review alone. Extraction now runs on every billable signature, so expect the 50% alert sooner; that alert is not a fault. With caching off, every call pays full input tokens for the same instruction. That doesn't matter at GFC's volume, but revisit it if volume reaches thousands a month.

**Verified:** `test/mdm_extraction.test.js` 28 tests. Mutations, each caught: the note not marked as documentation, the sign hook disabled, the addendum hook removed, documents sent again, list quotes dropped again, the `quoteSource` label dropped, and the full proposal left out of the audit. Full suite 2,827 passing and 0 failing. `scripts/verify_note_lifecycle.js` 223/223 over real HTTP. **Not proven here:** Gemini's actual output on a real note, since no Google credential reaches this sandbox.
