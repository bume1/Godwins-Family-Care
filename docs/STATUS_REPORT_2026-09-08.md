# GFC Clinical Line — Pre-Production Audit (Session 4.5 juncture)

**Date:** 2026-09-08
**Auditor:** Claude Code — code-verified (three parallel source sweeps of `server.js`, `public/clinical.html`, `openemr.js`, `clinicalRepository.js`, `patientReadRepository.js`) cross-checked against `CLAUDE.md`, `docs/OPENEMR_SERVER_DEFECTS_2026-08.md`, and the 4.3/4.4/4.5 prompts.
**Scope:** the specific clinical/IHPC pathways Bianca flagged (enrollment-doc upload, patient creation, chart tabs, SOAP forwarding), a go/no-go for **patient read in production**, and readiness of the queued AI work.
**Repo state:** `main` @ `fcd8de3` (PR #41). All findings TEST DATA ONLY.

---

## Bottom line

**Clinical read/write functionality is largely built and genuinely wired to OpenEMR — but the line is NOT ready for real-patient (PHI) use.** The remaining blockers are **governance/security and configuration, not the read code**:

1. OpenEMR runs the **password grant and does not validate `client_secret`** → every *enabled* OAuth client is usable without its secret; the API-user password is the entire perimeter. The `authorization_code` migration is **Session 5, planned not built**.
2. All activity attributes to one `gfc-app-api` service account; **per-user auth, MFA, durable audit, and BAAs are Session 5**.
3. The **4.3 live-EMR preflight was never run** (verified only against a 7.0.4 mock) — must pass before the first real login.
4. Config gaps: **billing NPI unset** (blocks sign-and-close by design), **clinician NPIs unset**, **ICD-10-CM not loaded** (codes empty).

**Safe now:** keep exercising the whole clinical line with test data. **Do not** enable real-patient read until the Session 5 auth migration lands, the live preflight passes, and the NPI/ICD-10 config closes.

One timeline correction the docs themselves flag: the "4.5 BLOCKED — stale v2 client / 42 scopes" entries (2026-09-06) were **corrected 2026-09-08** as a *build-sandbox artifact*. The deployed Replit env holds the **v4 client (52 granted scopes)**; 4.5 is **unblocked but unbuilt** (no native-write code written yet).

---

## The pathway questions, answered (code-verified)

### 1. Where does a provider/admin upload hand-submitted enrollment/consent documents?
**There is no upload affordance in the clinical workspace.** `clinical.html` has zero file inputs; its only "Documents" element (`clinical.html:345`) is a **read-only** display of documents already in OpenEMR. The real upload doors are elsewhere, and **none of them file into OpenEMR** — every path lands in Google Drive with a URL reference on the KV client record:

- **Patient self-upload** (portal, client-only): `POST /api/gfc/intake/upload` (`server.js:5545`) and signed-ROI `POST /api/gfc/transfer-roi/upload` (`server.js:8648`) → Drive; refs on `client.intakeUploads`.
- **Admin offline onboarding** (3.3): `POST /api/gfc/admin/enrollment/offline` (`server.js:8408`, admin-only, up to 20 files) → Drive folder "GFC Offline Intake Packets"; UI is the OfflineOnboardForm in `admin-enrollment.html:536`.
- The only app path that writes files *into* OpenEMR's document area is the **generated care-plan PDF** (`openemr.uploadPatientDocument`, keyed by numeric pid) — not hand-submitted scans.

**→ Gap / recommendation.** A clinician who receives a paper consent/records packet at a visit has nowhere in the chart to file it. If clinicians need scans on the OpenEMR chart, that's a small add (a document-upload control in `clinical.html` → the existing `uploadPatientDocument`, pid-keyed). If Drive-of-record is acceptable, document the intended path so front-desk/admin owns it. **This is the most concrete "broken pathway" you sensed.**

### 2. How do I add a new clinical patient — from EMR or from the app?
**From the app, in one click — but the person must already be a GFC client on a clinical service line.** One endpoint does both create and link: `POST /api/clinical/patients/:clientId/link` (`server.js:6003`, clinician-gated):
- **Create & link** — builds a FHIR Patient from the GFC demographics and POSTs to OpenEMR (`server.js:6019`).
- **Link existing** — verifies the supplied OpenEMR id first (`server.js:6017`), then stores it.
- Linkage saved as `client.openEmrPatientId` (the UUID; numeric pid resolved on demand). UI: "Create & link OpenEMR patient" / "Link an existing patient" in the Summary tab (`clinical.html:305,321`).

Prerequisite record comes from the **enrollment gate** or the **admin offline-onboarding form** — the offline path deliberately does **not** create an OpenEMR patient (`server.js:8408–8513`), so a clinician links it afterward.

**→ Guardrail already present:** re-linking an already-linked client is refused (`409 ALREADY_LINKED`, `server.js:6007`).
**→ Gap:** `createPatient` has **no demographic dedupe** — the dev instance has **8 duplicate "Demo Client" charts**. Before real enrollment, add a pre-create name+DOB search of OpenEMR with a "possible existing patient" confirm step.

### 3. Med Rec / Care Plan / Enrollment tabs
- **Med Rec — bidirectional and real.** Reads the med list from OpenEMR via FHIR `MedicationRequest` (`server.js:6214`); add/discontinue decisions **write back** via REST (`emr.addMedication`/`updateMedication`, `server.js:6248`), best-effort per row, mirrored into the app's structured list.
- **Care Plan — app-authored, OpenEMR can't take a structured plan on this version.** Plan persists to `client.carePlan` (versioned, `server.js:6356`); the **RN drawn signature** is captured at authoring (`care_plan_versions`). On client/POA co-sign, the app **emits one signed PDF carrying both the RN and client signatures** (`emitSignedCarePlanPdf` → `generateCarePlanPDF`, `server.js:5182`), files it to **Drive and** OpenEMR Documents, and serves the patient copy from Drive. **The Session-4 signed-co-signed-PDF requirement is met.** (Caveat: OpenEMR Documents read-back is unproven, so serving relies on Drive.)
- **Enrollment — 6-step sequence, activation-gated.** Two manual toggles (payer verification, NPA) + four **derived from real data** (ROI on file, initial visit done, care plan co-signed at current version, all three IHPC consents signed) — `clinicalRepository.js:61`. `POST …/activate` recomputes and refuses with `CHECKLIST_INCOMPLETE` + the missing labels until all six are done (`server.js:6443`). Your screenshot's "3/6" = payer + NPA marked; the derived four pending.

### 4. Are SOAP visits forwarded to OpenEMR today?
**Yes.** Signing a visit note creates a **native OpenEMR encounter** (`createEncounter`, `server.js:6151/7191`), writes the narrative as a **native `soap_note` row** (`addSoapNote`, `server.js:6166/7199`), and writes a second **"GFC structured note"** holding coding/Rx/orders/attestation — the documented interim for data OpenEMR 7.0.4 exposes no write API for (`server.js:6879`). Both are keyed by the **correct numeric pid/eid** (the 4.1 pid-0 orphaning bug is fixed, `openemr.js:334`).
**→ Not yet wired:** the planned **Session 4.5 native prescription/order/billing writes**. Today Rx is recorded app-side + mirrored into the med list and structured note, **not e-transmitted** (`server.js:7388`). The 6B charge route exists on the server (installed, healthy) but the app hasn't wired it live end-to-end.

### 5. AI additions (`GFC_SessionAI.1_ClaudeCode_Prompt.md`) — is now the time?
**No — and the prompt itself says so.** It is deliberately queued and self-gates on prerequisites that are **not yet met**: 4.5 native writes merged (unbuilt), ≥2 weeks of *real* clinical visits (line isn't live), and — decisively — a **preflight that requires the AWS BAA boundary**: Bedrock with zero-data-retention, Transcribe Medical, in-boundary S3 with a delete lifecycle. That boundary is **Session 5**. Dictation audio is PHI; running AI.1 before Session 5 would push PHI outside a BAA boundary. It states plainly: *"Do not run this before the main build needs are done."*
**→ Right sequence:** finish **4.5** (native writes) → run the **4.3 live preflight** → **Session 5** (AWS boundary — which *is* the AI preflight infra + auth migration) → accrue real visits → **then AI.1**. Starting now would draft notes against structures unvalidated by real use, on a secure boundary that doesn't exist. The prompt is well-designed (in-boundary only, unverified-until-touched, sign blocked on unconfirmed AI content, audio deleted post-transcription) — keep it exactly as queued.

---

## Pre-production punch list (owners)

| # | Item | Status | Owner | Blocks real-PHI? |
|---|---|---|---|---|
| 1 | OpenEMR `client_secret` not validated on password grant; disable superseded v2/v3 clients + `SQNsx…` dup | OPEN | EMR maintainer + Bianca | **Yes** — raise before go-live |
| 2 | Auth migration password grant → `authorization_code` (per-user) | Planned (Session 5) | app | **Yes** |
| 3 | Per-user auth · MFA · durable `audit_log` · BAAs | Planned (Session 5) | app + ops | **Yes** |
| 4 | 4.3 live-EMR preflight (FHIR round trip · 403 gate · appt/401) — only mock-verified | OPEN | app | **Yes** (before first real login) |
| 5 | Billing NPI unset → sign-and-close blocked (`SIGN_NO_BILLING_NPI`); clinician NPIs unset | OPEN | Bianca/ops (Coding queue → Billing settings) | Blocks signing |
| 6 | ICD-10-CM code set not loaded (`GET /api/codes` = 0 rows; FHIR Condition uncoded) | OPEN | ops | No (charge `justify` is free text) — but degrades coding UX |
| 7 | Session 4.5 native writes + 6B live wiring; retire app-side workarounds | Unbuilt (unblocked) | app | No (workarounds hold) |
| 8 | `createPatient` demographic dedupe (8 duplicate Demo Clients) | OPEN | app | No (hygiene, pre-enrollment) |
| 9 | No clinical-workspace document upload for hand-submitted scans | Gap (by design) | decision → app | No (Drive path exists) |

**Status-indicator caveat for reviewers:** the green **"OpenEMR connected"** pill means only "a password-grant token was issued" (`openemr.js:532`) — it does **not** probe a clinical endpoint, and given #1 a green light proves little. The scope-shortfall banner (added after the stale-client incident) is the more trustworthy signal. The **"Billing provider NPI not configured"** banner is a real config check; it's advisory in the UI but the hard block is server-side at sign time.

---

## What's genuinely solid (don't re-litigate)
Patient-read gates are real and server-enforced: link + clinical-service-line + consent-to-treat (+ ROI-family for family/POA), 403 with specific codes (`patientReadRepository.js:105`); patient identity resolves from the session, never a request param; a single server-side allow-list strips clinician-only fields; EMR reads degrade gracefully (a failing section returns empty, never a hard error). The care plan + signed PDF don't depend on the EMR link at all. These are production-grade — the gate to production is the auth/security/config list above, not the read logic.

_Method note: no application code was changed by this audit. Findings carry file:line anchors for spot-checking._
