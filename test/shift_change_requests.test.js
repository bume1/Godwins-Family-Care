// ============================================================================
// A caregiver asks for a shift to change (owner request, 2026-09-21)
//
// "Caregivers should be able to request adjustments in scheduled shift times in
//  the app, as well as update their availability."
//
// Before this a caregiver holding a CONFIRMED shift had no route at all — they
// could decline an offer they had not accepted, and after that the only lever
// was phoning the office, so the ask left no record. The rules that would break
// quietly and expensively if they regressed:
//
//   1. An ask writes NOTHING to the shift. A person answers it.
//   2. Approving a time change goes through the SAME editor a hand-typed
//      correction goes through — never its own write.
//   3. Only the holder may ask, and only about a shift they have accepted.
//   4. The notice minimum is enforced at the API, and the refusal hands over
//      the office number rather than being a dead end.
//   5. A stale ask — the shift moved since — is refused, never silently
//      applied to a different time.
//   6. A caregiver reads only their own requests and cannot widen that.
//   7. A decline requires a reason, and the caregiver is told it.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const sched = require('../schedulingRepository');
const { ORG } = require('../public/consent-text');

const ROUTE_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'scheduling.js'), 'utf8');
const COMPONENT_RAW = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'components', 'caregiver-schedule.js'), 'utf8');
// A SOURCE SCAN MUST STRIP COMMENTS BEFORE IT LOOKS. This file's own first
// draft asserted the phrase "waiting on the office" and passed under mutation,
// because the comment three lines above the markup explains what the markup
// does and contains the same words. A guard that cannot tell live code from
// prose about that code proves nothing — the house rule, walked into again.
const CODE = (src) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const COMPONENT = CODE(COMPONENT_RAW);
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'scheduling.html'), 'utf8');

const CLIENT = {
  id: 'client-1', name: 'Margaret Whitfield', role: 'client', email: 'c@test.local',
  enrollmentStatus: 'enrolled', careTeam: {}
};
const USERS = [
  { id: 'admin-1', name: 'GFC Admin', email: 'a@test.local', role: 'admin' },
  { id: 'mgr-1', name: 'Dana Manager', email: 'm2@test.local', role: 'user', isManager: true },
  { id: 'cna-1', name: 'Cam CNA', email: 'cna@test.local', role: 'vendor', licenseLevel: 'cna' },
  { id: 'cna-2', name: 'Chris CNA', email: 'cna2@test.local', role: 'vendor', licenseLevel: 'cna' },
  { id: 'cm-1', name: 'Courtney Hale', email: 'cm@test.local', role: 'caseManager' },
  CLIENT
];

// Far enough out to clear the notice minimum in every case but the ones that
// deliberately do not.
const hoursOut = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

const CONFIRMED = (extra = {}) => ({
  id: 'shift-1', client_id: 'client-1', client_name: 'Margaret Whitfield',
  caregiver_id: 'cna-1', caregiver_name: 'Cam CNA',
  start: hoursOut(72), end: hoursOut(76),
  required_license_level: null, pool_visibility: 'all_eligible',
  care_tier: 'A2', notes: '', pay_rate: null, status: 'confirmed',
  created_by: 'admin-1', created_by_name: 'GFC Admin', created_at: '2026-09-01T00:00:00.000Z',
  claimed_at: null, assigned_at: null, confirmed_at: '2026-09-02T00:00:00.000Z',
  started_at: null, completed_at: null, cancelled_at: null, reopened_at: null, ...extra
});

function harness(seed = {}, hooks = {}) {
  const store = new Map(Object.entries({ users: USERS, ...seed }));
  const db = {
    get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
    set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); }
  };
  const notifications = [];
  const activity = [];
  const router = require('../routes/scheduling')({
    db, config: require('../config'),
    logActivity: async (...a) => { activity.push(a); if (hooks.onActivity) hooks.onActivity(...a); },
    queueNotification: async (type, id, email, name, tpl) => { notifications.push({ type, email, tpl }); },
    getUsers: async () => await db.get('users'),
    invalidateUsersCache: () => {},
    authenticateToken: (req, _res, next) => {
      const u = USERS.find(x => x.id === (req.headers['x-as'] || 'admin-1'));
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
  return { call, db, store, notifications, activity, close: () => server.close() };
}

const ask = (body, as = 'cna-1') => ['POST', '/api/scheduling/shifts/shift-1/change-request', body, as];

// ============================================================================
// 1. Who may ask, and about what
// ============================================================================

test('the caregiver holding a confirmed shift can ask to move it, and NOTHING moves', async () => {
  const h = harness({ shifts: [CONFIRMED()] });
  try {
    const before = (await h.db.get('shifts'))[0];
    const res = await h.call(...ask({
      kind: 'time_change', proposedStart: hoursOut(76), proposedEnd: hoursOut(80),
      reason: 'School run — I can start two hours later.'
    }));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.request.status, 'pending');
    assert.strictEqual(res.body.request.kind, 'time_change');

    // THE ASK WRITES NOTHING TO THE SHIFT. Read the stored row back, not the
    // response — the whole failure mode here is a request that quietly moves it.
    const after = (await h.db.get('shifts'))[0];
    assert.strictEqual(after.start, before.start, 'the shift must not have moved');
    assert.strictEqual(after.end, before.end);
    assert.strictEqual(after.caregiver_id, 'cna-1', 'and they must still hold it');

    const stored = (await h.db.get('shift_change_requests'))[0];
    assert.strictEqual(stored.caregiver_id, 'cna-1');
    assert.strictEqual(stored.reason, 'School run — I can start two hours later.');
    assert.strictEqual(stored.shift_start_at_request, before.start,
      'the shift as it was when they asked is snapshotted, for the stale check');
  } finally { h.close(); }
});

test('a caregiver cannot ask about somebody else\'s shift', async () => {
  const h = harness({ shifts: [CONFIRMED()] });
  try {
    const res = await h.call(...ask({ kind: 'drop', reason: 'nope' }, 'cna-2'));
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'SHIFT_NOT_YOURS');
    assert.strictEqual((await h.db.get('shift_change_requests')), null, 'and nothing is written');
  } finally { h.close(); }
});

