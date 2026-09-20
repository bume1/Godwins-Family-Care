// ============================================================================
// Editing, bulk posting and bulk removal of shifts (owner request, 2026-09-20)
//
// "Make the schedules and shifts editable by admin and manager after posting.
//  Previous shifts too when we need to update the time. And the ability to bulk
//  add shifts and bulk remove shifts. Then add a calendar view."
//
// The rules that would break quietly and expensively if they regressed:
//
//   1. A PAST shift is editable. That is the point, not an oversight.
//   2. An absent key means "leave this alone" — one field cannot blank another.
//   3. An edit never silently releases the caregiver holding the shift.
//   4. The time log follows the shift, and the flags DERIVED from a schedule
//      that was wrong are re-derived; the geofence observations are not.
//   5. A bulk range keeps Eastern wall-clock time across the November change.
//   6. Bulk removal cancels a shift somebody held and only deletes one nobody
//      ever did.
//   7. The calendar buckets by the day it is in Georgia, not the viewer's.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const sched = require('../schedulingRepository');
const gfcTime = require('../public/gfc-time');

const ROUTE_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'scheduling.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'scheduling.html'), 'utf8');

const shift = (extra = {}) => ({
  id: 'shift-1', client_id: 'client-1', client_name: 'Margaret Whitfield', status: 'open',
  start: '2026-10-01T13:00:00.000Z', end: '2026-10-01T17:00:00.000Z',
  required_license_level: null, pool_visibility: 'all_eligible',
  care_tier: 'A2', notes: '', pay_rate: null, caregiver_id: null, ...extra
});

// ============================================================================
// 1. What an edit may change
// ============================================================================

test('a PAST shift is editable — correcting last Tuesday is the point', () => {
  const past = shift({ status: 'completed', start: '2020-01-06T14:00:00.000Z', end: '2020-01-06T18:00:00.000Z' });
  assert.strictEqual(sched.canEditShift(past), true);
  const r = sched.validateShiftEdit(past, { start: '2020-01-06T18:00:00.000Z', end: '2020-01-06T22:00:00.000Z' });
  assert.strictEqual(r.valid, true, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.changes.sort(), ['end', 'start']);
});

test('a CANCELLED shift is the one thing that cannot be edited', () => {
  assert.strictEqual(sched.canEditShift(shift({ status: 'cancelled' })), false);
  for (const status of ['open', 'claimed', 'assigned', 'confirmed', 'in_progress', 'completed']) {
    assert.strictEqual(sched.canEditShift(shift({ status })), true, `${status} must be editable`);
  }
});

test('an absent key means "leave this alone", so one field cannot blank another', () => {
  const s = shift({ notes: 'Front door code 4821', care_tier: 'A2', pay_rate: 22 });
  const r = sched.validateShiftEdit(s, { start: '2026-10-01T14:00:00.000Z' });
  assert.deepStrictEqual(r.changes, ['start']);
  assert.strictEqual(r.clean.notes, undefined, 'notes were not in the body and must not be touched');
  assert.strictEqual(r.clean.careTier, undefined);
  assert.strictEqual(r.clean.payRate, undefined);
});

test('a key present and empty CLEARS, which is a different act from omitting it', () => {
  const s = shift({ notes: 'Front door code 4821' });
  const r = sched.validateShiftEdit(s, { notes: '' });
  assert.deepStrictEqual(r.changes, ['notes']);
  assert.strictEqual(r.clean.notes, '');
});

test('only the start moving is still checked against the existing end', () => {
  const s = shift();   // 13:00 → 17:00
  const bad = sched.validateShiftEdit(s, { start: '2026-10-01T18:00:00.000Z' });
  assert.strictEqual(bad.valid, false);
  assert.ok(bad.errors.some(e => e.code === 'END_BEFORE_START'),
    'a start pushed past the stored end must be refused, not stored');
});

test('the client and the status are refused by name, not silently dropped', () => {
  const r = sched.validateShiftEdit(shift(), { clientId: 'client-2', status: 'confirmed' });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.code === 'CLIENT_NOT_EDITABLE'));
  assert.ok(r.errors.some(e => e.code === 'STATUS_NOT_EDITABLE'));
  // "Cancel and post a new one" is actionable; "unknown field" is not.
  assert.ok(r.errors.find(e => e.code === 'CLIENT_NOT_EDITABLE').message.includes('Cancel it'));
});

test('a shift longer than 24 hours is refused on edit as it is on posting', () => {
  const r = sched.validateShiftEdit(shift(), { end: '2026-10-03T17:00:00.000Z' });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.code === 'SHIFT_TOO_LONG'));
});

test('resaving the same values is not a change', () => {
  const s = shift({ notes: 'Code 4821', pay_rate: 22, required_license_level: 'cna' });
  const r = sched.validateShiftEdit(s, {
    start: s.start, end: s.end, notes: 'Code 4821', payRate: '22',
    requiredLicenseLevel: 'cna', poolVisibility: 'all_eligible'
  });
  assert.strictEqual(r.valid, true);
  assert.deepStrictEqual(r.changes, [], 'an idempotent save must not report an edit or email anybody');
});

