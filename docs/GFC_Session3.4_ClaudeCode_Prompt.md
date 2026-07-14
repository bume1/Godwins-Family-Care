# Session 3.4 — Claude Code Prompt
## Transfer-of-Care Provider ROI

**Prerequisite:** Sessions 3.1 and 3.2 merged. Session 3.3 (staff enrollment-submissions view) is independent — this work can run in parallel with 3.3.
**Status:** Ready to build.
**Model:** Opus.
**Important:** Build on dev with TEST DATA ONLY. Same rules as 3.2 — no real client PHI until HIPAA-live.

---

## What this session adds

A fifth ROI type in the branched consent set: **Transfer-of-Care ROI**. This lets a client authorize GFC to request and receive medical records from one or more prior providers in a single signing event. One event, one signature, one PDF per authorized provider. Handles 42 CFR Part 2 protected categories (mental health, substance use, HIV/AIDS, genetic testing) as a separate opt-in as federal law requires. Runs in parallel with the existing WordPress + Google Apps Script system during transition so nothing breaks.

Revocation UI is deferred to a later session. The data model includes the field so it can be added later without a schema migration.

---

## Paste this into Claude Code

```
You are continuing the GFC Care Platform build. Sessions 3.1 and 3.2 are merged.
Session 3.3 (staff enrollment-submissions view) may or may not be merged; this
work is independent and can proceed in parallel. Stack unchanged: Express
(server.js), CDN React, Replit KV, JWT. TEST DATA ONLY until HIPAA-live.

Branch: session/03.4-provider-transfer-roi

Read first, in full:
- docs/GFC_Session3_ClaudeCode_Prompt.md (context for what 3.1 and 3.2 built)
- docs/GFC_Intake_and_Packet_Spec_v1.md (consent taxonomy — you will extend §4.2)
- docs/GFC_Client_Care_Profile_Schema_v1.md (client data model — extended to
  include priorProviders and roiTransfer consent status)
- docs/source-forms/gfc_roi_upload.gs (existing Google Apps Script — reference
  implementation of business logic; do NOT copy code, but preserve field names,
  section structure, PDF layout, and behaviors)
- docs/source-forms/template-gfc-roi-upload.php (existing PHP form template —
  reference for UI flow, section order, e-signature capture, multi-provider
  card pattern)

SCOPE

Add a fifth ROI type to the existing branched consent set: Transfer-of-Care ROI.
This is client authorization for GFC to request and receive medical records from
one or more prior providers so care can be transferred cleanly. One signing
event can authorize multiple prior providers; the system generates one signed
PDF per provider. Unlike ROI-family, this does NOT gate the portal.

Extend, do not rebuild:
- The consents object on the client record (see GFC_Client_Care_Profile_Schema_v1.md)
  now includes roiTransfer with values 'signed' | 'pending' | 'na'.
- The client profile now has a priorProviders array (see schema). Editable
  independently of any ROI signing event. Populated at intake from PCP,
  specialists, and preferred hospital. Prefills the ROI form when the client
  starts the transfer-of-care flow.

DATA MODEL (add to the Replit KV store, keyed for future RDS migration)

consent_events (parent record for a signed consent):
- id (uuid), client_id, event_type (roi_transfer for this session), signed_at,
  signature_image_b64 (canvas capture), printed_name, relationship_authority,
  signer_ip_hash, expiration_date (nullable), expiration_event (nullable),
  purpose_treatment (bool, default true), purpose_other_text (nullable),
  includes_protected_info (bool, default FALSE), revoked_at (nullable — no UI
  for revocation in this session, but the field exists so a later session adds
  the UI without a schema change), source (enum: portal_online_form,
  portal_upload, legacy_import)

consent_provider_authorizations (child, one per prior provider on a transfer ROI):
- id, consent_event_id, provider_name, dept, address, phone, fax,
  generated_pdf_drive_url (current storage), generated_pdf_s3_key (nullable,
  populated by Track 0 migration later), file_name

consent_records_categories (join, one row per checked category):
- consent_event_id, category (enum: hp, lab, diag, imaging, meds, discharge,
  allergies, immune, other), other_text (nullable, populated only when
  category = other)

FLOW

Add a new tile on the client portal Documents & Consents view:
"Authorize record release from prior providers." Clicking opens a multi-screen
flow that mirrors template-gfc-roi-upload.php:

Screen 1: Choose path. Upload signed PDF, OR complete online form.

Screen 2A (upload path): Drag/drop or select. Accept PDF, JPG, PNG, 10 MB max.
On submit: write file to Drive folder "GFC Provider ROI Uploads" (existing
integration), create a consent_event with source=portal_upload, no
consent_provider_authorizations rows (since we don't know which providers from
an uploaded scan — admin classifies later), log to Google Sheet (parallel run).

Screen 2B (online form path): 8 sections matching the PHP form.
- Section 1 (Patient) prefills from client profile (firstName, lastName, dob,
  address, phone).
- Section 2 (Release from) prefills provider cards from client.priorProviders.
  Editable. "Add another provider" adds a card. Each card becomes one
  consent_provider_authorization row on submit.
- Section 3 (Release to) is static: Godwins Family Care LLC, address, phone, fax.
- Section 4 (Information authorized): 9 checkboxes plus Other with free text.
  Separate "specially protected information" opt-in checkbox — MUST default to
  FALSE. See enforcement note below.
- Section 5 (Purpose): Treatment default checked; Other with free text.
- Section 6 (Expiration): default 1 year from sign date; user can override with
  earlier date or event.
- Section 7 (Rights): static HIPAA revocation + redisclosure language, verbatim
  from the PHP form.
- Section 8 (Signature): canvas signature pad + printed name +
  relationship/authority + auto-filled sign date.

On submit: server-side validate all 45 CFR 164.508 required elements are
present (description of information via at least one checked category, purpose,
expiration, right-to-revoke language, redisclosure statement, signature image
non-empty, printed name, date). Missing any element blocks save with a specific
field-level error.

PDF GENERATION

For each provider card, generate one PDF matching the layout of renderROIHtml()
in gfc_roi_upload.gs. Use the same brand tokens (navy #033D50, gold #F5CD85,
cream #FAF7F2, Cormorant + Arial-fallback). Filename convention:
ROI_<ClientLastName>_<ProviderNameSanitized>_<YYYYMMDD>_<seq>.pdf.

Each generated PDF gets:
- Written to Drive folder "GFC Provider ROI Uploads" (parallel run continues
  to populate Drive)
- URL stored in consent_provider_authorizations.generated_pdf_drive_url
- generated_pdf_s3_key left null (populated by Track 0 migration later)

42 CFR PART 2 ENFORCEMENT (non-negotiable)

The 'includes_protected_info' field on consent_events gates whether substance
use, mental health, HIV/AIDS, and genetic testing records can be requested.
Enforce at the data-access layer, not just the form:
- A repository function that returns "what records can we ask this provider
  for?" MUST exclude the protected categories unless includes_protected_info ===
  true on the specific consent_event.
- Write unit tests that fail the build if this rule is bypassed.

PARALLEL RUN WITH LEGACY SYSTEM

During the transition period, every consent_event created in the portal ALSO
writes:
- A log row to the existing "Assessments & Intakes" Google Sheet, in the same
  columns the current GAS handler uses (Provider ROI URL, Provider ROI File).
- An admin email matching buildAdminEmail() output.
- A patient/submitter confirmation email matching buildPatientEmail() output.

The parallel-write behavior is toggled by a config flag PARALLEL_LEGACY_SYNC
(default true). Track 0 will set this to false at cutover.

LEGACY DATA IMPORT (one-time script)

Write a script scripts/import_legacy_transfer_rois.js that:
- Reads all rows from the "Assessments & Intakes" sheet where "Provider ROI URL"
  is populated.
- For each row, creates a matching consent_event with source=legacy_import,
  populates client_id via token lookup, marks status=signed.
- Copies the PDF from Drive into the same Drive folder path used by the new
  system (idempotent: skip if already present at destination).
- Creates consent_provider_authorizations rows where possible; if the legacy
  PDF was a single-provider form, one row. If a scan/upload with no structured
  provider data, zero rows (admin classifies later).
- Idempotent: re-running does not duplicate consent_events (dedupe by
  client_id + signed_at + file hash).

Do NOT delete or modify anything in Drive or the Google Sheet. The legacy
system continues to work through the parallel-run window.

NOTIFICATIONS

Same routing as the existing GAS handler:
- Admin gets one email with all generated PDFs attached.
- Client email + submitter email both get a plain confirmation (no PDFs).
- Emails go through the app's existing mailer; write to the same admin address
  (admin@godwinsfamilycarellc.com) unless config overrides.

DO NOT
- Build a revocation UI in this session. The revoked_at field exists but no
  form. Deferred to a later session.
- Change any other consent type (ROI-family, ROI-provider-comm, service
  agreement, NPP, etc.) built in 3.2. This is additive only.
- Migrate PDFs to S3. That belongs to Track 0.
- Turn off PARALLEL_LEGACY_SYNC. That's a Track 0 decision.
- Enter or store any real client PHI. Test data only.

ACCEPTANCE

- A test client whose profile has three prior providers can open the transfer
  ROI flow, see three prefilled provider cards, add a fourth, sign once, and
  four separate PDFs are generated with correct filenames and correct provider
  details on each.
- The "specially protected information" checkbox defaults FALSE. Submitting
  with it unchecked and then querying "what categories can we request from
  provider X?" returns only the non-protected categories.
- A unit test that tries to bypass includes_protected_info and pull protected
  categories anyway FAILS the build.
- A signed ROI creates a consent_event with source=portal_online_form, a
  matching row in the Google Sheet, PDFs in the Drive folder, and the correct
  admin + confirmation emails.
- Running scripts/import_legacy_transfer_rois.js on a fresh dev instance
  imports existing Drive ROIs without duplicating any records.
- App still boots; existing 3.1 and 3.2 flows unaffected; other client and
  admin logins unaffected.

Open ONE PR titled "Session 3.4: Provider Transfer-of-Care ROI." Stop for
review. Do not start Session 3.3 or Session 4 from this branch.
```

---

## After this lands
Session 3.3 (staff enrollment-submissions view) if not already done, then Session 4 (clinical portal + OpenEMR).
