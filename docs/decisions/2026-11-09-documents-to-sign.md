# Documents the office sends staff to review or sign

**Date:** 2026-11-09 · **Owner-directed** ("how can I send employees documents in the app too? even after onboarding?"; "should be stored in drive, the clients record in app visible to the staff member and mgmt/admin")

## What it does
- The admin team (admin, manager, care coordinator) sends a PDF to **one staff member** or to **everyone of chosen staff types** ("All staff" included). A by-type send reaches people added later too.
- Each send is either **Sign** (drawn signature + typed name + a box) or **Acknowledge** (typed name + a box).
- **The employee signs alone.** GFC does not countersign in the app; anything GFC signs goes on the PDF before it is sent.
- **Where it is sent from:**
  - a person's Staff Record → Documents → "Sent to Sign"
  - Admin Hub → **Documents to Sign**, for sending by type and seeing who has and hasn't done it
  - an onboarding **Add a Task** form, which sends the PDF to the same people and links the task to it
- **Where staff sign it:** My GFC → My Documents → **Waiting on You**, and in the onboarding item's side panel when a task carries it.

## Where the signed copy lives
- **Google Drive**, in the person's staff folder.
- **Filed** in `caregiver_documents` as kind `signed_document`, status `accepted`.
- **Visible to** the staff member (My Documents) and the admin team (Staff Record). No one else.
- **What the copy is:** the original PDF plus one appended record page. The page shows:
  - the title, the printed name and the drawn signature
  - the account email and the Eastern date and time
  - a hashed network address
  - **the SHA-256 of the original**
- Every open goes through the app with the token in the header, and is audited. A Drive id never reaches a browser.

## Must not undo
- **A document step on an onboarding task is recorded only by signing.**
  - `recordStep` refuses `DOCUMENT_SIGN_ROUTE` unless the sign route passes `{ viaDocument: true }` as a server-side option.
  - A request body cannot claim it, and the page shows no Mark Done for it.
- **The document signed must be the one sent.** The send stores the original's SHA-256, and signing refuses `DOC_CHANGED` if the stored file no longer matches.
- **Signing is blocked while "View as"** (`BLOCKED_WHILE_ACTING_AS`), like every signature route.
- **`signed_document` is not an upload kind.** It is only a label (`FILED_ONLY_KIND_LABELS`), so nobody can upload a file that claims to be a signed copy.
- **Withdrawing keeps the row and every copy already signed.** It only stops it reaching people who haven't done it.
  - On one person's record, Withdraw shows only for documents sent to that person alone.
  - A by-type document is withdrawn from the Documents to Sign page.

## Files
- `staffDocumentSends.js` (pure scope and status rules)
- `onboarding/signedDocument.js` (the record page)
- the routes in `routes/staffPortal.js`
- `public/document-sign-ui.js` (`window.GFCDocSign`, shared by My GFC, the caregiver app, the Admin Hub and onboarding)
- Collections: `staff_document_sends`, `staff_document_signings` (registered, not PHI).

## Verified
- `test/staff_document_sends.test.js`: 14 tests through the real router. Plus one in `test/onboarding_custom_tasks.test.js`.
- **20 mutations, all caught.** Two survived the first pass and were fixed:
  - an empty options object could slip past the document gate
  - my harness had mutated a comment
- Full suite 3601, 0 failing.
- **Chromium:**
  - an RN at 390px signs from My Documents, and the copy files
  - the onboarding drawer shows the sign panel
  - the office views show per-person status and who-has-signed

## Not proven from the sandbox
- Real Drive storage and retrieval: a fake Drive kept the bytes.

## Open for the owner
- An onboarding task whose document is later withdrawn stays on the checklist and says the document was withdrawn. Remove the task too, or send a new one.
- There is no email or text telling someone a document is waiting. They see it the next time they open My GFC or onboarding. Say if a notice should go out.