test('"any" and a blank level are ONE stored shape, so a no-op is seen as one', () => {
  const open = shift({ required_license_level: null });
  assert.deepStrictEqual(sched.validateShiftEdit(open, { requiredLicenseLevel: 'any' }).changes, []);
  const bad = sched.validateShiftEdit(open, { requiredLicenseLevel: 'anyone' });
  assert.strictEqual(bad.valid, false);
  assert.ok(bad.errors.some(e => e.code === 'LICENSE_LEVEL_INVALID'));
});

// ============================================================================
// 2. The time log follows, and only the derived flags move
// ============================================================================

test('a flag derived from the WRONG schedule is re-derived; an observation is not', () => {
  // Posted 9am by mistake; the visit was always 1pm and the caregiver arrived
  // at 1pm, carrying a four-hour "late" mark they did not earn.
  const log = {
    clock_in_at: '2026-10-01T17:00:00.000Z', clock_out_at: '2026-10-01T21:00:00.000Z',
    flags: ['late_clock_in', 'outside_geofence', 'manual_entry']
  };
  const corrected = { start: '2026-10-01T17:00:00.000Z', end: '2026-10-01T21:00:00.000Z' };
  const next = sched.rederiveScheduleFlags(log, corrected);
  assert.ok(!next.includes('late_clock_in'), 'the late mark was measured against a time that was wrong');
  assert.ok(next.includes('outside_geofence'), 'where somebody stood is not a function of the calendar');
  assert.ok(next.includes('manual_entry'), 'and neither is who attested the hours');
});

test('re-deriving ADDS a flag that is genuinely earned', () => {
  const log = { clock_in_at: '2026-10-01T18:30:00.000Z', clock_out_at: '2026-10-01T19:00:00.000Z', flags: [] };
  const next = sched.rederiveScheduleFlags(log, { start: '2026-10-01T13:00:00.000Z', end: '2026-10-01T21:00:00.000Z' });
  assert.ok(next.includes('late_clock_in'));
  assert.ok(next.includes('early_clock_out'));
});

test('the 10-minute grace survives the re-derivation', () => {
  const log = { clock_in_at: '2026-10-01T13:09:00.000Z', clock_out_at: '2026-10-01T17:05:00.000Z', flags: [] };
  assert.deepStrictEqual(sched.rederiveScheduleFlags(log, shift()), []);
});

test('an open visit re-derives its clock-in flag and invents no clock-out one', () => {
  const log = { clock_in_at: '2026-10-01T13:00:00.000Z', clock_out_at: null, flags: ['no_clock_out'] };
  const next = sched.rederiveScheduleFlags(log, shift());
  assert.deepStrictEqual(next, ['no_clock_out']);
});

// ============================================================================
// 3. Bulk posting keeps the practice clock
// ============================================================================

test('a range spanning the November clock change stays 9am throughout', () => {
  const r = sched.expandRecurrence({
    startDate: '2026-10-26', endDate: '2026-11-06',
    daysOfWeek: ['Mon', 'Wed', 'Fri'], startTime: '09:00', endTime: '13:00'
  });
  assert.strictEqual(r.valid, true, JSON.stringify(r.errors));
  assert.strictEqual(r.occurrences.length, 6);
  r.occurrences.forEach(o => {
    const p = gfcTime.zonedParts(o.start);
    assert.strictEqual(p.hour, 9, `${o.date} must start at 9am in Georgia, got ${p.hour}`);
    assert.strictEqual(gfcTime.zonedParts(o.end).hour, 13);
  });
  // And the stored instants differ by the hour the clock moved — which is the
  // whole proof that adding 7 days to an instant would have been wrong.
  assert.strictEqual(r.occurrences[2].start, '2026-10-30T13:00:00.000Z');
  assert.strictEqual(r.occurrences[3].start, '2026-11-02T14:00:00.000Z');
});

test('an overnight pattern ends on the next calendar day', () => {
  const r = sched.expandRecurrence({
    startDate: '2026-10-26', endDate: '2026-10-26',
    daysOfWeek: ['Mon'], startTime: '22:00', endTime: '06:00'
  });
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.overnight, true);
  assert.strictEqual(gfcTime.zonedParts(r.occurrences[0].end).isoDate, '2026-10-27');
  assert.ok(new Date(r.occurrences[0].end) > new Date(r.occurrences[0].start));
});

test('a range that matches no day says so rather than posting nothing quietly', () => {
  const r = sched.expandRecurrence({
    startDate: '2026-10-26', endDate: '2026-10-27',
    daysOfWeek: ['Sat'], startTime: '09:00', endTime: '13:00'
  });
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.errors[0].code, 'NO_OCCURRENCES');
});

