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
