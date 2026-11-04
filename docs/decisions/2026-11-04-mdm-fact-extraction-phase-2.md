# Clinical fact extraction from one note (AI coding pipeline, Phase 2)

_2026-11-04 · owner-directed · spec: GFC_AI_Coding_Pipeline_ClaudeCode_Spec.md, Phase 2_

**What it is.** `POST /api/clinical/patients/:clientId/encounters/:euuid/ai/extract-mdm`, clinical write access. Gemini reads one encounter note and returns facts: problems addressed, data reviewed, risk factors, and any total time stated. **It names no code.** Rules decide a level in Phase 3, after the clinician confirms the facts. The 2026-10-12 "no code or E/M selection" decision is not crossed here.

**How it runs.** The chart review's machinery: the one engine (`modelEngine.js`, new purpose `mdm_extraction`), a declared schema, a background job on an `ai_reviews` row. The existing `GET …/ai/reviews/:id` poll reads it (now carrying `purpose`, `encounterUuid` and `quoteCounts`), and the existing 180-day purge removes it. The encounter record keeps only a pointer, `latestMdmExtractionId`.

**What the model reads.** The note (the app's copy plus OpenEMR's, read by its recorded sid), the visit's structured fields, the problem list, the medication list, and the documents attached to that encounter. A section that could not be read is listed in `unreadable`, never filled another way.

**Must not undo:**
- **The model is shown no code.** Not the service codes, not a modifier, not an ICD-10 code. Diagnoses go in as descriptions only, so nothing in the prompt invites it to support a code already chosen. The schema has no code field (build-enforced), and any key the model adds is dropped by the engine before storage.
- **Every item carries a quote that is really in the note.** No quote: dropped and counted. A quote the text sources do not contain: dropped and counted (an invented quote is an inference wearing a citation). Matching ignores case, curly quotes and spacing, never different words. The one exception: when documents were attached, a quote not found in the text could have come from a document the app cannot read back, so it is kept and marked `quoteVerified: false`.
- **A minute count needs its quote too.** An unquoted or invented time becomes `totalMinutes: null, statementPresent: false`. "No time statement" is itself a fact and needs none.
- **`quote` is not a required schema field, on purpose.** In the shared engine one bad item fails the whole answer, so a required quote would sink the extraction instead of dropping one item.
- **Never written to the chart.** The job makes no OpenEMR write and no record write (build-enforced).
- Refused before anything is gathered: no note (`MDM_NO_NOTE`), a deleted encounter, or the model boundary not configured (`MODEL_BOUNDARY_REFUSED`, with its blockers).

**No screen yet.** The confirmation screen is Phase 3.4 and waits on the written decision change. Any screen that shows this output must say it is an unverified draft not saved to the chart. The GET already returns `notPartOfRecord: true`.

**Verified.** `test/mdm_extraction.test.js` 21 tests, including the job lifted out of `server.js` and run against a fake engine: what reaches the model (no codes), dropped and counted items, no OpenEMR write. 15 mutations, each caught. `scripts/verify_note_lifecycle.js` 223/223 over real HTTP, with the route's refusals. Full suite 2820 pass, 0 fail. **Not proven here:** Gemini's actual output on a real note. No Google credential reaches this sandbox; the admin hub's Run test is the go-live proof, then one extraction on a test encounter.
