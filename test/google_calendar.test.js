// Mirroring clinical visits onto the Google clinical calendar (owner, 2026-10-12).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../googleCalendar');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const memDb = () => { const m = new Map(); return { get: async k => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : null), set: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); } }; };
const fakeCal = () => {
  const calls = []; let n = 0;
  return { calls, events: {
    insert: async (a) => { calls.push(['insert', a]); return { data: { id: `ev${++n}` } }; },
    patch: async (a) => { calls.push(['patch', a]); return { data: { id: a.eventId } }; },
    delete: async (a) => { calls.push(['delete', a]); return {}; }
  } };
};
const visit = (o) => Object.assign({ eid: '101', clientId: 'c1', title: 'Follow-up visit', patientName: 'Juanita Guess', date: '2026-11-02', startTime: '09:00', durationMinutes: 45, location: 'home', address: '1 Main St, Marietta, GA 30060', clinicianName: 'Bethel Godwins, nurse practitioner' }, o || {});

test('the event is Georgia wall time with the zone named, so it is right on both sides of DST', () => {
  const e = G.buildEvent(visit());
  assert.deepEqual(e.start, { dateTime: '2026-11-02T09:00:00', timeZone: 'America/New_York' });
  assert.deepEqual(e.end, { dateTime: '2026-11-02T09:45:00', timeZone: 'America/New_York' });
  assert.equal(e.summary, 'Follow-up visit · Juanita Guess');
  assert.equal(e.location, '1 Main St, Marietta, GA 30060', 'a home visit carries the address');
  assert.equal(G.buildEvent(visit({ location: 'telehealth' })).location, undefined, 'a video visit does not');
  assert.equal(G.addMinutes('23:30', 60), '23:59', 'never spills onto the next day');
  assert.equal(G.buildEvent(visit({ date: 'nope' })), null);
});

test('book, move, no-show and cancel follow one event, keyed on the eid', async () => {
  const db = memDb(); const cal = fakeCal(); G.setClientForTests(cal);
  process.env.GOOGLE_CLINICAL_CALENDAR_ID = 'clinical@group.calendar.google.com';
  try {
    let r = await G.upsertVisit(db, visit());
    assert.equal(r.synced, true); assert.equal(cal.calls[0][0], 'insert');
    // A reschedule gives the visit a NEW eid; the same event moves.
    r = await G.upsertVisit(db, visit({ eid: '202', startTime: '13:00' }), { previousEid: '101' });
    assert.equal(cal.calls[1][0], 'patch'); assert.equal(cal.calls[1][1].eventId, 'ev1');
    assert.deepEqual((await db.get(G.COLLECTION)).map(x => x.eid), ['202'], 'the old eid no longer points at it');
    r = await G.upsertVisit(db, visit({ eid: '303', status: 'no_show' }), { previousEid: '202' });
    assert.match(cal.calls[2][1].requestBody.summary, /^No-show: /);
    r = await G.removeVisit(db, '303');
    assert.equal(r.synced, true); assert.equal(cal.calls[3][0], 'delete');
    assert.deepEqual(await db.get(G.COLLECTION), []);
  } finally { G.setClientForTests(null); delete process.env.GOOGLE_CLINICAL_CALENDAR_ID; }
});

test('a Google failure never throws, and an unconfigured calendar is a quiet no', async () => {
  const db = memDb();
  assert.deepEqual(await G.upsertVisit(db, visit()), { synced: false, reason: 'not_configured' });
  G.setClientForTests({ events: { insert: async () => { throw new Error('403 forbidden'); } } });
  try { const r = await G.upsertVisit(db, visit()); assert.equal(r.synced, false); assert.match(r.reason, /403/); }
  finally { G.setClientForTests(null); }
});

test('calendarStatus names every missing setting at once', () => {
  const s = G.calendarStatus();
  if (!s.configured) assert.ok(s.blockers.length >= 1);
  assert.equal(G.CALENDAR_SCOPE, 'https://www.googleapis.com/auth/calendar.events');
});

