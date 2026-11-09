# Caregiver training on Care Courses, a certificate per course

**Date:** 2026-11-09 · **Owner-directed**

## Why it was missing
- The caregiver onboarding built earlier was the welcome packet, which covers paperwork and clearance. It had no training in it.
- The Playbook's caregiver training (A.12) is listed as "modules to be developed".
- The SOP set the clinical quizzes wait on is clinical only. No caregiver SOPs exist in Drive.

## What was built
- **`onboarding/caregiverCourses.js`** holds the two collections the owner chose, copied from the Care Courses collection pages (2026-11-08):
  - **PCA_40**: 36 courses, 40 hours, for a caregiver on the forty-hour route. Twenty hours are due before serving a client, and the rest within six months (A.6).
  - **ANNUAL_8**: 7 courses, 8 hours, for every caregiver, renewed each calendar year (A.10).
- **Links:** Care Courses has no link to a single course, so every course links its collection page.
- **Proof:** each course is proven by its certificate of completion, uploaded per course from the caregiver's Training tab or by the office on her behalf. Certificates go to her caregiver Drive folder and the shared staff documents (`training_certificate`). The office can send one back with a reason, which reopens that course.
- **The 40-hour item (A.6.07)** is done only when all 36 certificates are on file and the supervisor's step is recorded. The tab shows the 20-hour "ready for clients" mark.
- **The annual training duty (A.10.R4)** records itself done on the date the year's seventh certificate lands.

## Verified
- 6 tests, with 7 of 7 mutations caught.
- Full suite passes.
- Rendered in Chromium at phone width.

## Open for the owner
- **Caregiver SOPs.** The Playbook's own modules (A.12: HIPAA, the app, care skills, dementia support) still need SOPs or materials. Care Courses covers the regulated training, not GFC's own procedures.
- **Course list changes.** If Care Courses changes a collection, the list is updated by hand in `caregiverCourses.js`.

## Addendum, same day
- **Two required modules for every caregiver,** each with its own Care Courses link (collection `GFC_CORE`). Both must have a certificate for item A.7.04 to be done.
  - HIPAA and Confidentiality: https://www.care-courses.com/company/qj5dz/module-detail
  - Introduction to Dementia Care: https://www.care-courses.com/company/q38w4/module-detail
- **Contractors (D.6.04)** take the same HIPAA module. The item carries an "Open the HIPAA course" button. Contractors keep TRN-005 as well (owner: yes to both).
- **Certified caregivers skip the 40-hour program** (owner). A caregiver whose welcome packet lists a PCA, CNA, HHA, LPN or RN certificate never gets the 40-hour program, even if the box is ticked in Setup. A nurse classification is excluded the same way. She takes the remaining training only.
  - The server reads the certificate fact from the packet on every build.
  - The Setup form's copy of it is ignored on save, so nobody can set it by hand.
- **"CareScout" = Care Courses.** The earlier addendum's CareScout wording is superseded.

## Addendum: the 40-hour program is automatic; "Qualifying route" reads "Credentials"
- **The owner activated a caregiver and the 40-hour training did not appear.** It depended on a Setup box ("forty-hour route") that nobody had ticked.
- **Now it applies by itself** to a caregiver classified PCA with no PCA, CNA or HHA certificate in her packet.
- **The classification comes from her license level on her account** (sitter → companion, PCA → PCA, CNA → PCA and certified, LPN → nursing) until the office sets one in Setup.
- **The license level is read by the server from her account**, never from the Setup form. The office can still tick the box for anyone else it applies to.
- **Item A.6.06** is titled "Credentials" (owner).
