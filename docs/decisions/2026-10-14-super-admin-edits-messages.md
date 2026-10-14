# The super admin can edit a sent portal message, at any point (2026-10-14)

Owner request: "give only super admins ability to edit portal messages at any point. I need to edit a message sent to one of our patients."

## What was decided (must not undo)

- **Only the super admin (`role: 'admin'`) can edit a message.** Not a manager, not the sender, not a clinician. `messagingRepository.canEditMessage` is the same rule as deleting a thread, so the two cannot drift. While viewing as someone else ("View as"), the request carries that person, so editing is refused there too.
- **Any message, at any time.** There is no time window.
- **The old words are never thrown away.** Every edit appends `{ at, byId, byName, reason, previousBody, previousFormat }` to the message's own `edits` list. A message to a patient is a record.
- **A reason is required**, as with deleting a thread. It stays in the office record.
- **Everyone reading the thread sees "Edited"** beside the time. They never see the old words, who edited it, or the reason.
- **What stays as sent:** the sender, the time, the attachments and the format. A formatted message is edited in its stored marks (`**bold**`, `_italic_`, and so on).
- **No new email goes out.** An edit is a correction, not a new message.
- **The thread list preview follows the edit** when it was the last message.
- **The audit row (`message_edited`) names the message, never its words.**
- **The Edit button comes from the server's `canEdit`.** The page decides nothing itself.

## Verified

- Two new tests in `test/care_team_messaging.test.js`, run through the real router. They cover:
  - who is refused: clinician, case manager, patient, POA, manager;
  - a missing reason, a blank body and an unchanged body;
  - a message that doesn't exist;
  - the old words kept;
  - the patient seeing the new words marked Edited, and never the old ones;
  - the preview following the edit;
  - the audit row carrying no words.
- 4 mutations caught: anyone can edit, old words not kept, old words sent to the screen, reason not required.
- Full suite: 2,458 tests, 0 failing.
- Not rendered in a browser this pass.