test('an absurd range is refused, not expanded into a thousand rows', () => {
  const r = sched.expandRecurrence({
    startDate: '2026-01-01', endDate: '2027-12-31',
    daysOfWeek: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], startTime: '09:00', endTime: '13:00'
  });
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.errors[0].code, 'TOO_MANY_OCCURRENCES');
  assert.deepStrictEqual(r.occurrences, [], 'nothing is handed back to be written');
});

test('a bad day name is named; a backwards range is refused', () => {
  const bad = sched.expandRecurrence({
    startDate: '2026-10-01', endDate: '2026-10-30',
    daysOfWeek: ['Funday'], startTime: '09:00', endTime: '13:00'
  });
  assert.ok(bad.errors.some(e => e.code === 'DAY_INVALID'));
  const back = sched.expandRecurrence({
    startDate: '2026-10-30', endDate: '2026-10-01',
    daysOfWeek: ['Mon'], startTime: '09:00', endTime: '13:00'
  });
  assert.ok(back.errors.some(e => e.code === 'DATE_RANGE_BACKWARDS'));
});

test('day names are accepted however they are spelled, and deduped', () => {
  const r = sched.expandRecurrence({
    startDate: '2026-10-05', endDate: '2026-10-05',
    daysOfWeek: ['monday', 'Mon', 'MONDAY'], startTime: '09:00', endTime: '13:00'
  });
  assert.strictEqual(r.occurrences.length, 1, 'one Monday is one shift');
});

// ============================================================================
// 4. Removing in bulk
// ============================================================================

test('a shift nobody ever held is deletable; anything else is not', () => {
  assert.strictEqual(sched.isNeverHeld(shift(), []), true);
  assert.strictEqual(sched.isNeverHeld(shift({ claimed_at: '2026-09-01T00:00:00Z' }), []), false);
  assert.strictEqual(sched.isNeverHeld(shift({ caregiver_id: 'cg-1' }), []), false);
  assert.strictEqual(sched.isNeverHeld(shift({ status: 'confirmed' }), []), false);
  assert.strictEqual(sched.isNeverHeld(shift({ status: 'completed' }), []), false);
  // Even an open shift that was released back to the pool has a time log
  // against it, and a row with hours behind it is never deleted.
  assert.strictEqual(sched.isNeverHeld(shift(), [{ shift_id: 'shift-1' }]), false);
});

test('a duplicate is the same client at the same time, and a cancelled row is not one', () => {
  const rows = [shift({ id: 'a' }), shift({ id: 'b', status: 'cancelled' })];
  assert.ok(sched.findDuplicateShift(rows, 'client-1', rows[0].start, rows[0].end));
  const onlyCancelled = [shift({ id: 'b', status: 'cancelled' })];
  assert.strictEqual(sched.findDuplicateShift(onlyCancelled, 'client-1', rows[0].start, rows[0].end), null,
    'reposting a shift that was called off is a real thing to do');
});

// ============================================================================
// 5. The routes — driven over real HTTP through the shipped router
// ============================================================================

const CLIENT = {
  id: 'client-1', name: 'Margaret Whitfield', role: 'client', email: 'm@test.local',
  enrollmentStatus: 'enrolled', careTier: 'A2',
  address: { line1: '12 Oak St', city: 'Marietta', state: 'GA', lat: 33.95, lng: -84.55 },
  careTeam: { primaryCaregiver: 'cna-1' }
};
const USERS = [
  { id: 'admin-1', name: 'GFC Admin', email: 'a@test.local', role: 'admin' },
  { id: 'mgr-1', name: 'Dana Manager', email: 'm2@test.local', role: 'user', isManager: true },
  { id: 'cna-1', name: 'Cam CNA', email: 'cna@test.local', role: 'vendor', licenseLevel: 'cna' },
  { id: 'pca-1', name: 'Pat PCA', email: 'pca@test.local', role: 'vendor', licenseLevel: 'pca' },
  { id: 'cm-1', name: 'Courtney Hale', email: 'cm@test.local', role: 'caseManager' },
  CLIENT
];

function harness(seed = {}, hooks = {}) {
  const store = new Map(Object.entries({ users: USERS, ...seed }));
  const db = {
    get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
    set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); }
  };
  const notifications = [];
  let who = 'admin-1';
  const router = require('../routes/scheduling')({
    db, config: require('../config'),
    logActivity: async (...a) => { if (hooks.onActivity) hooks.onActivity(...a); },
    queueNotification: async (type, id, email, name, tpl) => { notifications.push({ type, email, tpl }); },
    getUsers: async () => await db.get('users'),
    invalidateUsersCache: () => {},
    authenticateToken: (req, _res, next) => {
      const u = USERS.find(x => x.id === (req.headers['x-as'] || who));
      req.user = { ...u, isManager: !!u.isManager, hasClinicalAccess: !!u.hasClinicalAccess };
      next();
    },
    uuidv4: () => `id-${Math.random().toString(36).slice(2, 10)}`
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0);
  const port = server.address().port;
  const call = async (method, url, body, as) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(as ? { 'x-as': as } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* empty */ }
    return { status: res.status, body: json };
  };
  return { call, db, store, notifications, close: () => server.close() };
}

