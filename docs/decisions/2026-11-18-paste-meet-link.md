# Paste a Meet link when the app cannot make a video room

Date: 2026-11-18 · Owner-directed ("is there a backup… I can just add a manual Google link")

## What changed
- `POST /api/clinical/appointments/:eid/video-link { url }` stores a Meet link staff made themselves as the visit's room pointer (`manual: true`). From then on it behaves like an app-made room: the patient's Join button, the day-of join email, and the portal calendar all read it.
- The visit's video card shows a "Save Meet Link" box whenever the visit has no room.
- `meetRooms.parseManualMeetLink` accepts only `https://meet.google.com/xxx-xxxx-xxx` (with or without the scheme) and stores a clean URL. Anything else is refused by name.

## Must not undo
- **A pasted link never replaces an app-made room** (409 `VIDEO_ROOM_EXISTS`). A patient who already holds that link must not be handed a different one. A pasted link may be replaced by another pasted link.
- Same gate and same visit checks as Create Video Room (`loadVideoVisitContext`): video visits only, linked patient only.
- The activity log records that a link was pasted, never the link.
- Closing a visit never tries to end a pasted room through the Meet API, because the app does not own it. Staff end it in Google Calendar.
- The app cannot switch off recording or transcripts on a room it did not make. The card tells staff to do that themselves.