// REPOINTED 2026-09-21 by owner decision, not deleted. This asserted that an
// offer was not requestable at all. The owner widened it: "the caregiver should
// be able to request time changes for shifts they haven't accepted, too." The
// rule underneath — there is exactly ONE way to hand a shift back, and it is
// Decline — did not go away, so that half is pinned here instead.
test('an OFFER takes a time change, but handing it back is still Decline', async () => {
  const offered = CONFIRMED({ status: 'assigned' });
  const h = harness({ shifts: [offered] });
  try {
    const dropped = await h.call(...ask({ kind: 'drop', reason: 'cannot make it' }));
    assert.strictEqual(dropped.status, 400, JSON.stringify(dropped.body));
    const err = dropped.body.errors.find(e => e.code === 'KIND_NOT_FOR_THIS_SHIFT');
    assert.ok(err, JSON.stringify(dropped.body));
    assert.match(err.message, /decline the offer/i,
      'the refusal must point at the route that does exist');
    assert.deepStrictEqual(err.options, ['time_change']);

    const timed = await h.call(...ask({
      kind: 'time_change', proposedStart: hoursOut(76), proposedEnd: hoursOut(80),
      reason: 'I could do it two hours later.'
    }));
    assert.strictEqual(timed.status, 200, JSON.stringify(timed.body));
    const shift = (await h.db.get('shifts'))[0];
    assert.strictEqual(shift.status, 'assigned', 'asking does not accept the offer');
    assert.strictEqual(shift.start, offered.start, 'nor move it');
  } finally { h.close(); }
});

test('APPROVING a time change on an offer confirms it — asking WAS the agreement', async () => {
  const newStart = hoursOut(76), newEnd = hoursOut(80);
  const h = harness({ shifts: [CONFIRMED({ status: 'assigned' })] });
  try {
    const made = await h.call(...ask({
      kind: 'time_change', proposedStart: newStart, proposedEnd: newEnd, reason: 'School run'
    }));
    const res = await h.call('POST', `/api/scheduling/change-requests/${made.body.request.id}/approve`, {}, 'mgr-1');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    const shift = (await h.db.get('shifts'))[0];
    assert.strictEqual(shift.start, newStart, 'the time moved');
    assert.strictEqual(shift.status, 'confirmed',
      'and it is CONFIRMED — the caregiver asked for this time, so they have agreed to it');
    assert.strictEqual(shift.caregiver_id, 'cna-1');
    assert.strictEqual(res.body.confirmed, true,
      'the office must be told it is staffed, not just "approved"');

    // One email, and it must not tell them to accept something already theirs.
    const told = h.notifications.filter(n => n.type === 'shift_time_changed');
    assert.strictEqual(told.length, 1);
    assert.match(told[0].tpl.body, /approved your request/i);
    assert.match(told[0].tpl.body, /confirmed and on your schedule/i);
    assert.ok(!/accept it or decline it/i.test(told[0].tpl.body),
      'it is theirs now — telling them to accept it again is the bug this rule exists to stop');
  } finally { h.close(); }
});

test('DECLINING a request on an offer leaves the original offer standing', async () => {
  const h = harness({ shifts: [CONFIRMED({ status: 'assigned' })] });
  try {
    const original = (await h.db.get('shifts'))[0];
    const made = await h.call(...ask({
      kind: 'time_change', proposedStart: hoursOut(76), proposedEnd: hoursOut(80), reason: 'School run'
    }));
    const res = await h.call('POST', `/api/scheduling/change-requests/${made.body.request.id}/decline`,
      { note: 'Margaret needs the morning slot.' }, 'mgr-1');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    const shift = (await h.db.get('shifts'))[0];
    assert.strictEqual(shift.start, original.start, 'the original duration stands');
    assert.strictEqual(shift.end, original.end);
    assert.strictEqual(shift.status, 'assigned', 'and it is still an offer awaiting their answer');

    const told = h.notifications.find(n => n.type === 'shift_change_declined');
    assert.ok(told);
    assert.match(told.tpl.body, /original offer stands/i);
    assert.ok(!/still yours/i.test(told.tpl.body),
      'an offer they never accepted is not "still yours"');
  } finally { h.close(); }
});