test('build guard: every route that changes a visit mirrors it, and the reschedule moves it by the OLD eid', () => {
  const create = server.slice(server.indexOf("app.post('/api/clinical/patients/:clientId/appointments', "), server.indexOf("app.post('/api/clinical/appointments/:eid/reschedule'"));
  assert.match(create, /await mirrorVisitToGoogle\(\{ clientId: client\.id, eid: String\(eid\)/);
  const resched = server.slice(server.indexOf("app.post('/api/clinical/appointments/:eid/reschedule'"), server.indexOf("app.post('/api/clinical/appointments/:eid/cancel'"));
  assert.match(resched, /await mirrorVisitToGoogle\(\{[^}]*eid: String\(newEid\), previousEid: String\(row\.pc_eid\)/);
  const cancel = server.slice(server.indexOf("app.post('/api/clinical/appointments/:eid/cancel'"), server.indexOf("app.post('/api/clinical/appointments/:eid/no-show'"));
  assert.match(cancel, /await googleCalendar\.removeVisit\(db, String\(row\.pc_eid\)\)/);
  const noshow = server.slice(server.indexOf("app.post('/api/clinical/appointments/:eid/no-show'"), server.indexOf("app.post('/api/clinical/appointments/:eid/no-show'") + 4000);
  assert.match(noshow, /status: 'no_show'/);
  // Nothing calls Google in a way that can fail a booking.
  // ANCHORED ON THE FUNCTION, NOT ON A CHARACTER BUDGET. This read
  // `[\s\S]{0,1200}` and broke the moment the function grew past it — a
  // bounded scan is a guard that works only on the code it was written
  // against, which this repo has paid for several times.
  const mirror = server.slice(server.indexOf('const mirrorVisitToGoogle = async'));
  const mirrorFn = mirror.slice(0, mirror.indexOf('\n};') + 3);
  assert.ok(mirrorFn.length > 300 && mirrorFn.length < 4000, 'the mirror slice looks wrong');
  assert.match(mirrorFn, /catch \(e\) \{ console\.warn\('\[CALENDAR\] mirror error \(non-fatal\):'/);
});

// ── The provider's PHI-free invite (owner, 2026-11-05) ─────────────────────
// Clinicians here mostly hold personal Gmail accounts. The Workspace BAA
// covers the GFC domain and NOT a personal mailbox, so the invitation they
// receive carries no patient and no address; the identifying half stays on
// the clinical calendar, which is covered.

test('⚠️ the invite carries no patient and no address, at any input', () => {
  const inv = G.buildInvite({
    eid: '77', title: 'Follow-up', date: '2026-11-10', startTime: '09:00',
    durationMinutes: 45, location: 'home', providerEmail: 'doc@gmail.com'
  });
  const blob = JSON.stringify(inv);
  for (const leak of ['Juanita', 'Guess', '742 Evergreen', 'Atlanta']) {
    assert.ok(!blob.includes(leak), `${leak} must never reach an uncovered mailbox`);
  }
  // It is useful, not just safe: the clinician can tell what the hour is for.
  assert.strictEqual(inv.summary, 'GFC Follow-up');
  assert.match(inv.description, /Home visit/);
  assert.match(inv.description, /Open the Godwins Family Care app/);
  assert.deepStrictEqual(inv.attendees, [{ email: 'doc@gmail.com' }]);
  assert.strictEqual(inv.start.dateTime, '2026-11-10T09:00:00');
  assert.strictEqual(inv.end.dateTime, '2026-11-10T09:45:00');
  assert.strictEqual(inv.start.timeZone, 'America/New_York');
});

test('the invite builder is handed only what it may show — it cannot read a patient', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'googleCalendar.js'), 'utf8');
  const i = src.indexOf('function buildInvite(');
  assert.ok(i > 0, 'buildInvite not found');
  const raw = src.slice(i, src.indexOf('\n}', i));
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  assert.ok(code.length > 150, 'the slice or the stripper is wrong — this would pass vacuously');
  assert.ok(/attendees/.test(code), 'precondition: the stripped code is still the real function');
  // Build-enforced: not "we remembered to leave them out" but "they are not
  // in scope to leave in". The same reasoning as the critical-result notice
  // builder, which takes no arguments at all.
  for (const field of ['patientName', 'address', 'clientId']) {
    assert.ok(!new RegExp(`\\b${field}\\b`).test(code), `buildInvite must not read ${field}`);
  }
  // And the full event still carries them — or this test passes because the
  // app stopped putting a patient on any event at all.
  const full = G.buildEvent({
    eid: '1', title: 'Home visit', patientName: 'Juanita Guess', date: '2026-11-10',
    startTime: '09:00', durationMinutes: 30, location: 'home', address: '742 Evergreen, Atlanta GA'
  });
  assert.match(full.summary, /Juanita Guess/);
  assert.strictEqual(full.location, '742 Evergreen, Atlanta GA');
});

test('a bad or missing provider email sends nothing rather than a broken invite', () => {
  const base = { eid: '1', title: 'Visit', date: '2026-11-10', startTime: '09:00', durationMinutes: 30 };
  for (const bad of [undefined, null, '', '   ', 'not-an-email', 'a@b', 'a b@c.com']) {
    assert.strictEqual(G.buildInvite({ ...base, providerEmail: bad }), null, `"${bad}" must not become an attendee`);
  }
  assert.ok(G.buildInvite({ ...base, providerEmail: ' doc@gmail.com ' }), 'a padded address is still an address');
});

test('invites are OFF until their own calendar is named — never defaulted onto clinical@', () => {
  const keep = { ...process.env };
  try {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = JSON.stringify({ client_email: 'sa@x.iam.gserviceaccount.com', private_key: 'k' });
    process.env.GMAIL_SEND_AS = 'admin@godwinsfamilycarellc.com';
    process.env.GOOGLE_CLINICAL_CALENDAR_ID = 'clinical@group.calendar.google.com';
    delete process.env.GOOGLE_PROVIDER_INVITE_CALENDAR_ID;
    let st = G.calendarStatus();
    assert.strictEqual(st.configured, true, 'the clinical mirror is configured');
    // Defaulting invites onto the clinical calendar would put a second row on
    // every visit for everyone reading it — a change nobody asked for.
    assert.strictEqual(st.invitesConfigured, false);
    assert.notStrictEqual(st.inviteCalendarId, st.calendarId);
    assert.strictEqual(st.inviteCalendarId, null);
    process.env.GOOGLE_PROVIDER_INVITE_CALENDAR_ID = 'invites@group.calendar.google.com';
    st = G.calendarStatus();
    assert.strictEqual(st.invitesConfigured, true);
    assert.strictEqual(st.inviteCalendarId, 'invites@group.calendar.google.com');
  } finally { process.env = keep; }
});

test('booking invites, rescheduling moves the same invite, cancelling withdraws it', async () => {
  const store = new Map();
  const db = { get: async (k) => store.get(k) || null, set: async (k, v) => { store.set(k, v); return true; } };
  const calls = [];
  G.setClientForTests({ events: {
    insert: async (a) => { calls.push(['insert', a]); return { data: { id: 'ev1' } }; },
    patch: async (a) => { calls.push(['patch', a]); return { data: { id: 'ev1' } }; },
    delete: async (a) => { calls.push(['delete', a]); return {}; }
  } });
  try {
    const visit = { eid: '10', title: 'Follow-up', date: '2026-11-10', startTime: '09:00', durationMinutes: 30, location: 'home', providerEmail: 'doc@gmail.com' };
    let r = await G.upsertInvite(db, visit);
    assert.strictEqual(r.invited, true);
    // sendUpdates:'all' is what actually puts it in their inbox — without it
    // Google makes the event and tells nobody.
    assert.strictEqual(calls[0][1].sendUpdates, 'all');

    // A reschedule changes the eid (the tombstone swap), so the invite must
    // follow the NEW eid or the clinician keeps a slot nobody is attending.
    r = await G.upsertInvite(db, { ...visit, eid: '11', startTime: '14:00' }, { previousEid: '10' });
    assert.strictEqual(r.invited, true);
    assert.strictEqual(calls[1][0], 'patch', 'the same invite moves rather than a second one appearing');
    assert.strictEqual(calls[1][1].sendUpdates, 'all');
    const rows = await db.get(G.INVITE_COLLECTION);
    assert.deepStrictEqual(rows.map(x => x.eid), ['11'], 'the old eid does not linger');

    r = await G.removeInvite(db, '11');
    assert.strictEqual(r.invited, true);
    assert.strictEqual(calls[2][0], 'delete');
    assert.strictEqual(calls[2][1].sendUpdates, 'all', 'a silent delete leaves them driving to a cancelled visit');
    assert.deepStrictEqual(await db.get(G.INVITE_COLLECTION), []);
  } finally { G.setClientForTests(null); }
});

test('the full event and the invite are separate rows on separate calendars', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'googleCalendar.js'), 'utf8');
  assert.notStrictEqual(G.COLLECTION, G.INVITE_COLLECTION,
    'one map could only remember one of the two events a visit has');
  // The invite writes to the invite calendar, the mirror to the clinical one.
  const inv = src.slice(src.indexOf('async function upsertInvite('), src.indexOf('async function removeInvite('));
  assert.ok(/status\.inviteCalendarId/.test(inv) && !/calendarId: status\.calendarId/.test(inv),
    'the invite must not be written onto the clinical calendar');
});

