# Messaging safety, after internal notes reached a patient's chat

Owner, 2026-10-16: clinical staff posted internal team notes into Ms. Juanita's patient chat. Asks: only the person who started a Care Update answers the patient there (super admin too; everyone else reads); the super admin deletes single messages with an audit trail; descriptors on the start buttons; a yellow badge where the patient can or does see the conversation; and "verify the labels for who is in the chat... I noticed discrepancies there yesterday too."

## Must not undo

- **The one-answerer rule is CARE UPDATE ONLY** (owner correction: "i only want this change for the care update thread"). On a Care Update, the staff member who started it answers the patient side; if the office started it, the first non-admin staff reply claims it (`staff_responder_id`). The patient, POA and family always reply. The super admin always replies and never claims it. Anyone else on the staff side reads it and is refused with `PATIENT_THREAD_ONE_RESPONDER`, told to use Care Team without the patient or Clinical Oversight. Enforced by the server, not just hidden on the page.
- **Single-message delete is the super admin's alone** (`DELETE /api/messaging/messages/:id`). A reason is required. The message is archived to `deleted_messages` (PHI, registered) with who, when and why BEFORE it is removed; the thread preview is recomputed; the audit row names the message, never its words.
- **Every channel serves `patientSees` (`yes` / `no` / `choose`) and a one-line `audienceNote`** (`CHANNEL_AUDIENCE`). The page draws the descriptor and the yellow badge from that and decides nothing itself.
- **The yellow badge is staff-only** (`staffView` on the thread list). A patient is never warned that the patient sees a conversation.
- **A thread is patient-facing by who is actually on it** (`patient_facing`, set at creation), not by its channel. A Care Team note with the patient left off now files under the chart's Team tab, not Patient. This channel-level split is likely how the internal notes ended up in the patient's conversation list.
- **Labels come from the ACCOUNT TYPE** (`personLabel` reads `accountTypes.accountTypeOf`), stored on each message as `from_role_label`. The old label read the coarse messaging role, so a coordinator's message said "Office" and every licensed clinician said "Clinician". Messages saved before today read the sender's current account on the way out. POA messages keep "as POA for".
- **"In this conversation" is the thread's own participant list**, labelled the same way, with "You" marked. The screen cannot say someone is in a chat that the thread does not hold.

## Verified

- 8 new tests in `test/care_team_messaging.test.js` and the Care Update test rewritten; `test/clinical_redesign.test.js` chart-split guard repointed at the per-thread mark (it had pinned the channel-level split). 12 of 12 deliberate breaks caught.
- Full suite 2535, 0 failing (1 skipped, pre-existing). `scripts/verify_messaging.js` 95/95.
- The component rendered in headless Chromium: badges on threads and start buttons, descriptors, the yellow bar with who answers, the people list, the coordinator label, and Delete sending the reason. No page errors.

## Open for the owner

1. Care Update threads that already exist have no stored answerer. The first non-admin staff reply from now on claims it. If the wrong person answers first on an old thread, the super admin can delete their message.
2. Clean up Ms. Juanita's thread with the new per-message Delete. The removed messages stay in the office record.
