# Admin team onboarding: Playbook Chapter F

Owner, 2026-11-08: the admin team is next, because a new clinical operations team member starts this week. "Admin team" means administrators, managers and care coordinators. Chapter F also covers office, clinical operations, care coordination and business development staff, and it is the base a Community Care Liaison's onboarding builds on.

## What changed

- **`onboarding/chapterF.js`** is transcribed from Playbook v3.0 Chapter F, which was read from Drive and byte-identical to the 17:13 revision. It has five phases:
  1. Pre-Hire Screening
  2. Offer & Employment Paperwork
  3. Payroll & Time Setup (the Playbook's "Work-State Registration")
  4. Systems & Role Training
  5. First 90 Days
- **The engine is chapter-aware.** A person's record names their chapter in `inputs.chapter`.
  - Clinicians default to C. The admin team and liaisons default to F, from the account type.
  - The office can change the chapter in Setup.
  - Item and acknowledgment ids are unique across chapters.
- **Chapter F inputs:**
  - The state they work from. Outside Georgia adds work-state registration and the compensation gate.
  - Whether the role enters a client residence, which adds the Field Addendum (F.5).
  - Whether it supports a federally reimbursed line, which adds exclusion screening at hire and every 30 days.
  - Whether it carries variable compensation, which adds counsel review of the plan (F.8).
- **The admin team acknowledges the Administrative P&P v2.3** (owner decision). The Playbook's F.10 figure of 2.0 is kept on the record. Field Addendum is acknowledged only where the role enters a home.
- **No clinical training for Chapter F.** The Training Library is the clinical curriculum. A non-clinical role's training is its written role training plan (F.7.03), which is an item.
- **Recurring duties (F.9):** time records each pay period, exclusion verification every 30 days where applicable, and annual policy re-acknowledgment and performance review. **F.9 does not classify these rows, so they carry no classification.**
- **Screens:**
  - Credentialing, Ready to See Patients and Training are hidden for a Chapter F person.
  - The office's "not started" list now includes the admin team and liaisons, each labeled with their track.
  - Uploads go to "GFC Non-Clinical Staff Documents".
- **Liaisons can reach their own checklist** (`requireStaff` admits the onboarded account types).

## Actors marked INFERRED for the owner to confirm

F.3 names the Executive Director, the Payroll and Finance Officer, the credentialing owner and the Supervisor. Where the Playbook names nobody for a step:

| Item | Inferred actor |
|---|---|
| Application and interview | Executive Director records |
| Reference verification | Executive Director verifies |
| Offer letter | The hire signs |
| Compensation gate | Payroll and Finance Officer |
| Time recording | The hire tests it |
| Identity and access | Executive Director provisions |
| Collateral | Supervisor |
| Role training plan | The hire completes it |
| Documentation practice | Supervisor |
| Variable compensation counsel review | Executive Director records |

## Verified

- New route test (Chapter F track, the Field Addendum and out-of-state conditions, and Admin P&P v2.3 linked to the canonical copy).
- The overview and folder guards were updated.
- Full suite passes.
- Rendered in Chromium for the office and for the hire, with no Playbook code on screen.

## Open

- The Community Care Liaison's own Chapter G items (systems provisioning, the Liaison Playbook and Training Plan) are not built yet. A liaison is onboarded on F today.
- Chapters A, B, D, E and H are still to come.
