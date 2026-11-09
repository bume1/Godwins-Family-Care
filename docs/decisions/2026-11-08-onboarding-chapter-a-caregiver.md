# Onboarding Chapter A: caregivers, connected to the welcome packet

**Date:** 2026-11-08 · **Source:** Onboarding Playbook v3.0, Chapter A · **Owner rule:** nothing is recreated

## How it works
- **The caregiver's side is unchanged.** She still onboards through the welcome packet in the caregiver app: profile, the 23-item checklist, forms signed in the app, and the office's fingerprinting, orientation, app training and skills check.
- **The office now sees Chapter A** on the onboarding page, like every other role. Each Playbook item names the packet entries that prove it (`packet: [...]`). Its status is read live from the packet's own derived checklist (`welcomePacketRepository.buildChecklist`, the same one the caregiver app and the scheduling gate use). Nothing is stored twice.
- **When an item is done.** All its required packet entries are done, plus any step the packet does not cover:
  - the W-4
  - exclusion screening (OIG, SAM, Georgia Medicaid)
  - the records-check determination
  - the qualifying route
  - reference and employment-history calls
  - the supervisor's written competency evaluation
  - mentor pairing and the first-week debriefing
  - the 30/60/90 reviews
- **How packet statuses read on an item:**
  - A packet entry marked not required does not hold an item open.
  - A missing packet fails closed.
  - A document sent in but not yet reviewed reads "With the Office".
  - A missing or sent-back document reads "waiting on her".
- **Mapping check.** Every one of the 23 packet entries maps to a Playbook item, and a test fails if a new packet entry is left unmapped.
- **The registry attestation stands in for the abuse, neglect and exploitation attestation** (Rule 111-8-65-.09(5)(a)1). Physical ability and immunization are packet items the Playbook does not list. They sit under an owner-addition item.
- **Not collected again.** The Handbook, Code of Conduct and HIPAA acknowledgments come through packet items 17–19. Chapter A adds only the Field Addendum, Private Home Care P&P 3.1 and the job description, plus the drug testing consent. The caregiver app's Onboarding tab links to them.
- **Setup:** classification (companion, PCA or licensed nursing) narrows the qualifying-route checklist. Two flags: drives, and the forty-hour PCA training route.
- **Recurring (A.10):** copied with its classifications. Supervisory visits stay per residence, the same as Chapter B.

## Verified
- 9 tests, with 9 of 9 mutations caught.
- Full suite 3347 pass, 0 fail.
- Rendered in Chromium with a part-finished packet. TB accepted reads done, and the drug screen sent in reads waiting on review.

## Open for the owner
- **Welcome packet items 16–19 still say "Gusto".** The Playbook's changelog says payroll moved off that vendor. Confirm where those documents now come from.
- **Confirm the INFERRED actors.** These are the Executive Director doing reference calls and the supervisor recording the forty-hour training.
