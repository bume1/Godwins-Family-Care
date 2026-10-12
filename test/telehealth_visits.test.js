// ============================================================================
// test/telehealth_visits.test.js — T1 (Google Meet video visits)
//
// What is pinned here, and why each one:
//
//   A4  A reschedule NEVER defaults the place to 'home'. The location lives in
//       a marker inside pc_hometext and the 7.0.4 calendar LIST omits that
//       field, so a hydration failure used to turn a video visit into a house
//       call nobody was driving to.
//   A4  The room is created at booking, follows a reschedule, and is SHUT on a
//       cancellation, a no-show, or a move out of video — pointer and one-tap
//       links together.
//   B1  The clinician's button is keyed on the ROOM POINTER, not the location
//       marker, because the marker is null on every row of the list read.
//   B1  A video visit is not a driving leg. The mileage total is
//       billing-adjacent and a visit nobody drives to inflated it.
//   B2  The pre-join checks WARN at signing and never block.
//   B3  Starting the visit stamps the start, through the ONE writer, and
//       rejoining does not move it.
//   C1  `hasVideo` is published; the join LINK never is.
//   C2  The join window, and patient-or-POA only.
//   C4  The one-tap token: 256 bits, hashed, bound to one eid and one
//       recipient, window-only, revoked when the room is shut.
//   C5  "Video visit" and "Phone call" are separate labels.
//
// Mutation-checked: every assertion here was confirmed to fail when the
// behaviour it pins is reverted (see the decision note for the list).
// ============================================================================

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const meetRooms = require('../meetRooms');
const tokens = require('../videoJoinTokens');
const patientPublish = require('../patientPublish');
const clinicalRepo = require('../clinicalRepository');
const reminders = require('../visitReminders');
const myDay = require('../myDay');
const practiceTime = require('../public/gfc-time');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// A source scan that cannot tell live code from prose ABOUT that code proves
// nothing, so comments go first — and THE ORDER IS LOAD-BEARING. My first
// draft stripped block comments first, which meant the `/*` inside server.js's
// own line comment `// … /api/caregiver/*. Every route inside` opened a block
// that ran to the next `*/`: 370,000 characters of real code silently gone,
// and every assertion below then passed or failed on a file that was half
// missing. Whole-line `//` comments go first, so a `/*` inside one is gone
// before the block pass runs. `clinical_workspace_412.test.js` recorded the
// same lesson and the same shape; this is it, with the proof attached.
const stripComments = (src) => src
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');