test('a confirmed shift stays confirmed — approving does not re-run the transition', async () => {
  const h = harness({ shifts: [CONFIRMED()] });
  try {
    const made = await h.call(...ask({
      kind: 'time_change', proposedStart: hoursOut(76), proposedEnd: hoursOut(80), reason: 'x'
    }));
    const res = await h.call('POST', `/api/scheduling/change-requests/${made.body.request.id}/approve`, {}, 'mgr-1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.confirmed, false, 'it was already confirmed; nothing to confirm');
    assert.strictEqual((await h.db.get('shifts'))[0].status, 'confirmed');
  } finally { h.close(); }
});

test('declining the OFFER closes a request about it — no unanswerable queue items', async () => {
  const h = harness({ shifts: [CONFIRMED({ status: 'assigned' })] });
  try {
    await h.call(...ask({
      kind: 'time_change', proposedStart: hoursOut(76), proposedEnd: hoursOut(80), reason: 'x'
    }));
    await h.call('POST', '/api/scheduling/shifts/shift-1/decline', { reason: 'cannot do it at all' }, 'cna-1');
    const stored = (await h.db.get('shift_change_requests'))[0];
    assert.strictEqual(stored.status, 'closed',
      'the person who asked is no longer on the shift, so the question lapsed');
    assert.strictEqual((await h.db.get('shifts'))[0].status, 'open');
  } finally { h.close(); }
});

test('a shift already under way or finished is not a schedule question any more', async () => {
  for (const status of ['in_progress', 'completed', 'cancelled', 'open']) {
    const h = harness({ shifts: [CONFIRMED({ status })] });
    try {
      const res = await h.call(...ask({ kind: 'drop', reason: 'x' }));
      assert.strictEqual(res.status === 200, false, `${status} must not be requestable`);
    } finally { h.close(); }
  }
});

// ============================================================================
// 2. The notice minimum, and not being a dead end
// ============================================================================

test('inside the notice window the ask is refused AND handed the office number', async () => {
  const h = harness({ shifts: [CONFIRMED({ start: hoursOut(3), end: hoursOut(7) })] });
  try {
    const res = await h.call(...ask({ kind: 'drop', reason: 'I am unwell' }));
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'CHANGE_REQUEST_TOO_LATE');
    // A DEAD END IS HOW A CONTROL GETS WORKED AROUND. There is still a real
    // problem to solve today, so the refusal must route them somewhere.
    assert.strictEqual(res.body.office, ORG.phone,
      'the refusal must carry the office number, and the same one the consents print');
    assert.match(res.body.error, /Call the office/);
    assert.ok(res.body.minutesOfNotice < sched.CHANGE_REQUEST_NOTICE_MINUTES);
    assert.strictEqual((await h.db.get('shift_change_requests')), null);
  } finally { h.close(); }
});

test('the notice minimum is ONE constant, and the screen reads it from the server', () => {
  assert.strictEqual(typeof sched.CHANGE_REQUEST_NOTICE_MINUTES, 'number');
  assert.ok(sched.CHANGE_REQUEST_NOTICE_MINUTES > 0);
  // The page must not restate the number: a screen that says "24 hours" while
  // the server enforces 48 is how somebody is refused for no visible reason.
  assert.ok(!/at least 24 hours/i.test(COMPONENT) || /noticeMinutes|NOTICE/i.test(COMPONENT),
    'the caregiver screen must take the window from the server, not hardcode it');
});

test('canRequestShiftChange answers the same question the route asks', () => {
  const ok = sched.canRequestShiftChange({ status: 'confirmed', start: hoursOut(72) });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(sched.canRequestShiftChange({ status: 'confirmed', start: hoursOut(1) }).code,
    'CHANGE_REQUEST_TOO_LATE');
  assert.strictEqual(sched.canRequestShiftChange({ status: 'confirmed', start: hoursOut(-1) }).code,
    'SHIFT_ALREADY_STARTED');
  // `new Date(null)` is the EPOCH and the epoch is finite — an empty clock
  // would read as 1970 and make every shift look decades out.
  assert.strictEqual(sched.canRequestShiftChange({ status: 'confirmed', start: hoursOut(72) }, null).code,
    'NOW_INVALID');
  assert.strictEqual(sched.canRequestShiftChange({ status: 'confirmed', start: hoursOut(72) }, '').code,
    'NOW_INVALID');
});

// ============================================================================
// 3. What a valid ask looks like
// ============================================================================

test('a reason is required on both kinds — "no reason" is not actionable', async () => {
  const h = harness({ shifts: [CONFIRMED()] });
  try {
    for (const body of [
      { kind: 'drop' },
      { kind: 'time_change', proposedStart: hoursOut(76), proposedEnd: hoursOut(80) }
    ]) {
      const res = await h.call(...ask(body));
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.ok(res.body.errors.some(e => e.code === 'REASON_REQUIRED'));
    }
    assert.strictEqual((await h.db.get('shift_change_requests')), null);
  } finally { h.close(); }
});

test('an ask for the time it already has is refused, not queued as a no-op', async () => {
  const s = CONFIRMED();
  const h = harness({ shifts: [s] });
  try {
    const res = await h.call(...ask({
      kind: 'time_change', proposedStart: s.start, proposedEnd: s.end, reason: 'same'
    }));
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.errors.some(e => e.code === 'NO_CHANGE_REQUESTED'));
  } finally { h.close(); }
});

test('an invented kind is refused by name, with what is on offer', async () => {
  const h = harness({ shifts: [CONFIRMED()] });
  try {
    const res = await h.call(...ask({ kind: 'swap_with_chris', reason: 'x' }));
    assert.strictEqual(res.status, 400);
    const err = res.body.errors.find(e => e.code === 'KIND_INVALID');
    assert.ok(err, JSON.stringify(res.body));
    assert.deepStrictEqual(err.options, sched.CHANGE_REQUEST_KINDS);
  } finally { h.close(); }
});

