# The record-release receipt goes to real inboxes, each greeted by name

Owner, 2026-10-23, with a screenshot: the "We received your authorization form" email for a patient whose POA signed went to the patient's placeholder login (`client+…@placeholder.local`) and read "Hi Patrick, Your signed Authorization…", as if the patient had signed.

- **Cause:** the release receipt is sent by `dispatchRoiNotifications` straight through `sendEmail`, not the notification queue, so the placeholder check added on 2026-10-21 never saw it. It went to the patient's address and the primary contact, always worded for the patient.
- **Now:** one message per real inbox. The patient (only if they have a login of their own), **the person who signed it** (a POA), the patient's other POAs, and the primary contact. Only the patient is told "your records"; everyone else is greeted by their own name and gets wording that names nobody. Both release routes pass who signed.
- **`sendEmail` itself drops placeholder addresses** (`email.isPlaceholderAddress`), so no caller anywhere can email one by forgetting to check.
- Verified: `test/family_links.test.js` (receipt wording, recipients guard, mailer skip), full suite green, `verify_family_multi_patient.js` 69/69.
