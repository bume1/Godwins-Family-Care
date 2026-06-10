# GFC Caregiver–Client Matching Engine — Spec v1

Deterministic, explainable, admin-tunable. No machine learning in v1 (no outcome data yet, and a black box is a liability for elder care). Ranks caregivers for a given client.

---

## 1. Model: two stages

1. **Hard filter** — build the eligible pool. Pass/fail. Safety, license, logistics. Never traded against fit.
2. **Weighted rank** — score the eligible pool 0–100 and order it. The percentage on the Care Match card.

---

## 2. Stage 1 — hard filters (all must pass)

| Filter | Rule | Source |
|---|---|---|
| Lift / transfer capacity | Caregiver capacity ≥ client need (1-person / 2-person / mechanical lift) | client assessment ↔ caregiver profile |
| Skilled-task scope | Every required skilled task within caregiver license + competency | client intake ↔ caregiver competency |
| Credentials current | Cert, background check, TB/health clearance, CPR/BLS not expired | caregiver profile |
| Behavioral clearance | Behavioral/dementia cert present when client has aggression, wandering, or self-harm risk | client assessment ↔ caregiver training |
| Geography | Client within caregiver service radius | both |
| Availability | Caregiver covers the requested shift pattern | client request ↔ caregiver availability |
| Hard preference | Client "strong preference" gender or English-only, when set at that strength | client preference ↔ caregiver attribute |

Empty eligible pool → escalate to admin. Relax soft constraints, never hard ones.

---

## 3. Stage 2 — weighted factors

Each scores 0–1, times weight, summed. Defaults sum to 100. Weighted toward the evidence-backed levers (continuity, condition-specific training).

| Factor | Measures | Weight | Scored 0–1 by |
|---|---|---|---|
| Continuity | Prior visits with this client; consistency | 20 | prior-visit count, capped |
| Condition-specific experience | Dementia, post-stroke, behavioral matched to diagnoses | 20 | overlap client conditions ↔ caregiver tags |
| Schedule fit | Quality of availability overlap; full-pattern coverage | 15 | % of requested hours coverable |
| Proximity | Travel distance (lateness, turnover) | 12 | distance banded to a 0–1 curve |
| Personality fit | Client temperament vs caregiver temperament | 10 | rule map (e.g. anxious ↔ calm/patient) |
| Language / cultural | Shared language or cultural preference | 8 | match / partial / none |
| Gender preference | Soft preference (not the hard "strong" version) | 6 | match / no |
| Interests / rapport | Shared interests, conversational fit | 5 | overlap count, capped |
| Reliability history | Attendance, no early terminations, family ratings | 4 | rolling performance score |

---

## 4. Tier-adjusted weight profiles
Store a weight set per care tier, not one global set.
- **Tier 3 (behavioral/cognitive):** raise condition-specific experience and personality, lower proximity.
- **High physical need:** raise continuity and reliability.
- **Tier 1 (essential ADL):** defaults.
Admin can edit any profile.

---

## 5. Scoring formula

```
eligible = caregivers where ALL hard filters pass
for each caregiver c:
    available  = factors with data present for c
    W          = sum of weights of available factors      # renormalize for missing data
    FitScore_c = 100 * ( Σ_{i in available} score_i(c) * weight_i ) / W
rank eligible by FitScore_c desc
```

- **Missing data:** factor dropped, its weight redistributed across present factors (the `/ W` renormalization). Match flagged `confidence: partial` when a meaningful share of weight was missing.
- **Output percentage** = `round(FitScore_c)`.
- **Ties:** break by continuity, then reliability, then proximity.

---

## 6. Output (per ranked caregiver)
```
{
  caregiverId,
  fitScore,                 // 0–100, the card percentage
  confidence: 'full'|'partial',
  topReasons: [             // the card tags — top contributors
    { factor: 'Condition-specific experience', signal: 'Dementia · overnight' },
    { factor: 'Personality fit', signal: 'Calm match for anxious client' },
    { factor: 'Schedule fit', signal: 'Covers full overnight pattern' },
    { factor: 'Proximity', signal: '12 mi away' }
  ],
  passedFilters: [...]       // for audit / override review
}
```
`topReasons` = factors ranked by their `score × weight` contribution. This is what makes the match explainable and overridable.

---

## 7. Override and audit
Admin or Clinical can override the ranking and assign anyone in the eligible pool. Override is logged (who, when, chosen vs recommended, optional reason). Cannot override a hard filter — that would assign an unsafe or unlicensed match.

---

## 8. Outcome feedback loop (Phase 2)
Log every assignment's outcome: retention length, incidents, early termination, family rating. Periodically tune weights against what predicted good outcomes. This is the path from rule-based to genuinely "smart." Not in v1.

---

## 9. Dependencies
- **Client care profile** (from intake/assessment): ADL/lift need, skilled tasks, behavioral/cognitive, diagnoses, schedule, geography, temperament, language, gender preference.
- **Caregiver profile schema** — the data this engine reads. Mirror the client fields so they compare cleanly. *(Next deliverable.)*

## 10. Non-goals (v1)
No ML. No automatic assignment without human confirm. Deterministic and auditable only.
