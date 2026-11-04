# Diagnosis suggestions and add-on rules (AI coding pipeline, Phase 4)

_2026-11-04 · owner-directed · spec: GFC_AI_Coding_Pipeline_ClaudeCode_Spec.md, Phase 4 · built on the Phase 1–3b branch (PR #228)_

**4.1 Diagnosis suggestions.** `POST …/encounters/:euuid/ai/suggest-diagnoses` (clinical write), a background job on an `ai_reviews` row (purpose `dx_suggestion`), read through the existing poll and purged on the same 180 days. It reads the same note packet as Phase 2, now one shared helper (`gatherEncounterNotePacket`). Rules: `dxSuggestion.js`.
- Gemini proposes **ICD-10-CM codes only**, each with a quote. The instruction forbids CPT, HCPCS, modifiers and levels; the schema has one code field, validated as ICD-10-CM.
- **Dropped and counted:** no quote; a quote not in the note (kept as unverified only when documents were sent); a code not ICD-10 in shape; a code not in OpenEMR's ICD-10 table; a code that could not be checked; a duplicate. Every proposed code is looked up with the clinician's own session.
- OpenEMR's description is shown, not the model's. Unspecified codes are flagged with OpenEMR's more specific siblings.
- **Never written to the chart.** The clinician presses Add on the coding step; the diagnosis is saved only when she saves the coding, with source `ai_suggestion`. Each suggestion is decided (accepted or dismissed) on the review, so what was suggested, what was confirmed, who and when is on record.

**4.2 Add-on rules** (`addOnRules.js`, run inside the claim scrub). Offers are returned beside the findings and **are never applied**; a person adds the code or modifier, or does not.
- **G2211:** offered on a home or office E/M when GFC is the continuing source of care (clinical line, with a care plan or an earlier signed visit). Blocks with no E/M base, and with a modifier-25 base except beside an AWV on an office visit (CMS MLN006764).
- **G0318:** only with 99345 or 99350, only when the level was selected by time. **CMS's thresholds: 140 minutes for 99345, 110 for 99350, one unit at the threshold and one per further 15** (MLN006764, May 2026, Table 4). Offered when supported; billed otherwise it blocks, each case by name. CMS counts time from 3 days before to 7 days after; the app holds the date of service only, so it counts less, never more.
- **Modifier 25:** offered when an AWV or another separately identifiable service shares the date (add-ons do not count). **25, 59, XE, XS, XP and XU block without the rendering clinician's recorded reason** (`POST …/modifier-justification`, the rendering clinician only, text never in the activity log). 59 and the X modifiers are never offered.
- **95** stays automatic for audio-video telehealth; **93** is offered for audio-only, never derived.
- **TCM:** blocks when the discharge, contact and face-to-face dates on record (`PUT …/tcm-dates`, clinical or billing; the face-to-face defaults to the visit date; complexity defaults to the derived MDM) do not support the code billed.
- **AWV:** warns when GFC's history does not support G0438 or G0439, and every such warning points at Palmetto eServices because another practice's claim is not in GFC's records.

**Screens.** Coding step: Suggest Diagnoses From My Note, with the AI draft notice in full, each suggestion's quote, Add and Dismiss. A clinician sees a Modifier Reasons card when a line needs her reason. Billing: the scrub panel lists the offers ("may apply, never added automatically") and a TCM dates form when a TCM code is billed.

**Differs from the spec, on purpose:** the spec put G0318 at "each 15 minutes past 140" for both codes. CMS's own table gives 110 for 99350 and starts the first unit at the threshold. The source wins, as for the AMA table in Phase 3; it is one value in `addOnRules.js` if the owner wants 140.

**Verified.** `test/add_on_rules.test.js` 19 tests, the suggestion job lifted out of `server.js` and run against a fake engine and fake lookups. 23 mutations, each caught. `scripts/verify_note_lifecycle.js` 256/256 over real HTTP, including the modifier-25 reason gate and the suggestion route's refusals. Full suite 2890 pass, 0 fail. **Not proven here:** Gemini's suggestions on a real note.

**Open for the owner:** (1) the G0318 threshold above; (2) a coder confirms every 4.2 eligibility rule at the first audit (spec 4.3); (3) "continuing source of care" is read as clinical line plus a care plan or an earlier signed visit; say if it should be narrower.