const POSTED = () => ({
  id: 'shift-1', client_id: 'client-1', client_name: 'Margaret Whitfield',
  caregiver_id: null, caregiver_name: null,
  start: '2099-10-01T13:00:00.000Z', end: '2099-10-01T17:00:00.000Z',
  required_license_level: null, pool_visibility: 'all_eligible',
  care_tier: 'A2', notes: '', pay_rate: null, status: 'open',
  created_by: 'admin-1', created_by_name: 'GFC Admin', created_at: '2026-09-01T00:00:00.000Z',
  claimed_at: null, assigned_at: null, confirmed_at: null,
  started_at: null, completed_at: null, cancelled_at: null, reopened_at: null
});

test('a MANAGER edits a posted shift; a caregiver and a case manager cannot', async () => {
  const h = harness({ shifts: [POSTED()] });
  try {
    const ok = await h.call('PUT', '/api/scheduling/shifts/shift-1',
      { start: '2099-10-01T15:00:00.000Z', end: '2099-10-01T19:00:00.000Z' }, 'mgr-1');
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const stored = (await h.db.get('shifts'))[0];
    assert.strictEqual(stored.start, '2099-10-01T15:00:00.000Z', 'read back out of the store, not off the response');
    assert.strictEqual(stored.edited_by_name, 'Dana Manager');
    assert.strictEqual(stored.edit_count, 1);

    for (const as of ['cna-1', 'cm-1']) {
      const no = await h.call('PUT', '/api/scheduling/shifts/shift-1',
        { start: '2099-10-02T15:00:00.000Z' }, as);
      assert.strictEqual(no.status, 403, `${as} must be refused`);
      assert.strictEqual(no.body.code, 'SCHEDULE_MANAGER_ONLY');
    }
    const after = (await h.db.get('shifts'))[0];
    assert.strictEqual(after.start, '2099-10-01T15:00:00.000Z', 'a refused edit writes nothing');
  } finally { h.close(); }
});

