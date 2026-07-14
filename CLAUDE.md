# GFC Care Platform — running status
_Last updated: 2026-07-14_

This file is auto-loaded at the start of every Claude Code session. Read it first for current state. Details live in `docs/`.

---

## Current session focus

**Session 3.4 — Transfer-of-Care Provider ROI — ✅ built on branch `claude/docs-addition-a9g0p1` (PR pending).**

Next: Session 3.3 (staff enrollment-submissions view) if not already merged, then Session 4 (clinical portal + OpenEMR). After 3.4 is confirmed/merged, apply the applicable client-prototype visual updates (see `docs/prototype/client-prototype-full.html`).

---

## Session status

| # | Session | Status | Merged PR |
|---|---|---|---|
| 0 | Infra — AWS + OpenEMR + BAAs | 🟡 OpenEMR live, configs open (v2 §15) | — |
| 1 | Repo prep · rebrand · role model | ✅ Done | ? |
| 2 | Strip lab features · deactivate tracker · brand cleanup | 📄 Prompt ready | — |
| 3.1 | Client portal + enrollment gate | ✅ Done | ? |
| 3.2 | Gated enrollment intake + consents | ✅ Done | ? |
| 3.3 | Staff enrollment-submissions view | ⬜ Pending | — |
| 3.4 | Transfer-of-Care Provider ROI | ✅ Built (branch, PR pending) | — |
| 4 | Clinical portal + OpenEMR (4.1 clinician workspace, 4.2 clinician scheduling, 4.3 patient portal clinical read) | ⬜ Next priority | — |
| 5 | Clinical HIPAA go-live | ⬜ Planned | — |
| 6 | Caregiver app (mobile, tier-branched visit log) | ⬜ Planned | — |
| 7 | Scheduling · availability · time tracking (PHCP) | ⬜ Planned | — |
| 8 | Matching engine (PHCP) | ⬜ Planned | — |
| 9 | Messaging module (channel matrix) | ⬜ Planned | — |
| 10 | Family portal (read-only, ROI-gated) | ⬜ Planned | — |
| 11 | RPM / Continuous Care scaffold | ⬜ Planned | — |
| 12 | Audit log UI + final HIPAA / BAA review | ⬜ Planned | — |
| B-series | Billing (Track D) — B1 eligibility, B2 patient payments, B3 PHC invoicing, B4 rate card, B5 OpenEMR integration, B6 clearinghouse, B7 IME invoicing | ⬜ Planned — architecture spec `GFC_Billing_Architecture_Spec_v1.md` to be written | — |
| E-series | IME / C&P Track E — exam capture, scheduling, hours rollup | ⬜ Planned — spec per v2 §14 | — |

---

## Recent decisions

**07/2026 — Scope revision (Track D and Track E added).**
- Product scope now covers PHCP (Track A), Clinical PCHP + HBPC (Track B), RPM (Track C), Billing (Track D), and IME/C&P (Track E).
- OpenEMR treated as live; configurations in progress per v2 §15.
- Owner role and Billing/Coder role scaffolded via `hasBillingAccess` flag. Admin holds the flag for now.
- Billing vendor stack locked: **Availity** for both eligibility (270/271) and clearinghouse (837/835). **Stripe** for patient payments with strict PHI segregation and automated test enforcement.
- Patient cost-share model: charge estimated copay at time of service, reconcile against ERA when it posts.
- PHC sliding-scale: custom dollar amount per hour per client, not percentage discount. Stored in `client_rate_overrides` with reason code and effective/retirement dates.
- Pre-credentialing billing path: self-pay + superbill built as first-class, not a workaround. Per-payer credentialing status lives in the org-level `gfc_payer_credentialing` table.
- Bethel Godwins's individual NPI is a config value (`gfc_payer_credentialing.billing_npi_used`), not hardcoded. Flippable when GFC's organizational Medicare enrollment lands.
- CAQH ProView adopted as the credentialing consolidation tool (operations, not code).

