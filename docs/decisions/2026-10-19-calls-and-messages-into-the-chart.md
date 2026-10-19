# Calls and messages into the patient chart

**Date:** 2026-10-19 · **Owner-directed** ("calls and messages being automatically added to the patient chart as a message note and call note"). The owner approved this design the same day ("yes to all"). Built on the Quo branch, because calls need the same Quo connection the texts use.

## What it does

- **Message notes.** Each patient-facing conversation (a Care Update, a Care Team message with the patient on it, a clinical escalation) gets one **message note per conversation per day**, Eastern time. Internal team notes stay out of the record. They show on the chart Timeline as "Care Update message note · 3 messages". The words open on request, never in the list.
- **Filing message notes.** Once a day is over, its note files to OpenEMR as a PDF under Medical Record. This happens the next time a clinician or admin with a live OpenEMR sign-in opens the chart, the same way patient uploads file. If that day changes later (an edit, or a super admin's delete), it files again as a **corrected copy**.
- **Call notes.** An answered call on the office line (Quo) with the patient's phone or a designated POA's phone shows in the clinical Inbox as **Phone call to document**.
  - **Document Call** opens a Phone Call note as the clinician's own draft. It's already filled in with who, when, minutes (rounded up) and Quo's summary and next steps, labelled as the phone system's.
  - The clinician edits it, saves it and signs it like any note. Saving marks the call documented and names the encounter.
  - **Dismiss** needs a reason, for example "a scheduling call".
  - Calls also show on the Timeline with their state.

## Must not undo

- **Nothing from a call reaches OpenEMR without a clinician.** The webhook only records the call. The note is created with the clinician's own sign-in when they save it, and it bills only when signed. Build-enforced: the call handler has no OpenEMR call in it.
- **A message note is derived from the messages, never a second copy.** Only the filing is stored (`message_note_filings`: who, when, a hash, no words). Today is never filed; a day is filed once and again only if it changed.
- **Message notes are read through `messagingRepository.threadVisibility`.** A clinician sees on the Timeline only conversations they may already read.
- **Patient-facing comes from `isPatientFacing`,** the same per-thread mark the yellow badge uses (2026-10-16). A Care Team note with the patient left off is not a message note.
- **Numbers are matched the way the texts match them** (`resolveTexter`): the patient's phone or a designated POA's. A number two patients share, or nobody has, is recorded as handled and never guessed. A missed or unanswered call, a call on another line, or a repeat webhook goes no further.
- **Who may document a call is the same answer the note routes give:** a clinical note writer whose role may document a Phone Call note (`appointmentTypes.canDocumentType('pc_phone_ccm', …)`). An LMSW sees the call, waiting on the patient's clinician by name. Only that clinician, or an admin, can dismiss it.
- **One person per call.** A call someone has opened can't be taken by a second clinician. A clinician's existing unsaved note for that patient is never overwritten by a call. Discarding the draft puts the call back in the queue.
- **The summary can arrive before the call**, and is kept and merged.
- **Quo's text goes into the note as text.** A `*` or `_` in it never becomes formatting.
- **Collections `phone_calls` and `message_note_filings` are registered as PHI.** Call events share `sms_events` for de-duplication, keyed `call:<type>:<id>`.

## Setup (owner)

- In Quo, add **call.completed** and **call.summary.completed** to the same webhook as the texts (`https://app.godwinsfamilycarellc.com/api/webhooks/quo`) on the Main number. Quo's AI call summaries must be on for the summary part; without them the note still fills in who, when and minutes.
- Not proven against live Quo: the field names (`answeredAt`, `completedAt`, `duration`, `summary`, `nextSteps`) are read leniently, but only a real call proves them. Make a test call after deploy and check the Inbox.

## Verified

- `test/chart_communications.test.js` (10 tests).
- `scripts/verify_chart_communications.js`: **41/41 through the real server**, with OpenEMR, the sign-in check and Quo stubbed. Covers webhook to inbox to filled-in draft to saved note to documented, plus dismiss, Timeline, and filing once and as a corrected copy.
- **21 of 21 deliberate breaks caught.** One first "survived" because the harness's find string matched an older route; re-aimed, it was caught.
- Full suite 2557, 0 failing. `verify_quo_sms` 16/16, `verify_messaging` 95/95.
- `verify_note_lifecycle` is 177/182 both with and without this change and on `main`. Its five failures are a stale probe (case managers are LMSW since 2026-10-15), filed as a separate task.
- The clinical page compiles. It was not rendered in a browser this pass.

## Open for the owner

1. **Monthly care-management roll-up** (minutes across the month, CCM consent) is still the separate CCM spec. These notes carry the minutes for it.
2. **Calls not on the Quo office line** (a clinician's own mobile) are not seen.
3. **Older messages** before today file the next time each chart is opened. Up to 20 days per opening, so a long history files over a few openings.