test('only ONE open request per shift — tapping Ask twice does not make two', async () => {
  const h = harness({ shifts: [CONFIRMED()] });
  try {
    const body = { kind: 'drop', reason: 'Family emergency' };
    const first = await h.call(...ask(body));
    assert.strictEqual(first.status, 200);
    const second = await h.call(...ask(body));
    assert.strictEqual(second.status, 409);
    assert.strictEqual(second.body.code, 'CHANGE_REQUEST_ALREADY_OPEN');
    assert.strictEqual((await h.db.get('shift_change_requests')).length, 1);
  } finally { h.close(); }
});

// ============================================================================
// 4. Approving — the part that must not grow a second writer
// ============================================================================

test('approving a time change moves the shift THROUGH the shared editor', async () => {
  const newStart = hoursOut(76), newEnd = hoursOut(80);
  const h = harness({ shifts: [CONFIRMED()] });
  try {
    const made = await h.call(...ask({ kind: 'time_change', proposedStart: newStart, proposedEnd: newEnd, reason: 'School run' }));
    const id = made.body.request.id;

    const res = await h.call('POST', `/api/scheduling/change-requests/${id}/approve`, {}, 'mgr-1');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    const shift = (await h.db.get('shifts'))[0];
    assert.strictEqual(shift.start, newStart, 'the shift actually moved');
    assert.strictEqual(shift.end, newEnd);
    assert.strictEqual(shift.caregiver_id, 'cna-1', 'and the caregiver kept it');
    // The shared editor stamps who edited and counts it — proof it went
    // through that path rather than a private write.
    assert.strictEqual(shift.edited_by_name, 'Dana Manager');
    assert.strictEqual(shift.edit_count, 1);

    const stored = (await h.db.get('shift_change_requests'))[0];
    assert.strictEqual(stored.status, 'approved');
    assert.strictEqual(stored.decided_by_name, 'Dana Manager');

    // The caregiver is told the time changed — by the shared editor, once.
    const told = h.notifications.filter(n => n.type === 'shift_time_changed');
    assert.strictEqual(told.length, 1, 'told exactly once, not twice');
    assert.strictEqual(told[0].email, 'cna@test.local');
  } finally { h.close(); }
});

test('approving a time change carries the time log with it, like any other edit', async () => {
  const s = CONFIRMED({ status: 'confirmed' });
  const log = {
    id: 'log-1', shift_id: 'shift-1', caregiver_id: 'cna-1', client_id: 'client-1',
    scheduled_start: s.start, scheduled_end: s.end, flags: ['outside_geofence']
  };
  const newStart = hoursOut(76), newEnd = hoursOut(80);
  const h = harness({ shifts: [s], time_logs: [log] });
  try {
    const made = await h.call(...ask({ kind: 'time_change', proposedStart: newStart, proposedEnd: newEnd, reason: 'x' }));
    const res = await h.call('POST', `/api/scheduling/change-requests/${made.body.request.id}/approve`, {}, 'mgr-1');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const stored = (await h.db.get('time_logs'))[0];
    assert.strictEqual(stored.scheduled_start, newStart,
      'the timesheet must not be left behind — two writers, one value');
    assert.ok(stored.flags.includes('outside_geofence'),
      'the geofence verdict is an observation and is never rewritten');
  } finally { h.close(); }
});

test('approving a DROP puts the shift back in the open pool and tells them', async () => {
  const h = harness({ shifts: [CONFIRMED()] });
  try {
    const made = await h.call(...ask({ kind: 'drop', reason: 'Hospital appointment came through' }));
    const res = await h.call('POST', `/api/scheduling/change-requests/${made.body.request.id}/approve`, {}, 'mgr-1');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    const shift = (await h.db.get('shifts'))[0];
    assert.strictEqual(shift.status, 'open');
    assert.strictEqual(shift.caregiver_id, null, 'they are off it');
    // WHO let it go is kept, or a shift that bounced three times looks like one
    // nobody ever touched.
    assert.strictEqual(shift.released_from_name, 'Cam CNA');
    assert.match(String(shift.released_reason), /Hospital appointment/);

    const told = h.notifications.filter(n => n.type === 'shift_change_approved');
    assert.strictEqual(told.length, 1);
    assert.strictEqual(told[0].email, 'cna@test.local');
  } finally { h.close(); }
});

test('a STALE ask — the shift moved since — is refused, never applied to a different time', async () => {
  const h = harness({ shifts: [CONFIRMED()] });
  try {
    const askedStart = hoursOut(76);
    const adminStart = hoursOut(90);
    const made = await h.call(...ask({
      kind: 'time_change', proposedStart: askedStart, proposedEnd: hoursOut(80), reason: 'School run'
    }));
    // An admin moves the shift in the meantime.
    const moved = await h.call('PUT', '/api/scheduling/shifts/shift-1',
      { start: adminStart, end: hoursOut(94) }, 'admin-1');
    assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));

    const res = await h.call('POST', `/api/scheduling/change-requests/${made.body.request.id}/approve`, {}, 'mgr-1');
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'SHIFT_MOVED_SINCE_REQUEST');
    const shift = (await h.db.get('shifts'))[0];
    // Asserted against the value the ADMIN set, captured before the call. An
    // earlier draft rebuilt the expected string out of the actual one to dodge
    // millisecond drift, which made it impossible for the assertion to fail.
    assert.strictEqual(shift.start, adminStart, 'the admin\'s time stands');
    assert.notStrictEqual(shift.start, askedStart, 'and the stale ask was not applied');
    assert.strictEqual((await h.db.get('shift_change_requests'))[0].status, 'pending',
      'and the request is still waiting, not marked approved against a change that did not happen');
  } finally { h.close(); }
});

