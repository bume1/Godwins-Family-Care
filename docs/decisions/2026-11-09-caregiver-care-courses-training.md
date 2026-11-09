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