// A stripper that grabs the wrong slice proves nothing, so it says so out
// loud: every top-level declaration in the source must survive the strip.
const declarationsIn = (src) => {
  const out = new Set(); let m;
  const re = /^(?:const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
};
const code = (src, label) => {
  const out = stripComments(src);
  const lost = [...declarationsIn(src)].filter(n => !declarationsIn(out).has(n));
  assert.deepEqual(lost, [], `the comment stripper ate code from ${label || 'a file'}: ${lost.join(', ')}`);
  return out;
};
const SERVER = code(read('server.js'), 'server.js');

const instantOf = (d, t) => { const iso = practiceTime.instantFromZoned(d, t); return iso ? Date.parse(iso) : NaN; };

// The detail object of ONE logActivity call, bounded to the call itself. A
// fixed character window runs past the closing `});` and reads whatever
// happens to follow, which pins the layout rather than the audit row.
const auditDetail = (src, action) => {
  const i = src.indexOf(action);
  assert.ok(i > 0, `no audit call for ${action}`);
  const rest = src.slice(i);
  const end = rest.indexOf('});');
  assert.ok(end > 0, `could not find the end of the ${action} audit call`);
  return rest.slice(0, end);
};

// ---- A4: the reschedule never guesses the place -------------------------

test('A4: a reschedule refuses rather than defaulting the place to home', () => {
  // THE FIRST VERSION OF THIS ASSERTION SURVIVED MUTATION, and the mutation
  // harness is the only reason I know. It checked that the OLD expression
  // (`location: body.location || dec.location || 'home'`) was absent — which a
  // default written a different way does not restore. What decides it is the
  // ONE line that resolves the place, so that is what is pinned: an unreadable
  // marker must resolve to null and nothing else.
  const rsLine = SERVER.match(/const rsLocation = [^;]*;/);
  assert.ok(rsLine, 'the reschedule resolves its place in one place');
  assert.equal(rsLine[0], 'const rsLocation = body.location || dec.location || null;',
    'an unreadable location marker must resolve to null, never to a place');
  assert.ok(!/location:\s*body\.location\s*\|\|\s*dec\.location\s*\|\|\s*'home'/.test(SERVER),
    'and the old fall-through is gone');
  assert.match(SERVER, /APPT_LOCATION_UNKNOWN/, 'it refuses by name');
  // Validated against the declared vocabulary, so a garbage location in the
  // body cannot become 'home' inside buildAppointmentFields either.
  assert.match(SERVER, /!clinicalRepo\.APPT_LOCATIONS\.includes\(rsLocation\)/);
  assert.match(SERVER, /location: rsLocation,/, 'and the validated value is what is used');
});

test('B1: the video modality is the DECLARED one, never a literal nobody declares', () => {
  // A REAL BUG THE PROBE FOUND AND NO UNIT TEST WOULD HAVE: both the encounter
  // read and the sign-time warning compared the note's modality against
  // 'video'. The declared modality vocabulary is in_person / telehealth /
  // phone — nothing called 'video' has ever existed — so `isVideoVisit` was
  // false for every video visit written through the note editor, the checklist
  // never appeared, and the sign warning never fired. Both now go through one
  // predicate, and the comparison is pinned to the declared value.
  const apptTypes = require('../appointmentTypes');
  assert.ok(apptTypes.MODALITIES.some(m => m.key === clinicalRepo.LOCATION_NEEDS_VIDEO),
    'the room-needing value is one the modality vocabulary actually declares');
  assert.ok(!apptTypes.MODALITIES.some(m => m.key === 'video'), 'and "video" is not a modality');
  assert.equal(clinicalRepo.isVideoModality('telehealth'), true);
  assert.equal(clinicalRepo.isVideoModality('TELEHEALTH'), true);
  for (const m of ['video', 'in_person', 'phone', '', null, undefined]) {
    assert.equal(clinicalRepo.isVideoModality(m), false, `${m} is not the video modality`);
  }
  // Neither site may compare a modality against a literal again.
  assert.ok(!/modality[^\n]*=== 'video'/.test(SERVER), 'no literal modality comparison in server.js');
  assert.match(SERVER, /clinicalRepo\.isVideoModality\(/);
  assert.ok((SERVER.match(/clinicalRepo\.isVideoModality\(/g) || []).length >= 2,
    'both the encounter read and the sign warning go through it');
});

test('A4: buildAppointmentFields still takes the four declared locations, phone among them', () => {
  assert.deepEqual(clinicalRepo.APPT_LOCATIONS, ['home', 'telehealth', 'office', 'phone']);
  // A PHONE CALL IS NOT A VIDEO VISIT: conflating them would open a Meet room
  // nobody joins for every care-management call.
  assert.equal(clinicalRepo.locationNeedsVideoRoom('telehealth'), true);
  for (const l of ['home', 'office', 'phone', '', null, undefined, 'TELEHEALTHX']) {
    assert.equal(clinicalRepo.locationNeedsVideoRoom(l), false, `${l} needs no room`);
  }
  assert.equal(clinicalRepo.locationNeedsVideoRoom('TELEHEALTH'), true, 'case does not decide it');
});

test('A4: the room is created at booking, follows a reschedule, and is shut on cancel and no-show', () => {
  // Gated on the ROOM-NEEDING location, so nothing is created for a phone call.
  assert.match(SERVER, /if \(clinicalRepo\.locationNeedsVideoRoom\(built\.location\)\) \{\s*\n\s*apptVideo = await createVideoRoomFor\(/);
  // A MEET FAILURE NEVER BLOCKS THE BOOKING: the visit is on the calendar and
  // the shortfall is a warning.
  assert.match(SERVER, /if \(!apptVideo\.created\) apptWarnings\.push\(/);
  assert.match(SERVER, /\n    await migrateVideoLink\(row\.pc_eid, newEid\);/,
    'the room moves to the eid the tombstone swap created');
  const closes = SERVER.match(/\n\s*(?:const \w+ = )?await closeVideoRoomFor\(/g) || [];
  assert.ok(closes.length >= 3, `cancel, no-show and reschedule-away all shut the room (found ${closes.length})`);
});

test('A4: createVideoRoomFor never throws, and a Meet failure is a result not an exception', () => {
  const src = SERVER.slice(SERVER.indexOf('const createVideoRoomFor'));
  const body = src.slice(0, src.indexOf('\nconst closeVideoRoomFor'));
  assert.match(body, /return \{ created: false, code: 'MEET_NOT_CONFIGURED'/);
  assert.match(body, /return \{\s*\n?\s*created: false, code: 'MEET_NO_HOST_ACCOUNT'/);
  assert.match(body, /catch \(e\) \{[\s\S]{0,200}return \{ created: false/, 'a Meet error is caught and reported');
  // THE HOST IS THE APPOINTMENT'S CLINICIAN, never the acting user: an admin
  // books on a clinician's behalf and a room hosted by the admin would leave
  // the clinician a guest in their own visit.
  assert.match(body, /await hostForProviderId\(providerId\)/);
  assert.ok(!/hostForProviderId\(req\.user/.test(SERVER), 'the host never comes from the caller');
  // The ACTIVITY LOG names which visit got a room, never the join link.
  assert.match(body, /'video_room_created'[\s\S]{0,200}spaceName: room\.spaceName/);
  assert.ok(!/meetingUri/.test(auditDetail(body, "'video_room_created'")),
    'a meeting URI must never reach the activity log');
});

test('A4: the POINTER goes whenever the room is shut, whatever Google says', () => {
  const src = SERVER.slice(SERVER.indexOf('const closeVideoRoomFor'));
  const body = src.slice(0, src.indexOf('\nconst migrateVideoLink'));
  // A join button on a visit that was called off is worse than a room left
  // open that nothing links to, so the delete is NOT conditional on `result.ok`.
  assert.match(body, /await db\.set\('appointment_video_links', rows\.filter/);
  const del = body.indexOf("await db.set('appointment_video_links'");
  const guard = body.lastIndexOf('if (', del);
  assert.ok(guard < body.indexOf('try {'), 'the pointer delete is not inside a success branch');
  assert.match(body, /videoJoinTokens\.revokeForEid\(tokens, eid/, 'and the one-tap links go with it');
  assert.match(body, /failures: result\.failures/, 'a failure to shut it is reported, not swallowed');
});

// ---- B1: the room pointer, not the location marker ----------------------

test('B1: a day row carries the room from the POINTER, because the list read has no location', () => {
  const row = myDay.buildMyDay({
    date: '2026-10-20', appointments: [{ eid: '9', clientId: 'c1', startTime: '14:00', date: '2026-10-20', location: null }],
    clientsById: new Map([['c1', { id: 'c1', name: 'J', address: { lat: 33.9, lng: -84.4 } }]]),
    timingsByEid: new Map(), signedEids: new Set(), unsignedEarlier: [], openTasks: 0, blocks: [],
    homeVisitFields: [], startCoords: null,
    videoByEid: new Map([['9', { meetingUri: 'https://meet.example/abc', meetingCode: 'abc-defg-hij' }]])
  });
  assert.equal(row.visits[0].video.meetingUri, 'https://meet.example/abc');
  // And the row says what it is, even though the marker was null.
  assert.equal(row.visits[0].location, 'telehealth');
  // A visit nobody drives to is NOT a driving leg: the mileage total is
  // billing-adjacent and counting it overstated every mile after it.
  assert.equal(row.visits[0].remote, true);
  assert.equal(row.visits[0].coords, null);
  assert.equal(row.visits[0].distance.reason, 'video_visit');
  assert.equal(row.totals.milesPartial, false, 'a video visit is not an unplaceable stop');
  assert.equal(row.totals.unplaceableStops, 0);
});

test('B1: with no room, the row offers nothing to join', () => {
  const row = myDay.buildMyDay({
    date: '2026-10-20', appointments: [{ eid: '9', clientId: 'c1', startTime: '14:00', date: '2026-10-20' }],
    clientsById: new Map([['c1', { id: 'c1', name: 'J', address: { lat: 33.9, lng: -84.4 } }]]),
    timingsByEid: new Map(), signedEids: new Set(), unsignedEarlier: [], openTasks: 0, blocks: [],
    homeVisitFields: [], startCoords: null, videoByEid: new Map()
  });
  assert.equal(row.visits[0].video, null);
  assert.equal(row.visits[0].remote, false, 'a home visit is still a driving leg');
  assert.ok(row.visits[0].coords, 'and still has somewhere to drive to');
});

test('B1: the page keys its button on the room, never on the location', () => {
  const page = code(read('public/clinical.html'), 'clinical.html');
  assert.match(page, /canWrite && v\.video && \['scheduled', 'en_route', 'arrived'\]\.includes\(v\.state\)/,
    'Start video visit is offered on the room');
  // The location marker is null on every list row, so a button keyed on it
  // would never appear at all.
  assert.ok(!/v\.location === 'telehealth'/.test(page), 'and never on the marker the list cannot show');
  // Nobody drives to or arrives at a video visit.
  assert.match(page, /canWrite && !v\.video && v\.state === 'scheduled'/);
  assert.match(page, /canWrite && !v\.video && \['scheduled', 'en_route'\]\.includes\(v\.state\)/);
});

// ---- B2: the pre-join checklist -----------------------------------------

test('B2: three checks, and the telehealth election is read not asked twice', () => {
  assert.deepEqual(clinicalRepo.TELEHEALTH_CHECK_KEYS, ['identity', 'location', 'consent']);
  const signed = { consents: { consentToTreat: 'signed' }, consentMeta: { consentToTreat: { choices: { telehealth: 'consent' } } } };
  const out = clinicalRepo.buildTelehealthChecklist({}, signed);
  assert.equal(out.election, 'consent');
  assert.equal(out.electionWarning, null);
  assert.match(out.items.find(i => i.key === 'consent').prefill, /Consented to telehealth/);
  // Three answers, three different facts. `null` is "never asked" and must not
  // read as consent — which is the whole reason this is a tri-state.
  assert.equal(clinicalRepo.telehealthElectionOf({ consents: { consentToTreat: 'signed' }, consentMeta: { consentToTreat: { choices: {} } } }), null);
  const declined = clinicalRepo.buildTelehealthChecklist({}, {
    consents: { consentToTreat: 'signed' }, consentMeta: { consentToTreat: { choices: { telehealth: 'decline' } } }
  });
  assert.equal(declined.election, 'decline');
  assert.match(declined.electionWarning, /in-person visits only/i);
  const never = clinicalRepo.buildTelehealthChecklist({}, {});
  assert.equal(never.election, null);
  assert.match(never.electionWarning, /No telehealth election/i);
  assert.ok(!never.items.some(i => i.prefill), 'nothing is prefilled from an election nobody made');
});

test('B2: an UNSIGNED consent carries no election, whatever its choices say', () => {
  // A choice recorded against a consent that was never executed is not an
  // election: the patient has not signed anything.
  assert.equal(clinicalRepo.telehealthElectionOf({
    consents: { consentToTreat: 'pending' }, consentMeta: { consentToTreat: { choices: { telehealth: 'consent' } } }
  }), null);
  assert.equal(clinicalRepo.telehealthElectionOf({
    consents: { consentToTreat: 'signed_offline' }, consentMeta: { consentToTreat: { choices: { telehealth: 'consent' } } }
  }), 'consent', 'a paper signature counts');
});

test('B2: a recorded check keeps who and when, and the outstanding list is what is left', () => {
  const rec = { telehealthChecks: { identity: { confirmed: true, by: { name: 'Bethel' }, at: '2026-10-20T18:00:00Z' } } };
  const out = clinicalRepo.buildTelehealthChecklist(rec, {});
  const id = out.items.find(i => i.key === 'identity');
  assert.equal(id.confirmed, true);
  assert.equal(id.by.name, 'Bethel');
  assert.equal(out.complete, false);
  assert.equal(out.outstanding.length, 2);
  const all = clinicalRepo.buildTelehealthChecklist({
    telehealthChecks: Object.fromEntries(clinicalRepo.TELEHEALTH_CHECK_KEYS.map(k => [k, { confirmed: true }]))
  }, {});
  assert.equal(all.complete, true);
  assert.deepEqual(all.outstanding, []);
});

test('B2: the checks WARN at signing and never block it', () => {
  // `checkSignReadiness` is the gate. If a telehealth check ever reached it,
  // a note would be refused over a tick box — an hour of documentation held
  // hostage to paperwork.
  const gate = read('clinicalRepository.js');
  const fn = gate.slice(gate.indexOf('const checkSignReadiness'));
  const body = fn.slice(0, fn.indexOf('\nconst ', 10));
  assert.ok(!/telehealthChecks|TELEHEALTH_CHECK/.test(body), 'the sign gate knows nothing about the checks');
  // It warns instead.
  assert.match(SERVER, /Video visit pre-join checks not recorded/);
  const warn = SERVER.indexOf('Video visit pre-join checks not recorded');
  assert.ok(SERVER.slice(warn - 400, warn).includes('warnings.push'), 'as a warning, not a refusal');
  // And the route that records one refuses a key it does not know, by name.
  assert.match(SERVER, /BAD_TELEHEALTH_CHECK/);
  assert.match(SERVER, /clinicalRepo\.TELEHEALTH_CHECK_KEYS\.includes\(key\)/);
});

test('B2: the audit row carries WHICH check, never where the patient said they were', () => {
  const row = auditDetail(SERVER, "'telehealth_check_recorded'");
  assert.match(row, /check: key, confirmed/);
  assert.ok(!/note/.test(row), 'where somebody is sitting is clinical content, not an audit field');
});

// ---- B3: starting the visit stamps the start ----------------------------

test('B3: starting a video visit stamps the start through the ONE writer', () => {
  const src = SERVER.slice(SERVER.indexOf("app.post('/api/clinical/visits/:eid/video/start'"));
  const body = src.slice(0, src.indexOf('\n});'));
  assert.match(body, /await stampVisitTiming\(\{[\s\S]{0,160}field: VISIT_TIMING_EVENTS\.start/);
  assert.ok(!/db\.set\('visit_timings'/.test(body), 'it never writes the store itself');
  // REJOINING DOES NOT MOVE THE START. The clinician is returning to a visit
  // already running, and re-stamping would shorten the time they are billing.
  assert.match(body, /out\.code === 'TIMING_ALREADY_SET'/);
  assert.match(body, /rejoining did not change it/);
  // The stamp is best-effort relative to JOINING: a clinician must never be
  // kept out of a visit because a time could not be written.
  assert.match(body, /try \{[\s\S]{0,600}stampVisitTiming[\s\S]{0,900}catch \(e\) \{[\s\S]{0,300}timingNote/);
  // No room, no start. MY FIRST DRAFT ASSERTED THE STRING `MEET_NO_ROOM`,
  // which appears TWICE in this route — no pointer at all, and a pointer with
  // no join link — so deleting the first guard left the second one matching and
  // the assertion passed. Both guards are now pinned by shape.
  assert.match(body, /if \(!row\) \{[\s\S]{0,240}code: 'MEET_NO_ROOM'/,
    'a visit with no room pointer is refused');
  assert.match(body, /if \(!row\.meetingUri\) \{[\s\S]{0,240}code: 'MEET_NO_ROOM'/,
    'and so is a pointer with no join link');
  const guards = (body.match(/code: 'MEET_NO_ROOM'/g) || []).length;
  assert.equal(guards, 2, 'exactly those two');
});

// ---- C1 / C5: what is published, and the labels ------------------------

test('C1: the published row carries hasVideo and never the join link', () => {
  const out = patientPublish.buildPublishedAppointments({
    summaries: [{ eid: '9', date: '2026-12-01', startTime: '14:00', durationMinutes: 30, title: 'Follow-up', location: 'telehealth', providerId: '7', status: '-', state: 'scheduled' }],
    today: '2026-11-01', providerName: () => 'Bethel Godwins, FNP',
    hasVideoFor: (eid) => eid === '9'
  });
  assert.equal(out[0].hasVideo, true);
  assert.equal(out[0].location, 'Video visit');
  const json = JSON.stringify(out);
  assert.ok(!/meet\.|meetingUri|meetingCode|https?:/.test(json), 'no join link is ever published');
});

test('C1: a video visit the calendar list could not describe still says what it is', () => {
  // The list read gives `location: null`; the ROOM says it is a video visit.
  const out = patientPublish.buildPublishedAppointments({
    summaries: [{ eid: '9', date: '2026-12-01', startTime: '14:00', title: 'Follow-up', location: null, status: '-', state: 'scheduled' }],
    today: '2026-11-01', providerName: () => null, hasVideoFor: () => true
  });
  assert.equal(out[0].location, 'Video visit');
  assert.equal(out[0].hasVideo, true);
});

test('C5: video and phone are separate labels', () => {
  const L = patientPublish.APPOINTMENT_LOCATION_LABELS;
  assert.equal(L.telehealth, 'Video visit');
  assert.equal(L.phone, 'Phone call');
  // The old single label told a patient expecting a call to look for a video
  // link, and a patient expecting video that a call would do.
  assert.ok(!Object.values(L).some(v => /\//.test(v)), 'no label covers two kinds of visit');
  const V = SERVER.match(/const VISIT_PLACE_LABEL = Object\.freeze\(\{[\s\S]*?\}\);/)[0];
  assert.match(V, /telehealth: 'Video visit'/);
  assert.match(V, /phone: 'Phone call'/);
});

test('C1: hasVideo is NOT carried forward by the merge when the new read says false', () => {
  // A location the calendar could not show is kept; a room that has gone is
  // not. The pointer store is read from this app's own store on every publish,
  // so false means the room is gone — and a stale `true` would leave a Join
  // button on a visit with no room behind it.
  const prior = [{ id: '9', location: 'Video visit', hasVideo: true }];
  const next = [{ id: '9', location: null, hasVideo: false }];
  const merged = patientPublish.mergeAppointments(prior, next);
  assert.equal(merged[0].location, 'Video visit', 'the location survives a thinner read');
  assert.equal(merged[0].hasVideo, false, 'the room does not');
});

// ---- C2: the join window ------------------------------------------------

test('C2: the room opens 15 minutes early and closes an hour after the scheduled end', () => {
  const w = patientPublish.joinWindow({ date: '2026-10-20', startTime: '14:00', durationMinutes: 30 }, instantOf);
  assert.equal(w.ok, true);
  assert.equal(w.opensAt, '2026-10-20T17:45:00.000Z');  // 13:45 ET
  assert.equal(w.closesAt, '2026-10-20T19:30:00.000Z'); // 14:30 ET + 60
  assert.equal(patientPublish.joinState(w, Date.parse('2026-10-20T17:44:59Z')).code, 'JOIN_TOO_EARLY');
  assert.equal(patientPublish.joinState(w, Date.parse('2026-10-20T17:45:00Z')).ok, true);
  assert.equal(patientPublish.joinState(w, Date.parse('2026-10-20T19:30:00Z')).ok, true);
  assert.equal(patientPublish.joinState(w, Date.parse('2026-10-20T19:30:01Z')).code, 'JOIN_CLOSED');
  // Measured against the END, not the start: a 60-minute visit measured from
  // its start would close exactly as it was meant to finish.
  const long = patientPublish.joinWindow({ date: '2026-10-20', startTime: '14:00', durationMinutes: 60 }, instantOf);
  assert.equal(long.closesAt, '2026-10-20T20:00:00.000Z');
});

test('C2: a visit with no usable time has no window at all', () => {
  for (const a of [{ date: '2026-10-20' }, { startTime: '14:00' }, {}, null]) {
    assert.equal(patientPublish.joinWindow(a, instantOf).code, 'JOIN_NO_TIME');
  }
  // THE CASES ABOVE ONLY EXERCISE THE SHAPE GUARD, and the mutation harness is
  // the only reason I know: a value that is PRESENT and does not resolve to an
  // instant goes past it and is caught by the arithmetic. Those are the ones
  // that matter, because a window built out of NaN compares false to
  // everything and would read as "closed" — or, with the comparison flipped,
  // as permanently open.
  for (const a of [
    { date: '2026-13-45', startTime: '14:00' },
    { date: 'not-a-date', startTime: '14:00' },
    { date: '2026-10-20', startTime: 'teatime' }
  ]) {
    assert.equal(patientPublish.joinWindow(a, instantOf).code, 'JOIN_NO_TIME', JSON.stringify(a));
  }
  // Never defaulted to "now": a window the app cannot compute is refused, not
  // guessed open.
  assert.equal(patientPublish.joinState(patientPublish.joinWindow({}, instantOf), Date.now()).ok, false);
});

test('C2: the window is read in GEORGIA, in both halves of the year', () => {
  // The same wall clock is a different instant in July and in December. An
  // offset from a UTC instant is right today and wrong after a clock change —
  // the DST bug of 2026-09-16, in a new place.
  const summer = patientPublish.joinWindow({ date: '2026-07-20', startTime: '14:00', durationMinutes: 30 }, instantOf);
  const winter = patientPublish.joinWindow({ date: '2026-12-20', startTime: '14:00', durationMinutes: 30 }, instantOf);
  assert.equal(summer.opensAt, '2026-07-20T17:45:00.000Z');  // EDT, UTC-4
  assert.equal(winter.opensAt, '2026-12-20T18:45:00.000Z');  // EST, UTC-5
});

test('C2: patient and POA join; other family are told the patient can invite them', () => {
  const src = SERVER.slice(SERVER.indexOf("app.get('/api/gfc/clinical/appointments/:eid/join'"));
  const body = src.slice(0, src.indexOf('\n});'));
  // Appearing on a video call is ATTENDING the visit. The sharing toggle that
  // lets a cousin see that a visit is on Tuesday is not consent for them to be
  // in the room.
  assert.match(body, /audience !== 'patient' && audience !== 'poa'/);
  assert.match(body, /JOIN_NOT_PERMITTED/);
  assert.match(body, /invite you from inside the visit/, 'and it is not a dead end');
  // A row that is not theirs is simply not in their own published calendar, so
  // it answers 404 rather than a 403 that confirms it exists.
  assert.match(body, /r\.clientId === client\.id/);
  assert.match(body, /APPOINTMENT_NOT_FOUND/);
  assert.match(body, /requireEnrolledClient/, 'behind the enrollment gate like every patient route');
  // AND IT CHECKS THE WINDOW. My first draft pinned only the gating, so
  // removing the window check from this route left every assertion green —
  // the harness caught it. The window is the thing that stops a link working
  // a month after the visit, and it is the SAME one /v/<token> checks.
  assert.match(body, /patientPublish\.joinState\(patientPublish\.joinWindow\(appt, joinInstant\), Date\.now\(\)\)/);
  assert.match(body, /if \(!state\.ok\) \{[\s\S]{0,200}status\(409\)/, 'and refuses outside it');
  // Every hand-out is logged.
  assert.match(body, /logPatientClinicalRead\(req, ctx, 'video_join_link'/);
});

// ---- C4: the one-tap token ---------------------------------------------

test('C4: the token is 256 bits, stored hashed, and never stored in the clear', () => {
  const { token, row } = tokens.buildToken({ eid: '9', clientId: 'c1', recipientUserId: 'u1', recipientRole: 'patient', salt: 's' });
  assert.equal(tokens.TOKEN_BYTES, 32);
  assert.match(token, tokens.TOKEN_PATTERN);
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.ok(!JSON.stringify(row).includes(token), 'the plaintext token is never in the row');
  assert.equal(row.tokenHash.length, 64);
  // A stolen store yields no usable link: the hash is salted with the app's
  // own secret.
  assert.notEqual(tokens.hashToken(token, 's'), tokens.hashToken(token, 'other'));
  assert.ok(tokens.findByToken([row], token, 's'));
  assert.equal(tokens.findByToken([row], token, 'other'), null);
});

test('C4: a malformed or wrong token is refused without reaching the compare', () => {
  const { token, row } = tokens.buildToken({ eid: '9', clientId: 'c1', recipientUserId: 'u1', recipientRole: 'patient', salt: 's' });
  for (const bad of ['', 'abc', null, undefined, token.slice(0, 42), `${token}x`, '../../etc/passwd']) {
    assert.equal(tokens.findByToken([row], bad, 's'), null, `${bad} is refused`);
  }
  // timingSafeEqual THROWS on a length mismatch rather than returning false,
  // so a short or absent stored hash must be refused before it reaches the
  // compare. MY FIRST DRAFT COMPARED TWO EQUAL-LENGTH JUNK VALUES, which
  // never trips that throw at all — the harness caught it.
  assert.equal(tokens.hashesMatch('aa', 'bbbb'), false, 'unequal lengths are refused, not thrown on');
  assert.doesNotThrow(() => tokens.hashesMatch('aa', 'bbbb'));
  assert.doesNotThrow(() => tokens.hashesMatch(null, 'a'.repeat(64)));
  assert.equal(tokens.hashesMatch(null, 'a'.repeat(64)), false);
  // A row whose stored hash went missing matches nothing rather than crashing.
  assert.doesNotThrow(() => tokens.findByToken([{ tokenHash: 'short' }], token, 's'));
  assert.equal(tokens.findByToken([{ tokenHash: null }, row], token, 's').id, row.id);
});

test('C4: a token is bound to ONE appointment and ONE recipient', () => {
  const a = tokens.buildToken({ eid: '9', clientId: 'c1', recipientUserId: 'u1', recipientRole: 'patient', salt: 's' });
  const b = tokens.buildToken({ eid: '9', clientId: 'c1', recipientUserId: 'u2', recipientRole: 'poa', salt: 's' });
  assert.notEqual(a.token, b.token);
  // The row says whose it is and which visit, so a link forwarded in a family
  // group chat is one visit's exposure, not a standing key.
  assert.equal(a.row.recipientUserId, 'u1');
  assert.equal(a.row.eid, '9');
  assert.equal(tokens.liveTokenFor([a.row, b.row], '9', 'u1').id, a.row.id);
  assert.equal(tokens.liveTokenFor([a.row, b.row], '9', 'u3'), null);
  assert.equal(tokens.liveTokenFor([a.row, b.row], '10', 'u1'), null, 'not the next visit');
  // A recipient role the module does not know is refused rather than stored.
  assert.throws(() => tokens.buildToken({ eid: '9', clientId: 'c1', recipientUserId: 'u1', recipientRole: 'cousin', salt: 's' }), /recipient is one of/);
  for (const miss of [{ eid: '' }, { clientId: '' }, { recipientUserId: '' }, { salt: '' }]) {
    assert.throws(() => tokens.buildToken({ eid: '9', clientId: 'c1', recipientUserId: 'u1', recipientRole: 'patient', salt: 's', ...miss }));
  }
});

test('C4: revoking tombstones rather than deleting, so a shut link can say it was shut', () => {
  const a = tokens.buildToken({ eid: '9', clientId: 'c1', recipientUserId: 'u1', recipientRole: 'patient', salt: 's' });
  const other = tokens.buildToken({ eid: '10', clientId: 'c1', recipientUserId: 'u1', recipientRole: 'patient', salt: 's' });
  const rows = [a.row, other.row];
  assert.equal(tokens.revokeForEid(rows, '9', 'cancelled'), 1);
  assert.ok(rows[0].revokedAt);
  assert.equal(rows[0].revokedReason, 'cancelled');
  assert.equal(rows[1].revokedAt, null, 'another visit\'s link is untouched');
  // STILL FINDABLE: "never existed" and "was shut off" need different next
  // steps from whoever is holding the link.
  assert.ok(tokens.findByToken(rows, a.token, 's'));
  assert.equal(tokens.liveTokenFor(rows, '9', 'u1'), null, 'but it is not live');
  assert.equal(tokens.revokeForEid(rows, '9', 'cancelled'), 0, 'revoking twice is a no-op');
});

test('C4: links move with the room on a reschedule rather than being reminted', () => {
  const a = tokens.buildToken({ eid: '9', clientId: 'c1', recipientUserId: 'u1', recipientRole: 'patient', salt: 's' });
  const dead = tokens.buildToken({ eid: '9', clientId: 'c1', recipientUserId: 'u2', recipientRole: 'poa', salt: 's' });
  tokens.revokeForEid([dead.row], '9', 'cancelled');
  const rows = [a.row, dead.row];
  assert.equal(tokens.migrateEid(rows, '9', '11'), 1, 'only the LIVE link moves');
  assert.equal(rows[0].eid, '11');
  assert.equal(rows[0].movedFromEid, '9');
  assert.equal(rows[1].eid, '9', 'a tombstone stays where it was');
  // Sending a second link while the first still worked would leave somebody
  // holding two and guessing.
  assert.ok(tokens.findByToken(rows, a.token, 's'), 'the same token still works, on the new eid');
});

test('C4: /v/<token> checks the SAME window the portal button checks, and serves a page not a redirect', () => {
  const src = SERVER.slice(SERVER.indexOf("app.get('/v/:token'"));
  const body = src.slice(0, src.indexOf('\n});'));
  assert.match(body, /patientPublish\.joinState\(patientPublish\.joinWindow\(appt, joinInstant\), Date\.now\(\)\)/,
    'one rule, two doors');
  // A redirect would put the room URL in browser history and in any Referer
  // the next hop sends.
  assert.ok(!/res\.redirect/.test(body), 'no redirect');
  assert.match(body, /res\.type\('html'\)\.send\(joinPage/);
  // 404 for one that never existed, 410 for one that did and was shut off.
  assert.match(body, /refuse\(404, 'This link is not valid'/);
  assert.match(body, /refuse\(410, 'This link has been turned off'/);
  // It is audited: /v is a PHI path, because it opens a live door into a
  // patient's consultation.
  const audit = require('../auditLog');
  assert.equal(audit.isPhiPath('/v/abc'), true);
  assert.match(body, /'video_join_link_used'/);
  assert.ok(!/meetingUri/.test(auditDetail(body, "'video_join_link_used'")), 'never the link itself');
});

test('C4: the join page escapes everything it prints', () => {
  const src = SERVER.slice(SERVER.indexOf('const joinPage ='));
  const body = src.slice(0, src.indexOf('\napp.get(\'/v/:token\''));
  // One escaper, the note formatter's. A page that interpolates a provider
  // name or an org value raw is a page somebody can inject into.
  assert.match(body, /const esc = noteFormat\.escapeHtml/);
  const interps = body.match(/\$\{[^}]+\}/g) || [];
  for (const i of interps) {
    assert.ok(/esc\(|link \?|JOIN_OPENS_MINUTES_BEFORE/.test(i), `unescaped interpolation in the join page: ${i}`);
  }
});

// ---- C4: the day-of nudge ----------------------------------------------

test('C4: the nudge is 30 minutes before the start, in Georgia, and rides the one store', () => {
  assert.equal(reminders.VIDEO_JOIN_MINUTES_BEFORE, 30);
  assert.equal(reminders.videoJoinSendAt('2026-10-20', '14:00'), '2026-10-20T17:30:00.000Z');
  assert.equal(reminders.videoJoinSendAt('2026-12-20', '14:00'), '2026-12-20T18:30:00.000Z', 'EST, not an offset');
  for (const bad of [['2026-10-20', ''], ['not-a-date', '14:00'], ['2026-10-20', '25:00'], ['2026-10-20', null]]) {
    assert.equal(reminders.videoJoinSendAt(bad[0], bad[1]), null, `${bad} has no send time`);
  }
  const b = reminders.buildVisitReminder({ id: '1', clientId: 'c', eid: '9', visitDate: '2026-10-20', startTime: '14:00', kind: 'video_join', now: '2026-10-19T00:00:00Z' });
  assert.equal(b.reminder.kind, 'video_join');
  assert.equal(b.reminder.sendAt, '2026-10-20T17:30:00.000Z');
  // A row with NO kind is a day-before reminder, so every row written before
  // this change keeps behaving exactly as it did.
  assert.equal(reminders.kindOf({}), 'day_before');
  assert.equal(reminders.kindOf({ kind: 'video_join' }), 'video_join');
  assert.equal(reminders.kindOf(null), 'day_before');
});

test('C4: a nudge found more than an hour late is VOIDED, not sent', () => {
  // Twelve hours is right for "your visit is tomorrow" and absurd for "your
  // visit starts in 30 minutes".
  assert.equal(reminders.VIDEO_JOIN_MISSED_WINDOW_HOURS, 1);
  assert.equal(reminders.missedWindowHoursFor('video_join'), 1);
  assert.equal(reminders.missedWindowHoursFor('day_before'), reminders.MISSED_WINDOW_HOURS);
  const row = { id: '1', eid: '9', kind: 'video_join', status: 'scheduled', sendAt: '2026-10-20T17:30:00.000Z' };
  assert.equal(reminders.dueReminders([row], '2026-10-20T18:00:00Z').due.length, 1, 'half an hour late is still useful');
  assert.equal(reminders.dueReminders([row], '2026-10-20T19:00:00Z').missed.length, 1, 'ninety minutes late is not');
  const day = { id: '2', eid: '9', status: 'scheduled', sendAt: '2026-10-19T13:00:00.000Z' };
  assert.equal(reminders.dueReminders([day], '2026-10-19T20:00:00Z').due.length, 1, 'the day-before window is unchanged');
});

test('C4: the nudge voids by KIND, so a visit moved out of video keeps its day-before reminder', () => {
  const vid = { id: '1', eid: '9', kind: 'video_join', status: 'scheduled' };
  const day = { id: '2', eid: '9', status: 'scheduled' };
  const out = reminders.voidRemindersForEid([vid, day], '9', 'no_longer_video', null, 'video_join');
  assert.equal(out.voided, 1);
  assert.equal(out.rows.find(r => r.id === '1').status, 'void');
  assert.equal(out.rows.find(r => r.id === '2').status, 'scheduled',
    'voiding both would leave the patient with no reminder at all');
  // Left out, it voids both — which is what a cancellation wants.
  assert.equal(reminders.voidRemindersForEid([vid, day], '9', 'cancelled').voided, 2);
});

test('C4: the nudge opens with "Your visit", and the vague version carries NO link', () => {
  // `sendToClientSide` rewrites /^Your visit/ to "{Name}'s visit" for a POA,
  // so a paragraph that starts any other way tells a POA "your visit" about
  // somebody else's appointment. That is the mechanism, not a style rule.
  const d = reminders.videoReminderCopy({ detail: true, when: '2pm', joinUrl: 'https://app/v/t', orgPhone: '404' });
  assert.match(d.paragraphs[0], /^Your visit/);
  assert.equal(d.joinUrl, 'https://app/v/t');
  const v = reminders.videoReminderCopy({ detail: false, when: '2pm', joinUrl: 'https://app/v/t', orgPhone: '404' });
  assert.match(v.paragraphs[0], /^Your visit/);
  // A one-tap link is a door into a live consultation: it goes out only where
  // the transport is inside the BAA.
  assert.equal(v.joinUrl, null);
  const vagueJson = JSON.stringify(v);
  assert.ok(!/2pm|https?:/.test(vagueJson), 'no time and no link in the vague version');
  assert.ok(!/2pm/.test(v.subject));
});

test('C4: the nudge has its OWN dedupe key and its own gated cta', () => {
  const n = code(read('notifications.js'), 'notifications.js');
  const src = n.slice(n.indexOf('async function videoReminder'));
  const body = src.slice(0, src.indexOf('\n  }\n'));
  // A bare `${eid}:reminder` would collide with the day-before notice and the
  // nudge would be swallowed as a duplicate of it.
  assert.match(body, /entityId: `\$\{reminder\.eid\}:video-join`/);
  assert.ok(!/\$\{reminder\.eid\}:reminder/.test(body));
  // `ctaFor` is only consulted when detail is allowed, so a transport outside
  // the BAA sends "sign in to your portal" and nothing else.
  assert.match(body, /ctaFor: detail \? ctaFor : null/);
  assert.match(body, /videoReminderCopy/);
});

test('C4: the mint reuses a live link and refuses when there is no room', () => {
  const src = SERVER.slice(SERVER.indexOf('const mintJoinCta'));
  const body = src.slice(0, src.indexOf('\n// Generate a URL-friendly slug'));
  // The pointer store is the authority: a visit moved out of video between the
  // booking and the nudge gets the portal button instead of a link to nothing.
  assert.match(body, /if \(!link \|\| !link\.meetingUri\) return null;/);
  assert.match(body, /if \(live\) return null;/, 'one live link per person');
  assert.match(body, /recipientRole: actingFor \? 'poa' : 'patient'/);
  assert.match(body, /appLinks\.videoJoinFor\(token\)/, 'the path comes from appLinks, never a literal');
  assert.ok(!/token|meetingUri/.test(auditDetail(body, "'video_join_link_issued'")),
    'neither the token nor the room URL is logged');
});

// ---- Meet space safety (the room itself) --------------------------------

test('every Meet space is created with recording off and host-only chat', () => {
  // These are the settings that decide whether a consultation can be recorded
  // or taken over. Pinned by VALUE, because a default somebody changes in the
  // Workspace console must not change what this app asks for.
  const c = meetRooms.SPACE_CONFIG;
  assert.equal(c.accessType, 'TRUSTED', 'never OPEN: a link is not an invitation to the internet');
  assert.equal(c.moderation, 'ON');
  assert.equal(c.attendanceReportGenerationType, 'DO_NOT_GENERATE');
  for (const [k, v] of Object.entries(c.artifactConfig)) {
    assert.ok(/DO_NOT|OFF|NO_/.test(JSON.stringify(v)), `${k} must be off: ${JSON.stringify(v)}`);
  }
  assert.equal(c.moderationRestrictions.chatRestriction, 'HOSTS_ONLY');
  assert.equal(c.moderationRestrictions.reactionRestriction, 'HOSTS_ONLY');
  // Presenting is NOT restricted: a patient holding up a medicine bottle or a
  // wound is the point of a video visit.
  assert.equal(c.moderationRestrictions.presentRestriction, 'NO_RESTRICTION');
  assert.equal(c.moderationRestrictions.defaultJoinAsViewerType, 'OFF');
});

test('nothing identifying can reach a Meet space', () => {
  // `createSpace` takes ONE argument — the clinician's own Workspace address —
  // so it cannot be handed a patient.
  assert.equal(meetRooms.createTransport({ getAuth: () => ({}) }).createSpace.length, 1);
  const src = code(read('meetRooms.js'), 'meetRooms.js');
  for (const w of ['clientId', 'patient', 'displayName', 'firstName', 'lastName', 'dob']) {
    assert.ok(!new RegExp(w, 'i').test(src), `meetRooms.js must not know about ${w}`);
  }
});

test('build: the two T1 collections are claimed in the migration registry, as PHI', () => {
  const m = read('dataMigration.js');
  assert.match(m, /key: 'appointment_video_links', phi: true/);
  assert.match(m, /key: 'appointment_join_tokens', phi: true/);
});

test('build: nothing in the Meet path records, transcribes or takes notes', () => {
  // A consultation that is recorded without anybody deciding to is the worst
  // thing this feature could do, so the absence is build-enforced rather than
  // left to a config default.
  const src = code(read('meetRooms.js'), 'meetRooms.js') + code(read('videoJoinTokens.js'), 'videoJoinTokens.js');
  assert.ok(!/RECORDING_ON|TRANSCRIPTION_ON|SMART_NOTES_ON|startRecording/i.test(src));
  // And the one scope requested is the narrowest that can create a space.
  assert.deepEqual(meetRooms.MEET_SCOPES, ['https://www.googleapis.com/auth/meetings.space.created']);
});

test('build: the admin test creates a real room and shuts it again', () => {
  const src = SERVER.slice(SERVER.indexOf("app.post('/api/admin/meet/test'"));
  const body = src.slice(0, src.indexOf('\n});'));
  // `configured` means the settings parse, which is a different fact from
  // Google honouring them. This is the route that proves the second.
  assert.match(body, /await meetRooms\.createSpace\(email\)/);
  assert.match(body, /await meetRooms\.closeSpace\(email, room\.spaceName\)/);
  assert.match(body, /requireAdmin/);
  const i = body.indexOf('createSpace(email)');
  assert.ok(body.indexOf('closeSpace(email', i) > i, 'the test leaves nothing joinable behind');
  // No patient is involved: the test route never loads a client.
  assert.ok(!/loadClinicalClient|clientId/.test(body));
});
