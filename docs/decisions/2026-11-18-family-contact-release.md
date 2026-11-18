# A family contact's own HIPAA release, with an expiry (owner, 2026-11-18)

## The ask

Caregivers who act a bit like a POA, with no legal authority, need access to a
client's health information within reason: tied to specific clients, view-only,
no billing, logged, easy to revoke, and a record that a signed HIPAA release
is on file, with an expiry date.

## What already existed (no new role needed)

The **Family / Authorized Contact** account type already does almost all of it:

- Linked to specific patients (`familyLinks.js`), one link per patient.
- Non-POA family is read-only, never sees billing, and sees only what the
  patient's Sharing settings open (care plan, appointments, medicines, etc.).
- Locked until the patient's family Release of Information consent is signed.
- PHI reads land in the audit log; revoke is Remove Link or deactivating the
  account, effective on the next request.

## The gap, and what changed

The family ROI is one consent per patient with free-text names. Nothing
recorded a release for **this person**, and nothing expired.

- Each family link now carries `release: { signedOn, expiresOn, note,
  recordedBy, recordedAt }` or null. `familyLinks.normalizeRelease` validates
  it (real dates, expiry after signing; a blank expiry means "until revoked").
- **A page that saves a link without sending `release` keeps the one on file.**
  Several screens rebuild links from `{ clientId, isPoa, relationship }`; if
  that wiped the release, an unrelated save would silently drop it. Only an
  explicit `release: null` (or blank dates) clears it.
- `releaseState` reads it on Georgia's date: a release expiring on the 30th is
  good through the end of the 30th.
- **When it has expired, a non-POA contact is refused on the next request**
  (`FAMILY_RELEASE_EXPIRED`) at the three doors family reads through: the
  portal gate (`requireEnrolledClient`), the clinical read
  (`evaluateClinicalReadAccess`) and messaging (`requireMessagingRole`). The
  portal shows "Your access is paused" with a call-the-office line.
- **A POA is never gated on it.** A POA is the patient's personal
  representative and stands in for them.
- **No release recorded does not block.** Existing family contacts keep working
  on the patient's ROI as before; the client page shows "No release recorded"
  in amber so the office can catch up.
- The client page (Family and authorized contacts) gained Signed and Expires
  date fields and a status badge per contact.

## Left for the owner

- Whether "no release recorded" should block new non-POA contacts.
- A reminder email to the office before a release expires (30-day window is
  already computed as `expiring`).
- Per-person sharing. Sharing is still per patient: every non-POA contact for
  a patient sees the same sections.