test('a request the editor then REFUSES stays pending rather than reading as approved', async () => {
  // A second shift the caregiver already holds, overlapping the time they are
  // asking to move into. The shared editor refuses on conflict.
  const mine = CONFIRMED();
  const seededStart = mine.start;
  const other = CONFIRMED({ id: 'shift-2', start: hoursOut(76), end: hoursOut(81) });
  const h = harness({ shifts: [mine, other] });
  try {
    const made = await h.call(...ask({
      kind: 'time_change', proposedStart: hoursOut(77), proposedEnd: hoursOut(79), reason: 'x'
    }));
    const res = await h.call('POST', `/api/scheduling/change-requests/${made.body.request.id}/approve`, {}, 'mgr-1');
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'SHIFT_CONFLICT');
    assert.match(String(res.body.hint), /still waiting/);
    assert.strictEqual((await h.db.get('shift_change_requests'))[0].status, 'pending');
    // The shift is untouched — compared against the seeded row captured up
    // front, not against itself.
    assert.strictEqual((await h.db.get('shifts'))[0].start, seededStart,
      'a refused edit must leave the shift exactly where it was');
  } finally { h.close(); }
});

// ============================================================================
// 5. Declining, withdrawing, and who can see what
// ============================================================================

test('a decline REQUIRES a reason and the caregiver is told it', async () => {
  const h = harness({ shifts: [CONFIRMED()] });
  try {
    const made = await h.call(...ask({ kind: 'drop', reason: 'Family thing' }));
    const id = made.body.request.id;

    const bare = await h.call('POST', `/api/scheduling/change-requests/${id}/decline`, {}, 'mgr-1');
    assert.strictEqual(bare.status, 400);
    assert.strictEqual(bare.body.code, 'DECLINE_NOTE_REQUIRED');
    assert.strictEqual((await h.db.get('shift_change_requests'))[0].status, 'pending');

    const ok = await h.call('POST', `/api/scheduling/change-requests/${id}/decline`,
      { note: 'Nobody else is cleared for Margaret that day.' }, 'mgr-1');
    assert.strictEqual(ok.status, 200);
    const stored = (await h.db.get('shift_change_requests'))[0];
    assert.strictEqual(stored.status, 'declined');
    assert.strictEqual(stored.decision_note, 'Nobody else is cleared for Margaret that day.');
    // The shift is untouched and still theirs.
    assert.strictEqual((await h.db.get('shifts'))[0].caregiver_id, 'cna-1');

    const told = h.notifications.find(n => n.type === 'shift_change_declined');
    assert.ok(told, 'a caregiver told only "no" asks again or stops telling us');
    assert.match(told.tpl.body, /Nobody else is cleared/);
  } finally { h.close(); }
});

test('an answered request cannot be answered twice', async () => {
  const h = harness({ shifts: [CONFIRMED()] });
  try {
    const made = await h.call(...ask({ kind: 'drop', reason: 'x' }));
    const id = made.body.request.id;
    await h.call('POST', `/api/scheduling/change-requests/${id}/decline`, { note: 'no' }, 'mgr-1');
    const again = await h.call('POST', `/api/scheduling/change-requests/${id}/approve`, {}, 'mgr-1');
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.body.code, 'CHANGE_REQUEST_DECIDED');
    assert.strictEqual((await h.db.get('shifts'))[0].caregiver_id, 'cna-1', 'and nothing happened');
  } finally { h.close(); }
});

test('a caregiver withdraws their OWN request, and only their own', async () => {
  const h = harness({ shifts: [CONFIRMED()] });
  try {
    const made = await h.call(...ask({ kind: 'drop', reason: 'x' }));
    const id = made.body.request.id;

    const notYours = await h.call('POST', `/api/scheduling/change-requests/${id}/withdraw`, {}, 'cna-2');
    assert.strictEqual(notYours.status, 403);
    assert.strictEqual(notYours.body.code, 'REQUEST_NOT_YOURS');

    const ok = await h.call('POST', `/api/scheduling/change-requests/${id}/withdraw`, {}, 'cna-1');
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await h.db.get('shift_change_requests'))[0].status, 'withdrawn');
  } finally { h.close(); }
});

test('a caregiver reads only their OWN requests and cannot widen it', async () => {
  const mine = CONFIRMED();
  const theirs = CONFIRMED({ id: 'shift-2', caregiver_id: 'cna-2', caregiver_name: 'Chris CNA' });
  const h = harness({ shifts: [mine, theirs] });
  try {
    await h.call('POST', '/api/scheduling/shifts/shift-1/change-request', { kind: 'drop', reason: 'a' }, 'cna-1');
    await h.call('POST', '/api/scheduling/shifts/shift-2/change-request', { kind: 'drop', reason: 'b' }, 'cna-2');

    const mineRes = await h.call('GET', '/api/scheduling/change-requests', undefined, 'cna-1');
    assert.strictEqual(mineRes.status, 200);
    assert.strictEqual(mineRes.body.requests.length, 1);
    assert.strictEqual(mineRes.body.requests[0].caregiverId, 'cna-1');

    // The caregiverId filter is the MANAGER's. Passing somebody else's id must
    // still return your own rows, never widen the read.
    const widened = await h.call('GET', '/api/scheduling/change-requests?caregiverId=cna-2', undefined, 'cna-1');
    assert.strictEqual(widened.body.requests.length, 1);
    assert.strictEqual(widened.body.requests[0].caregiverId, 'cna-1');

    const mgr = await h.call('GET', '/api/scheduling/change-requests', undefined, 'mgr-1');
    assert.strictEqual(mgr.body.requests.length, 2, 'a manager sees the queue');
  } finally { h.close(); }
});

