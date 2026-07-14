# GFC Care Platform — Status Audit

**Date:** 2026-07-14
**Auditor:** Claude Code (read-only audit — no application code modified)
**Baseline:** `docs/GFC_SESSION_PLAN.md` (companion: `docs/GFC_App_Build_v2.md`)
**Repo state:** `main` @ `a563c1b`; audit branch `claude/gfc-status-audit-ms4d6v`

---

## Method

- Read `GFC_SESSION_PLAN.md` and `GFC_App_Build_v2.md` for the intended scope of each session.
- Enumerated merged PRs and branches via the GitHub API.
- Grepped the actual application code (`server.js`, `config.js`, `public/*.html`, `public/app.js`) for the endpoints, fields, flags, and modules each session was supposed to add.
- Compared `docs/GFC_Client_Care_Profile_Schema_v1.md` and `docs/GFC_Intake_and_Packet_Spec_v1.md` against `GFC_App_Build_v2.md` and against the code to flag spec drift.

**Status legend:** BUILT = merged and present in code · IN PROGRESS = partially present or ops-in-flight · PENDING = spec/reference only, no code · BLOCKED = gated on an unbuilt prerequisite.

---

## Evidence base

### Merged PRs (all merged to `main`)

| PR | Title | Session | Merged |
|---|---|---|---|
| #1 | Reorganize documentation into `docs/` | — | 2026-06-10 |
| #2 | Repo prep, rebrand, role model | 1 | 2026-06-10 |
| #3 | (rebrand continuation) | 1 | 2026-06-10 |
| #4 | Add prototype visual references | — | 2026-06-10 |
| #5 | Strip lab features, deactivate tracker, brand cleanup | 2 | 2026-06-10 |
| #6 | Client portal + enrollment gate | 3.1 | 2026-06-10 |
| #7 | Gated enrollment intake (Stage 2) | 3.2 | 2026-06-24 |
| #8 | Docs refresh — intake v1.1, App Build v2, Session Plan | — | 2026-06-24 |

> Note: the GitHub `minimal_output` list reports `merged:false` for these, but every one carries a `merged_at` timestamp — they are merged. The `merged:false` flag is unreliable in minimal mode.

### Branches present

`main`, `claude/determined-brown-ow99cd` (S1), `claude/serene-einstein-4i7jpr` (S2), `claude/nifty-faraday-b1i84b` (S3.1 + docs), `session/03-enrollment-intake` (S3.2), `docs/prototype-refs`, `claude/gfc-status-audit-ms4d6v` (this audit). No branch exists for any session ≥ 3.3.

---

## Per-session status

### Session 0 — Infra (AWS + OpenEMR + BAAs) — **IN PROGRESS (ops, not code-verifiable)**
- **Evidence:** No OpenEMR/FHIR client, OAuth2 config, or RDS wiring anywhere in the codebase. This is an operations track; the repo cannot confirm it.
- **Drift:** Docs (`SESSION_PLAN` 🟡, `App Build v2` §15) say OpenEMR is live with configs open. Consistent with "no integration code yet." No action for the codebase; tracked externally.

