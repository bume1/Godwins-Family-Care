# Announcements for every staff member, built on the caregiver Feed

**Date:** 2026-11-10 · **Owner-directed:** "an area all staff can access as an announcement or upgrade to review", and "I don't want redundancy, the caregivers have a version of this."

## What was there
- The caregiver Feed (`/caregiver` → Feed) read office posts from `caregiver_broadcasts`. It was caregiver-only.
- No other staff type had anything like it.
- Two duplicate composers posted to it: Admin Hub → Inbox → Caregiver Feed, and Caregiver Management → Feed post.

## What changed
- **One store.** `caregiver_broadcasts` rows now carry `audience` (`'all_staff'` or a list of account types) and an optional https `link`.
  - A row with no audience stays caregivers-only. Every post made before today keeps the readers it was written for.
- **One rule.** `staffAnnouncements.visibleTo` decides who sees a post. The caregiver Feed and My GFC both read through it.
- **Two places to read.**
  - **My GFC → Announcements** for every staff type except caregivers, with an unread card on Home.
  - Caregivers see the same posts in their Feed.
  - Both have "I've Reviewed This".
- **One composer**, in My GFC → Announcements, for the admin team (admin, manager, care coordinator).
  - It shows who has reviewed each post and who has not, and posts can be taken down.
  - The two old composers now point there.
  - Posting still goes through `POST /api/caregiver/broadcasts`, widened with audience and link. Retire is `POST /api/caregiver/broadcasts/:id/retire`.
- **Receipts.** New collection `staff_announcement_reads` (not PHI, registered in `dataMigration.js`), one row per person per post, append-only.
  - `POST /api/my/announcements/:id/reviewed` records the signed-in person's own receipt only.
  - `GET /api/my/admin/announcements` is the admin team's report.

## Must not undo
- **No audience means caregivers.** Widening the default would show old caregiver-only posts to everyone.
- **A post is never deleted.** Taking one down sets `active: false` and keeps who did it and when.
- **The composer says no client names.** Every reader in the audience sees the post.

## Verified
- `test/staff_announcements.test.js`: 6 tests through the real routers.
- 6 of 6 mutations caught:
  - the Feed ignoring audience
  - a receipt written for someone else
  - old posts widened to everyone
  - the staff gate dropped
  - the report opened to all staff
  - a non-https link accepted
- Two existing tests repointed at the one composer (`caregiver_feed_scope`, `messaging`).
- Full suite 3604 pass, 0 fail.
- `scripts/verify_announcements_render.js`: 10/10 in Chromium, coordinator at 1280px and nurse at 390px. The render caught a layout bug in the report line, now fixed.
- The caregiver Feed's new button was compiled, not rendered.

## Open for the owner
- No email goes out when something is posted. Say if staff should get a PHI-free "new announcement in My GFC" email.
- First post: the updated staff guide, once it is uploaded.
