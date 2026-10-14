# B1, the insurance round trip: intake → app → OpenEMR → Availity → back (2026-10-13)

Owner-directed from `GFC_Insurance_Eligibility_Loop_Spec.md`. This is B1's app half. The X12 270/271 itself waits on the Availity EDI enrollment with Palmetto; until then the biller checks in the Availity portal and records the result here.

**Prerequisite gate, recorded:** Sessions 0, 8, 10, 11 and 12 are not done and the B-series sits after them. The owner approved skipping on 2026-10-13. This work does not depend on matching, the family portal, RPM or the audit UI.

## What Scope 0 found

- **The Medicare check never fired for a real record, and the spec's correction was itself wrong.** The spec said the two fallbacks in `isMedicarePatient` rescue most patients. Neither does. The first read `intake.insurance.insuranceTypes`, but intake fields are stored flat (`intake.insuranceTypes`), so that object never exists. The test covering it built its fixture in a shape production never writes. The second read `payer.primaryName`, which nothing writes. A Part B or dual-eligible patient, shaped exactly as the intake mirror stores them, came back **false**. So the 2026-10-12 CDS audit's "never fires" was right.
- **There were five payer vocabularies, not four.** The fifth is the enrollment screen's free-text "Payer type" box.
- **OpenEMR 8.4 has a standard insurance write**, so Scope C's STOP did not apply. Checked in the 8.4.0 source:
  - `POST` and `PUT /api/patient/:puuid/insurance` (`_rest_routes_standard.inc.php:572-583`).
  - `provider` is OpenEMR's numeric insurance-company row id (`CoverageValidator.php:67`), listed by `GET /api/insurance_company`.
  - **FHIR Coverage is read-only on 8.4.**
  - `subscriber_ss` is listed as required in the published API docs but is not enforced by the validator. The app never sends it.
  - **A refused row answers HTTP 200 with `validationErrors` and writes nothing** (the seventh instance of that trap).
- **The write needs scopes the deployed v4 client does not have:** `user/insurance.write` and `user/insurance_company.read`.
- **0C was not answerable from the sandbox.** Per-clinician OpenEMR sign-in means nothing here can list the live instance's insurance companies.

## What was decided (must not undo)

- **ONE payer vocabulary: `insuranceEligibility.js`.**
  - Closed kinds: `medicare_ffs`, `medicare_advantage`, `medicaid`, `medicaid_mco`, `commercial`, `va`, `ltc`, `private_pay`.
  - Every legacy string goes through **one translation table**. That includes `'medicare_b'`, which `server.js` `ENUM.payerType` still produces on purpose. Stored records are read as they are; nothing is migrated or rewritten.
  - `isMedicarePatient` is one line through it, with both fallbacks removed.
- **'Dual eligible' is two ranked payers.** Medicare is billed first and Medicaid second, since Medicaid is the payer of last resort. 'Combination' with payers nobody ranked is **unresolved and shown to the biller, never guessed.**
- **Rank is a new field on each payer block.** Exactly one may be primary; two primaries are refused at both save routes.
- **QMB is stated (`qmb`: Unknown / Yes / No) and never inferred.** Absent means unknown.
- **A malformed Medicare number (MBI) is saved and flagged, never refused.**
  - The format is written once. Letters S, L, O, I, B and Z are never valid.
  - Every save upper-cases it and strips spaces and hyphens.
  - The wizard warns once, and a second Continue moves on.
- **Coverage start and end dates on each block.** A member id with no start date is flagged, not refused. The OpenEMR write refuses without one.
- **The card photo uses the existing `insuranceCard` document kind**, uploaded from the insurance step. No second upload was created.
- **Verification state lives on the client record**, as `client.insuranceVerification[rank]`. Every result is also kept, append-only, in `insurance_verification_events` (registered, PHI).
  - **Nothing auto-verifies, and nothing auto-expires.** Age is shown, never enforced.
  - The one exception is not a clock. A verification is fingerprinted to the kind, member id and payer it checked, so **a member id changed after the check reads as unverified again**. That check was about different data.
- **Mismatch keeps both values.** A plan type found that differs from intake (above all Medicare Advantage where intake said Original Medicare) is saved as `mismatch` **even if the biller picked "verified"**. Intake's kind and payer and the check's kind and payer are all kept and shown together on the banner, My Day and the pre-visit packet.
- **The gate is on the CLAIM, never the signature.** `checkInsuranceForBilling` has one call site, inside `billing-submit`, and runs before anything is written.
  - The refusal names the payer: "Cannot submit to billing: Humana Gold Plus coverage is unverified."
  - Private pay passes.
  - **The override is admin only, a reason is required, and it is stored on the record** (`insuranceCheck.override`) and logged (`billing_insurance_override`). A manager is refused. Nothing in the sign gate knows insurance exists.
- **QMB: no copay statement, under Original Medicare or Medicare Advantage.** The block sits on both creating a copay statement and sending one.
  - **There is no override.** If the QMB answer is wrong, correct it on intake, where it is stated.
  - **Home care hours are deliberately not blocked.** They are private-pay personal care, not Medicare cost sharing. This is a narrower reading than the spec's "no patient statement"; say if you want those blocked too.
  - Collection tasks and balance transfers do not exist yet. The same function already answers for them, and a test pins that.
