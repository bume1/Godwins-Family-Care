# Session 8 — Claude Code Prompt
## Matching engine (PHCP) — caregiver ↔ client, two-stage, explainable

**Prerequisite:** **Sessions 6 AND 7 merged.** Not parallel-safe — this session reads the caregiver profiles Session 6 populates and the availability Session 7 collects. Running it early produces an engine with nothing to rank.
**Model:** Opus.
**Spec:** `docs/GFC_Matching_Engine_Spec_v1.md` (normative) · `docs/GFC_Client_Care_Profile_Schema_v1.md` · `docs/GFC_Caregiver_Profile_Schema_v1.md`.
**Build target:** the staff Care Match screen in `docs/prototype/phcp-portal-prototype.html`.
**Important:** TEST DATA ONLY.

---

## Paste this into Claude Code

```
You are continuing the GFC Care Platform build. Read CLAUDE.md first and honor
its prerequisite gate. Sessions 6 and 7 must both be merged — if either is not,
STOP and tell Bianca. TEST DATA ONLY.

Branch: session/08-matching (or harness-assigned)

Read first, in full:
- docs/GFC_Matching_Engine_Spec_v1.md — NORMATIVE. §2 hard filters, §3 weighted
  factors, §4 tier profiles, §5 scoring formula, §6 output, §7 override/audit
- docs/GFC_Client_Care_Profile_Schema_v1.md — §2 shared vocabularies, §3 lift
  mapping, §4 temperament rule map
- docs/GFC_Caregiver_Profile_Schema_v1.md
- Session 7's availability store and Session 6's caregiver records
- The staff Care Match screen in docs/prototype/phcp-portal-prototype.html

ARCHITECTURE
Deterministic and explainable. NO machine learning in v1. Every score must be
reproducible from stored inputs and every ranking must show its reasons. If a
match cannot be explained in one screen, it is wrong.

The client and caregiver schemas share enums deliberately (§2 of the client
schema) so comparison is exact, not fuzzy. Do not normalize or fuzzy-match
across them — if a value does not compare cleanly, that is a data problem to
report, not to paper over.

SCOPE

A. Stage 1 — hard filters (spec §2)
All must pass or the caregiver is excluded from the pool entirely, with the
failing filter recorded:
- License/scope sufficient for the client's skilledTasksNeeded
- liftCapacity >= the client's transferNeed (mapping in client schema §3)
- Required credentials present and unexpired
- Geography within the configured radius
- Availability overlaps the requested schedule (from Session 7)
- Strong genderPreference and languagePreference honored when strength is
  "strong"

B. Stage 2 — weighted score (spec §3-§5)
Rank the eligible pool. Factors per spec §3, weights per the tier-adjusted
profiles in §4, formula per §5. Weights are ADMIN-TUNABLE and stored, not
hardcoded — an admin can adjust them and the change is audited.
Temperament uses the rule map in client schema §4, not equality.

C. Output (spec §6)
Per ranked caregiver: the Care Match percentage, the factors that contributed
and their weights, any soft preferences not met, and the hard filters passed.
A human reading one card must understand why this caregiver ranked here.

D. Override and audit (spec §7)
An admin may assign a caregiver the engine did not rank first. Overrides
require a reason and are logged with the ranking that was displayed at the time.
That record is what makes the engine improvable later.

E. Integration
Surface in the staff Care Match screen. Feed the Session 7 shift-assignment
flow: assigning from a ranked list carries the match context onto the shift
record.

DO NOT
- Use ML, embeddings, or any non-deterministic ranking.
- Hardcode weights.
- Fuzzy-match across the shared enums.
- Auto-assign. The engine ranks; a human assigns.
- Build the outcome feedback loop (spec §8) — Phase 2.
- Enter real PHI.

ACCEPTANCE
- A caregiver failing any hard filter is absent from the pool, and the failing
  filter is recorded and displayable.
- Two caregivers with identical inputs score identically. Run the same match
  twice and assert identical output.
- Changing an admin weight changes the ranking predictably, and the change is
  audited.
- Every ranked result renders its contributing factors and unmet soft
  preferences.
- A Tier A4 (behavioral) client and a Tier A1 client with otherwise identical
  needs produce different rankings, per the tier weight profiles.
- An override records the reason and the ranking as displayed.
- Assigning from the ranked list carries match context onto the shift.
- Non-admin roles 403 on the matching routes.
- App boots; Sessions 6 and 7 unaffected.

Update CLAUDE.md AND docs/GFC_SESSION_PLAN.md per the running instruction
(steps 4-7). Open ONE PR titled "Session 8: Matching engine." Stop for review.
```