test('a caregiver cannot approve or decline — that is the office\'s call', async () => {
  const h = harness({ shifts: [CONFIRMED()] });
  try {
    const made = await h.call(...ask({ kind: 'drop', reason: 'x' }));
    const id = made.body.request.id;
    for (const [verb, body] of [['approve', {}], ['decline', { note: 'no' }]]) {
      const res = await h.call('POST', `/api/scheduling/change-requests/${id}/${verb}`, body, 'cna-1');
      assert.strictEqual(res.status, 403, `${verb} must be refused for a caregiver`);
    }
    assert.strictEqual((await h.db.get('shift_change_requests'))[0].status, 'pending');
    assert.strictEqual((await h.db.get('shifts'))[0].caregiver_id, 'cna-1');
  } finally { h.close(); }
});

test('a case manager reaches none of it', async () => {
  const h = harness({ shifts: [CONFIRMED()] });
  try {
    const list = await h.call('GET', '/api/scheduling/change-requests', undefined, 'cm-1');
    assert.strictEqual(list.status, 403);
    const asked = await h.call(...ask({ kind: 'drop', reason: 'x' }, 'cm-1'));
    assert.strictEqual(asked.status === 200, false);
  } finally { h.close(); }
});

// ============================================================================
// 6. The record
// ============================================================================

test('the audit names WHAT was asked, never the client\'s details', async () => {
  const h = harness({ shifts: [CONFIRMED()] });
  try {
    await h.call(...ask({ kind: 'drop', reason: 'Hospital appointment for my mother' }));
    const entry = h.activity.find(a => a[2] === 'shift_change_requested');
    assert.ok(entry, 'the ask is recorded');
    const meta = JSON.stringify(entry[5] || {});
    assert.match(meta, /"kind":"drop"/);
    // An audit trail is not a second copy of who the client is, nor of a
    // caregiver's private reason.
    assert.ok(!/Margaret/.test(meta), 'the client is named by id, not by name');
    assert.ok(!/Hospital appointment/.test(meta), 'the free-text reason stays on the row');
  } finally { h.close(); }
});

test('the collection is claimed in the registry, and claimed as PHI', () => {
  const reg = fs.readFileSync(path.join(__dirname, '..', 'dataMigration.js'), 'utf8');
  const line = reg.split('\n').find(l => l.includes("key: 'shift_change_requests'"));
  assert.ok(line, 'Session 5 fails the build on an unclaimed collection');
  assert.match(line, /phi:\s*true/, 'it names a client and carries free text about them');
});

// ============================================================================
// 7. The screens
// ============================================================================

test('the caregiver screen offers the ask only where the SERVER says it can', () => {
  // The app must never render a control the API is going to refuse: the
  // component reads `changeRequestable` off the shift rather than working out
  // the notice window for itself, which would drift from the constant.
  assert.ok(/s\.changeRequestable/.test(COMPONENT),
    'the ask button must be gated on the server\'s answer');
  assert.ok(!/24\s*\*\s*60|1440/.test(COMPONENT),
    'the component must not restate the notice minimum');
  // And where it cannot ask, the reason is shown rather than a dead disabled
  // button — that reason carries the office number for the one refusal a
  // caregiver can act on today.
  assert.ok(/changeRequestBlockedReason/.test(COMPONENT));
});

test('an ask already waiting is shown as a STATE, not a second button', () => {
  assert.ok(/openChangeRequest/.test(COMPONENT));
  // Asking twice is refused server-side; a caregiver who cannot see that they
  // already asked will ask again and be told no for no visible reason. Matched
  // against comment-stripped source, and on the MARKUP rather than the prose.
  assert.ok(/<span class="gchip">[\s\S]{0,200}waiting on the office/.test(COMPONENT),
    'the standing request must be rendered as a visible chip, not just tracked');
});

test('the caregiver can read the ANSWER, including why it was declined', () => {
  // DEFINED IS NOT RENDERED. The first version of this asserted the function
  // existed, so deleting the single call site left it green — the function sat
  // there rendering nothing. Assert the CALL.
  assert.ok(/\+ renderMyRequests\(state\)/.test(COMPONENT),
    'the requests list must actually be rendered, not merely defined');
  assert.ok(/function renderMyRequests/.test(COMPONENT));
  assert.ok(/decisionNote/.test(COMPONENT),
    'a caregiver told only "no" asks again, or stops telling us at all');
});

test('the caregiver form resolves its times through the shared Eastern clock', () => {
  // A `datetime-local` read with `new Date()` uses the DEVICE's zone, so a
  // phone set wrong would ask for a different hour than the one they typed.
  assert.ok(/instantFromZoned/.test(COMPONENT),
    'the proposed time must go through gfc-time, not new Date(value)');
  const sender = COMPONENT.slice(COMPONENT.indexOf('function sendChangeRequest'),
    COMPONENT.indexOf('function submitAvailability'));
  assert.ok(!/new Date\((?!\))/.test(sender.replace(/\/\/.*$/gm, '')),
    'the sender must not construct a Date from the raw input itself');
});

