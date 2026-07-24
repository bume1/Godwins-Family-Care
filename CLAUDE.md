# GFC Care Platform — running status
_Last updated: 2026-07-24_

This file is auto-loaded at the start of every Claude Code session. Read it first for current state. Details live in `docs/`.

---

## Current session focus

**Sessions 3.3 and 3.4 — finish Session 3.**
- 3.3: `docs/GFC_Session3.3_ClaudeCode_Prompt.md` (staff enrollment view + offline onboarding + care-tier migration)
- 3.4: `docs/GFC_Session3.4_ClaudeCode_Prompt.md` (Transfer-of-Care Provider ROI)

They are independent and can run in parallel or in either order. Session 4 (clinical + OpenEMR) follows.

---

## Session status

| # | Session | Status | Merged PR |
|---|---|---|---|
| 0 | Infra — AWS + OpenEMR + BAAs | 🟡 OpenEMR live, configs open (v2 §15) | — |
| 1 | Repo prep · rebrand · role model | ✅ Done | #2 (+ #3) |
| 2 | Strip lab features · deactivate tracker · brand cleanup | ✅ Done (incl. 07/2026 cleanup follow-ups) | #5 |
| 3.1 | Client portal + enrollment gate | ✅ Done | #6 |
| 3.2 | Gated enrollment intake + consents | ✅ Done | #7 |
| 3.3 | Staff enrollment view + offline onboarding + care-tier migration | 📄 Prompt ready | — |
| 3.4 | Transfer-of-Care Provider ROI | 📄 Prompt ready | — |
| 4 | Clinical portal + OpenEMR (4.1 clinician workspace, 4.2 clinician scheduling, 4.3 patient portal clinical read) | ⬜ Next priority | — |
| 5 | Clinical HIPAA go-live | ⬜ Planned | — |
| 6 | Caregiver app (mobile, tier-branched visit log) | ⬜ Planned | — |
| 7 | Scheduling · availability · time tracking (PHCP) | ⬜ Planned | — |
| 8 | Matching engine (PHCP) | ⬜ Planned | — |
| 9 | Messaging module (channel matrix) | ⬜ Planned | — |
| 10 | Family portal (read-only, ROI-gated) | ⬜ Planned | — |
| 11 | RPM / Continuous Care scaffold | ⬜ Planned | — |
| 12 | Audit log UI + final HIPAA / BAA review | ⬜ Planned | — |
| B-series | Billing (Track D) — B1 eligibility, B2 patient payments, B3 PHC invoicing, B4 rate card, B5 OpenEMR integration, B6 clearinghouse, B7 IME invoicing | ⬜ Planned — **architecture spec `GFC_Billing_Architecture_Spec_v1.md` to be written before any B-session starts** | — |
| E-series | IME / C&P Track E — exam capture, scheduling, hours rollup | ⬜ Planned — spec per v2 §14 | — |

---

## Recent decisions

**07/2026 — Prototypes updated (late July).**
- Prototypes updated: `client-prototype-full.html` (Session 3 target), `caregiver-app-prototype.html` (Session 6 target), `phcp-portal-prototype.html` (Sessions 3/7/8/10 reference).
- New clinical prototypes are the **Session 4 build targets**: `clinical-emr-prototype-v1.html` (desktop clinician workspace), `clinical-emr-mobile-prototype-v1.html` (mobile), `patient-portal-prototype-v2.html` (patient clinical read).
- Full prototype list with session mapping lives in `GFC_App_Build_v2.md` §Companion specs.

**07/2026 — Offline patients decision.**
- Only 7 legacy paper-packet patients exist; all future patients sign in-app. The AI-extraction offline-reconciliation spec was **shelved** (not built).
- Instead, Session 3.3 includes: `signed_offline` consent status, an admin "Add offline-onboarded patient" form, and a one-shot CSV import script (`scripts/import_offline_patients.js`).

