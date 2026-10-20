# The note probe's "read-only staff" was a case manager, and a case manager is an LMSW now

**Why:** `scripts/verify_note_lifecycle.js` reported 191 passed, 5 failed on `main`. The app was right; the probe was stale. Its `CM` fixture was `role: 'caseManager'` with clinical role `readOnly`. Since the account-types change (`docs/decisions/2026-10-15-account-types.md`), every case manager is an LMSW and the boot migration (`clinicalRoles.js`) moves a read-only case manager to `lmsw`. So the "read-only staff" checks were testing a licensed social worker, who may co-sign and record a screening. The other two failures were knock-ons: a third co-signature, and a second screening on the encounter.

## What changed (probe only, no app code)

- **The read-only checks now use a View-only Manager** (`VIEW`), stored exactly as `accountTypes.fieldsFor('manager', 'view')` writes it. That is the read-only account that still exists. Co-sign, write a note and record a screening are each refused with 403.
- **The case manager fixture is now an LMSW / Case Manager** (`role: caseManager`, clinical role `lmsw`, as `fieldsFor('lmsw')` writes it), and one new check asserts the current rule: a case manager writing a note without a social work visit type is refused with `VISIT_TYPE_REQUIRED`.
- The probe stops at login if the case manager or View-only manager cannot sign in, so a broken fixture fails loudly instead of as five 403 mismatches.

## Verified

- `node scripts/verify_note_lifecycle.js`: **197 passed, 0 failed**.
- `npm test`: 2614 tests, 0 failing (1 skipped, pre-existing).