test('the office queue exists, and a decline there requires a reason', () => {
  assert.ok(PAGE.includes("id: 'changes'"), 'an owner item is only open once there is somewhere to do it');
  assert.ok(/change-requests\/\$\{r\.id\}\/approve/.test(PAGE));
  assert.ok(/change-requests\/\$\{r\.id\}\/decline/.test(PAGE));
  const panel = PAGE.slice(PAGE.indexOf("{tab === 'changes' &&"), PAGE.indexOf("{tab === 'time' &&"));
  assert.ok(/window\.prompt/.test(panel), 'the decline must collect the reason the API requires');
  assert.ok(/if \(note === null\) return;/.test(panel),
    'cancelling the prompt must not post an empty decline');
  // The server's own sentence on a refusal — a conflict and a stale request
  // need different answers, and "failed" sends the next person at the wrong
  // layer.
  assert.ok(/alert\(e\.message\)/.test(panel));
});

test('the queue is badged with what is actually waiting on somebody', () => {
  assert.ok(/changeRequests\.filter\(r => r\.status === 'pending'\)\.length/.test(PAGE),
    'a tab nobody looks at is a queue nobody works');
});

// ============================================================================
// 8. Availability is updatable, and which one is in force is not guesswork
// ============================================================================

test('the newest submission per caregiver is flagged in force, by the SERVER', async () => {
  const older = {
    id: 'av-1', caregiver_id: 'cna-1', caregiver_name: 'Cam CNA', effective_from: '2099-01-01',
    windows: [{ day: 'Mon', start: '09:00', end: '17:00' }], blackout_dates: [], note: '',
    status: 'reviewed', submitted_at: '2026-08-01T00:00:00.000Z'
  };
  const newer = { ...older, id: 'av-2', status: 'submitted', submitted_at: '2026-09-01T00:00:00.000Z' };
  const other = { ...older, id: 'av-3', caregiver_id: 'cna-2', caregiver_name: 'Chris CNA',
    submitted_at: '2026-07-01T00:00:00.000Z' };
  const h = harness({ caregiver_availability: [older, newer, other] });
  try {
    const res = await h.call('GET', '/api/scheduling/availability', undefined, 'mgr-1');
    assert.strictEqual(res.status, 200);
    const byId = Object.fromEntries(res.body.availability.map(a => [a.id, a]));
    assert.strictEqual(byId['av-2'].current, true, 'the newest is in force');
    assert.strictEqual(byId['av-1'].current, false, 'the older one is superseded, not deleted');
    // PER CAREGIVER, not globally — another caregiver's only submission is
    // theirs and is in force however old it is.
    assert.strictEqual(byId['av-3'].current, true);

    const mine = await h.call('GET', '/api/scheduling/availability', undefined, 'cna-1');
    assert.strictEqual(mine.body.availability.length, 2, 'a caregiver sees only their own');
    assert.strictEqual(mine.body.availability.find(a => a.id === 'av-2').current, true);
  } finally { h.close(); }
});

test('a resubmission supersedes rather than erases — the old one stays readable', async () => {
  const h = harness({});
  try {
    const far = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const body = { effectiveFrom: far, windows: [{ day: 'Mon', start: '09:00', end: '17:00' }], blackoutDates: [] };
    const first = await h.call('POST', '/api/scheduling/availability', body, 'cna-1');
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const second = await h.call('POST', '/api/scheduling/availability',
      { ...body, windows: [{ day: 'Tue', start: '10:00', end: '14:00' }] }, 'cna-1');
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));

    const rows = await h.db.get('caregiver_availability');
    assert.strictEqual(rows.length, 2, 'what they said in August is still on file');
    const list = await h.call('GET', '/api/scheduling/availability', undefined, 'cna-1');
    const inForce = list.body.availability.filter(a => a.current);
    assert.strictEqual(inForce.length, 1, 'exactly one is in force');
    assert.strictEqual(inForce[0].windows[0].day, 'Tue', 'and it is the newer one');
  } finally { h.close(); }
});

test('both screens say which availability is in force, rather than deriving it', () => {
  // Assert the LABELS render, not merely that the field is referenced. The
  // first version checked `a.current` appeared, which stayed true when the
  // "In force" branch was emptied out — the ternary still named the field
  // while the screen said nothing.
  for (const [label, src, who] of [
    ['caregiver app', COMPONENT, 'the caregiver'], ['office board', CODE(PAGE), 'the office']
  ]) {
    assert.ok(/In force/.test(src), `${label}: ${who} must be able to see which one is in force`);
    assert.ok(/Superseded/.test(src), `${label}: and which ones are not`);
    assert.ok(/a\.current/.test(src), `${label}: read from the server, not re-derived`);
  }
  // Neither may work it out for itself — two derivations of "the newest one"
  // is how a caregiver and the office end up looking at different rotas.
  assert.ok(!/submittedAt[\s\S]{0,80}sort/.test(COMPONENT),
    'the component must not re-sort to decide which is current');
});

