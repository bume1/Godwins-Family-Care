# T1 — Google Meet video visits (owner-directed, spec `GFC_Gemini_AI_Reviewer_ClaudeCode_Spec.md` §T1)

Clinical visits could be booked as telehealth since 4.12 and there was nothing
to join: the appointment carried a `[GFC location=telehealth]` marker, the
claim carried modifier 95, and the patient and clinician met on whatever either
of them arranged by phone. This is the room, both doors into it, and the proof
that it works.

## Locked in — what a later session must not undo

- **⚠️ `meetRooms.js` IS THE ONLY PLACE THAT TALKS TO MEET, and `createSpace`
  TAKES ONE ARGUMENT — the clinician's own Workspace address.** It cannot be
  handed a patient, which is the strongest available guarantee that nothing
  identifying reaches a Google space. Build-enforced: the module may not
  mention `clientId`, `patient`, `displayName`, `firstName`, `lastName` or
  `dob`, and extra arguments at a call site provably never reach the request.
- **⚠️ EVERY SPACE IS CREATED WITH RECORDING, TRANSCRIPTION AND AI NOTES OFF,
  moderation ON, chat and reactions HOST-ONLY, attendance reports
  DO_NOT_GENERATE, and `accessType: 'TRUSTED'` — never OPEN.** A recording of a
  medical visit is a new record with its own retention, consent and disclosure
  questions, none of which this build answers. The configuration is sent AT
  CREATION, so a Workspace default somebody changes later cannot switch
  recording on for visits already booked. **Presenting is deliberately NOT
  restricted**: a patient holding up a pill bottle or a wound is the point of a
  video visit. Pinned by value, every one of them.
- **⚠️ A RESCHEDULE NEVER DEFAULTS THE PLACE.** The location lives in a marker
  inside `pc_hometext` and the 7.0.4 calendar LIST omits that field, so
  `location: body.location || dec.location || 'home'` silently turned a video
  visit into a house call nobody was driving to. It is refused instead —
  409 `APPT_LOCATION_UNKNOWN`, naming the four places — and the value is
  validated against `APPT_LOCATIONS`, so a garbage body cannot become 'home'
  inside `buildAppointmentFields` either.
- **⚠️ THE ROOM IS A POINTER, NOT A LEDGER.** `appointment_video_links` holds
  the eid, the client, the space and who hosts it — no date, no time, no
  status. The appointment in OpenEMR is the one record of when the visit is,
  and a second copy here would drift the first time somebody moved it in
  OpenEMR's own calendar. **The pointer is what the screens key on**, not the
  location marker, because the marker is null on every row of a list read.
- **A MEET FAILURE NEVER BLOCKS A BOOKING.** The visit goes on the calendar and
  the shortfall is a warning: a video visit with no room is still a visit
  somebody can phone about, whereas a refused booking is care not scheduled.
  `createVideoRoomFor` returns a result and never throws.
- **THE HOST IS THE APPOINTMENT'S CLINICIAN, never the acting user.** An admin
  books on a clinician's behalf, and a room hosted by the admin would leave the
  clinician a guest in their own visit.
- **THE POINTER GOES WHENEVER THE ROOM IS SHUT, whatever Google says.** A join
  button on a visit that was called off is worse than a room left open that
  nothing links to. A failure to shut it is reported so somebody can close it
  by hand. Cancel, no-show and a reschedule out of video all shut it.
- **STARTING THE VIDEO VISIT STAMPS IT AS STARTED, and rejoining does not move
  the start.** A video visit has no arrival to record, so without this a
  telehealth note carried no start time and the billing guide's required time
  statement read "no time recorded" for every visit done by video. Re-stamping
  on a rejoin would shorten the visit being billed. **The timing write is now
  ONE writer** (`stampVisitTiming`), shared with the existing timing route —
  two places writing `startedAt` is how the board and the time statement start
  disagreeing about one visit.
- **THE PRE-JOIN CHECKS WARN AND NEVER BLOCK.** Two identifiers, the patient's
  physical location (licensure follows the PATIENT, not the clinician), and the
  telehealth election read from the signed consent to treat. The sign gate
  knows nothing about them, build-enforced: a note refused over a tick box is
  an hour of home-visit documentation held hostage to paperwork, and the
  clinician on the call is the person who knows whether identity was confirmed.
  The election is a **tri-state** — consented, declined, or never asked — and
  `null` must never read as consent.
- **⚠️ `hasVideo` IS PUBLISHED; THE JOIN LINK NEVER IS.** The link is handed out
  by a window-checked route at the moment of joining, and every hand-out is
  logged, so a link cannot sit in a cached portal response or an old email and
  open the room months later. A stale `hasVideo: true` is NOT carried forward
  by `mergeAppointments` — unlike a location the calendar could not show, the
  pointer is read from this app's own store on every publish, so false means
  the room is gone.
