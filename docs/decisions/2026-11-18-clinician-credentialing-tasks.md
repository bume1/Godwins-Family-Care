# Clinician credentialing tasks on every clinician's checklist

**Date:** 2026-11-18 · **Owner:** "add the credentialing tasks we have added for Thanmayie to all providers' initial onboarding (CAQH etc.)"; "all signing should happen in app (upload is a backup)"

## New built-in tasks
These apply to the clinician checklist (Chapter C) and to hybrid clinicians (Chapter E, which reuses it):
- **C.5.07 I-9 identity document copies** (Phase: Offer & Employment Paperwork). The payroll officer verifies.
- **C.6.15 Medicare enrollment and reassignment to Godwins Family Care.** The credentialing owner records it.
- **C.6.16 CAQH ProView profile.** Verified. The description covers the 120-day re-attestation.
- **C.6.17 Georgia PDMP registration**, only when the clinician prescribes. Verified.
- **C.6.18 BLS card.** Verified, and its expiry is tracked under Renewals.
- **C.6.19 Education: diplomas and transcripts.** Verified.

Already built in, so not added again:
- NPI taxonomy (C.6.02)
- DEA (C.6.05, when they prescribe controlled substances)
- outside employment (C.6.09)
- TB, immunizations, and the driver's license (C.6.10–12)

Instructions are taken from the onboarding guide the office wrote for the first clinician. The office can change them with Edit Instructions.

**Not added to** contracted exam clinicians (Chapter D): they do not bill Medicare or plans, or prescribe, under GFC.

## Signing happens in the app
On an offer letter or agreement, the office now sees "Use Attach Document to Sign above". Uploading a signed paper copy sits behind "Signed on paper instead?", the same as policies.

## Open for the owner
The tasks the office added by hand for Thanmayie now repeat these built-in ones on her checklist. Remove the hand-added copies, or hide the built-in ones for her with Edit Task.

## Verified
- A test in `test/onboarding_reorganize.test.js`.
- Full suite passing.