// REPOINTED 2026-09-20 on the owner's instruction: "make sure that old shifts
// edited also email the caregiver." This asserted the opposite — that a
// correction to last week was paperwork nobody needed telling about. The reason
// it was wrong is payroll: the time log's copy of the schedule moves with the
// shift, so correcting a past visit changes what that caregiver's timesheet
// says about a day they already worked.
test('editing a PAST shift emails the CAREGIVER, and not the client', async () => {
  const past = { ...POSTED(), status: 'completed', caregiver_id: 'cna-1', caregiver_name: 'Cam CNA',
    start: '2026-01-06T14:00:00.000Z', end: '2026-01-06T18:00:00.000Z' };
  const h = harness({ shifts: [past] });
  try {
    const res = await h.call('PUT', '/api/scheduling/shifts/shift-1',
      { start: '2026-01-06T18:00:00.000Z', end: '2026-01-06T22:00:00.000Z' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual((await h.db.get('shifts'))[0].start, '2026-01-06T18:00:00.000Z');

    const types = h.notifications.map(n => n.type);
    assert.deepStrictEqual(types, ['shift_time_changed'],
      'the caregiver whose timesheet just changed is told; the client is not');

    const body = h.notifications[0].tpl.body;
    // "Your shift has moved" is an instruction about where to be, and it is
    // nonsense about last Tuesday. A past shift says the RECORD was corrected.
    assert.ok(/corrected/i.test(body), `past wording expected, got: ${body}`);
    assert.ok(!/has moved/i.test(body), 'a past shift did not "move" anywhere');
    assert.ok(/clocked have not changed/i.test(body),
      'the question they will actually have is whether their pay changed');
    assert.ok(/record corrected/i.test(h.notifications[0].tpl.subject));
  } finally { h.close(); }
});

test('a past correction with NO caregiver on it emails nobody', async () => {
  const orphan = { ...POSTED(), status: 'cancelled' };
  const past = { ...POSTED(), id: 'shift-2', status: 'completed', caregiver_id: null, caregiver_name: null,
    start: '2026-01-06T14:00:00.000Z', end: '2026-01-06T18:00:00.000Z' };
  const h = harness({ shifts: [orphan, past] });
  try {
    const res = await h.call('PUT', '/api/scheduling/shifts/shift-2',
      { start: '2026-01-06T18:00:00.000Z', end: '2026-01-06T22:00:00.000Z' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(h.notifications.length, 0);
    assert.ok(/no caregiver is on this shift/i.test(res.body.message),
      'and the screen says WHY nobody was told, rather than staying silent');
  } finally { h.close(); }
});

test('the "previous time" in the email is the OLD time, not the new one', async () => {
  // `const before = rows[idx]` aliases the live row, which is mutated in place
  // a few lines later — so every "previously" line printed the NEW time and the
  // audit log's before/after read identical. It hid behind an assertion that
  // checked for the PHRASE rather than the value.
  const past = { ...POSTED(), status: 'completed', caregiver_id: 'cna-1', caregiver_name: 'Cam CNA',
    start: '2026-01-06T14:00:00.000Z', end: '2026-01-06T18:00:00.000Z' };
  const h = harness({ shifts: [past] });
  try {
    await h.call('PUT', '/api/scheduling/shifts/shift-1',
      { start: '2026-01-06T20:00:00.000Z', end: '2026-01-07T00:00:00.000Z' });
    const body = h.notifications[0].tpl.body;
    // 14:00Z is 9:00 AM in Georgia; 20:00Z is 3:00 PM. Both strings must be in
    // the message, and they must be different.
    assert.ok(/9:00\u202fAM|9:00 AM/.test(body), `the old time must appear: ${body}`);
    assert.ok(/3:00\u202fPM|3:00 PM/.test(body), `the new time must appear: ${body}`);
  } finally { h.close(); }
});

test('the audit log records the real before/after, not two copies of after', async () => {
  const logged = [];
  const past = { ...POSTED(), status: 'completed', caregiver_id: 'cna-1', caregiver_name: 'Cam CNA',
    start: '2026-01-06T14:00:00.000Z', end: '2026-01-06T18:00:00.000Z' };
  const h = harness({ shifts: [past] }, { onActivity: (...a) => logged.push(a) });
  try {
    // Both ends move: a start pushed past the stored end is refused, and a
    // refused edit audits nothing — which would make this test pass for the
    // wrong reason if the assertion below were any weaker.
    const res = await h.call('PUT', '/api/scheduling/shifts/shift-1',
      { start: '2026-01-06T20:00:00.000Z', end: '2026-01-07T00:00:00.000Z' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const entry = logged.find(a => a[2] === 'shift_edited');
    assert.ok(entry, 'the edit must be audited');
    const details = entry[5];
    assert.strictEqual(details.before.start, '2026-01-06T14:00:00.000Z');
    assert.strictEqual(details.after.start, '2026-01-06T20:00:00.000Z');
    assert.notStrictEqual(details.before.start, details.after.start,
      'an audit pair that reads identical records nothing');
  } finally { h.close(); }
});

test('moving a FUTURE shift tells the caregiver, and the client once confirmed', async () => {
  const booked = { ...POSTED(), status: 'confirmed', caregiver_id: 'cna-1', caregiver_name: 'Cam CNA' };
  const h = harness({ shifts: [booked] });
  try {
    const res = await h.call('PUT', '/api/scheduling/shifts/shift-1', { start: '2099-10-01T15:00:00.000Z' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const types = h.notifications.map(n => n.type).sort();
    assert.deepStrictEqual(types, ['shift_time_changed', 'shift_time_changed_client']);
    const toCaregiver = h.notifications.find(n => n.type === 'shift_time_changed');
    assert.ok(/previous time was/i.test(toCaregiver.tpl.body),
      'the old time is in the message — "your shift moved" without it is unusable');
    // The VALUE, not just the phrase. 13:00Z is 9:00 AM in Georgia and 15:00Z
    // is 11:00 AM; a message printing the new time twice says nothing.
    assert.ok(/9:00\u202fAM|9:00 AM/.test(toCaregiver.tpl.body),
      `the previous time must be the OLD one: ${toCaregiver.tpl.body}`);
  } finally { h.close(); }
});

test('changing only the NOTES emails nobody', async () => {
  const booked = { ...POSTED(), status: 'confirmed', caregiver_id: 'cna-1', caregiver_name: 'Cam CNA' };
  const h = harness({ shifts: [booked] });
  try {
    await h.call('PUT', '/api/scheduling/shifts/shift-1', { notes: 'Front door code 4821' });
    assert.strictEqual(h.notifications.length, 0);
    assert.strictEqual((await h.db.get('shifts'))[0].notes, 'Front door code 4821');
  } finally { h.close(); }
});

test('an edit that would push the holder out of scope is REFUSED, never a silent release', async () => {
  const held = { ...POSTED(), status: 'confirmed', caregiver_id: 'pca-1', caregiver_name: 'Pat PCA' };
  const h = harness({ shifts: [held] });
  try {
    const res = await h.call('PUT', '/api/scheduling/shifts/shift-1', { requiredLicenseLevel: 'lpn' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'SHIFT_HOLDER_INELIGIBLE');
    assert.ok(res.body.reason.includes('below'), 'the refusal says why');
    assert.ok(res.body.hint, 'and what to do instead');
    const stored = (await h.db.get('shifts'))[0];
    assert.strictEqual(stored.required_license_level, null, 'nothing was written');
    assert.strictEqual(stored.caregiver_id, 'pca-1', 'and nobody was released');
  } finally { h.close(); }
});

test('an edit into a time the holder already works is refused with the clash named', async () => {
  const a = { ...POSTED(), id: 'shift-1', status: 'confirmed', caregiver_id: 'cna-1', caregiver_name: 'Cam CNA' };
  const b = { ...POSTED(), id: 'shift-2', status: 'confirmed', caregiver_id: 'cna-1', caregiver_name: 'Cam CNA',
    start: '2099-10-02T13:00:00.000Z', end: '2099-10-02T17:00:00.000Z' };
  const h = harness({ shifts: [a, b] });
  try {
    const res = await h.call('PUT', '/api/scheduling/shifts/shift-1',
      { start: '2099-10-02T14:00:00.000Z', end: '2099-10-02T18:00:00.000Z' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'SHIFT_CONFLICT');
    assert.strictEqual(res.body.conflict.id, 'shift-2');
    assert.strictEqual((await h.db.get('shifts'))[0].start, '2099-10-01T13:00:00.000Z');
  } finally { h.close(); }
});

test('THE TIME LOG FOLLOWS THE SHIFT, and its derived flags with it', async () => {
  const worked = { ...POSTED(), status: 'completed', caregiver_id: 'cna-1', caregiver_name: 'Cam CNA',
    start: '2026-01-06T14:00:00.000Z', end: '2026-01-06T18:00:00.000Z' };
  const log = {
    id: 'log-1', shift_id: 'shift-1', caregiver_id: 'cna-1', client_id: 'client-1',
    scheduled_start: '2026-01-06T14:00:00.000Z', scheduled_end: '2026-01-06T18:00:00.000Z',
    clock_in_at: '2026-01-06T18:00:00.000Z', clock_out_at: '2026-01-06T22:00:00.000Z',
    total_minutes: 240, flags: ['late_clock_in', 'late_clock_out', 'outside_geofence']
  };
  const h = harness({ shifts: [worked], time_logs: [log] });
  try {
    const res = await h.call('PUT', '/api/scheduling/shifts/shift-1',
      { start: '2026-01-06T18:00:00.000Z', end: '2026-01-06T22:00:00.000Z' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.timeLogsUpdated, 1);
    const stored = (await h.db.get('time_logs'))[0];
    assert.strictEqual(stored.scheduled_start, '2026-01-06T18:00:00.000Z',
      'payroll reads the log, so a log left behind means the board and the timesheet disagree');
    assert.ok(!stored.flags.includes('late_clock_in'), 'the late mark was against a schedule that was wrong');
    assert.ok(!stored.flags.includes('late_clock_out'));
    assert.ok(stored.flags.includes('outside_geofence'), 'the geofence verdict is an observation and stands');
    assert.strictEqual(stored.total_minutes, 240, 'hours worked come from the clock, not the calendar');
    assert.ok(stored.schedule_corrected_by_name, 'and the log says who moved it');
  } finally { h.close(); }
});

test('a cancelled shift refuses the edit and says which state it is in', async () => {
  const h = harness({ shifts: [{ ...POSTED(), status: 'cancelled' }] });
  try {
    const res = await h.call('PUT', '/api/scheduling/shifts/shift-1', { notes: 'x' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'SHIFT_NOT_EDITABLE');
    assert.strictEqual(res.body.status, 'cancelled');
  } finally { h.close(); }
});

test('bulk posting writes the whole pattern and skips a duplicate', async () => {
  const h = harness({ shifts: [] });
  try {
    const res = await h.call('POST', '/api/scheduling/shifts/bulk', {
      clientId: 'client-1', startDate: '2099-10-05', endDate: '2099-10-16',
      daysOfWeek: ['Mon', 'Wed'], startTime: '09:00', endTime: '13:00',
      requiredLicenseLevel: 'any', poolVisibility: 'all_eligible'
    }, 'mgr-1');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const rows = await h.db.get('shifts');
    assert.strictEqual(rows.length, 4, 'two Mondays and two Wednesdays');
    rows.forEach(r => {
      assert.strictEqual(gfcTime.zonedParts(r.start).hour, 9);
      assert.strictEqual(r.status, 'open');
      assert.ok(r.bulk_batch_id, 'every row says which batch made it');
    });
    assert.strictEqual(new Set(rows.map(r => r.bulk_batch_id)).size, 1);

    // Clicking Post twice is the commonest way to get two of everything.
    const again = await h.call('POST', '/api/scheduling/shifts/bulk', {
      clientId: 'client-1', startDate: '2099-10-05', endDate: '2099-10-16',
      daysOfWeek: ['Mon', 'Wed'], startTime: '09:00', endTime: '13:00',
      requiredLicenseLevel: 'any', poolVisibility: 'all_eligible'
    }, 'mgr-1');
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.body.code, 'BULK_NOTHING_POSTED');
    assert.strictEqual(again.body.skipped.length, 4);
    assert.strictEqual((await h.db.get('shifts')).length, 4, 'and nothing was written the second time');
  } finally { h.close(); }
});

test('a bulk post to one caregiver sends ONE email, not one per shift', async () => {
  const h = harness({ shifts: [] });
  try {
    const res = await h.call('POST', '/api/scheduling/shifts/bulk', {
      clientId: 'client-1', startDate: '2099-10-05', endDate: '2099-10-30',
      daysOfWeek: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], startTime: '09:00', endTime: '13:00',
      requiredLicenseLevel: 'cna', assignToCaregiverId: 'cna-1'
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.created.length > 15);
    assert.strictEqual(h.notifications.length, 1, 'eighteen identical emails is a mailbox nobody reads');
    assert.ok(h.notifications[0].tpl.subject.includes('shifts'));
    (await h.db.get('shifts')).forEach(r => assert.strictEqual(r.status, 'assigned'));
  } finally { h.close(); }
});

test('a bulk template that is wrong writes NOTHING at all', async () => {
  const h = harness({ shifts: [] });
  try {
    const res = await h.call('POST', '/api/scheduling/shifts/bulk', {
      clientId: 'client-1', startDate: '2099-10-05', endDate: '2099-10-16',
      daysOfWeek: ['Mon'], startTime: '09:00', endTime: '13:00',
      requiredLicenseLevel: 'brain surgeon'
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'SHIFT_INVALID');
    assert.deepStrictEqual(await h.db.get('shifts'), [],
      'a refused template must leave no orphan rows behind');
  } finally { h.close(); }
});

test('bulk removal CANCELS what somebody held and DELETES only what nobody did', async () => {
  const open = { ...POSTED(), id: 's-open' };
  const held = { ...POSTED(), id: 's-held', status: 'confirmed', caregiver_id: 'cna-1', caregiver_name: 'Cam CNA' };
  const done = { ...POSTED(), id: 's-done', status: 'completed', caregiver_id: 'cna-1', caregiver_name: 'Cam CNA' };
  const h = harness({ shifts: [open, held, done] });
  try {
    const res = await h.call('POST', '/api/scheduling/shifts/bulk-remove',
      { shiftIds: ['s-open', 's-held', 's-done'], reason: 'Client went into hospital' }, 'mgr-1');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.deleted.map(d => d.shiftId), ['s-open']);
    assert.deepStrictEqual(res.body.cancelled.map(c => c.shiftId), ['s-held']);
    assert.deepStrictEqual(res.body.refused.map(r => r.shiftId), ['s-done'],
      'a completed visit is a record of care given and is never removed');

    const rows = await h.db.get('shifts');
    assert.deepStrictEqual(rows.map(r => r.id).sort(), ['s-done', 's-held']);
    const cancelled = rows.find(r => r.id === 's-held');
    assert.strictEqual(cancelled.status, 'cancelled');
    assert.strictEqual(cancelled.cancel_reason, 'Client went into hospital');
    assert.strictEqual(h.notifications.length, 1, 'the caregiver is told once, not once per shift');
  } finally { h.close(); }
});

test('bulk removal without a reason writes nothing', async () => {
  const h = harness({ shifts: [POSTED()] });
  try {
    const res = await h.call('POST', '/api/scheduling/shifts/bulk-remove', { shiftIds: ['shift-1'], reason: '  ' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'CANCEL_REASON_REQUIRED');
    assert.strictEqual((await h.db.get('shifts')).length, 1);
  } finally { h.close(); }
});

test('a manager reads the board and the roster; the money stays admin-only', async () => {
  const h = harness({ shifts: [POSTED()] });
  try {
    const board = await h.call('GET', '/api/scheduling/shifts', undefined, 'mgr-1');
    assert.strictEqual(board.status, 200);
    assert.strictEqual(board.body.shifts.length, 1);

    const roster = await h.call('GET', '/api/scheduling/caregivers', undefined, 'mgr-1');
    assert.strictEqual(roster.status, 200);
    // The page asks the SERVER what this viewer may do rather than reading a
    // role out of the browser.
    assert.strictEqual(roster.body.access.manageSchedule, true);
    assert.strictEqual(roster.body.access.managePay, false);
    assert.strictEqual(roster.body.access.manageLocations, false);
    assert.strictEqual(roster.body.access.canOverrideGates, false);

    for (const url of ['/api/scheduling/payroll.csv', '/api/scheduling/billing.csv']) {
      const res = await h.call('GET', url, undefined, 'mgr-1');
      assert.strictEqual(res.status, 403, `${url} must stay admin-only`);
    }
    const typed = await h.call('POST', '/api/scheduling/time-logs',
      { caregiverId: 'cna-1', clientId: 'client-1', clockInAt: '2026-01-01T14:00:00Z', reason: 'dead phone' }, 'mgr-1');
    assert.strictEqual(typed.status, 403, 'typing in hours is a payroll attestation');

    const admin = await h.call('GET', '/api/scheduling/caregivers', undefined, 'admin-1');
    assert.strictEqual(admin.body.access.managePay, true);
  } finally { h.close(); }
});

// ============================================================================
// 6. Build-enforced: the page, and the lines that are easy to lose
// ============================================================================

test('the calendar buckets by the day it is in GEORGIA, not the viewer\'s', () => {
  assert.ok(PAGE.includes('window.GFC_TIME.zonedParts(iso)'),
    'the day key must come from the practice clock');
  const cal = PAGE.slice(PAGE.indexOf('const ShiftCalendar'), PAGE.indexOf('const EditShift'));
  // An 8pm Tuesday shift is Wednesday in UTC and Monday nowhere — these two
  // accessors are exactly how the grid loses a day.
  assert.ok(!/\.getDate\(\)/.test(cal), 'getDate() is the device midnight, not Georgia\'s');
  assert.ok(!/new Date\([^)]*\)\.getDay\(\)/.test(cal.replace(/getUTCDay\(\)/g, '')),
    'the weekday of a real instant must come from zonedParts');
});

test('the edit form builds its times through the shared Eastern converter', () => {
  const editor = PAGE.slice(PAGE.indexOf('const EditShift'), PAGE.indexOf('const BulkPost'));
  assert.ok(editor.includes('window.GFC_TIME.instantFromZoned(date, start)'),
    'a date and a time from a form are Eastern wall clock, whatever zone the admin sits in');
  assert.ok(!/new Date\(`\$\{date\}T/.test(editor),
    'new Date("2026-11-01T09:00") reads the browser\'s zone — that is the bug this replaced');
});

test('the shared converter is exported and survives the clock change', () => {
  assert.strictEqual(typeof gfcTime.instantFromZoned, 'function');
  assert.strictEqual(gfcTime.instantFromZoned('2026-10-30', '09:00'), '2026-10-30T13:00:00.000Z');
  assert.strictEqual(gfcTime.instantFromZoned('2026-11-02', '09:00'), '2026-11-02T14:00:00.000Z');
  // Junk in is null out, never the epoch. `new Date(null)` is 31/12/1969, which
  // is worse than printing nothing — the trap the formatter hit on 2026-09-16.
  for (const bad of [[null, '09:00'], ['2026-13-01', '09:00'], ['2026-10-30', '25:00'], ['', '']]) {
    assert.strictEqual(gfcTime.instantFromZoned(bad[0], bad[1]), null, JSON.stringify(bad));
  }
});

test('the bulk expansion reads a bare calendar date in UTC, deliberately', () => {
  // A date string carries no zone. Reading "2026-10-26" in Eastern makes it the
  // evening of the 25th — a Sunday — and the whole pattern shifts by a day.
  const r = sched.expandRecurrence({
    startDate: '2026-10-26', endDate: '2026-10-26',
    daysOfWeek: ['Mon'], startTime: '09:00', endTime: '13:00'
  });
  assert.strictEqual(r.occurrences.length, 1, '2026-10-26 is a Monday');
  assert.strictEqual(r.occurrences[0].date, '2026-10-26');
});

test('an edit leaves a trace on the board, and the projection carries it', () => {
  assert.ok(/editedAt: r\.edited_at/.test(ROUTE_SRC), 'publicShift must project who edited it');
  assert.ok(/editedByName: r\.edited_by_name/.test(ROUTE_SRC));
  // A stamp only in the store is one nobody reads — the same correction the
  // enrollment override needed.
  assert.ok(PAGE.includes('s.editedByName'), 'and the board must show it');
});

test('the audit records WHICH fields moved and the times, never a client detail', () => {
  const route = ROUTE_SRC.slice(ROUTE_SRC.indexOf("router.put('/api/scheduling/shifts/:id'"),
    ROUTE_SRC.indexOf("router.post('/api/scheduling/shifts/bulk'"));
  assert.ok(route.includes("'shift_edited'"));
  assert.ok(route.includes('fields: changes'));
  assert.ok(!/client_name/.test(route.slice(route.indexOf('shift_edited'), route.indexOf('shift_edited') + 600)),
    'an audit trail is not a second copy of who the client is');
});

test('the client can never be moved between shifts from the editor', () => {
  assert.ok(!sched.SHIFT_EDITABLE_FIELDS.includes('clientId'));
  assert.ok(!sched.SHIFT_EDITABLE_FIELDS.includes('status'));
  assert.ok(!Object.keys(sched.SHIFT_EDIT_COLUMN).includes('clientId'));
  // Every editable field must map to a column, or an edit silently writes
  // `undefined` onto the row.
  sched.SHIFT_EDITABLE_FIELDS.forEach(k => {
    assert.ok(sched.SHIFT_EDIT_COLUMN[k], `${k} has no column to write to`);
  });
});
