# The most accurate supported level, and pre-filled claim lines

Owner decision, 2026-11-04, after a real-patient test came out too conservative: "I don't want a default to lowest code, I want a default to the most likely accurate code and a human biller reviews", and pre-filled claim lines with every applicable code.

**This changes the coding spec's standing constraint "ambiguity resolves downward" and Phase 3.3 "select the lower by default."**

**1. The default is the higher SUPPORTED level** (`emMdm.deriveLevel`).
- When the note states a total time that reaches a higher level than MDM, time is the default. The AMA lets the level be chosen by MDM or by time, whichever the documentation supports higher, so this is the accurate code, not an upcode.
- Choosing time no longer needs a separate clinician affirmation: the time is one of the facts she confirms on the same screen. `chooseMdm` lets her deliberately take the MDM level, recorded as an override. `chooseTime`/`affirmTime` are accepted and ignored so an older page cannot break.
- **What the note does not say is never the default.** The `possible` levels (a "worsening" that might be severe, a new problem whose prognosis is not stated) still only raise `LEVEL_AMBIGUOUS` for the biller. That is the line between accurate and upcoding, and it stays.
- `LEVEL_AMBIGUOUS` still fires whenever the candidates disagree.

**2. Claim lines are pre-filled when the clinician confirms** (`claimPrefill.js`, called from the `em-derivation` route).
- The derived E/M, linked to the visit's first four diagnoses, then every add-on the rules offer: modifiers first (25 when another service shares the date, 93 for audio-only), then the add-on codes re-evaluated (G2211 for continuing care, G0318 with the units the time supports). Applying modifiers first means G2211 is never added beside a -25 home visit.
- Every line it writes is `suggested`. A person's own lines are never touched, and a person's E/M is never replaced. A re-confirmation replaces earlier suggestions instead of stacking.
- **A human biller reviews.** Each suggested line is a `LINE_SUGGESTED` scrub warning and a "Suggested, review" chip on the line. Saving the coding is the acceptance (`buildEncounterServices` keeps no `suggested` key). Modifier 25 still blocks until the clinician records her reason. Nothing posts, submits or releases on its own.

**Verified:** `test/em_derivation.test.js` updated to the new default (28 passing). `test/claim_prefill.test.js` 10 tests over the real add-on rules and scrub. Four mutations each caught: the lower default restored, suggestions stacking, modifiers not applied, and a person's E/M replaced. `scripts/verify_note_lifecycle.js` 257/257 over real HTTP, including the pre-fill and a re-confirmation. Full suite 3,008 passing and 0 failing.

**Open for the owner:** the diagnosis links on a suggested line are the visit's first four diagnoses. The biller should trim them to what each line actually treated.
