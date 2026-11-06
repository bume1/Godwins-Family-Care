# GFC Clinician Training Library

**Version 1.0 draft · November 2026 · First learner: Thanmayie Bethi, FNP-BC, PMHNP-BC**
**Feeds:** the Training step of the GFC app onboarding wizard
**Built on:** the Clinical Policies and Procedures Manual GFC-CLIN-v2.0 and GFC Clinical SOPs, Set 1

---

## 1. How the training works

Every module follows the same pattern. Research on long-term retention supports each part of it.

1. **Learn.** One workflow per module. 10 to 15 minutes. Video, SOP, and any resources in one place.
2. **Check.** Two or three scenario questions at the end. The correct answer and the reason show right after she answers.
3. **Do.** Hands-on workflows are demonstrated, then done while someone watches, then signed off.
4. **Keep.** The app re-asks one or two questions from the module at day 3, 10, 30, and 90. A wrong answer sends her back to that module.

The manual says what the rule is. The SOP says how to do it in our systems. The module teaches the SOP.

---

## 2. Module record (what the app stores)

Every module uses these fields. Any field can be left blank, and the app hides blank ones.

| Field | Type | Notes |
|---|---|---|
| `id` | text | `TRN-` + number. Never renumbered |
| `title` | text | Plain task name, for example "Order labs and close the loop" |
| `phase` | enum | `WELCOME`, `EXAMS`, `CLINICAL_PREP`, `GO_LIVE`, `FIRST_90` |
| `roles` | list | `NP` today. `RN`, `LMSW`, `CCC`, `CCA`, `CCL`, `EA` reserved |
| `lanes` | list | `CLINICAL`, `EXAMS`, or both. Blank means everyone in the role |
| `credentials` | list | Optional filter, for example `PMHNP` for psych modules |
| `relationship` | list | `W2`, `1099`, `HYBRID`. 1099 modules are framed as standards, never instruction |
| `format` | enum | `VIDEO`, `READ`, `LIVE`, `EXTERNAL`, `OBSERVED`, `SHADOW` |
| `minutes` | number | Estimated time |
| `host` | role | Who leads or signs off. Role names only, mapped to people in settings |
| `video_url` | link | Recorded walkthrough (Drive or Loom) |
| `drive_url` | link | Google Drive folder or file for this module |
| `live_session_url` | link | Google Meet link for a scheduled live session |
| `live_session_time` | datetime | When the live session is booked |
| `external_url` | link | Outside training portal |
| `resources` | list | Extra links: `{label, url}` |
| `sop_refs` | list | SOP IDs this module teaches |
| `manual_refs` | list | Manual section numbers (update after the new manual is final) |
| `checks` | list | 2 or 3 questions: `{prompt, options, answer, why, source}` |
| `spaced_recheck` | list | Default `[3, 10, 30, 90]` days |
| `signoff` | enum | `ATTEST` (she signs), `COUNTERSIGN` (she signs, Clinical Director countersigns), `OBSERVED` (observer signs after watching), `NONE` |
| `unlocks_after` | list | Module IDs that must be done first |
| `feeds_gate` | list | Playbook gate this counts toward: `G1`, `G2`, `G3`, `G4` |
| `version` | text | Bumps when the SOP behind it changes, and triggers a re-check |

**Release rule:** modules unlock by phase and by gate, not all at once. She only sees the next few things she needs.

**Question loop:** when she asks something a module doesn't answer, the person who answers logs it on that module. The module gets updated in the next revision.

---

## 3. Module map for Thanmayie

### Phase 1 · WELCOME (now, while Core paperwork finishes)

| ID | Module | Format | Min | Host | Sign-off | Feeds |
|---|---|---|---|---|---|---|
| TRN-001 | Welcome to GFC: who we are, our service lines, who does what | VIDEO | 15 | Executive Director | ATTEST | G1, G2 |
| TRN-002 | Your Role Card: what you own, what you don't, who to ask, what a good week looks like | READ | 10 | Executive Director | ATTEST | G1, G2 |
| TRN-003 | Our systems: GFC app, e-prescribing, faxing, Google Workspace, phone lines, team chat rules | VIDEO | 15 | Clinical Ops Coordinator | ATTEST | G1, G2 |
| TRN-004 | App tour on first login | In-app | 10 | System | NONE | G1, G2 |
| TRN-005 | Privacy and security in the home and in our systems | VIDEO | 15 | Executive Director | ATTEST | G1, G2 |
| TRN-006 | Clinical Policies and Procedures Manual: read, attest, scenarios | READ | 60 | Clinical Director | COUNTERSIGN | G2 |
| TRN-007 | Home-Based Clinical Care SOP | READ | 20 | Clinical Director | COUNTERSIGN | G1, G2 |

### Phase 2 · EXAMS (starts once the screening application clears)

