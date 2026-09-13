# Scripts

One-shot / manually-invoked scripts. None of these run automatically — they
are run by hand when needed.

## import_offline_patients.js (Session 3.3, Scope B3)

Bulk-creates client records for the legacy paper-packet patients (the ~7
clients who signed on paper before the app existed). Creates each client with
`source: 'legacy_offline'`, `enrollmentStatus: 'intake_complete'`, and
consent statuses set per the CSV's two consent-key lists.

**Usage:**

```bash
cp scripts/offline_patients.sample.csv scripts/offline_patients.csv
# edit scripts/offline_patients.csv with real patient data
node scripts/import_offline_patients.js
# or point at a different path:
node scripts/import_offline_patients.js path/to/your.csv
```

Idempotent — re-running against the same CSV skips rows that already match
an existing client (dedupe key: `firstName + lastName + dob`, case-insensitive).
Successes and failures are logged with timestamps to
`scripts/import_offline_patients.log`.

**CSV columns** (header row required — see `scripts/offline_patients.sample.csv`
for two fake example rows):

`firstName, lastName, dob, gender, addressLine1, city, state, zip, phone,
primaryLanguage, livesWith, serviceLine, careTier, primaryContactName,
primaryContactRelationship, primaryContactPhone, primaryContactEmail,
emergencyContactName, emergencyContactPhone, allergies, medicationsJson,
insuranceCarrier, insuranceMemberId, insuranceGroup, consentsSignedOffline,
consentsPending, consentsNa, consentsSignedAt, hourlyRate, dailyMinimumHours,
rateEffectiveDate, driveFolderUrl (optional link to that patient's packet PDFs)`

**Consent status is per type, never blanket** — a legacy paper client may well
have signed eight of nine documents. Three pipe-delimited columns carry the
split: `consentsSignedOffline`, `consentsPending`, `consentsNa` (declined or not
applicable), each holding consent type keys, e.g.
`npp|roiFamily|serviceAgreement`. Every key is checked against the consent
registry in `public/consent-text.js`; an unrecognised key is skipped and named
in the log rather than written to the record. The fourteen valid keys and the
lane each belongs to are listed in `docs/CONSENT_REGISTRY_v2.md`.

Note the lane split (Session 4.6): a Private Home Care client signs
`serviceAgreement`, an In-Home Primary Care patient signs
`ihpcServiceAgreement`, and a dual-lane client signs **both**. `careTier` is a
home care concept — leave it blank for an IHPC-only patient.

`consentsSignedAt` sets the paper-signing date for every `consentsSignedOffline`
entry in that row; omit it and the script's run date is used. For a per-consent
signing date, use "Add offline-onboarded patient" in `/admin/enrollment`
instead, which asks for it one consent at a time.

`hourlyRate` and `dailyMinimumHours` carry the agreed rate off the paper
Financial Agreement. Both Private Home Care money documents render that table,
so without them neither is presentable in-app and the client would be blocked at
their first in-app signature.

TEST DATA ONLY until HIPAA-live.

## verify_46_consents.js (Session 4.6)

Acceptance run for the consent registry, the lane split, the rate gate, the
provenance rules and the signed-copy generators. Boots the real Express app
against a local key-value store that speaks the Replit DB protocol, so the
routes are exercised over HTTP rather than only at the unit level.

    node scripts/verify_46_consents.js

Every assertion reads back a STORED VALUE. A 200 that wrote nothing is the
failure mode this codebase keeps meeting, so a status code is never treated as
proof. Runs entirely locally — no network, no live EMR, no PHI. Exits non-zero
on any failure.

## import_legacy_transfer_rois.js (Session 3.4)

One-time importer for the legacy Transfer-of-Care Provider ROI Google Sheet.
See the file header for usage.

## Session 5 — HIPAA go-live scripts (2026-09-10)

| Script | What it does |
|---|---|
| `export_kv_snapshot.js [out.json]` | Dumps every key of the current store (`DATA_STORE` selects it) to JSON. The app-side half of the pre-cutover snapshot; contains PHI — keep it inside the boundary. |
| `migrate_kv_to_postgres.js [--dry-run] [--verify-only] [--from-file snap.json] [--ignore k1,k2] [--overwrite]` | KV → Postgres. Walks the source dynamically; **refuses on any collection without a handler** in `dataMigration.js`; idempotent; verifies by read-back; writes a per-collection report next to the script. |
| `verify_session5.js` | Boots the real server on the memory adapter (or `BASE_URL=` for a deployed host) and runs the 38-check acceptance: production boot refusals, MFA enrol/verify/recovery, session revocation and idle expiry, the per-user OpenEMR handshake, durable audit rows, scrubbed log. |
| `verify_emr_authcode.js` | **Owner-run** live acceptance for per-user OpenEMR auth: authorize URL → pasted redirect → PKCE exchange → userinfo → TEST-DATA note written and read back with the OpenEMR `user` on the row. Reports whether the password grant is still on. |
| `emr_login.js` | Obtains a per-user OpenEMR token from a terminal for the other live probes (`verify_84_transport.js`, `verify_6b_charges.js`, …), which now read `OPENEMR_PROBE_ACCESS_TOKEN` instead of the retired API user. |
