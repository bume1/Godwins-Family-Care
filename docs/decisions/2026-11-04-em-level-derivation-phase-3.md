# E/M level derivation from confirmed facts (AI coding pipeline, Phase 3)

_2026-11-04 · owner-directed · rests on `2026-11-04-ai-assisted-coding.md`, which changes decision 9_

**What it is.** The clinician confirms the facts of her own visit; rules derive the E/M level. No model names a code.

- **`emLevels.js`** is the one place the 16 codes, their MDM and their time thresholds live (meet or exceed, never ranges). New lookups: family by setting and patient status, code for an MDM level, level for minutes. A test fails if any other source file holds one of those codes or a level-to-minutes table.
- **`emMdm.js`**: the AMA framework from Table 1 of the AMA 2023 E/M guidelines PDF (cited on each element's scoring function). MDM is the highest level met by two of three elements. Mappings from the confirmed facts, all conservative:
  - Problems: stable = stable chronic illness; worsening = chronic with exacerbation (never "severe", so problems never reach High); new = acute uncomplicated (Low, not "uncertain prognosis"); resolved = minor; unclear = not counted.
  - Data: lab, imaging and outside records count as unique Category 1 items. A GFC prior note is not an external note.
  - Risk: prescription management and SDOH moderate; intensive drug monitoring and hospitalization decisions high; a surgery decision moderate (minor/major not stated); OTC low; "other" unscored.
- **Two candidates.** MDM and time (time only when the note states it). **The lower is the default.** A higher time level is chosen only when the clinician asks for it AND affirms the time explicitly; that is recorded as an override.
- **`LEVEL_AMBIGUOUS`** when the candidates disagree, when missing evidence could change the final level (not merely when a conservative call was made), when the time entered at signing differs from the note's, or when a new-patient visit has a signed GFC visit inside three years (then the established family is used). It carries both candidates, each element's facts with their quotes, and the absences, stated as absences.
- **The flag is the coder's.** Never returned to a clinician (the encounter view and the confirmation response omit it). It persists after release, shows as a scrub warning, lists on the coding queue's **Level Review** tab, and is resolved only by billing with a note, staying on the record resolved. A billed E/M that is not the confirmed level is also a scrub warning.
- **`POST …/encounters/:euuid/em-derivation`** (clinical write; once signed, only the rendering clinician; refused for a credential that does not bill E/M, and after billing submits). The server decides each fact's source (extracted, edited, added) by comparing against the extraction; a quote the page sends that is not the extraction's is not kept.
- **Audit:** every confirmation is an append-only row in `em_derivations` (PHI, registered): extracted facts, confirmed facts, derived level, final level, who, when, override. The activity log carries codes only.
- **Screens.** Clinician: a Visit Facts card (Read My Note, the AI draft notice in full, each fact editable with its quote, Confirm Facts; then the code and the sentence explaining it, and the affirm-time choice when the note supports a higher time level). No dollar amount. Billing: the derived level, both candidates and the flag with a Resolve form, on the Billing card.
- **3.6:** `GET /api/clinical/reports/em-distribution?month=` (billing): per clinician, this month against last, E/M lines per code, the share at the top level, and the flag rate. Shown on the Hold Queue tab.

**Verified.** `test/em_derivation.test.js` 27 tests (the AMA table row by row, the candidates, the flag, the scrub warnings, and the server pieces lifted out of `server.js` and run). 20 mutations, each caught. `scripts/verify_note_lifecycle.js` 243/243 over real HTTP, including the full confirm, affirm, flag, resolve and report path. Full suite 2847 pass, 0 fail.

**Open for the owner:** the mappings above are this build's reading of the AMA table against the Phase 2 fact vocabulary. A certified coder should confirm them at the first audit, as the sunset in the decision change requires.