test('server: both halves go through one mirror, and cancelling withdraws the invite', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf('const mirrorVisitToGoogle =');
  assert.ok(i > 0, 'mirrorVisitToGoogle not found');
  const fn = src.slice(i, src.indexOf('\n};', i));
  assert.ok(/upsertVisit\(/.test(fn) && /upsertInvite\(/.test(fn),
    'one function does both halves, so a route cannot send one and forget the other');
  // The invite call must be handed only what it may show.
  const call = fn.slice(fn.indexOf('upsertInvite('));
  for (const field of ['patientName', 'address', 'facts', 'clientId']) {
    assert.ok(!call.includes(field), `the invite call must not pass ${field}`);
  }
  assert.ok(/removeInvite\(/.test(src), 'cancelling must withdraw the invitation');
  // Two callers now (clinical visits and IME exams), and that is fine — what
  // must not happen is a second idea of what an invite IS. Every caller goes
  // through the one shared writer and none builds a body itself.
  assert.ok((src.match(/googleCalendar\.upsertInvite\(/g) || []).length >= 1, 'at least one caller');
  // Scoped to the MIRROR, not the whole file: `attendees:` legitimately
  // appears where the appointment list is shaped for the screen. What must
  // not happen is server.js building a Google attendee body of its own.
  assert.ok(!/attendees\s*:\s*\[/.test(fn),
    'the mirror must not assemble an invite body — that lives in googleCalendar.buildInvite');
  assert.ok(!/attendees\s*:\s*\[\s*\{\s*email/.test(src),
    'nowhere in server.js may build a Google attendee list');
  assert.strictEqual((fs.readFileSync(path.join(__dirname, '..', 'googleCalendar.js'), 'utf8')
    .match(/function buildInvite\(/g) || []).length, 1, 'one definition of what an invite is');
});

// ── An IME exam on the clinical calendar (owner, 2026-11-05) ───────────────
// The exam line is billed to the contracting vendor, not claimed, so it keeps
// its own record and never reaches OpenEMR. It does reach the clinical
// calendar and My Day.

test('an exam event names the veteran — the clinical calendar is inside the BAA', () => {
  const e = G.buildExamEvent({
    examId: 'x1', firstName: 'James', lastName: "O'Brien", examDate: '2026-11-10',
    examTime: '11:00', durationMinutes: 60, siteLabel: 'Savannah clinic', providerName: 'Bethel Godwins'
  });
  assert.strictEqual(e.summary, "IME Exam · O'Brien, James");
  assert.strictEqual(e.location, 'Savannah clinic');
  assert.match(e.description, /Independent medical examination/);
  assert.match(e.description, /With Bethel Godwins/);
  assert.match(e.description, /Change it there, not here/);
  assert.strictEqual(e.start.dateTime, '2026-11-10T11:00:00');
  assert.strictEqual(e.end.dateTime, '2026-11-10T12:00:00');
  assert.strictEqual(e.extendedProperties.private.gfcKind, 'ime');
  // Nobody is invited to THIS event: the provider's copy is the PHI-free one.
  assert.strictEqual(e.attendees, undefined);
});

test('an exam with no time gets no event rather than a made-up hour', () => {
  assert.strictEqual(G.buildExamEvent({ examId: 'x', lastName: 'Ames', examDate: '2026-11-10' }), null);
  assert.strictEqual(G.buildExamEvent({ examId: 'x', lastName: 'Ames', examDate: '2026-11-10', examTime: '' }), null);
  // A roster row has always been allowed to carry no time, and a clinic that
  // runs first-come has nothing to enter. Placing one at a guessed hour puts
  // a clinician somewhere nobody said to be.
  assert.ok(G.buildExamEvent({ examId: 'x', lastName: 'Ames', examDate: '2026-11-10', examTime: '09:00' }));
  // No length recorded is an hour on the calendar — a block has to have an
  // end — but the roster still stores no length. The event is the only place
  // that figure exists, which is why it is not written back.
  const e = G.buildExamEvent({ examId: 'x', lastName: 'Ames', examDate: '2026-11-10', examTime: '09:00' });
  assert.strictEqual(e.end.dateTime, '2026-11-10T10:00:00');
});

test('adding, moving, un-timing and removing an exam', async () => {
  const store = new Map();
  const db = { get: async (k) => store.get(k) || null, set: async (k, v) => { store.set(k, v); return true; } };
  const calls = [];
  G.setClientForTests({ events: {
    insert: async (a) => { calls.push(['insert', a]); return { data: { id: 'ex1' } }; },
    patch: async (a) => { calls.push(['patch', a]); return { data: { id: 'ex1' } }; },
    delete: async (a) => { calls.push(['delete', a]); return {}; }
  } });
  try {
    const exam = { examId: 'r1', firstName: 'Ann', lastName: 'Lee', examDate: '2026-11-10', examTime: '09:00', durationMinutes: 45, siteLabel: 'Savannah clinic' };
    assert.strictEqual((await G.upsertExam(db, exam)).synced, true);
    assert.strictEqual(calls[0][0], 'insert');

    // Moving the time moves the same event, not a second one.
    assert.strictEqual((await G.upsertExam(db, { ...exam, examTime: '13:00' })).synced, true);
    assert.strictEqual(calls[1][0], 'patch');
    assert.deepStrictEqual((await db.get(G.EXAM_COLLECTION)).map(r => r.examId), ['r1']);

    // ⚠️ CLEARING THE TIME TAKES IT OFF THE CALENDAR. Leaving the event behind
    // would show an hour nobody is holding.
    const cleared = await G.upsertExam(db, { ...exam, examTime: null });
    assert.strictEqual(cleared.removed, true);
    assert.strictEqual(calls[2][0], 'delete');
    assert.deepStrictEqual(await db.get(G.EXAM_COLLECTION), []);

    // An exam that never had a time and still has none is a no-op, not a
    // delete of somebody else's event.
    const none = await G.upsertExam(db, { examId: 'r2', lastName: 'Ames', examDate: '2026-11-10' });
    assert.strictEqual(none.synced, false);
    assert.strictEqual(none.reason, 'no_time');
    assert.strictEqual(calls.length, 3, 'nothing was sent to Google for an untimed exam');

    await G.upsertExam(db, exam);
    assert.strictEqual((await G.removeExam(db, 'r1')).removed, true);
    assert.deepStrictEqual(await db.get(G.EXAM_COLLECTION), []);
  } finally { G.setClientForTests(null); }
});

test('exam events are their own map — not an eid pretending to be one', () => {
  assert.notStrictEqual(G.EXAM_COLLECTION, G.COLLECTION);
  assert.notStrictEqual(G.EXAM_COLLECTION, G.INVITE_COLLECTION);
  const src = fs.readFileSync(path.join(__dirname, '..', 'googleCalendar.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function upsertExam('), src.indexOf('async function removeExam('));
  // An exam has no OpenEMR appointment, so storing its id in a field named
  // `eid` would be a lie in the data a later reader would act on.
  assert.ok(/examId: String\(exam\.examId\)/.test(fn), 'keyed on the roster row id');
  assert.ok(!/\beid\b/.test(fn), 'an exam has no eid');
});

test('server: the Veterans board writes to Google and NEVER to OpenEMR', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf('const mirrorExamToGoogle =');
  assert.ok(i > 0, 'mirrorExamToGoogle not found');
  const fn = src.slice(i, src.indexOf('\nconst unmirrorExamFromGoogle', i));
  assert.ok(/googleCalendar\.upsertExam\(/.test(fn));
  assert.ok(/googleCalendar\.upsertInvite\(/.test(fn), 'the provider gets the same PHI-free invite a visit sends');
  // ⚠️ The owner's rule: OpenEMR's calendar holds clinical appointments only.
  assert.ok(!/openemr|postAppointmentRow|createAppointmentRow/i.test(fn),
    'an exam must never reach OpenEMR');
  // Every roster write keeps the calendar in step, and removal takes both off.
  for (const after of ['veteran_added', 'veteran_updated']) {
    const at = src.indexOf(`'${after}'`);
    assert.ok(/mirrorExamToGoogle\(/.test(src.slice(at, at + 400)), `${after} must mirror`);
  }
  const rm = src.indexOf("'veteran_removed'");
  assert.ok(/unmirrorExamFromGoogle\(/.test(src.slice(rm, rm + 400)), 'removal takes it off the calendar');
  // The invite for an exam carries no veteran: it is handed a title, not a name.
  const call = fn.slice(fn.indexOf('upsertInvite('));
  for (const leak of ['firstName', 'lastName']) {
    assert.ok(!call.includes(leak), `the exam invite must not pass ${leak}`);
  }
  // ⚠️ CLEARING AN EXAM'S TIME WITHDRAWS THE INVITATION. Without this the
  // provider keeps an invite to a slot that no longer exists — buildInvite
  // refuses to make a timeless one, so nothing new is sent and the stale one
  // just sits there. Caught by a mutation that removed the condition.
  assert.match(fn, /row\.examTime\s*\n?\s*\?\s*await googleCalendar\.upsertInvite\(/,
    'an invite is sent only for a timed exam');
  assert.match(fn, /:\s*await googleCalendar\.removeInvite\(db, `ime:\$\{row\.id\}`\)/,
    'and an exam with no time has its invitation withdrawn');
});

// ── Other clinical team members on a visit (owner, 2026-11-05) ────────────
// "Other team members can be added to appointment as scheduled, for example,
// family meetings." One event, several guests — never one event each.

test('the guest list folds the clinician and the team into one invite', () => {
  const inv = G.buildInvite({
    eid: '5', title: 'Family meeting', date: '2026-11-10', startTime: '15:00',
    durationMinutes: 60, location: 'office',
    providerEmail: 'doc@gmail.com', attendeeEmails: ['CM@gmail.com', ' sw@gmail.com ', 'doc@gmail.com']
  });
  // De-duplicated and case-folded: the clinician appears once even when also
  // picked from the list, which is the obvious way to double-invite someone.
  assert.deepStrictEqual(inv.attendees, [{ email: 'doc@gmail.com' }, { email: 'cm@gmail.com' }, { email: 'sw@gmail.com' }]);
  // ONE event with three guests, not three events.
  assert.strictEqual(typeof inv.summary, 'string');
  // Still no patient, with a longer guest list than before.
  assert.ok(!/Juanita|Guess|Evergreen/i.test(JSON.stringify(inv)));
  // Guests cannot see each other: who else attends a patient's care meeting
  // is itself something a recipient has no need to learn from an invitation.
  assert.strictEqual(inv.guestsCanSeeOtherGuests, false);
});

test('one bad address does not stop the rest of the team being told', () => {
  const inv = G.buildInvite({
    eid: '5', title: 'Family meeting', date: '2026-11-10', startTime: '15:00',
    attendeeEmails: ['good@gmail.com', 'rubbish', '', null, 'also@gmail.com']
  });
  assert.deepStrictEqual(inv.attendees.map(a => a.email), ['good@gmail.com', 'also@gmail.com']);
  // But an invitation with nobody left on it is not sent at all.
  assert.strictEqual(G.buildInvite({ eid: '5', date: '2026-11-10', startTime: '15:00', attendeeEmails: ['rubbish'] }), null);
  assert.deepStrictEqual(G.inviteEmails({}), []);
});

test('⚠️ only clinical team members can be put on a visit — never a patient\'s family', () => {
  const roles = require('../clinicalRoles');
  const yes = [
    { role: 'user', clinicalRole: 'provider', clinicalRoleConfirmed: true, hasClinicalAccess: true },
    { role: 'caseManager', clinicalRole: 'readOnly', clinicalRoleConfirmed: true },
    { role: 'user', clinicalRole: 'lcsw', clinicalRoleConfirmed: true, hasClinicalAccess: true },
    { role: 'admin' }
  ];
  // A patient's own family is a DIFFERENT privacy decision and an open one:
  // their mailbox is not covered, and even a PHI-free invitation on a
  // daughter's calendar says this patient had a care meeting.
  const no = [{ role: 'client' }, { role: 'family' }, { role: 'family', familyIsPoa: true },
    { role: 'vendor', licenseLevel: 'PCA' }, { role: 'admin', accountStatus: 'inactive' }];
  for (const u of yes) assert.strictEqual(roles.canAttendVisit(u), true, JSON.stringify(u));
  for (const u of no) assert.strictEqual(roles.canAttendVisit(u), false, JSON.stringify(u));
});

test('server: the attendee route refuses anyone ineligible BY NAME, and the list is served', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf("app.put('/api/clinical/appointments/:eid/attendees'");
  assert.ok(i > 0, 'attendees route not found');
  const route = src.slice(i, src.indexOf("app.get('/api/clinical/attendee-candidates'"));
  // Silently dropping somebody leaves them off a meeting they were added to.
  assert.match(route, /if \(resolved\.invalid\.length\) \{[\s\S]{0,400}?ATTENDEE_NOT_ELIGIBLE/,
    'the refusal must be reachable, not just present — `if (false)` passed until this pinned the condition');
  assert.match(route, /invalid: resolved\.invalid/);
  assert.match(route, /mirrorVisitToGoogle\(/, 'saving the list must send the invitations');
  // ⚠️ The patient must survive an attendee change. Passing a null clientId
  // here would PATCH THE CLINICAL EVENT WITH NO PATIENT AND NO ADDRESS —
  // stripping the patient off the calendar because somebody joined a meeting.
  assert.match(route, /clinicalClientsByPuuid\(\)\)\.get\(String\(row\.puuid\)\)/);
  assert.match(route, /clientId: appClient \? appClient\.clientId : null/);
  // Eligibility is asked of clinicalRoles, not restated in the route.
  assert.ok(/clinicalRoles\.canAttendVisit\(/.test(src), 'one predicate decides who may attend');
  // A reschedule gives the visit a new eid, so the guest list follows it.
  assert.ok(/const moveAttendees = async \(fromEid, toEid\)/.test(src));
  assert.ok(/await moveAttendees\(previousEid, eid\)/.test(src), 'the mirror moves the list with the visit');
});

test('page: the picker renders from the SERVED list and warns about a missing email', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
  assert.ok(/^    const VisitAttendees = /m.test(src), 'must sit at module scope (react_input_focus)');
  const i = src.indexOf('const VisitAttendees =');
  const comp = src.slice(i, src.indexOf('const DayScheduleRow', i));
  assert.match(comp, /api\.attendeeCandidates\(\)/, 'the eligible list is served, never named in the page');
  // A screen with its own idea of who may attend drifts from the gate.
  for (const role of ["'provider'", "'lcsw'", "'caseManager'", "'readOnly'"]) {
    assert.ok(!comp.includes(role), `the page must not name ${role}`);
  }
  // Said plainly rather than letting the invite fail quietly.
  assert.match(comp, /no email on file/);
  assert.match(comp, /carries no patient details/);
  assert.match(src, /<VisitAttendees appt=\{appt\}/, 'and it is actually rendered');
});
