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
insuranceCarrier, insuranceMemberId, insuranceGroup, consentsSignedOffline
(pipe-delimited consent type keys, e.g. `npp|roiFamily|serviceAgreement`),
consentsPending (pipe-delimited), driveFolderUrl (optional link to that
patient's packet PDFs)`

`consentsSignedOffline` entries are recorded with `signedAt` set to the
script's run date (the exact paper-signing date isn't captured by this bulk
path — for a precise date, use "Add offline-onboarded patient" in
`/admin/enrollment` instead, which asks for it per consent).

TEST DATA ONLY until HIPAA-live.

## import_legacy_transfer_rois.js (Session 3.4)

One-time importer for the legacy Transfer-of-Care Provider ROI Google Sheet.
See the file header for usage.
