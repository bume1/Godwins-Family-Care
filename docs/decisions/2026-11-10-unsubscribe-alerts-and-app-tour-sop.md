# The office hears about every unsubscribe, and SOP 1 is the app tour

**Date:** 2026-11-10 · **Owner-directed:** "I need to know if someone unsubscribes" and "can we add SOP 1 for the app tour?"

## Unsubscribe alerts
- Clicking the unsubscribe link in any GFC email used to flip `emailUnsubscribed` and tell nobody. From then on, that person got no announcements, reminders, shift notices or onboarding emails.
- **Now every active Super Admin is emailed** when someone unsubscribes or turns email back on (`emailPreferenceNotice.js`, notice `email_preference_changed`).
  - The email says who, their kind of account, their email address, and the time in Eastern.
  - It has a button to User Management.
- Only a real change sends a notice. Clicking the same link twice says nothing new. An admin is never told about their own change.
- The person's name is in the body only, never the subject. The notice is marked PHI, because the person may be a client.
- `emailUnsubscribedAt` is stored. The User Management "Unsubscribed" badge now shows the date.
- The activity log records `email_unsubscribed` / `email_resubscribed`.
- **Limit:** a Super Admin who has unsubscribed themselves is not emailed either. The queue honours their own choice.

## SOP 1 as the app tour
- TRN-004 "Application tour at first login" assumed an in-app tour that does not exist, so it could never be completed.
- SOP 1 (Google Doc in Drive → EMR & App Guides) is now its material, seeded at boot by `trainingMaterial.seedDefaults`.
- It is seeded **once**: only when the module has no material and was never seeded. An office that removes or replaces the link is never overridden by a restart.
- With material in place, staff open SOP 1 and click "I Completed This".
- **The Google Doc must be shared** with the staff who will open it (for example, anyone at godwinsfamilycarellc.com with the link). The app links to it; Drive decides who can read it.

## Verified
- `test/email_preference_notice.test.js` (4) and `test/training_default_material.test.js` (3).
- 3 of 3 mutations caught: everyone emailed, the name in the subject, and the notice not marked PHI.
- Full suite 3603 pass, 0 fail.
- A boot with the memory store logged "Default training material added to TRN-004."
