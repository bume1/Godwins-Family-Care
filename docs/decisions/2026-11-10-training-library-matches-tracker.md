# The Training Library matches the owner's Training Material Tracker

**Date:** 2026-11-10 · **Owner-directed:** the library should reflect every module on the tracker, the tracker view should live in the app for admins and managers and stay wired to what staff see, Drive material already made should be attached, and each training should say what policy it ties to.

## What changed
- **Catalog**
  - **TRN-101 retired** (owner). It is removed from the catalog, Chapter D's list and the IME determination, which now needs TRN-102 to 105. Completions already on file stay in the data.
  - **TRN-213 retitled** "Continuous Care Management Program: consent, assigned responsibilities, and time logging".
  - **TRN-004 retitled** "The GFC app: signing in, onboarding, hours and pay, scheduling and availability". It is ONE module that holds a guide per area of the app; Manage Material takes up to 20 files and 20 links.
  - **New: TRN-009 KaiCare Ai**, for clinicians and care coordinators (owner), required in each one's training phase.
  - **New: TRN-501–503**, the three caregiver app videos, for caregivers only.
- **Audience rule.** A catalog module may name `audience` (account types). `libraryTrainings.extrasFor` places it in each role's training phase, the same path as the shared six and office-added trainings. The chapter curriculum never picks up an audience module.
- **`onboarding/libraryCatalog.js`** holds, per module:
  - its group
  - the policy it ties to: the document and sections, never copied text (owner)
  - the next step
  - the office note
  - A test fails if any module lacks an entry or an entry names no module.
- **Who sees what.** Staff see "Ties to: <document>, <sections>", linked. Next step and office notes are office-only (some name policy holes).
  - The office can change both on the library page: `PUT /api/onboarding/admin/library/:id/office`, stamped with who and when.
- **Drive material seeded at boot, per file, by key.**
  - TRN-001 and 002: Team Roles v2
  - TRN-004: SOP 1
  - TRN-501–503: the three videos
  - A file the office removes never comes back. A default added later still reaches a module seeded earlier.
- **Library page rebuilt** in the tracker's shape, with less on screen.
  - Tiles, filter chips and the "how a module is built" box.
  - Grouped tables with five columns: ID, training and who it's for, in-app status, policy, next step.
  - Everything else (format, sign-off, office fields, manual sections, Manage Material) sits behind Details. On a phone the rows stack.
  - Status is computed from SOP or material and never typed.
  - Care Courses shows as a reference row.
- **Office-added trainings** can name the policy they tie to (a line plus an https link).

## Must not undo
- **No manual text in the app.** The manual stays the one copy.
- **Office fields never reach staff and never make a training ready.**
- **IDs are permanent.** TRN-101 is not reused.

## Verified
- New tests: `test/training_library_catalog.test.js` (4), plus a rewritten `training_default_material`. Seven existing tests were repointed: catalog ids, phases, pending refs, Chapter D, track lanes, the IME determination, and the written-SOP count (13 → 12).
- 5 of 5 mutations caught: audience ignored, scoped modules leaking into the clinician curriculum, an office note sent to staff, the seed ignoring keys, and a bad next step accepted.
- Full suite 3648 pass, 0 fail.
- The Library page was rendered in Chromium against the real server at 1280 and 390, with no page errors.
- The staff card's policy line was compiled, not rendered.

## Open for the owner
- **Share in Drive:** Team Roles v2, the three videos, SOP Set 1 and both manuals. Caregivers need the PHC manual, not the clinical one.
- **The videos are .mov files up to 300 MB.** MP4 previews more reliably on phones.
- **Decisions still listed as next steps:**
  - TRN-007: a separate read, or a duplicate?
  - TRN-212: a policy gap.
  - TRN-220: which written standard is it checked against?
- **TRN-004 still needs** an app guide for Hours & Pay and one for Scheduling & Availability.
- **Retire the separate tracker page.**
