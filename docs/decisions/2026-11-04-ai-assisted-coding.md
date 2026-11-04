# AI-assisted coding: rules-based E/M derivation is now permitted

_2026-11-04 · owner decision (directed in session: "phase 3 entirely, go") · changes the Gemini AI Reviewer spec, decision 9 (2026-10-12)_

**The decision before.** Decision 9 of the Gemini AI Reviewer spec, 2026-10-12: "no code or E/M selection."

**1. The decision now.** It is changed to permit **rules-based E/M derivation from model-extracted, clinician-confirmed facts.** A model is still never asked to name a code, never shown one in its prompt, and never returns one (the extraction schema has no code field, build-enforced). Rules in `emMdm.js`, over the verified table in `emLevels.js`, decide the level.

**2. The conditions.** All of them hold, or this decision does not:
- Nothing auto-submits. Every claim lands in the hold queue and a person releases it.
- The clinician confirms **facts**, never a code. The code appears only after confirmation, with a sentence saying how it was reached, and no dollar amount.
- Ambiguity resolves **downward**. The lower candidate is the default. A higher time-based level needs the note to state the time and the clinician to affirm it. Missing evidence raises a `LEVEL_AMBIGUOUS` flag for the coder, stated as an absence, never as advice on what to document.
- The level table carries its sources (`verifiedAgainst`) and a review date (`nextReviewDue: 2027-01-01`).
- Every suggestion and confirmation is logged: what was extracted, what was confirmed, the derived level, the final level, who, when, and whether the clinician chose the non-default level (`em_derivations`, append-only).
- Level distribution is reviewed monthly, per clinician, against the prior month, with the flag rate beside it.

**3. The reason.** No coder is on staff, visits are accumulating undocumented for billing, and the rendering clinician does not select CPT codes. GFC has no PTAN, so no Original Medicare claim can transmit regardless: a coder reviews every batch before any does. Medicare Advantage claims are reviewed by hand.

**4. The sunset.** When a certified coder is hired, they audit a sample monthly, confirm the Phase 4.2 add-on rules, and these conditions are reviewed.
