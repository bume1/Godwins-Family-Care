# A care plan from an unlicensed author reaches a clinician to sign, then the patient (owner, 2026-11-09)

Owner report: a care plan drafted by someone who is not licensed "simply saves and is only visible to the internal team", with no way for the licensed clinician to sign it. The screenshot showed a clinical plan with no signing box anywhere and no "waiting on a clinician" note.

- **The cause in the screenshot: the shared admin account counted as a provider.** `resolveClinicalRole` makes every admin a provider, so a plan written from the GFC Admin account saved as fully signed. It never waited on anyone, so no clinician was ever offered a signature.
- **An admin signs a care plan as a provider only with an NPI on file** (owner choice). Without one, `evaluateCarePlanSignature` records the admin as the author (`clinicalRole: 'admin'`) and the plan waits for a clinician, as a coordinator's does. This is the rule referrals already use for an admin (`isReferralTarget`). Everywhere else an admin still resolves to provider.
- **An RN co-signs a clinical patient's plan written by a coordinator, an LMSW or a no-NPI admin** (owner choice). A clinical plan an RN wrote still needs a provider or an LCSW. `canCompleteCarePlan(user, serviceLine, plan)` reads the author's role from the plan. The co-sign route, the care plan screen and the Inbox all ask this one function.
- **The co-sign box moved above the plan.** At the foot of a long plan it sat below the fold on a laptop.
- **Home care plans were hard to reach:** the Inbox's Open Care Plan tried to open a clinical chart a home care client does not have, and My Day listed clinical plans only. Inbox items now carry `noChart`, which opens `/clinical?carePlan=<id>`, and the digest reads every client.
- **The patient is emailed when the plan becomes active** (`notify.carePlanReady`): when a licensed author's save completes it, or when the co-signature does, unless the client already signed that version. The email carries no plan content. The POA rewrite now covers "Your care plan".
- **Plans saved before this are not reopened.** A plan the admin account already saved as complete stays active and visible to the patient. To add a clinician's signature, write a new version from a clinician's account.
- **Verified:**
  - `test/care_plan_cosign_release.test.js`: 10 tests.
  - 12 of 12 deliberate breaks caught.
  - `scripts/verify_care_plan_cosign_release.js`: 38/38 over real HTTP.
  - `verify_care_plan_format.js` was repointed to the new rule (37/37). `verify_care_plan_patient_visibility.js` (16/16) and `verify_clinical_roles.js` (57/57) pass as before.
  - Full suite: 3,597 tests, 0 failing.
  - Rendered in Chromium as a provider and an RN: the Co-Sign Plan button is at the top of the plan.
  - `verify_care_plan_chart_filing.js` fails the same way on main without this change.
