# One message note per conversation, every call a note, encounter date filled in

**Date:** 2026-10-19 · **Owner-directed**: "ensure the texts appear in the portal messaging especially with one note updated with messaging details per convo and then all call summary / transcript for patient or poa becomes a note", then "make sure encounter date automatically populates". This changes parts of `2026-10-19-calls-and-messages-into-the-chart.md` (PR #199); where they differ, this file wins.

## Checked first: nothing conflicted

The owner asked whether texting and calls were built twice across #199 and #202. They were not:

- **#202** was the message formatting fix only.
- **Texting and calls exist once on `main`:** `quoSms.js`, the Quo webhook in `routes/messaging.js`, and `chartCommunications.js`.
- **Nothing to strip.** The other "transcript" mentions in the code are Google Meet's recording-off settings.
- **Texts from a patient or POA already appear in the patient's portal thread**, marked "By text". This is now proven end to end.

## What changed

- **Message notes:**
  - **One note per conversation, not per day**, holding every message and kept up to date.
  - A conversation with a message today is still open. Once a day passes with no new message, it files to OpenEMR on the next chart open.
  - OpenEMR cannot replace a document, so a conversation that later grows or changes files again as an **updated copy holding the whole conversation**. The newest copy is always complete.
  - The key is `msg:<threadId>`.
- **Call notes:**
  - **Every answered call with a patient or designated POA becomes a call note by itself.** It holds who, when, how long, Quo's summary and next steps, and the **full transcript** with speakers named (the patient-side person from their own number, otherwise "GFC staff").
  - Quo's `call.transcript.completed` is now read. Like the summary, it can arrive before or after the call itself.
  - A call note files once the transcript is in, or 2 hours after the call if none comes, and files again as an updated copy if the summary or transcript changes. Documenting or dismissing the call does not refile it.
  - It shows on the Timeline as "Call note", and opens from there.
  - This is the record of the conversation. The billable Phone Call note is still the clinician's to write and sign, and it now points at the call note for the transcript.
- **Encounter date:**
  - The note screen has an **Encounter Date** box that fills itself in: today; or the date a saved note or a call draft already carries; or, for a note opened from an appointment, the appointment's date (set by the server).
  - A note opened from a call is dated **the day of the call**, not the day it is written up.
  - Once the note is saved, the date shows read-only.

## Must not undo

- A message note is still derived from the messages, never a stored copy. Patient-facing still means `isPatientFacing`, and visibility is still `threadVisibility`.
- **Nothing reaches OpenEMR without a person's own sign-in.** Filing happens on chart open, as uploads do.
- **The call-note hash covers only what the phone system said** (summary, next steps, transcript, length), so workflow changes never refile it.

## Setup (owner)

- Add **call.transcript.completed** to the Quo webhook, alongside `call.completed` and `call.summary.completed`.
- Quo call transcripts and AI summaries must be turned on in Quo. Without them, the call note still records who, when and how long, and files after 2 hours.

## Verified

- `test/chart_communications.test.js` (12): message notes per conversation, filing and updated copies, the call note text with speakers, readiness, and the encounter-date guard.
- `scripts/verify_chart_communications.js`: **52/52 through the real server**. New checks cover:
  - the transcript, before and after the call;
  - the encounter dated the day of the call, in the app and in OpenEMR;
  - one note per conversation;
  - the call note opened and filed;
  - an updated copy when a conversation grew;
  - the patient's own text in their portal thread, marked by text.
- **12 of 12 deliberate breaks caught.** One first survived because no test sent the transcript before the call; that case was added.
- One page guard was repointed: `toNote` became `toNote` plus `toNoteBody` so the date rides on every note shape.
- Full suite 2615, 0 failing. `verify_quo_sms` 16/16, `verify_messaging` 95/95. The clinical and portal pages compile. Not rendered in a browser this pass.