- **⚠️ THE JOIN WINDOW: 15 minutes before the start, until 60 minutes after the
  scheduled END.** Measured against the end, not the start, because a
  60-minute visit measured from its start would close exactly as it was meant
  to finish. `patientPublish.joinWindow` is the ONE rule and BOTH doors check
  it — the portal button and the one-tap link — so a link cannot outlive the
  button beside it.
- **⚠️ PATIENT AND POA ONLY, and that is a deliberate narrowing of
  `requireEnrolledClient`.** Appearing on a video call is ATTENDING the visit,
  not reading about it: the sharing toggle that lets a cousin see that a visit
  is on Tuesday is not consent for them to be in the room. A POA acts for the
  patient everywhere else (4.3) and acts for them here; other family are told
  the patient can invite them from inside the visit.
- **⚠️ THE ONE-TAP LINK: 256 bits, STORED HASHED, bound to one appointment and
  one recipient, window-only, revoked when the room is shut.** The upload link
  keeps its token in plaintext because it is a persistent upload-only channel;
  this one opens a live clinical visit, so a copy of the store is not a copy of
  the keys. It is **revoked, not deleted** — "never existed" (404) and "was
  shut off" (410) need different next steps from whoever is holding it. A
  reschedule MOVES live links rather than reminting: sending a second while the
  first still worked leaves somebody holding two and guessing.
- **`/v/<token>` SERVES A PAGE WITH A BUTTON, NOT A REDIRECT.** A redirect
  would put the room's URL in the browser's history and in any Referer the next
  hop sends; one tap on a button the patient can see is the same number of taps
  and leaks neither. It is registered as a **PHI path** in `auditLog.js`,
  because it opens a live door into a patient's consultation.
- **NO JOIN LINK, TOKEN OR ROOM URL IS EVER IN AN AUDIT ROW OR A LOG.** Which
  visit, who for, and the space name — never the way in.
- **THE DAY-OF NUDGE RIDES THE EXISTING REMINDER STORE AND SCANNER**, told
  apart by `kind`. A row with no kind is a day-before reminder, so every row
  written before this keeps behaving exactly as it did. Its missed window is
  **one hour, not twelve**: twelve is right for "your visit is tomorrow" and
  absurd for "your visit starts in 30 minutes". It has its **own dedupe key**
  (`${eid}:video-join`) — a bare `${eid}:reminder` would collide with the
  booking notice and the nudge would be swallowed as a duplicate. **The vague
  version carries NO link**: a one-tap link is a door into a live consultation,
  so it goes out only where the transport is inside the BAA.
- **A visit rescheduled out of video loses its NUDGE and KEEPS its day-before
  reminder** (`voidRemindersForEid` takes a kind). Voiding both would leave the
  patient with no reminder at all.
- **A PHONE CALL IS NOT A VIDEO VISIT.** `phone` is a declared location and
  gets no room; `APPOINTMENT_LOCATION_LABELS` now reads "Video visit" and
  "Phone call" separately, where the old single "Video / phone visit" told a
  patient expecting a call to look for a video link and a patient expecting
  video that a call would do.
- **A VIDEO VISIT IS NOT A DRIVING LEG.** The mileage total is
  billing-adjacent, and a visit nobody drives to inflated every mile after it —
  the same reasoning the cancelled-visit rule already follows. It is also not
  an "unplaceable stop", which would make an accurate total report itself as
  partial. **The limit is named rather than hidden: a PHONE visit is still
  counted as a house call on My Day**, because the list read cannot see its
  marker and there is no pointer to read instead.
- **`configured` MEANS THE SETTINGS PARSE. It is not evidence Google honours
  them**, and the admin panel says so in those words rather than showing a
  green tick that has not been earned — the distinction a narrowed OAuth token
  behind a green "OpenEMR connected" cost this repo weeks. `POST
  /api/admin/meet/test` is the proof: it creates a real space and immediately
  restricts it, with no patient involved and nothing stored.

## Two bugs found on the way

- **THE MODALITY WAS COMPARED AGAINST A LITERAL NOTHING DECLARES.** Both the
  encounter read and the sign-time warning asked whether the note's modality
  was `'video'`. The declared vocabulary is `in_person` / `telehealth` /
  `phone`; nothing called `video` has ever existed. So `isVideoVisit` was false
  for every video visit written through the note editor, the checklist never
  appeared and the warning never fired. **Found by the probe, not by a unit
  test** — the tests were pinning the code's own wrong value back at itself.
  Both sites now go through `clinicalRepo.isVideoModality`, and the comparison
  is pinned to the declared value.
