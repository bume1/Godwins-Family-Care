# A designated POA enrolls the patient and signs in their own name

Owner, 2026-10-21: a POA opening a patient who had not done intake hit "Family access is locked — awaiting ROI" instead of the intake form. Owner decisions: the POA does everything the patient would; signatures carry the "<POA> as POA for <patient>" stamp; no separate counsel flag.

## The dead end it closes
- Every family login, POA included, was locked until the patient's **family Release of Information** was signed (`requireEnrolledClient`).
- Intake, consents, submit, uploads and the record release were **patient-login only** (`requireClientForIntake`) and found the patient by the signed-in user's own id.
- The family ROI is signed during intake, so a POA could never get in, and a patient with no login of their own could never be enrolled online. Session 4.3 had flagged this as open.

## What was decided
- **A designated POA is gated like the patient**: on intake, never on the family release, which is the patient's permission for *other* family to see their care. Plain family are unchanged.
- **`requireClientForIntake` admits a POA for the patient chosen for this sign-in** and sets `req.intakeClientId`; every route it guards now works on that patient (intake read/save/submit, consents, intake and document uploads, the no-login upload link, prior providers, the Transfer-of-Care release). Plain family are refused.
- **Signatures are in the POA's own name.** A consent signed by a POA stores `signerRole: 'poa'`, `signedById`, `actingFor` and `signedAs: "<POA> as POA for <patient>"`. The signed consent PDF and the enrollment packet print `signedAs`. A record release signed by a POA states "Power of Attorney" as the signer's authority if left blank.
- **Notifications:** no notice is ever queued to a placeholder login (one check in `recipientMayBeEmailed` covers every notice; the message notifier and the client-side recipient list also skip it). The "enrollment complete" email now also goes to the patient's POAs, with a link that opens that patient (`/portal?for=<id>`).
- A consent signed as POA no longer makes the patient look like a "possible shared POA login".

## Verified
- `scripts/verify_family_multi_patient.js` 69/69, including a POA enrolling a no-login patient end to end; three mutations (the intake gate, the ROI bypass, the signer stamp) each confirmed to fail it.
- `test/family_links.test.js` 20; `scripts/verify_portal_render.js` with a new POA-intake audience in Chromium (intake gate, "as their POA" wording, no page errors).
- `bug_sweep_0929`'s "POA gets no upload controls" guard repointed to the new rule (plain family read-only, POA can upload). Full suite green.