### Session 1 — Repo prep · rebrand · role model — **BUILT**
- **Evidence:** PRs #2/#3 merged. `config.js` defines a frozen `ROLES` map — `admin`, `user`, `client`, `vendor`, `case_manager`, `family` (6 roles). Brand tokens `public/css/gfc-tokens.css`, GFC assets under `public/brand/`, `COMPANY_NAME`/emails rebranded.
- **New role fields present:** `hasClinicalAccess`, `licenseLevel`, `enrollmentStatus`, `careTeam` all read/written in `server.js` (user create/update routes).
- **Drift:** `hasBillingAccess` is **absent from the code** (see Spec Drift #2). The 2 future roles (`owner`, `billing`) are correctly not built.

### Session 2 — Strip lab features · deactivate tracker · brand cleanup — **BUILT & MERGED**
- **Evidence:** PR #5 merged; ~8 `Session 2:` commits on `main` (inventory, validation reports, soft-pilot, knowledge hub, link-directory removed; tracker deactivated; brand strings fixed). `docs/strip-list.md` carries an execution-status section.
- **⚠️ STATUS DRIFT:** Both `GFC_SESSION_PLAN.md` (line 14) and `CLAUDE.md` still mark Session 2 as **"📄 Prompt ready"** — it is done and merged. This is the single most misleading status entry in the plan.
- **Known partial follow-ups (from PR #5, still open):** dormant validation components in `public/service-portal.html` (`DailyLogSection`, `ViewValidationPage`, `ContinueValidationPage`, `isValidation` branches) not fully excised; lab HubSpot connector kept dormant rather than removed.

### Session 3.1 — Client portal + enrollment gate — **BUILT**
- **Evidence:** PR #6 merged. `server.js`: `requireEnrolledClient` middleware (default-deny), ungated `GET /api/gfc/me`, gated `/api/gfc/care-plan|visits|messages|documents`. Family access gated on `consents.roiFamily === 'signed'` with no override. `public/portal.html` renders `GfcClientPortal`.

### Session 3.2 — Gated enrollment intake + consents — **BUILT**
- **Evidence:** PR #7 merged. `server.js`: `requireClientForIntake`, `GET/POST /api/gfc/intake`, `POST /api/gfc/consents`, `POST /api/gfc/intake/submit` (flips `intake_pending → intake_complete`). `GFC_CONSENT_DEFS` branches PHC vs IHPC (`financialAgreement`, `pcaScope` vs `consentToTreat`, `assignmentOfBenefits`, `practiceNpp`). Structured medication rows, DOB→age derivation, `payer` passthrough. `GfcIntakeFlow` wizard in `portal.html`.
- **Drift:** Consent set includes `roiFamily` + `roiProvider` but **not** `roiTransfer` (that is Session 3.4, correctly absent). `careTier` still uses the 1/2/3 vocabulary (see Spec Drift #1).

### Session 3.3 — Staff enrollment-submissions view — **PENDING**
- **Evidence of absence:** No staff-facing enrollment/submissions review view and no `/api/gfc/admin` enrollment-review endpoint. The only related artifact is an `intake_complete` `<option>` in the admin-hub user-status dropdown (`public/admin-hub.html:1533`) — a user-status filter, not a submissions queue.
- **Verdict:** Not started. Matches `SESSION_PLAN`/`CLAUDE.md` (⬜ Pending).

### Session 3.4 — Transfer-of-Care Provider ROI — **PENDING**
- **Evidence of absence:** No `roiTransfer` in `GFC_CONSENT_DEFS`, no `priorProviders` field, no canvas signature capture, no per-provider PDF generation, no `/api/gfc/roi*` route. (The one `canvas`-signature grep hit in `server.js` is the existing `SignaturePad`, unrelated.)
- **Staged for build:** Reference forms `docs/gfc_roi_upload.gs` and `docs/template-gfc-roi-upload.php` are present, plus the paste-ready prompt `docs/GFC_Session3.4_ClaudeCode_Prompt.md`.
- **⚠️ PATH DRIFT:** `CLAUDE.md` and `SESSION_PLAN` §Detail reference these as `docs/source-forms/gfc_roi_upload.gs` and `docs/source-forms/template-gfc-roi-upload.php`, but they actually live at **`docs/` root**, not in `docs/source-forms/` (which holds `gfc-visit-log.html` and `template-gfc-intake-3.php`).

### Session 4 — Clinical / In-Home Primary Care + OpenEMR (4.1/4.2/4.3) — **PENDING**
- **Evidence of absence:** Zero OpenEMR / FHIR / OAuth2 references in `server.js`. No clinician workspace (4.1), no OpenEMR-tied scheduling (4.2), no patient clinical read (4.3). The only clinical hook is the `openEmrPatientId` field in the *schema doc* — not in code.
- **Verdict:** Marked "Next priority" in the plan; nothing built.

### Session 5 — Clinical HIPAA go-live — **PENDING (blocked on 4 + infra)**
- **Evidence of absence:** No AWS-boundary migration, no MFA enforcement, no PII-scrubbed logging, no dedicated `audit_log` persistence. `server.js` has a `logActivity()` activity trail but not the HIPAA audit-log store the plan and `CLAUDE.md` require (see Spec Drift #6).

### Session 6 — Caregiver app (PHCP) — **PENDING**
- **Evidence:** Prototype only (`docs/prototype/caregiver-app-prototype.html`, `docs/source-forms/gfc-visit-log.html`). No caregiver workspace code, no tier-branched visit log.

### Session 7 — Scheduling · availability · time tracking (PHCP) — **PENDING**
- **Evidence of absence:** No availability submission, open-shift, GPS clock-in/out, or payroll-export code.

### Session 8 — Matching engine (PHCP) — **PENDING**
- **Evidence:** Spec only (`docs/GFC_Matching_Engine_Spec_v1.md`). No matching code; the shared client/caregiver enums the spec depends on are not yet both present in code.

### Session 9 — Messaging module — **PENDING**
- **Evidence:** Only the `GET /api/gfc/messages` fixture stub from 3.1 exists. No structured channel matrix, role-based visibility, or escalation events.

### Session 10 — Family portal — **PENDING (gate scaffold only)**
- **Evidence:** The ROI-family gate for the `family` role exists in `requireEnrolledClient` (`server.js:2090`), so the access-control scaffold is in. The read-only monitoring feed itself is not built.

### Session 11 — RPM / Continuous Care — **PENDING**
- **Evidence:** Monitoring consent is present but inactive (Track C flag / `na`). No RPM scaffold code.

### Session 12 — Audit log UI + final HIPAA review — **PENDING**
- **Evidence:** `logActivity()` exists as a backend trail; no audit-log UI, no final-review artifacts.

### B-series — Billing (Track D) — **PENDING**
- **Evidence of absence:** No `hasBillingAccess`, no `gfc_payer_credentialing`, no `client_rate_overrides`, no Availity/Stripe billing integration, no eligibility (270/271) or claim (837/835) code in `server.js`. The `payer` object is stored as an intake passthrough only (`server.js:5230`) — the expanded eligibility/`stripeCustomerId` structure from the schema doc is not enforced or populated.
- **⚠️ MISSING SPEC:** `GFC_App_Build_v2.md` and `CLAUDE.md` reference `GFC_Billing_Architecture_Spec_v1.md` as the source of truth for B-series prompts. **This file does not exist in `docs/`.**
- Stripe string matches elsewhere in the repo (`public/changelog.html`, `public/service-portal.html`, login/reset pages) are legacy/unrelated, not billing implementation.

### E-series — IME / C&P (Track E) — **PENDING**
- **Evidence:** No code. Scope defined only in `App Build v2` §14. No exam-capture, scheduling, or hours-rollup implementation.

---

## Status summary

| Session | Plan says | Actual | Match? |
|---|---|---|---|
| 0 | 🟡 In progress | IN PROGRESS (ops) | ✅ |
| 1 | ✅ Done | BUILT | ✅ |
| 2 | 📄 Prompt ready | **BUILT & MERGED** | ❌ plan stale |
| 3.1 | ✅ Done | BUILT | ✅ |
| 3.2 | ✅ Done | BUILT | ✅ |
| 3.3 | ⬜ Pending | PENDING | ✅ |
| 3.4 | ⬜ Pending | PENDING | ✅ |
| 4 | ⬜ Next priority | PENDING | ✅ |
| 5 | ⬜ Planned | PENDING (blocked) | ✅ |
| 6 | ⬜ Planned | PENDING | ✅ |
| 7 | ⬜ Planned | PENDING | ✅ |
| 8 | ⬜ Planned | PENDING | ✅ |
| 9 | ⬜ Planned | PENDING | ✅ |
| 10 | ⬜ Planned | PENDING (gate scaffold) | ✅ |
| 11 | ⬜ Planned | PENDING | ✅ |
| 12 | ⬜ Planned | PENDING | ✅ |
| B-series | ⬜ Planned | PENDING | ✅ |
| E-series | ⬜ Planned | PENDING | ✅ |

**One status error in the plan:** Session 2 is marked "Prompt ready" but is fully merged.

---

## Spec-doc drift

### 1. Care-tier vocabulary — three-way inconsistency (highest-impact)
- **Intake spec v1.1** (`GFC_Intake_and_Packet_Spec_v1.md`) retired "Tier/Triage Level" in favor of the canonical **Track A (A1–A4) / Track B** enum (§3.2, and its header note).
- **Client schema doc** (`GFC_Client_Care_Profile_Schema_v1.md:25`) **still** defines `careTier: "1|2|3"` (Essential ADL / Comprehensive / Behavioral).
- **Code** (`server.js:4940` `CARE_TIER_LABELS`) also still uses 1/2/3.
- PR #8 explicitly flagged the code reconcile ("shipped 3.2 code still uses `CARE_TIER_LABELS`; reconcile to Track A/B in 3.3/Session 4"). The **client schema doc was not updated in that same pass**, so it now disagrees with the intake spec it is supposed to align with. Recommend reconciling the schema doc + code to Track A/B together.

### 2. `hasBillingAccess` — claimed scaffolded, not in code
- **`CLAUDE.md`** ("Recent decisions"): *"Owner role and Billing/Coder role scaffolded via `hasBillingAccess` flag. Admin holds the flag for now."* This reads as already-in-code.
- **`App Build v2` §4** is more careful: the flag is *"scaffolded so `hasBillingAccess` reads cleanly … Not built now."*
- **Code:** `hasBillingAccess` appears **nowhere** in `server.js` or `config.js`. Only `hasClinicalAccess` exists. The flag is aspirational, not scaffolded. Recommend softening the `CLAUDE.md` wording to "planned" until B-series lands.

### 3. ROI reference-file paths wrong in the running docs
- `CLAUDE.md` and `SESSION_PLAN` cite `docs/source-forms/gfc_roi_upload.gs` and `docs/source-forms/template-gfc-roi-upload.php`. The files are actually at `docs/gfc_roi_upload.gs` and `docs/template-gfc-roi-upload.php` (repo `docs/` root). Either move the files into `source-forms/` or fix the references.

### 4. Missing billing architecture spec
- `GFC_Billing_Architecture_Spec_v1.md` is named as the B-series source of truth in both `CLAUDE.md` and `App Build v2`, but the file does not exist. B-series cannot start against a spec that isn't written.

### 5. `audit_log` requirement not yet met
- `CLAUDE.md` ("Environment reminders"): *"Every PHI access writes to `audit_log`."* Code implements a general `logActivity()` trail, not a dedicated `audit_log` persistence layer. This is expected (Sessions 5/12 own it) but the reminder is stated as a current invariant when it is a future one — worth noting so it isn't mistaken for an existing guarantee.

### 6. Merged-PR numbers unknown in `CLAUDE.md`
- The `CLAUDE.md` status table lists merged PRs for Sessions 1, 3.1, 3.2 as "?". From this audit: Session 1 = **PR #2**, Session 3.1 = **PR #6**, Session 3.2 = **PR #7**, Session 2 = **PR #5**. These can be filled in.

---

## Recommended doc fixes (no code changes implied)

1. Flip Session 2 to ✅ (merged, PR #5) in `SESSION_PLAN.md` and `CLAUDE.md`.
2. Reconcile `GFC_Client_Care_Profile_Schema_v1.md` `careTier` to Track A/B to match intake spec v1.1 (and schedule the matching code change for 3.3/Session 4 as PR #8 noted).
3. Soften the `hasBillingAccess` "scaffolded" claim in `CLAUDE.md` to "planned."
4. Fix the ROI reference-file paths (or relocate the files into `docs/source-forms/`).
5. Note `GFC_Billing_Architecture_Spec_v1.md` as *to be written* (it's implied to exist).
6. Fill in the known merged-PR numbers in the `CLAUDE.md` table.

_This audit made no changes to application code. It only reports the observed state of the repository as of 2026-07-14._
