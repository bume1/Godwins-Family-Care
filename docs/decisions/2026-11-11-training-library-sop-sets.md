# Training Library points at the new SOP sets (2026-11-11)

Owner uploaded the separate SOP .docx files to Drive and asked that the Training Library line up with them and link the right file.

## What changed
- `onboarding/sources.js` gains four canonical sources: `ADMIN_SOPS_SET1` (GFC-ADMIN-SOP-S1, SOP-ACC-01/ONB-01/ONB-02), `ADMIN_SOPS_SET2` (S2, SOP-SIG-01/SIG-02), `ADMIN_SOPS_SET3` (S3, SOP-PAY-01/PAY-02) in 01 Company / Policies & Procedures / Current, and `STAFF_PAY_GUIDE` in 06 People / Training. All v1.0.
- **TRN-004 (the app training)** now seeds Set 1, Set 2 and the Staff Pay Guide. Its policy line is Set 1, naming SOP-ACC-01, SOP-ONB-01 and SOP-SIG-02. Next step stays "Write SOP" because SOP-SCH-01 (Scheduling & Availability) is still owed.
- **TRN-503 (caregiver onboarding documents)** also gets the Staff Pay Guide and Set 2.
- **The Staff Pay Guide has ONE source point (owner, same day).** The Drive file is the truth, written once in `sources.js` (`STAFF_PAY_GUIDE`). The Training Library carries it (TRN-004, TRN-503), and the pay setup step of every onboarding list (A.5.02, B.5.02, C.5.03, D.4.03, E.2.02, F.5.03) shows a "Read the Staff Pay Guide" button pointing at the same entry, as extra help. **The button disappears once that step is complete or marked not applicable**; the guide stays in the library. Every default training link now reads its Drive pointer from `sources.js` rather than restating the id.
- **Set 3 is office only** and is a library reference row ("Payroll records, Gusto to the app (admins and managers)"), never a staff module. A test asserts it never lands on a staff training.
- **The old SOP 1 Google Doc is retired.** `RETIRED_URLS` takes it off TRN-004 once at boot on deployments that already seeded it, keeping the row with who and when. A link the office added by hand to that same document is also taken off, since the document itself is withdrawn.

## Must not undo
- Set 3 stays off every staff training.
- The retirement never edits the stored record in place; it copies the links first.

## Verified
Suite 3683 pass, 0 fail. Two mutations (retirement loop disabled, in-place mutation restored) each fail a test.

## Open for the owner
- Withdraw the old SOP 1 Google Doc and the Gusto working guide Google Doc in Drive.
- Write SOP-SCH-01 and add it to TRN-004.
- None of this is live until the EC2 container is rebuilt.