**07/2026 — Intake field-parity build (front-end parity, structured backend).**
- The Stage-2 enrollment wizard (`GfcIntakeFlow` in `public/portal.html`) was expanded from ~50 fields to full parity with the legacy WordPress intake (`docs/source-forms/template-gfc-intake-3.php`, ~150 fields). Guiding rule (per owner): **preserve every field's front-end structure from the legacy intake, while mapping into the app's structured backend shape the matching/billing engines need.**
- Wizard is now 12 steps: path · client · contacts · **care situation** · **schedule & urgency** · **homebound & recent care** · medical · function & safety · **caregiver match** · insurance · consents · review (new steps in bold).
- Legacy fields restored/added: client legal name; submitter block; full emergency-contact detail (relationship/email/address); care-situation triage (help-needed, ongoing-conditions, main-reason, cognition, PCP status, appointment access); schedule (start/hours/urgency/days/recurring, payment expectation, service interests, caregiver stress); homebound + recent medical (last visit/hospitalization, ER visits, current services, HBPC interests); coded **diagnoses checklist** (replacing the free-text regression) + additional dx + advance directive; pharmacy fields, med notes, full 14-item skilled-task list + provider, recent clinical events; ADL grooming, equipment, IADL block, dietary/food allergies, cognitive status, dementia stage, behavioral notes + full options, functional-risk-6mo, home-safety full options, two-person assist, staff-safety notes, decision-making, legal-docs; caregiver-matching prefs (personality, gender/language/experience prefs, interests, past caregiver); full insurance detail (SSN4, insurance-types, Medicare/Medicaid/Commercial/LTC blocks, payment method, billing contact); 911-authorization + crisis-notify.
- Backend: `server.js` `POST /api/gfc/intake` persists the whole structured intake (nested objects/arrays/enums, never free text) and `mirrorIntakeToClientProfile()` maps the matching/billing-relevant fields up onto the client record in the v1 schema shape (conditions, homeSafetyFlags, twoPersonAssistRequired, temperament, genderPreference, caregiverExperienceRequired, and an assembled `payer` object). Partial/draft saves never wipe existing profile data.
- Structural divergences kept (spec-aligned, not regressions): DOB captured once → age derived; medications as structured rows (not a joined string); diagnoses as a coded checklist. Verified: 41-check round-trip persistence + mirror test, 12-step render/navigation test (zero console errors), 9/9 unit tests.

**07/2026 — Session 3.4 built (Transfer-of-Care Provider ROI).**
- New data model as three KV collections keyed for RDS migration: `consent_events` (parent), `consent_provider_authorizations` (one per prior provider), `consent_records_categories` (one per checked category). Lives in `roiRepository.js` (`createRepository(db)` factory + pure helpers).
- **42 CFR Part 2 enforced at the data-access layer**, not just the form: `roiRepository.getRequestableRecordCategories(event, rows)` excludes the four protected categories (mental_health, substance_use, hiv_aids, genetic_testing) unless `includes_protected_info === true`. Defense-in-depth strips protected categories even if injected into the rows. Build fails on bypass via `test/roi_protected_categories.test.js` (`npm test`, `node --test`). Test runner bootstrapped from scratch (none existed) — `"test"` script added to `package.json`.
- One signing event → one PDF per provider (`pdf-generator.js` `generateProviderROIPDF`, pdfkit, brand tokens navy/gold/cream, verbatim rights + redisclosure). Filenames `ROI_<Last>_<Provider>_<YYYYMMDD>_<seq>.pdf`. Written to Drive folder "GFC Provider ROI Uploads" (`googledrive.js` `uploadProviderROIFile`); `generated_pdf_s3_key` left null for Track 0.
- Routes (`server.js`, all `authenticateToken` + `requireClientForIntake`): `GET /api/gfc/transfer-roi` (prefill), `PUT /api/gfc/prior-providers` (edit independently), `POST /api/gfc/transfer-roi/upload` (scan path, source=portal_upload, zero provider rows), `POST /api/gfc/transfer-roi/submit` (online form, validates all 45 CFR 164.508 elements server-side). Portal UI: new tile + multi-screen canvas-signature flow in `public/portal.html` (`GfcTransferRoi`). Does NOT gate the portal.
- `priorProviders` added to the client profile (schema mirror), normalized at intake and editable independently; prefills the ROI form.
- Parallel legacy sync (`legacySync.js`) gated by `config.PARALLEL_LEGACY_SYNC` (default true): Google Sheet "Provider ROI URL"/"Provider ROI File" columns + admin email (PDFs attached, internal only) + patient/submitter confirmation (never any PDF/PHI). Mailer (`email.js`) gained attachment passthrough.
- One-time idempotent importer `scripts/import_legacy_transfer_rois.js` (dedupe by client_id + signed_at + file hash; never modifies Drive/Sheet). Revocation UI deferred — `revoked_at` field exists.