- **THE PORTAL HAD NO TOKEN HELPER.** It reads three keys and the only reader
  was `App`'s state initializer, so anything outside the prop chain had no way
  to authorize a request but an inline `localStorage` read — the `Bearer null`
  defect of 2026-09-22 waiting to happen. `portalToken()` is the one reader
  now, and `App` uses it too.

## Verified

- `test/telehealth_visits.test.js` — 41 tests. **71 mutations, every one
  confirmed to turn a test red.**
- **Six of my own assertions survived the first mutation pass and were
  rewritten rather than the catch claimed:** the reschedule default (I asserted
  the OLD expression was absent, which a default written another way does not
  restore), the no-room guard (`MEET_NO_ROOM` appears twice in that route, so
  deleting one left the other matching), the join window on the patient route
  (I pinned the gating and never the window), and two cases that only exercised
  a belt-and-braces guard while the load-bearing line went untested.
- **Two guards are recorded in the code as belt-and-braces**, with the line
  that does the work named, so a later simplification does not remove the
  wrong one: `joinWindow`'s shape check (the `Number.isFinite` check does the
  work) and `findByToken`'s pattern check (`hashesMatch`'s length check does).
- **MY FIRST COMMENT STRIPPER ATE 370,000 CHARACTERS OF `server.js`.**
  Stripping block comments first meant the `/*` inside server.js's own line
  comment `// … /api/caregiver/*. Every route inside` opened a block that ran
  to the next `*/`, and every assertion then passed or failed on a file that
  was half missing. Line comments go first now, and the stripper asserts that
  every top-level declaration survived it. `clinical_workspace_412.test.js`
  recorded the same lesson and named the same comment.
- `scripts/verify_telehealth_visits.js` — **83/83 through the real HTTP
  routes**, against a stateful fake Meet and OpenEMR, reading stored rows back.
- Five existing guards **repointed, not deleted**: the timing re-stamp rule
  (the code moved into the extracted writer; both doors are now pinned), the
  reminder call counts (widened for the gated nudge, with the ungated
  day-before pair still pinned), the published-appointment label and key set,
  and the patient-route parameter allow-list (`:eid` joins `:docId` and
  `:visitId`). The GFC-domain sweep gained one named exception, itself pinned
  to the assertion that earns it: a test proving a lookalike domain is refused
  has to contain one.
- Full suite **2140, 2139 passing, 0 failing, 1 skipped** (pre-existing). All
  three pages compile. Neighbouring probes re-run green: notes 162/162, orders
  90/90, clinical roles 57/57.
- **NOT proven from this sandbox, stated plainly: that Google accepts the
  credential and the space configuration.** `meetStatus()` says the settings
  parse, which is a different fact, and never claims otherwise. The admin
  **Test video room** button on the deployment is what closes that half.

## Found and NOT fixed

- **Several existing test files strip block comments before line comments and
  then read `server.js`**, so they are scanning a file with ~370,000
  characters missing and any "this string is absent" assertion over that range
  passes vacuously. `clinical_workspace_412.test.js` and
  `document_reading_surfaces.test.js` already use a safe `strippedSafely`;
  `care_team_messaging`, `patient_publish`, `document_extraction`,
  `drive_storage` and `frontend_auth_header` do not. Out of T1's scope and
  worth a pass of its own — the fix is the ordering, and `strippedSafely` is
  already written.

## Open for the owner

1. **The Google setup, and it is all in Google rather than in code.** Add the
   `meetings.space.created` scope to the existing domain-wide delegation
   (**alongside the Drive and Gmail scopes on one line — replacing the line
   stops email and Drive working**), then set `MEET_ENABLED=true`. The admin
   hub's **Video visits** panel names every missing piece, and **Test video
   room** is what proves Google accepts it. Until that is done a telehealth
   booking still succeeds and says in a warning that it has no room.
2. **Every clinician who will host needs a GFC Google account.** The admin
   panel names the ones who do not have one: their visits book and then have no
   room. `MEET_WORKSPACE_DOMAINS` defaults to the BAA domains.
3. **The join window is two constants** (`JOIN_OPENS_MINUTES_BEFORE` = 15,
   `JOIN_CLOSES_MINUTES_AFTER` = 60) and the nudge is one
   (`VIDEO_JOIN_MINUTES_BEFORE` = 30). Say if any is wrong.
4. **Nobody is emailed a link for a visit booked inside the nudge window** —
   the same skip the day-before reminder makes, for the same reason. They use
   the portal button. Say if a booking inside half an hour should send one.
5. **Whether a patient should be able to join from a phone call instead.** A
   phone visit deliberately has no room; if the practice wants a dial-in number
   for one, that is Meet's phone bridge and a separate decision.
