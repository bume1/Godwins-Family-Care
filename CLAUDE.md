# GFC Care Platform — running status
_Last updated: 2026-08-13_

This file is auto-loaded at the start of every Claude Code session. Read it first for current state. Details live in `docs/`.

---

## Current session focus

**Session 3 nearly complete → Session 4 (Clinical / In-Home Primary Care + OpenEMR) is next priority.**

On branch `claude/docs-addition-a9g0p1` (PR pending), and now rebased on latest `main` (late-July prototype + spec updates merged in):
- **3.4 — ✅ built.** Transfer-of-Care Provider ROI (`docs/GFC_Session3.4_ClaudeCode_Prompt.md`). See Recent decisions.
- **Intake field parity — ✅ built.** Stage-2 wizard expanded to full legacy-WordPress field parity (12 steps), structured backend for the matching/billing engines. See Recent decisions.
- **Session 3 client-prototype visual refresh** (`docs/prototype/client-prototype-full.html`) applied to `public/portal.html`.
- **3.3 — 📄 prompt ready, not yet built** (`docs/GFC_Session3.3_ClaudeCode_Prompt.md`): staff enrollment view + offline onboarding + care-tier migration. Independent of 3.4.

**Next: Session 4 — Clinical portal + OpenEMR** (`GFC_SESSION_PLAN.md` §Session 4): 4.1 clinician workspace (OpenEMR write via FHIR), 4.2 clinician scheduling (OpenEMR-tied), 4.3 patient portal clinical read. Build targets: `docs/prototype/clinical-emr-prototype-v1.html` (desktop), `clinical-emr-mobile-prototype-v1.html` (mobile), `patient-portal-prototype-v2.html` (patient read).

**Session 4 also carries the signed-PDF requirement:** every signable document must render a PDF with **all of that document's captured digital signatures populated, per document, respectively** (signature image + name + timestamp + IP). Care plan → client co-signature *and* RN author signature; each consent → its signer's signature; Transfer-of-Care ROI already does this per provider (3.4, the reference pattern). Carry-over from Session 3: the care-plan co-signature image is captured and stored, but no signed care-plan PDF is emitted yet — 4.1 must add it. Spec: `GFC_Intake_and_Packet_Spec_v1.md` §4.3, `GFC_SESSION_PLAN.md` §Session 4, `GFC_App_Build_v2.md` §Session 4.

---

## Session status

| # | Session | Status | Merged PR |
|---|---|---|---|
| 0 | Infra — AWS + OpenEMR + BAAs | 🟡 OpenEMR live, configs open (v2 §15) | — |
| 1 | Repo prep · rebrand · role model | ✅ Done | #2 (+ #3) |
| 2 | Strip lab features · deactivate tracker · brand cleanup | ✅ Done (incl. 07/2026 cleanup follow-ups) | #5 |
| 3.1 | Client portal + enrollment gate | ✅ Done | #6 |
| 3.2 | Gated enrollment intake + consents (+ full intake field-parity build) | ✅ Done · parity build ✅ on branch `claude/docs-addition-a9g0p1` (PR pending) | #7 |
| 3.3 | Staff enrollment view + offline onboarding + care-tier migration | 📄 Prompt ready | — |
| 3.4 | Transfer-of-Care Provider ROI | ✅ Built on branch `claude/docs-addition-a9g0p1` (PR pending) | — |
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