| ID | Module | Format | Min | Host | Sign-off | Feeds |
|---|---|---|---|---|---|---|
| TRN-101 | What an exam is and isn't: evaluative, no treating, no solicitation | VIDEO | 10 | Executive Director | ATTEST | G1 |
| TRN-102 | VA disability examination training | EXTERNAL | about 1,200 | Self-paced | Certificate upload | G1 |
| TRN-103 | Contractor's required training | EXTERNAL | varies | Self-paced | Certificate upload | G1 |
| TRN-104 | GFC exam workflow: scheduling, check-in, templates, report turnaround, quality review, restricted access | LIVE | 120 | Executive Director | OBSERVED | G1 |
| TRN-105 | Emergent findings during an exam | VIDEO | 10 | Clinical Director | ATTEST | G1 |
| TRN-106 | First exam reports reviewed (first 5) | OBSERVED | n/a | Clinical Director | OBSERVED | Focused review |

### Phase 3 · CLINICAL PREP (runs while the Board reviews her NPA)

Spread over the 4 to 6 week wait, about 2 modules a week. Shadowing is allowed in this phase, as long as she only observes.

| ID | Module | Format | Min | Host | Sign-off | Feeds |
|---|---|---|---|---|---|---|
| TRN-201 | From referral to first visit: acceptance, intake, consents, first visit within the standard | VIDEO | 15 | Clinical Ops Coordinator | ATTEST | G2 |
| TRN-202 | Visit day: itinerary, check-in and check-out, field safety, leaving a visit | VIDEO | 15 | Clinical Director | ATTEST | G2 |
| TRN-203 | Infection prevention and bag technique | VIDEO + OBSERVED | 20 | Clinical Director | OBSERVED | G2 |
| TRN-204 | Bloodborne pathogens (W2) | EXTERNAL | 60 | Self-paced | Certificate upload | G2 |
| TRN-205 | Documentation: note types, required sections, signing within the standard, corrections | VIDEO | 15 | Clinical Director | ATTEST | G2 |
| TRN-206 | Orders and results: ordering, faxed requisitions, results inbox, closing the loop, critical values | VIDEO | 15 | Clinical Ops Coordinator | ATTEST | G2 |
| TRN-207 | Prescribing and refills: scope, e-prescribing handoff, refill rules | VIDEO | 15 | Clinical Director | ATTEST | G2 |
| TRN-208 | Controlled substances: PDMP, Schedule II referral path, treatment agreements | VIDEO | 10 | Clinical Director | ATTEST | G3 |
| TRN-209 | Escalation: when to consult the supervising physician, urgent clinical line, change in condition | VIDEO | 10 | Clinical Director | ATTEST | G2 |
| TRN-210 | Medical emergencies in the home | VIDEO | 10 | Clinical Director | ATTEST | G2 |
| TRN-211 | Psych risk assessment, safety planning, and crisis response | VIDEO | 20 | Clinical Director | ATTEST | G4 |
| TRN-212 | Psych visit workflow and note set | VIDEO | 15 | Clinical Director | ATTEST | G4 |
| TRN-213 | Care management programs: consent, who does what, time logging | VIDEO | 15 | Clinical Ops Coordinator | ATTEST | G2 |
| TRN-214 | Transitions of care: discharge follow-up, med reconciliation | VIDEO | 10 | Clinical Ops Coordinator | ATTEST | G2 |
| TRN-215 | Coding and billing integrity | VIDEO | 15 | Executive Director | ATTEST | G2 |
| TRN-216 | Mandatory reporting | VIDEO | 10 | Clinical Director | ATTEST | G2 |
| TRN-217 | Incidents and near misses: what to report and how | VIDEO | 10 | Clinical Director | ATTEST | G2 |
| TRN-218 | Telehealth visits | VIDEO | 10 | Clinical Director | ATTEST | Telehealth privilege |
| TRN-219 | Shadow home visits (2 to 3 visits, observing only) | SHADOW | n/a | Clinical Director | OBSERVED | G2 |
| TRN-220 | Point-of-care testing and home equipment competency | OBSERVED | 30 | Clinical Director | OBSERVED | G2 |

### Phase 4 · GO-LIVE (first clinical patients, once the NPA is approved)

| ID | Module | Format | Host | Sign-off |
|---|---|---|---|---|
| TRN-301 | Live clinical session: protocol judgment and a real chart walked together | LIVE (about 2 hours, on site) | Executive Director hosts, Clinical Director leads | OBSERVED |
| TRN-302 | Paired first visits, same-day debrief | OBSERVED | Clinical Director | OBSERVED |
| TRN-303 | Chart review on every early encounter (first 30 days or first 10 per new privilege) | OBSERVED | Clinical Director | OBSERVED |
| TRN-304 | Workflow sign-offs: each Phase 3 hands-on workflow marked independent | OBSERVED | Clinical Director | OBSERVED |

### Phase 5 · FIRST 90 DAYS

