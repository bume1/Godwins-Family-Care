# Create Video Room for a video visit that has none (2026-11-18)

**Owner report:** "our telehealth link is not working."

## Cause
A Meet room was only ever made at two moments: booking and reschedule. If
neither worked (Meet not switched on yet, the clinician had no GFC Google
account, or Google refused the call), the visit was booked as video with no
room, and nothing could give it one. The booking only returned a warning. After
that:

- the patient portal showed no Join Video Visit button (it keys on `hasVideo`,
  which comes from the room pointer),
- the day-of reminder carried no one-tap link (it is scheduled only when a room
  exists),
- the clinician's card said "reschedule it as one so a room is created", which
  meant moving a visit that did not need to move.

## Change
- `POST /api/clinical/appointments/:eid/video-room`, gated like every other
  booking change (`requireClinicalDocumenter` + `SCHEDULING`, own calendar
  unless admin or coordinator via `loadAppointmentForMutation`).
- Returns an existing room unchanged, so nobody holding a link is handed a new one.
- Refuses a visit that is not booked as video (`APPT_NOT_VIDEO`); changing the
  place is still a reschedule.
- Uses the one room builder, `createVideoRoomFor`, so the host rule and room
  config cannot fork. Google's own reason or the named setup gap is returned on
  failure.
- On success, schedules the day-of video reminder and republishes the patient's
  calendar so the Join button appears.
- The encounter's Video visit card shows **Create Video Room** where it used to
  say "reschedule it". My Day is unchanged: its list read cannot see the
  location marker, so a button there would key on a value that is always null.

## Verified
- `test/telehealth_visits.test.js` B4 (two tests). Removing the not-video guard
  fails it.
- `test/visit_reminders.test.js` A3 count widened from 4 to 5 for the new
  reminder call.
- Full suite 3946, 0 failing.
- **Not proven live:** creating a real room needs Meet set up on the deployment.
  The admin dashboard's **Test Video Room** button is that proof.