**07/2026 — Scope revision (Track D and Track E added).**
- Product scope now covers PHCP (Track A), Clinical PCHP + HBPC (Track B), RPM (Track C), Billing (Track D), and IME/C&P (Track E).
- OpenEMR treated as live; configurations in progress per v2 §15.
- Owner and Billing/Coder roles designed but not yet in code. `hasBillingAccess` flag is planned (reserved wording in v2 §4), not scaffolded. Admin will carry the flag when B-series lands.
- Billing vendor stack locked: **Availity** for both eligibility (270/271) and clearinghouse (837/835). **Stripe** for patient payments with strict PHI segregation and automated test enforcement.
- Patient cost-share model: charge estimated copay at time of service, reconcile against ERA when it posts.
- PHC sliding-scale: custom dollar amount per hour per client, not percentage discount. Stored in `client_rate_overrides` with reason code and effective/retirement dates.
- Pre-credentialing billing path: self-pay + superbill built as first-class, not a workaround. Per-payer credentialing status lives in the org-level `gfc_payer_credentialing` table.
- Bethel Godwins's individual NPI is a config value (`gfc_payer_credentialing.billing_npi_used`), not hardcoded. Flippable when GFC's organizational Medicare enrollment lands.
- CAQH ProView adopted as the credentialing consolidation tool (operations, not code).

**07/2026 — Session 3.4 added.**
- Transfer-of-Care Provider ROI: multi-provider record release, one signing event generates one PDF per prior provider.
- Canvas signature capture (not typed name) because the PDF is provider-facing.
- 42 CFR Part 2 protected-info opt-in defaults FALSE; enforced at the data-access layer with unit-test build-fail if bypassed.
- Legacy Drive + Google Sheet system runs in parallel via `PARALLEL_LEGACY_SYNC` flag.
- Revocation UI deferred to a later session; `revoked_at` field exists.
- Reference implementations at `docs/source-forms/gfc_roi_upload.gs` and `docs/source-forms/template-gfc-roi-upload.php`.

---

## Spec documents (source of truth)

Read these before starting any session. Where the code and the spec disagree, the spec wins.

- `docs/GFC_App_Build_v2.md` — master architecture, tracks, roles, HIPAA rules, billing overview (§13), IME scope (§14), OpenEMR config items (§15)
- `docs/GFC_SESSION_PLAN.md` — session order, status, timeline
- `docs/GFC_Intake_and_Packet_Spec_v1.md` — intake stages, consent taxonomy (including Transfer-of-Care ROI in §4.2)
- `docs/GFC_Client_Care_Profile_Schema_v1.md` — client data model (includes `priorProviders`, `consents.roiTransfer`, expanded `payer` block, careTier A1–A4/B enum)
- `docs/GFC_Caregiver_Profile_Schema_v1.md` — caregiver data model
- `docs/GFC_Caregiver_Workspace_Spec_v1.md` — caregiver app, tier-branched visit log
- `docs/GFC_Matching_Engine_Spec_v1.md` — caregiver ↔ client matching
- `docs/source-forms/` — reference PHP/GAS implementations to port from
- `docs/prototype/` — visual reference HTML (updated 07/2026 — clinical EMR + patient-portal-v2 prototypes are Session 4 targets)

Session-specific prompts live at `docs/GFC_SessionN_ClaudeCode_Prompt.md`.

---

## Environment reminders

- **Data hosting for PHI:** AWS inside the BAA boundary. Never Replit.
- **Documents, consents, email:** HIPAA Google Workspace (Drive + Gmail) under existing BAA.
- **Test data only** on all sessions until HIPAA-live. No real client PHI.
- **Stripe never touches PHI.** Neutral descriptors only. Automated tests fail the build if clinical text reaches a Stripe payload.
- **Every billing route** will check `hasBillingAccess` (when B-series lands). **Every PHI access will write to `audit_log`** once Session 5 lands; today `logActivity()` provides the interim activity trail.

---

## Running instruction for every session

**Before opening the PR at the end of any session, update this file:**

1. Change the "Last updated" date at the top.
2. Update the session status table row for the session you just built (flip ⬜ to ✅, add the PR number).
3. Add a bullet under "Recent decisions" for anything locked in this session that future sessions need to know.
4. Update "Current session focus" to point at the next session (per `docs/GFC_SESSION_PLAN.md`).
5. Commit the `CLAUDE.md` change with the rest of the session's PR.

This keeps the running status current without a separate process. If you skip it, the next session starts blind.