| ID | Item | When | Host |
|---|---|---|---|
| TRN-401 | Week-one check-in | Day 5 | Executive Director |
| TRN-402 | Check-ins every two weeks, 30 minutes | Through day 90 | Clinical Ops Coordinator |
| TRN-403 | 30-day review: friction and what's unclear | Day 30 | Executive Director |
| TRN-404 | 60-day review: coaching | Day 60 | Clinical Director |
| TRN-405 | 90-day review: performance and scope | Day 90 | Clinical Director, Executive Director |
| TRN-406 | Spaced re-checks running in the background | Day 3, 10, 30, 90 per module | System |

### Annual

Refreshers for privacy, infection prevention, emergencies and crisis response, documentation and coding, and bloodborne pathogens. Plus any module whose SOP changed that year.

---

## 4. What she sees vs what admin sees

**Clinician view:** "Up next" (2 or 3 modules), her live sessions with the Meet link and time, her progress by phase, and the re-check questions due today.
**Admin view:** completion and scores per module, missed re-checks, sign-offs waiting, questions logged per module, and which gate each open module is holding up.

---

## 5. Measures

| Measure | Source |
|---|---|
| Module completion and check scores | App |
| Re-check accuracy at day 30 and 90 | App |
| Notes signed on time | Chart data |
| Orders closed, results acknowledged on time | Chart data |
| Chart review findings in the first 30 days | Focused review log |
| Questions logged per module (should fall over time) | App |

---

## 6. Recording plan (how your way gets captured once)

For each video module, record your screen while doing the real task and talking through it (10 to 15 minutes, nothing scripted). Upload it to the module's Drive folder. The transcript becomes the SOP draft, the checklist, and the check questions. Each recording only has to be made once, and is redone only when the workflow changes.

Suggested recording order, matched to when she needs them:
1. TRN-003 Our systems
2. TRN-104 GFC exam workflow
3. TRN-205 Documentation
4. TRN-206 Orders and results
5. TRN-207 Prescribing and refills
6. TRN-209 Escalation

---

# GFC SOP Template

Every SOP uses this shape so staff always know where to look.

```
SOP-[AREA]-[NUMBER]  ·  [Task name]
Version · Effective date · Owner · Policy reference (manual section)

PURPOSE         One sentence: what this SOP gets done
APPLIES TO      Roles and lanes
WHEN            The trigger that starts it
WHO             Role for each step (clinician, coordinator, physician)

STEPS           Numbered, one action each, written in our systems
                (which screen, which button, which form)

DONE MEANS      How you know it's complete
                (for example: note signed, result acknowledged, patient contacted)

TIME STANDARD   The deadline, if one applies

ESCALATE IF     What triggers a call, and to whom

COMMON MISTAKES  Two or three real ones, added as they happen

RELATED         Other SOPs, forms, training module ID
```

## Planned SOP set (to be written from the updated manual)

| SOP | Task | Module |
|---|---|---|
| SOP-SYS-01 | Systems access, logins, and devices | TRN-003 |
| SOP-SYS-02 | Team communication: what goes where | TRN-003 |
| SOP-PRV-01 | Privacy in the home and in our systems | TRN-005 |
| SOP-EXM-01 | Exam day, from schedule to submitted report | TRN-104 |
| SOP-EXM-02 | Emergent findings during an exam | TRN-105 |
| SOP-PAT-01 | Referral to first visit | TRN-201 |
| SOP-VIS-01 | Visit day and field safety | TRN-202 |
| SOP-VIS-02 | Infection prevention and bag technique | TRN-203 |
| SOP-DOC-01 | Documenting and signing a visit | TRN-205 |
| SOP-DOC-02 | Late entries and corrections | TRN-205 |
| SOP-ORD-01 | Placing an order and sending the requisition | TRN-206 |
| SOP-ORD-02 | Results inbox and critical values | TRN-206 |
| SOP-RX-01 | Prescribing and the e-prescribing handoff | TRN-207 |
| SOP-RX-02 | Refill requests | TRN-207 |
| SOP-RX-03 | Controlled substances | TRN-208 |
| SOP-ESC-01 | Consulting the supervising physician | TRN-209 |
| SOP-ESC-02 | Urgent clinical line and change in condition | TRN-209 |
| SOP-EMR-01 | Medical emergency in the home | TRN-210 |
| SOP-BH-01 | Suicide and violence risk, safety planning, crisis | TRN-211 |
| SOP-BH-02 | Psych visit workflow | TRN-212 |
| SOP-CM-01 | Care management enrollment and time logging | TRN-213 |
| SOP-TOC-01 | Discharge follow-up | TRN-214 |
| SOP-BIL-01 | Coding and claim readiness | TRN-215 |
| SOP-RPT-01 | Mandatory reporting | TRN-216 |
| SOP-INC-01 | Reporting an incident or near miss | TRN-217 |
| SOP-TH-01 | Telehealth visit | TRN-218 |