**07/2026 — Session 3.4 added.**
- Transfer-of-Care Provider ROI: multi-provider record release, one signing event generates one PDF per prior provider.
- Canvas signature capture (not typed name) because the PDF is provider-facing.
- 42 CFR Part 2 protected-info opt-in defaults FALSE; enforced at the data-access layer with unit-test build-fail if bypassed.
- Legacy Drive + Google Sheet system runs in parallel via `PARALLEL_LEGACY_SYNC` flag.
- Revocation UI deferred to a later session; `revoked_at` field exists.
- Reference implementations in `docs/source-forms/gfc_roi_upload.gs` and `docs/source-forms/template-gfc-roi-upload.php`.

**07/2026 — Lab HubSpot connector kept dormant (do not delete).**
- The HubSpot integration is legacy lab-diagnostic CRM code, intentionally **retained but inactive**, to be reactivated when GFC's CRM is upgraded. Do not remove it.
- **Where it lives:** `hubspot.js` (the connector — deals, tickets, owners, notes, file uploads); the ticket-polling engine + `resolveHubSpotOwnerToUser` + `buildServiceReportFromTicket` in `server.js`; the HubSpot config block in `config.js`; and client company/deal/contact linking + ticket display in `public/app.js`, `public/portal.html`, `public/admin-hub.html`, `public/service-portal.html`.
- **Why it's dormant (two gates):**
  1. **Auth** — `hubspot.js` `getAccessToken()` fetches its token from the Replit connector broker via `REPLIT_CONNECTORS_HOSTNAME`. That env var is unset outside Replit (and absent in the AWS boundary), so every HubSpot call throws `HubSpot connector not configured` and no-ops.
  2. **Polling** — the ticket→service-report poll loop only starts when its stored config `enabled` flag is true (`if (config.enabled)` in `server.js`); it ships disabled.
- **To reactivate (on CRM upgrade):** replace the Replit-broker token fetch in `getAccessToken()` with a real HubSpot OAuth / private-app token sourced from the AWS-boundary secrets store; confirm the `config.js` HubSpot poll interval/target-stage values and the pipeline/stage IDs match the live account; then flip the polling `enabled` flag (admin config endpoint). If the new CRM is **not** HubSpot, treat `hubspot.js` as the reference contract (tickets → service reports, owner→user mapping, note/file sync) and reimplement against the new vendor rather than reviving the Replit path.
- Note: the lab **validation** workflow that was interwoven with this connector was removed from `public/service-portal.html` (its backend routes went in Session 2); the HubSpot connector itself was deliberately left intact.

---

## Spec documents (source of truth)

Read these before starting any session. Where the code and the spec disagree, the spec wins.

- `docs/GFC_App_Build_v2.md` — master architecture, tracks, roles, HIPAA rules, billing overview (§13), IME scope (§14), OpenEMR config items (§15)
- `docs/GFC_SESSION_PLAN.md` — session order, status, timeline
- `docs/GFC_Intake_and_Packet_Spec_v1.md` — intake stages, consent taxonomy (including Transfer-of-Care ROI in §4.2)
- `docs/GFC_Client_Care_Profile_Schema_v1.md` — client data model (includes `priorProviders`, `consents.roiTransfer`, expanded `payer` block)
- `docs/GFC_Caregiver_Profile_Schema_v1.md` — caregiver data model
- `docs/GFC_Caregiver_Workspace_Spec_v1.md` — caregiver app, tier-branched visit log
- `docs/GFC_Matching_Engine_Spec_v1.md` — caregiver ↔ client matching
- `docs/source-forms/` — reference PHP/GAS implementations to port from
- `docs/prototype/` — visual reference HTML for the UI

Session-specific prompts live at `docs/GFC_SessionN_ClaudeCode_Prompt.md`.

---

## Environment reminders

- **Data hosting for PHI:** AWS inside the BAA boundary. Never Replit.
- **Documents, consents, email:** HIPAA Google Workspace (Drive + Gmail) under existing BAA.
- **Test data only** on all sessions until HIPAA-live. No real client PHI.
- **Stripe never touches PHI.** Neutral descriptors only. Automated tests fail the build if clinical text reaches a Stripe payload.
- **Every billing route** checks `hasBillingAccess`. Every PHI access writes to `audit_log`.

---

## Running instruction for every session

**Before opening the PR at the end of any session, update this file:**

1. Change the "Last updated" date at the top.
2. Update the session status table row for the session you just built (flip ⬜ to ✅, add the PR number).
3. Add a bullet under "Recent decisions" for anything locked in this session that future sessions need to know.
4. Update "Current session focus" to point at the next session (per `docs/GFC_SESSION_PLAN.md`).
5. Commit the `CLAUDE.md` change with the rest of the session's PR.

This keeps the running status current without a separate process. If you skip it, the next session starts blind.
