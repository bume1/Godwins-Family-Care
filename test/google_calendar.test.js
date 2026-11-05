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
  assert.match(server, /const mirrorVisitToGoogle = async[\s\S]{0,1200}catch \(e\) \{ console\.warn\('\[CALENDAR\] mirror error \(non-fatal\):'/);
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
  assert.strictEqual((src.match(/googleCalendar\.upsertInvite\(/g) || []).length, 1,
    'exactly one invite writer — a second would drift from this one');
});