**08/2026 — Session 3 audit remediation (branch `claude/docs-addition-a9g0p1`).** A four-dimension audit (security/HIPAA, backend, frontend, spec) ran against the branch; all findings fixed before Session 4:
- **Importer crash (P0):** the legacy ROI importer routed a synthetic `legacy:<token>` through `signed_at`, crashing `buildConsentEvent` (RangeError on the 1-yr expiration) on every real row. Importer now passes a real ISO timestamp (token stays in the dedupe hash only); `buildConsentEvent` also guards unparseable dates. Test: `test/roi_importer_date.test.js`.
- **Service-line lockout (P0):** switching service line mid-wizard left a stale consent set → unsubmittable enrollment. The path step now persists the new line and refetches `consentDefs`/`requiredConsents` (`changeServiceLine`); the submit gate also refuses a vacuous "all signed" when consent defs failed to load.
- **Enum fidelity (P1):** `mirrorIntakeToClientProfile` was storing wizard display labels; it now normalizes to schema **enum codes** for every matching/billing field (gender, conditions[open-enum→slug fallback], skilledTasks, per-ADL levels, fallRisk, cognitiveStatus, dementiaStage, behavioral/homeSafety flags, temperament, advanceDirective.status, twoPersonAssist, transferNeed, payer.type). `genderPreference`→`{value,strength}`, `interests`→string[]; `transferNeed`+`schedule` now mirrored. Raw labels stay in the intake blob for round-trip.
- **Structured errors (P1):** portal `handleResponse` now preserves the server's `code`/`missingFields`/`fieldErrors` (via `err.data` + shared `asError`), so intake and ROI field-level remediation UX works.
- **Care-plan co-sign (P1):** version validated against the resolved plan version (409 on mismatch); co-signatures are **append-only** in a new `care_plan_cosign_events` KV collection (the signature image lives there, out of the hot-path `users` blob); the dev fixture uses a non-real version sentinel (`SAMPLE_CARE_PLAN_VERSION = 0`) so a sample co-sign can't collide with a real future version.
- **Parity + hardening (P2/P3):** ROI-family "authorized recipients / restrictions" fields added (wizard + `roiFamilyAuthorization` mirror); uploads now content-sniff magic bytes (declared mime no longer trusted); **PHI Drive files no longer world-readable** — the `type:'anyone'` grant is gated behind `DRIVE_ALLOW_ANYONE_LINK` (default false); JWT_SECRET fail-fast in production; consent e-sign IP now hashed (consistent with ROI); patient name removed from the admin ROI email subject.
- Verified: 12/12 unit tests, a 30-check integration harness (enum round-trip, co-sign version/append-only, MIME sniff, service-line refresh), and esbuild JSX compile of `portal.html`.

**07/2026 — Care-plan co-signature = drawn signature pad; signed-PDF requirement set for Session 4.**
- The care-plan co-signature in the portal (`GfcCarePlan` in `public/portal.html`) now uses the **canvas signature-pad** mechanism (same as the Transfer-of-Care ROI), not a checkbox. `POST /api/gfc/care-plan/cosign` requires a PNG data-URL signature (400 on missing/invalid, 413 on oversize) and stores the image on the per-version co-sign record; the care-plan GET returns only `coSignedAt`, never the image.
- Care-plan endpoint is now **per-patient**: real `client.carePlan` wins field-by-field over the dev sample fixture, `careTier` always from the client record, `coSignedAt` keyed to the plan's actual version. No patient names/dates are baked into the UI.
- **Signed-PDF requirement (Session 4+):** every signable document must render a PDF with **all of that document's captured digital signatures populated, per document, respectively** (image + name + timestamp + IP). Care plan → client co-signature *and* RN author signature; each consent → its signer's signature; ROI already does this per provider (3.4). Carry-over: the care-plan co-signature image is captured/stored but **no signed care-plan PDF is emitted yet** — Session 4 (4.1) must add it. Spec: `GFC_Intake_and_Packet_Spec_v1.md` §4.3, `GFC_SESSION_PLAN.md` + `GFC_App_Build_v2.md` §Session 4.

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
- Reference implementations at `docs/source-forms/gfc_roi_upload.gs` and `docs/source-forms/template-gfc-roi-upload.php`.

**Do not delete — dormant lab HubSpot connector.**
- `hubspot.js` + its polling engine in `server.js` + the HubSpot block in `config.js` + client/ticket UI hooks in `public/*.html` are legacy lab-CRM code, intentionally **retained but inactive** (reactivate on CRM upgrade). Dormant via two gates: `getAccessToken()` needs `REPLIT_CONNECTORS_HOSTNAME` (unset off Replit → no-ops) and the poll loop only starts when its stored config `enabled` flag is true (ships disabled). Do not remove it in any session.

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
