# Session 3.3 — Claude Code Prompt
## Staff enrollment-submissions view + offline patient onboarding + care-tier migration

**Prerequisite:** Sessions 3.1 and 3.2 merged. Independent of 3.4 (can run in either order or in parallel).
**Status:** Ready to build.
**Model:** Opus.
**Important:** Build on dev with TEST DATA ONLY. Same rules as 3.2 — no real client PHI until HIPAA-live.

---

## What this session adds

Three additive scopes, all in one branch and one PR:

1. **Staff enrollment-submissions view** — the admin/clinical area for reviewing intake submissions from 3.2.
2. **Offline patient onboarding** — a path to bring the 7 existing paper-packet patients into the app without making them redo intake. Includes a `signed_offline` consent status, an admin action to mark intake satisfied from paper, and a one-shot CSV import script for bulk entry.
3. **Care-tier code migration** — the legacy `1|2|3` enum in `server.js` gets migrated to the Track A/B enum (`A1|A2|A3|A4|B`) per intake spec v1.1 §3.2 and PR #8's original note.

---

## Paste this into Claude Code

```
You are continuing the GFC Care Platform build. Sessions 3.1 and 3.2 are merged.
Session 3.4 (Transfer-of-Care ROI) may or may not be merged; this work is
independent. Stack unchanged: Express (server.js), CDN React, Replit KV, JWT.
TEST DATA ONLY until HIPAA-live.

Branch: session/03.3-staff-enrollment-view

Read first, in full:
- docs/GFC_Session3_ClaudeCode_Prompt.md (context for what 3.1 and 3.2 built)
- docs/GFC_App_Build_v2.md (v2 §5.3 for the enrollment gate; §15 OpenEMR configs
  for reference only, not scope here)
- docs/GFC_Intake_and_Packet_Spec_v1.md (§3.2 for Track A/B enum, §4.2 for the
  consent set, §4.3 for signature and audit rules)
- docs/GFC_Client_Care_Profile_Schema_v1.md (client data model; careTier is now
  documented as A1|A2|A3|A4|B — code migration is part of THIS session)
- CLAUDE.md at repo root (running status)

SCOPE

Three scopes, one PR, but each in its own commit so they're reviewable
independently.

===============================================================================
A. STAFF ENROLLMENT-SUBMISSIONS VIEW
===============================================================================

Add a staff view for reviewing intake submissions from Session 3.2.

Location: new route /admin/enrollment served to admin, case_manager, and user
(clinical) roles. Deny all other roles at the API layer, not just the UI.

List view:
- Paginated table of all clients with columns: name, DOB, service line
  (PHC/IHPC), care tier (A1-A4 or B — see scope C), enrollmentStatus, intake
  completion % (count of required items satisfied / total required),
  submitted-at timestamp, source (in_app | offline).
- Filter chips: All | Intake pending | Ready for review | Enrolled | Needs
  follow-up.
- Sort by submitted date (default desc), name, service line.
- Search by name or DOB.

Detail view (click a client):
- All 3.2 intake fields grouped by section (matching the intake flow order).
- Consent statuses per type, with signature timestamp and provenance badge
  (in_app | signed_offline). Uses new signed_offline enum from scope B.
- Structured medication rows.
- Payer / insurance detail.
- File uploads (advance directive PDF, insurance card image, offline packet
  PDFs from scope B).
- Action buttons visible per role:
  * "Mark as reviewed" (admin, clinical, case_manager) — adds a reviewed_at
    timestamp + reviewer user id, no state change.
  * "Request follow-up" (admin, clinical) — opens a form to specify which
    items need patient action; sends a non-PHI portal notification; sets
    status to Needs follow-up.
  * "Approve enrollment" (admin only) — flips enrollmentStatus to `enrolled`.
    Blocks with a specific error listing missing items if any required consent
    or field is missing.

New API endpoints (all under /api/gfc/admin/enrollment, all role-gated at API
layer):
- GET  /list?filter=&sort=&page=&q= — paginated, filterable
- GET  /:clientId — full submission detail
- POST /:clientId/review — set reviewed_at + reviewer_id
- POST /:clientId/follow-up — body: { items: [key1, key2, ...] }
- POST /:clientId/approve — flip to enrolled or return 409 with missing items

Audit: every action writes to logActivity() (interim trail per CLAUDE.md).

UI: build in public/portal.html or a new public/admin-enrollment.html following
the existing admin-hub pattern. Use the same brand tokens (navy #033D50, gold
#F5CD85, cream #FAF7F2, Cormorant + DM Sans).

===============================================================================
B. OFFLINE PATIENT ONBOARDING
===============================================================================

Two paths to onboard patients whose intake was signed on paper before the app
existed. Both live under the staff enrollment view (scope A).

B1. Consent status enum addition
Add signed_offline as a distinct value alongside signed, pending, na. Same
"satisfied" semantics as signed for the enrollment gate, but preserved for
audit and provenance.

Update:
- The consent status enum in server.js and any Typescript types.
- The requireEnrolledClient middleware to treat {signed, signed_offline} as
  satisfied for the gate.
- The family-portal ROI-family check to accept either signed or signed_offline.
- GFC_CONSENT_DEFS documentation to note both values satisfy each requirement.

B2. Admin action: "Add offline-onboarded patient"
On the /admin/enrollment list view, add a top-right button (admin role only)
"Add offline-onboarded patient." Opens a full-page form (not a modal — too much
data):

Section 1: File upload
- Accept multiple PDFs and images (paper packet scans). 10 MB per file.
- Uploaded to Drive folder "GFC Offline Intake Packets" via the existing Drive
  integration.
- URLs stored on the created client record under a new field
  `offlinePacketDriveUrls: [string]`.

Section 2: Structured data entry
Required fields per intake spec §2A:
- firstName, lastName, preferredName (optional)
- dob (single date, age auto-derived)
- gender
- address (line1, city, state=GA default, zip)
- phone
- primaryLanguage
- livesWith
- serviceLine (PHC | IHPC | both)
- careTier (A1 | A2 | A3 | A4 | B — see scope C)
- primaryContact (name, relationship, phone, email, preferredChannel)
- emergencyContacts (at least one)
- careTeam (assignedFNPs, assignedCaseManager, primary/backup caregiver — can
  be blank at entry, filled later)
- allergies (text)
- medications (structured rows: name, dose, route, frequency, prescriber,
  pharmacy) — at least an empty array
- payer (type, insuranceIds, eligibility left blank for now)

Section 3: Consent checklist
For each consent in enrollmentRequirements(serviceLine):
- Radio button: "Signed on paper" | "Not on paper — will request in-app" | "N/A"
- If "Signed on paper": require signedAt date input (the date on the paper)
- Set consent status accordingly: signed_offline | pending | na

Section 4: Confirm and create
- Preview panel showing what will be created.
- "Create client record" button:
  * Creates the client with source=legacy_offline (new field on client record)
  * Sets enrollmentStatus = intake_complete
  * Writes audit trail entries per field and per consent
  * Redirects to the detail view of the new client

Access: admin role only. API endpoint POST /api/gfc/admin/enrollment/offline.

B3. Bulk import script
Write scripts/import_offline_patients.js:
- Accepts a CSV path argument (default: scripts/offline_patients.csv).
- CSV columns (header row required):
  firstName, lastName, dob, gender, addressLine1, city, state, zip, phone,
  primaryLanguage, livesWith, serviceLine, careTier, primaryContactName,
  primaryContactRelationship, primaryContactPhone, primaryContactEmail,
  emergencyContactName, emergencyContactPhone, allergies, medicationsJson,
  insuranceCarrier, insuranceMemberId, insuranceGroup, consentsSignedOffline
  (pipe-delimited consent keys), consentsPending (pipe-delimited),
  driveFolderUrl (optional link to that patient's packet PDFs)
- For each row: creates client with source=legacy_offline,
  enrollmentStatus=intake_complete, consents populated per the two lists with
  signed_offline status (for the first list) or pending (for the second) and
  signedAt = script run date for the signed_offline ones.
- Idempotent: dedupe by firstName + lastName + dob; skip and log if exact
  match exists.
- Logs successes and failures to scripts/import_offline_patients.log with
  timestamp and clientId per successful create.
- Does NOT run automatically. Bianca invokes it manually with the CSV in
  place. README note in scripts/README.md explaining how to run.

Provide scripts/offline_patients.sample.csv with two fake rows so the CSV
format is self-documenting.

===============================================================================
C. CARE-TIER CODE MIGRATION (1/2/3 → A1/A2/A3/A4/B)
===============================================================================

Per intake spec v1.1 §3.2 and PR #8's original note, code still uses the legacy
1/2/3 enum for careTier while specs use Track A/B. Migrate now if it hasn't
been done in a prior session.

Precheck: search server.js and public/*.html for existing careTier values. If
CARE_TIER_LABELS is already keyed by A1/A2/A3/A4/B, skip this scope and note
in the PR that it was already applied.

Otherwise:

1. Update CARE_TIER_LABELS in server.js. New enum: A1, A2, A3, A4, B. Labels:
   - A1: "Essential ADL"
   - A2: "Comprehensive ADL + IADL"
   - A3: "IADL-Forward Support"
   - A4: "Behavioral Support & Cognitive Wellness"
   - B: "Skilled Nursing (Track B)"

2. Update the intake form's care-tier picker (portal.html, GfcIntakeFlow) to
   expose the five values.

3. Update the staff enrollment view (scope A) and any other UI displaying the
   care tier to render the new labels.

4. Write a one-shot migration function that walks all existing client records
   and rewrites careTier per legacy mapping:
   - 1 → A1
   - 2 → A2
   - 3 → A4
   Any record with a value not in {1, 2, 3, A1, A2, A3, A4, B} is logged with
   its ID and left untouched.

5. Run the migration once on startup, gated by an env flag
   CARE_TIER_MIGRATION_APPLIED=false (default). After successful run, log a
   line instructing Bianca to set the flag to true so it doesn't re-run.
   Include the flag in .env.example.

6. Keep this migration as its own commit within the PR so it's reviewable on
   its own.

===============================================================================
DO NOT
===============================================================================
- Enter or store real client PHI. Test data only.
- Build AI-based document extraction. That was proposed as a spec and shelved.
- Change any 3.1, 3.2, or 3.4 code beyond what these three scopes require.
- Touch OpenEMR / FHIR / clinical-workspace code. That's Session 4.
- Turn on billing routes or `hasBillingAccess` flag. That's the B-series.
- Modify Session 2 cleanup items (dormant service-portal.html validation
  components, dormant lab HubSpot connector) — those are already handled.

===============================================================================
ACCEPTANCE
===============================================================================

A. Staff enrollment view
- Admin loads /admin/enrollment and sees the paginated list, filtered
  correctly by each chip.
- Case manager and clinical roles see the same list; admin-only actions
  (Add offline-onboarded patient, Approve enrollment) are hidden.
- Approve enrollment blocks with 409 + specific missing items when required
  consents or fields are absent.
- Requesting follow-up sends a non-PHI portal notification to the patient
  listing only the outstanding items.

B. Offline onboarding
- signed_offline satisfies the enrollment gate identically to signed.
- "Add offline-onboarded patient" creates a valid, gate-passing client with
  real PDF(s) linked in Drive, correct consent statuses set to
  signed_offline, and enrollmentStatus = intake_complete.
- Bulk import script creates test clients from the sample CSV; re-running
  it on the same CSV does not duplicate records.

C. Care-tier migration
- Existing test clients with careTier: 1 have careTier: 'A1' after migration.
- All UI (intake form, staff view, portal) displays the new labels.
- The migration only runs when CARE_TIER_MIGRATION_APPLIED is false or unset.
- Records with unexpected careTier values are logged and left alone (no data
  loss).

Full session
- App still boots. Existing 3.1, 3.2, 3.4 (if merged) flows unaffected.
- Client, caregiver, and admin logins unaffected.
- All new PHI-touching actions write to logActivity().

Open ONE PR titled "Session 3.3: Staff enrollment view + offline onboarding +
care-tier migration." Stop for review. Do not start Session 4.
```

---

## After this lands
Session 4 (Clinical portal + OpenEMR — split into 4.1 clinician workspace, 4.2 clinician scheduling, 4.3 patient portal clinical read) is next.
