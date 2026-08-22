# GFC Care Platform — running status
_Last updated: 2026-08-22 (Session 4.1 merged, PR #19)_

This file is auto-loaded at the start of every Claude Code session. Read it first for current state. Details live in `docs/`.

---

## Current session focus

**Session 4.1 (clinician workspace + OpenEMR write) — ✅ merged (PR #19). Next: Session 4.2 (clinician scheduling, OpenEMR-tied), then 4.3 (patient portal clinical read).**

- **4.1 — ✅ Done (PR #19).** Clinician workspace at `/clinical` (`public/clinical.html`), OpenEMR FHIR/REST client (`openemr.js`), pure clinical helpers (`clinicalRepository.js`), routes under `/api/clinical/*` all API-layer gated by `requireClinicalStaff` (Admin or `hasClinicalAccess`). Care-plan authoring writes `client.carePlan` **versioned starting at 1** (the 3.5 contract — portal + co-sign now unblocked); co-sign completion emits the **signed care-plan PDF with both signatures** (RN author + client co-sign) to Drive + client record + OpenEMR Documents. Clinical enrollment checklist (v2 §6) drives IHPC ACTIVATED. Details in "Recent decisions."
- **Write verification complete (2026-08-18):** client swap + `gfc-app-api` ACL fix landed; full H&P chain proven end-to-end through `openemr.js` (encounter → note → FHIR read-back), plus problem/allergy/medication writes. Two **EMR-server-side defects** remain (app degrades gracefully on both) — root-caused 2026-08-22 and written up for the EMR maintainer in `docs/OPENEMR_SERVER_DEFECTS_2026-08.md`: (1) the vitals REST endpoint 500s unconditionally (`VitalsCalculatedService::$authUserId` typed `int` receives null — reproduced on all five payload shapes incl. note-only, so no payload avoids it; readings are preserved verbatim in the encounter note and a warning is surfaced to the clinician) and (2) both document endpoints 500 on a **SQL binding bug** at `src/Services/DocumentService.php:92` (`SELECT id FROM categories WHERE replace(LOWER(name), ' ', '') = ?` is issued without its bind array, so MySQL rejects the literal `?`; the upload's `getResponseForPayload ... bool given` is the same failure surfacing through the response helper). **Correction:** the earlier `sites/default/documents` write-permission hypothesis was wrong — the stack trace shows application code, not the filesystem. No client-side workaround exists: FHIR `DocumentReference` create is advertised in the CapabilityStatement but `POST /fhir/DocumentReference` returns 404 Route not found. Both are for the EMR maintainer, not app code; re-test after the server fix.

**4.2/4.3 build targets:** `docs/prototype/clinical-emr-prototype-v1.html` (desktop), `clinical-emr-mobile-prototype-v1.html` (mobile), `patient-portal-prototype-v2.html` (patient read). 4.3's clinical read reuses `openemr.js` scoped to the logged-in patient's `openEmrPatientId` (403 until linked + clinical line + consent-to-treat per schema §6).

---

## Session status

| # | Session | Status | Merged PR |
|---|---|---|---|
| 0 | Infra — AWS + OpenEMR + BAAs | 🟡 OpenEMR live, configs open (v2 §15) | — |
| 1 | Repo prep · rebrand · role model | ✅ Done | #2 (+ #3) |
| 2 | Strip lab features · deactivate tracker · brand cleanup | ✅ Done (incl. 07/2026 cleanup follow-ups) | #5 |
| 3.1 | Client portal + enrollment gate | ✅ Done | #6 |
| 3.2 | Gated enrollment intake + consents (+ full intake field-parity build) | ✅ Done (parity build merged in #13) | #7 |
| 3.3 | Staff enrollment view + offline onboarding + care-tier migration | ✅ Done | #16 |
| 3.4 | Transfer-of-Care Provider ROI | ✅ Done | #13 |
| 3.5 | Reconciliation — fixture removal, live data wiring, desktop pass | ✅ Done | #15 |
| 4.1 | Clinician workspace (OpenEMR write) | ✅ Done | #19 |
| 4.2 | Clinician scheduling (OpenEMR-tied) | ⬜ Next priority | — |
| 4.3 | Patient portal clinical read | ⬜ Planned (fast-follow) | — |
| 5 | Clinical HIPAA go-live (+ OpenEMR auth migration to authorization_code) | ⬜ Planned | — |
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

**08/2026 — Session 4.1 built & merged (PR #19, branch `claude/clinician-care-plan-auth-ra1t7k`).** Clinician workspace + OpenEMR write per the Session 4.1 prompt. Locked in:
- **Session 0 gate:** Bianca approved proceeding into Session 4.1 with the OpenEMR preflight serving as the §15 config check (Session 0 remains 🟡; its open items are now precisely enumerated below).
- **OpenEMR auth (dev window) — Option B approved:** OAuth2 **password grant** with a dedicated `gfc-app-api` OpenEMR user + confidential client, tokens held server-side only (`openemr.js`; browser never sees them). A correctly-scoped client **"GFC Care Platform (server)"** was dynamically registered (the original client had 9 read-only scopes bound at registration, which OpenEMR cannot widen) — 38 scopes granted, least-privilege for 4.1. **Migration to authorization_code + refresh_token is Session 5 scope** (recorded in `GFC_SESSION_PLAN.md` §Session 5), after which the password-grant global gets disabled.
- **Transport deviation approved:** OpenEMR 7.0.4's FHIR API is read-only for clinical resources, so **reads go via FHIR R4** (Patient, Condition, MedicationRequest, AllergyIntolerance, Encounter, CarePlan, DocumentReference, Observation) and **clinical writes via the standard REST API** (`encounter`, `vital`, `soap_note`, `medical_problem`, `medication`, `allergy`, `document`); Patient create/update stays FHIR. The one-record-in-OpenEMR rule stands — the app stores only `client.openEmrPatientId`, `client.carePlan`, and activity entries. Instance quirks encoded in `openemr.js`: `medical_problem.begdate` plain date, `allergy.begdate` datetime, medication endpoints keyed by numeric pid (resolved+cached from uuid), med-list reads via FHIR MedicationRequest (the standard-API list GET 500s on uuid-less rows).
- **Every EMR call audits** through `logActivity()` (user, role, patientId, resource, action) via `openemr.setActivityLogger()`.
- **Clinician workspace** (`/clinical`, desktop-first per prototype, mobile-responsive): IHPC/both patient list with link/sync state; live chart (problems/allergies/meds/encounters/vitals/documents); H&P per intake spec §2C — BP **both arms enforced server-side** (higher arm recorded in the vitals form, both preserved verbatim in the note), systems exam, skin/wound with measurements, PAINAD-style pain score, home-hazard inventory, RN triage writing the Track (A1–A4/B) onto `client.careTier`; intake pre-fill visibly marked until clinician-confirmed (`confirmedFields` stored on the visit stamp); med reconciliation (family rows vs FHIR MedicationRequest, resolution writes to OpenEMR + updates app structured rows); problem-list writes.
- **Care plan (the carry-over):** RN authors problems/goals/tasks/frequency/days/times/duration/charge-note/effective+target dates with a **drawn RN signature** (3.4 pad pattern). Save writes `client.carePlan` versioned **starting at 1**, prior versions + RN signature images retained append-only in a new `care_plan_versions` KV collection, and files an "authored — pending co-signature" PDF to OpenEMR Documents. **Co-sign completion emits the signed care-plan PDF with BOTH signatures** (image + name + timestamp + hashed-IP verification each, per spec §4.3) → Drive folder "GFC Care Plans" (`uploadCarePlanFile`, PHI-safe), reference on `client.carePlanDocs`, and OpenEMR Documents (surfaces as FHIR DocumentReference). PDF emission is best-effort by design: a storage failure logs + never voids the completed co-signature.
- **Clinical enrollment sequence (v2 §6):** per-patient checklist — payer verification (manual until B1) → records/ROI (derived from 3.4 `consent_events`, revoked events excluded) → NPA/prescriptive-authority (manual) → initial visit (derived from H&P stamp) → care plan authored **and co-signed at the current version** (derived) → IHPC consents (derived; 3.2 already captures consentToTreat/assignmentOfBenefits/practiceNpp — nothing added). Manual steps who/when-stamped; `POST .../activate` 409s with the missing steps until all pass, then stamps ACTIVATED and sets `enrollmentStatus: 'enrolled'`. Activation invariants are build-enforced in `test/clinical_workspace.test.js` (15 new tests; 28/28 pass).
- **OpenEMR items still open (Session 0 / §15), post-verification:** ~~client swap~~ and ~~`gfc-app-api` ACL~~ done (2026-08-18, encounter + note writes verified live). Remaining, all EMR-server-side (full write-up: `docs/OPENEMR_SERVER_DEFECTS_2026-08.md`): fix the vitals REST endpoint 500 (`VitalsCalculatedService::$authUserId` null, unconditional) and the document endpoints' 500 (SQL binding bug at `DocumentService.php:92` — **not** a filesystem-permission issue as first reported) — app code handles both gracefully meanwhile; practice/facility + provider records still return 403 on org-level reads (Practitioner/Organization/Coverage — ACL group covers clinical sections only); fee schedule / Availity / ERA config remain manual checks (B-series). Preflight artifacts labeled "(TEST DATA)" were left on dev patient TEST PatientOne.

**08/2026 — Session 3.3 built & merged (PR #16, branch `claude/session-3-3-review-5xa6f2`).** Staff enrollment view + offline onboarding + care-tier migration, per `docs/GFC_Session3.3_ClaudeCode_Prompt.md`. Locked in:
- **Staff enrollment view (`/admin/enrollment`, `public/admin-enrollment.html`):** paginated/filterable/searchable list of all clients (filter chips: All / Intake pending / Ready for review / Enrolled / Needs follow-up), a detail view grouped by intake section with per-consent provenance badges, and role-gated actions — "Mark as reviewed" and "Request follow-up" (admin/clinical/case-manager), "Approve enrollment" and "Add offline-onboarded patient" (admin only). All five new endpoints under `/api/gfc/admin/enrollment/*` are role-gated at the API layer (`requireEnrollmentStaff` / `requireAdmin`), not just the UI. `POST .../approve` 409s with the specific missing consents/fields when enrollment isn't actually complete. Every action writes to `logActivity()`.
- **`signed_offline` consent status:** a third satisfying value alongside `signed` (vs. `pending`/`na`) — `isConsentSatisfied()` is now the single source of truth used by the enrollment gate, the family ROI check, and intake submit's required-consent check, so paper-signed consents unlock the portal identically to in-app e-signed ones while staying distinguishable for audit/provenance.
- **Offline onboarding:** `POST /api/gfc/admin/enrollment/offline` (admin only) creates a client with `source: 'legacy_offline'`, `enrollmentStatus: 'intake_complete'`, uploads paper-packet scans to Drive (`googledrive.uploadOfflinePacketFile`, PHI-safe — routes through the existing `DRIVE_ALLOW_ANYONE_LINK`-gated helper, no anyone-link grant by default), and sets consent statuses per a per-consent radio checklist (signed on paper / not on paper / N/A). `scripts/import_offline_patients.js` bulk-imports from CSV, idempotent by `firstName+lastName+dob`, logs to `scripts/import_offline_patients.log`; sample CSV + `scripts/README.md` included.
- **Care-tier migration:** `migrateCareTierEnum()` runs once on boot (gated by `CARE_TIER_MIGRATION_APPLIED`, unset/false by default), rewrites stored legacy `1/2/3` values to `A1/A2/A4` in place, logs and leaves alone any unrecognized value (no data loss). The read-time `normalizeCareTier()` resolution added in an earlier session already handled display; this is the one-shot write-side migration PR #8's original note called for.
- Merged as **PR #16** (2026-08-16). Session 3 is now feature-complete (3.1–3.5).

**08/2026 — Session 3.5 reconciliation (branch `claude/new-session-dxkmip`).** Bianca's walkthrough found fixture/prototype content in the unlocked portal and no desktop layout; a full drift audit ran (`docs/DRIFT_REPORT_2026-08-15.md`). Locked in:
- **No sample data, ever.** The server-side sample care plan / fixture visits / fixture messages (`buildGfcTestData`) are deleted. `GET /api/gfc/care-plan` returns the client's real `carePlan` or `null`; visits come from `visit_logs`; messages from a new `gfc_messages` KV collection — all scoped to the logged-in client. A client with no data sees branded empty states.
- **Session 4 contract:** RN-authored care plans write `client.carePlan` with `version` starting at **1**; the co-sign route 409s (`NO_CARE_PLAN`) when no real plan exists, so nothing can ever be signed against sample content. The v0 sample sentinel is retired.
- **Messages:** basic client→admin send persists (`POST /api/gfc/messages`, channel `admin`, 4000-char cap, family blocked). Staff-side inbox + full channel matrix stay in Session 9; until then admin-bound messages live in the `gfc_messages` store (DECISION item pending on an interim admin view).
- **Client portal desktop layout:** at ≥1024px the unlocked portal renders a persistent left side-nav grid (`.gfc-shell.desktopnav`); gate/intake/ROI keep a widened centered column; mobile (<1024px) untouched.
- **Family linkage fixed:** admin-hub user form now has a "Linked client" selector for the Family role, stored as `familyOfClientId` (client user id) and persisted by both `/api/users` create + update. The vendor-only `assignedClients` name-based picker is no longer the (broken) only path.
- Dead lab nav removed per strip-list §7: "Implementations" sidebar entry (admin hub) and "Launch App" quick action (client-portal admin). Tracker code itself stays retained.
- DECISION items for Bianca in the drift report §5: banner photography (still lab imagery), interim admin message inbox, `hasImplementationsAccess` checkbox.

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

## Prerequisite gate — read before starting ANY session

Before beginning any session's work, check the session status table above for any EARLIER-numbered session that is not ✅ Done. If one exists, STOP and tell Bianca which sessions are pending, and ask whether to (a) run the pending session first or (b) explicitly skip it and proceed. Do not proceed on an implicit skip. Record any approved skip as a bullet under "Recent decisions" with the date and reason.

## Running instruction for every session

**Before opening the PR at the end of any session, update this file:**

1. Change the "Last updated" date at the top.
2. Update the session status table row for the session you just built (flip ⬜ to ✅). The PR number is usually unknown at this point — write the status as `✅ built · PR pending` and leave the "Merged PR" column as `— (pending)`. Do **not** invent a number.
3. Add a bullet under "Recent decisions" for anything locked in this session that future sessions need to know.
4. Update "Current session focus" to point at the next session (per `docs/GFC_SESSION_PLAN.md`).
5. Also update the session status row in `docs/GFC_SESSION_PLAN.md` — the plan and this file must never disagree.
6. Commit the `CLAUDE.md` (and `docs/GFC_SESSION_PLAN.md`) change with the rest of the session's PR.

**After that PR merges — backfill the number (this is where the docs go stale if skipped):**

7. Once the session's PR is merged, flip its row from `✅ built · PR pending` / `— (pending)` to `✅ Done` with the **real** PR number, in **both** `CLAUDE.md` and `docs/GFC_SESSION_PLAN.md`, and clear any "not yet opened as a PR" / "unmerged" wording in "Current session focus" and "Recent decisions". A merge does not update these files by itself — the next session, or the merge follow-up, must do it. (Root cause of the 3.3 stale-doc drift: step 2 ran, step 7 didn't exist.)

This keeps the running status current without a separate process. If you skip it, the next session starts blind.