test('the caregiver screen offers the ask on an OFFER, and only the kinds served', () => {
  const offers = COMPONENT.slice(COMPONENT.indexOf('function renderOffers'),
    COMPONENT.indexOf('function renderOpen'));
  assert.ok(/data-act="ask-change"/.test(offers),
    'an offer at the wrong time is where a change is cheapest to ask about');
  assert.ok(/s\.changeRequestable/.test(offers), 'and still gated on the server\'s answer');
  // The form must not restate the kind list: an offer takes a time change
  // only, and a page offering "I cannot work this" there would be refused.
  // The served list must be what the CONDITION tests, not merely a string that
  // appears somewhere. Replacing the condition with `false` left the name in
  // the untaken branch and the first version of this guard stayed green.
  assert.ok(/changeRequestKinds[\s\S]{0,40}\?/.test(COMPONENT),
    'the kinds must be served and actually drive the form, not hardcoded');
  assert.ok(/kinds\.map\(/.test(COMPONENT), 'and the options are rendered from them');
  const form = COMPONENT.slice(COMPONENT.indexOf('function askForm'),
    COMPONENT.indexOf('function renderOffers'));
  assert.ok(!/value="drop"/.test(form),
    'the page must not hardcode an option the server may not allow for this shift');
});

test('the form warns that asking IS agreeing, before they send it', () => {
  const form = COMPONENT.slice(COMPONENT.indexOf('function askForm'),
    COMPONENT.indexOf('function renderOffers'));
  // Approving puts the shift on their schedule with no second acceptance, so a
  // caregiver who meant "only if" has to know that before they ask.
  assert.ok(/goes on your schedule/.test(form), 'the consequence must be stated on the form');
  assert.ok(/original offer still stands/.test(form), 'and what a refusal means');
});

test('the office is told whether the shift is now STAFFED, not merely approved', () => {
  const APPROVE_DECL = "router.post('/api/scheduling/change-requests/:id/approve'";
  const at = ROUTE_SRC.indexOf(APPROVE_DECL);
  const body = ROUTE_SRC.slice(at, ROUTE_SRC.indexOf('router.post(', at + APPROVE_DECL.length));
  assert.ok(/confirmed: confirmedNow/.test(body),
    '"Approved" alone does not tell an office whether to keep chasing the shift');
  // And the confirm must go through the state machine, not a hand-written
  // status write, or a shift confirmed this way loses the stamps and the
  // client notification that Accept produces.
  assert.ok(/moveShift\(\{/.test(body), 'the confirm must use the shared transition');
  // Whitespace-tolerant: the first version of this matched only the spaced
  // form, so `rs[i].status='confirmed'` walked straight past it.
  assert.ok(!/\.status\s*=\s*['"]confirmed['"]/.test(body),
    'never a hand-written status write — it loses the stamps and the client email');
  assert.ok(/notifyConfirmed\(/.test(body), 'and the client is told, exactly as Accept tells them');
});

test('a failed confirm after a successful edit is reported, never called success', () => {
  const APPROVE_DECL = "router.post('/api/scheduling/change-requests/:id/approve'";
  const at = ROUTE_SRC.indexOf(APPROVE_DECL);
  const body = ROUTE_SRC.slice(at, ROUTE_SRC.indexOf('router.post(', at + APPROVE_DECL.length));
  assert.ok(/CHANGE_APPLIED_NOT_CONFIRMED/.test(body),
    'the time has already moved — silently returning 200 leaves an unconfirmed shift nobody is watching');
});

// ----------------------------------------------------------------------------
// A caregiver's "My hours" tab (owner report, 2026-09-21): an admin correction
// carried its `admin_edited` flag straight into the same red chip row as
// Outside Geofence and Late Clock In — a caregiver saw a different number and
// a warning that looked like their own fault, with no reason attached. The
// server already sends who corrected it, when, and why (publicTimeLog);
// nothing displayed it.
// ----------------------------------------------------------------------------
test('an admin correction is never rendered as a fault chip', () => {
  const fn = COMPONENT.slice(COMPONENT.indexOf('function renderTime(state)'),
    COMPONENT.indexOf('function bind(state, root)'));
  assert.ok(fn.length > 40, 'renderTime must be found');
  // The fault-chip loop must run over a list with admin_edited filtered out,
  // not the raw flags array — a mutation that drops the filter must fail this.
  assert.ok(/filter\(function \(f\) \{ return f !== 'admin_edited'; \}\)/.test(fn),
    'admin_edited must be stripped before the red-chip loop runs');
  const chipLoop = fn.slice(fn.indexOf('faultFlags.length'), fn.indexOf('l.edited'));
  assert.ok(chipLoop.includes('faultFlags.map'), 'the chip loop must iterate the filtered list, not l.flags directly');
  assert.ok(!/l\.flags\.map/.test(chipLoop), 'the raw flags array must not reach the chip loop');
});

test('a correction is shown neutrally, with who, when and why — never as a chip', () => {
  const fn = COMPONENT.slice(COMPONENT.indexOf('function renderTime(state)'),
    COMPONENT.indexOf('function bind(state, root)'));
  const note = fn.slice(fn.indexOf('l.edited'));
  assert.ok(/class="gwhy"/.test(note), 'a neutral style, not a chip — this is not a fault');
  assert.ok(!/gchip warn/.test(note), 'must not reuse the red fault-chip class');
  assert.ok(/Corrected by the office/.test(note));
  assert.ok(/l\.editedByName/.test(note), 'who made the correction');
  assert.ok(/fmtDate\(l\.editedAt\)/.test(note), 'and when — a date, not a bare timestamp');
  assert.ok(/l\.editReason/.test(note), 'and why — the field the server already sends and nothing showed');
});
