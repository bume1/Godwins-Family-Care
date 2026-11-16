# Sign or acknowledge, declared once per document (2026-11-15)

**Owner report.** "Our document filing system isn't seamlessly reflecting what should be signed vs. acknowledged across our onboarding area and My Documents." The Code of Conduct showed as an acknowledgment for all staff, and it must be signed.

## What was wrong
- **Policies were acknowledge-only, hard-coded.** The Handbook, Code of Conduct, Field Addendum, HIPAA and the manuals were one Acknowledge click each in onboarding. The click opened a Drive link in another tab, took no signature and filed no copy to My Documents.
- **One document, two rules.** Caregivers sign the Code of Conduct in their welcome packet; every other role clicked Acknowledge on it.
- **Offer letters.** Her SIGN step could be ticked off with "Mark Done" when nobody had attached the PDF for her to sign.

## What changed
- **Each policy declares `action: 'sign' | 'acknowledge'`** on its one entry in `onboarding/chapterC.js` ACKNOWLEDGMENTS. Every chapter reads that same entry.
  - **Sign (owner):** Code of Conduct, Field Addendum, Employee Handbook, HIPAA and Confidentiality.
  - **Acknowledge:** Clinical, Private Home Care and Administrative P&P manuals, the job description, and anything with no `action`.
- **A sign document counts only when signed** (`track.ackSatisfies`): in the app (`method: 'signed'`) or on paper filed by the office (`'paper'`). An older click-acknowledgment is kept in `ackHistory` and reads "acknowledged, still to sign".
  - **Everyone re-signs (owner).** Staff who clicked Acknowledge on the Code of Conduct see it waiting again.
- **Policies open on the shared signing screen** (`GFCDocSign.SignWorkspace`), the same one as documents the office sends: the policy on the left; the tick box, name and (to sign) drawn signature on the right; the added page shown as a preview.
  - Routes: `GET /api/my/policy-docs/:policyId/file`, `POST …/preview` (writes nothing), `POST …/sign`. The version is the server's, never the page's.
  - The Word files in Policies / Current are drawn into a PDF by `onboarding/policyPdf.js` (pdf-lib, the docx read by `documentText.js`). The signing records the SHA-256 of the source files.
  - The signed copy files to their Documents (`caregiver_documents`, `signed_document`, with `policy_id` and `policy_version`), a row goes to the new `staff_policy_signings`, and every onboarding item that asks for the policy records it.
- **The policies share the "waiting on you" list** (`GET /api/my/document-sends`, rows with `kind: 'policy'`), so the Home banner, the menu count and My Documents → Waiting on You all show them.
- **Who owes what** comes from their own checklist (`onboarding/policySigning.js`, `composeChecklist`): the Field Addendum reaches the admin team only when the role enters a home; caregivers sign the Code of Conduct, Handbook and HIPAA in their welcome packet and are not asked twice. A policy with no file (the job description) is not offered; the office files it.
- **Onboarding drawer:** each policy says "To sign" or "To acknowledge" and opens with Open and Sign / Open and Acknowledge. The office's button reads File Paper Signature for a sign document.
- **Offer letters:** her SIGN step is done by signing the attached document (`viaDocument`), or by the office after the signed paper copy is uploaded to the item (`SIGN_IN_APP`, `SIGNED_COPY_REQUIRED`). Signing an attached document on a built-in item now records her step (it was refused before by the same new guard's absence of `viaDocument`).
- Signing a policy is blocked while viewing as someone else (`impersonation.js`).

## Verification
- `test/policy_signing.test.js`: 10 tests, pure and through the real router. 6 deliberate code breaks, all caught.
- Four existing tests repointed, not deleted: the click route now refuses a policy with a file (`ACK_OPEN_DOCUMENT`), and the document-send tests read office-sent rows apart from policies.
- Full suite: 3,922 tests, 0 failing. `onboarding.html`, `my.html`, `caregiver.html`, `admin-hub.html` and `document-sign-ui.js` compile.
- Rendered in Chromium: the waiting list with sign and acknowledge rows, and the Code of Conduct on the signing screen with "You acknowledged this on 11/1/2026. It now has to be signed." No page errors.

## Not proven from the sandbox
- The real policy files read from Drive. They are .docx (checked 2026-11-15); the converter was run on a real Word file made with LibreOffice.

## Must not undo
- A sign document must never count on a click or an in-app acknowledgment.
- The policy's version comes from the server.

## Follow-up (2026-11-16): the office sees who has signed each policy
- Tracing the flow for the signing SOP found a gap: Documents to Sign → Who and the Staff Record's Sent to Sign listed only documents the office uploads. A policy's status showed only inside each person's onboarding checklist, and not at all for staff without one.
- `GET /api/my/admin/policy-signatures` (admin team; `?userId` for one person) lists each policy and where every person who owes it stands: signed, signed on paper, acknowledged, "acknowledged, not signed", or not yet.
- `GFCDocSign.OfficePolicies` shows it as **GFC Policies** under Documents to Sign (with Who) and on every Staff Record (with Signed Copy).
- 1 test, 2 deliberate breaks caught. Suite 3,923, 0 failing. Rendered in Chromium.