- **This revises the 2026-09 "do not write coverage" decision.** The reasoning stands (an unverified payer must not reach a claim). The conclusion changed:
  - The app writes the OpenEMR insurance row **only after a biller records a VERIFIED check and picks OpenEMR's insurance company** (owner choice, 2026-10-13). Never from intake alone.
  - **One row per ranked payer.** The subscriber is the patient, unless a commercial policy names someone else.
  - `accept_assignment` comes from the signed Assignment of Benefits consent.
  - **A failed write never undoes the verification.** It is recorded on the row and shown.
  - `docs/OPENEMR_COVERAGE.md` is regenerated from `openemrCoverage.js` with the new rows. The old entry is gone, not left beside the new behaviour.
- **The two scopes are requested now, ahead of the successor client.** A token carries the intersection of requested and granted scopes, so this is safe. Until the new client exists the write reports `EMR_INSURANCE_SCOPE` by name and nothing else is affected. There is no new banner. The scope-count guard went from 54 to 56.
- **No X12, ever, and no payer ids.** A build guard sweeps the app for X12 parsing. The only id handled is OpenEMR's own company row id, picked from OpenEMR's list.

## Consumers of `client.payer` (the before-state) and what happened to each

| Consumer | Before | Now |
|---|---|---|
| `orderRequisitions.isMedicarePatient` | code list without `medicare_b`; two dead fallbacks | normaliser, one line |
| `clinicalRepository.summarizePayerForBanner` | its own block reading; `payer.qmb === true` | normaliser + verification state; QMB stated only |
| `server.js` H&P prefill `payerType` | raw code (`medicare_b`) | canonical label |
| `server.js` checklist `ltcPolicy` / `coverage` | regex on `payer.type` | normaliser |
| `pdf-generator.js` requisition "Primary payer" | `payer.primaryName`, never written, so **always blank** | normaliser |
| `myDay.buildDayRow` | none | verification line (new) |
| `portalProfile.coverageForPatient` | display of blocks, last-4 only | **unchanged**: patient-facing display, reads blocks not codes |
| `consentRender` / face-sheet PDF "Payer type" | prints raw `payer.type` | **unchanged on purpose**: it prints into signed consents, and changing a rendered value raises re-signature flags |
| `admin-enrollment.html` payer summary / free-text box | raw | **unchanged**: display; the editor now also shows the new fields |
| `server.js` mirror and editor merge (producers) | produce `medicare_b` / `combination` | unchanged producers; read through the table |

## Verified

- `test/insurance_eligibility.test.js`: 41 tests covering F2 cases 1–13 plus the OpenEMR row shape.
- Two existing guards were **repointed, not deleted**:
  - The scope count is now 54 + 2.
  - The `isMedicarePatient` test now asserts the shapes production actually stores, and that the dead shape no longer counts.
- **Eight mutations, each confirmed to turn a test red.** These are the spec's six, with two split into both halves:
  - `medicare_b` dropped.
  - QMB set to yes whenever Medicaid is present.
  - Intake coverage starting verified.
  - The gate moved to signing.
  - The QMB block bypassed, in the module and in copay creation.
  - Mismatch collapsed, by status and by dropping the intake side.
- Full suite: 2,377 tests, 0 failing, 1 skipped (pre-existing).
- `scripts/verify_note_lifecycle.js` runs **177 passed, 5 failed**, through the real routes against a fake OpenEMR.
  - The 5 failures are pre-existing: case managers being treated as LMSW. `main` shows the same 5 (164/5).
  - The 13 new checks all pass: signed while unverified; refused, by name, with nothing written; a manager's override refused; the insurance screen is billing's; the MBI normalised; MA-vs-Original recorded as a mismatch with both values on the clinician's banner; the mismatch refuses the claim; the company list read; the row reaching OpenEMR as primary, self-subscriber, with no SSN; history kept; the claim submits.
- `clinical.html`, `portal.html` and `admin-enrollment.html` compile with esbuild.

## Not proven from the sandbox

- That live OpenEMR 8.4 accepts the insurance row. It needs the successor client, and the subscriber name must match the OpenEMR patient record exactly.
- That the live instance has insurance companies configured (0C).
- Neither page was rendered in a browser this pass.

## Open for the owner

1. **Register a successor OpenEMR client carrying the v4 client's 54 scopes plus `user/insurance.write` and `user/insurance_company.read`**, then swap `OPENEMR_CLIENT_ID` and `OPENEMR_CLIENT_SECRET` on the box. Until then a verification saves in the app and reports "not written to OpenEMR".
2. **Check OpenEMR → Administration → Insurance Companies** has Medicare (Palmetto), Georgia Medicaid and the Medicare Advantage plans you bill.
3. **Every existing patient is now unverified, so no claim can be submitted until billing records a check** (or an admin overrides with a reason). That is the intended control. It does mean the first few submissions will stop until someone works the Insurance card.
4. Home care hours for a QMB client are still billable (see above). Say if you want them blocked.
5. The face-sheet and consent renderers still print the raw payer code. Changing them would re-flag signed consents, so that is a separate decision.
