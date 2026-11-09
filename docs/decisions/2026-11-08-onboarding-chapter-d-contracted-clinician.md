# Onboarding Chapter D: the contracted clinician (1099)

**Date:** 2026-11-08 · **Source:** Onboarding Playbook v3.0, Chapter D (D.1–D.8)

## What was built
- `onboarding/chapterD.js`. Four phases:
  - Scope Letter & Agreement
  - Credentialing
  - Systems & Standards
  - Ready to See Patients
- Thirteen items when every input is on, all citing the Playbook.
- **D.5 says C.2 applies without modification.** So the credentialing rows reuse C.6's own steps and C.2 classifications, with C.2 cited.
  - Packet, NPI, protocol agreement, alternate physician, controlled substances and exclusion screening come straight from C.6.
- **The certificate of insurance comes from the carrier.** It is never a copy the clinician supplies. It lists GFC as additional insured and expires (renewal tracking).
- **Examiner credentialing** appears only when IME is in scope. **Payer enrollment** appears only for insured billing. A **BAA** appears only when the new `baaRequired` input is on.
- **Monitoring (D.7)** is C.9 copied row by row as `D.7.R1–R7`. The annual row reads "malpractice renewal verified by carrier certificate".
- **A provider account set to `1099` defaults to Chapter D.** The record is stamped `relationship: '1099'` and the page reads "Contracted (1099)".

## Must not undo
- **D.2 is build-enforced.** `test/onboarding_chapter_d.test.js` fails the build if D gains any of these:
  - an Employee Handbook or Code of Conduct acknowledgment
  - I-9, W-4 or direct deposit paperwork
  - an item about training, competency, orientation, probation or scheduling
  - a step where GFC observes the clinician's practice
  
  Each of those is evidence of employment, per D.2.
- **A contracted clinician's readiness never waits on a Training Library module.** The chapter carries `trainsClinically: false` and `determinationModules` returns nothing for it. Service lines open on the C.8 conditions alone, and the Training tab is hidden. The same lines under Chapter C still require their modules, and a test pins that difference.
- `openDetermination` reads determinations from the person's own chapter, not from C.

## Verified
- 11 tests, with 13 of 13 mutations caught.
- Full suite passes.
- Rendered in Chromium: office view at 1440, the contractor's own view at 390.

## Open for the owner
- **Actors marked INFERRED** need confirming:
  - who signs the scope letter, BAA and agreement on her side
  - Payroll and Finance verifying the W-9 and vendor setup
  - the Executive Director provisioning systems
- **Counsel review of the agreement (D.4)** is recorded as part of the Executive Director executing it. There is no separate "counsel" actor.
- **Chapter E (hybrid: employed and contracted at once)** comes next. It runs C and D side by side, builds the shared items once, and checks the E.3 separation tests.
