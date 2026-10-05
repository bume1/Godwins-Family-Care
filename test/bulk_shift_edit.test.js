// ============================================================================
// Editing a batch of shifts (owner request, 2026-10-05)
//
// "Add the option to bulk delete or bulk edit shifts already released to the
//  pool."
//
// Bulk DELETE already existed (PR #104) and already handled a pool shift
// correctly, so this is the editing half. The rules that would break quietly
// and expensively if they regressed:
//
//   1. A batch takes a TIME OF DAY, never an absolute instant — one instant
//      would stack every selected shift on the same moment.
//   2. Each shift's own date is read in GEORGIA. A 9pm shift's UTC date is
//      tomorrow, so a UTC slice moves it to the wrong day.
//   3. The SPEC is all-or-nothing; the SHIFTS are not. A bad licence level
//      writes nothing; one clashing shift of forty must not refuse the rest.
//   4. ONE WRITER for a shift's time: the route loops `applyShiftEdit` and
//      writes nothing itself.
//   5. One email per person per CASE, not one per shift — and the three cases
//      (a future shift moved, an unanswered offer, a past record corrected)
//      are never flattened into one wrong sentence.
//   6. An absent key means "leave this alone".
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const bodyParser = require('body-parser');

const sched = require('../schedulingRepository');
const gfcTime = require('../public/gfc-time');

const ROUTE_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'scheduling.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'scheduling.html'), 'utf8');

// Comments are stripped before any source scan. A guard that reads its own
// explanation as code proves nothing — this repo has paid for that five times.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');
const CODE = stripComments(ROUTE_SRC);

// The slice of the route file that is the bulk-edit handler, anchored at both
// ends and loud if either anchor moves.
function bulkEditBody() {
  const open = CODE.indexOf("router.post('/api/scheduling/shifts/bulk-edit'");
  assert.ok(open > -1, 'the bulk-edit route must exist');
  const next = CODE.indexOf("router.", open + 50);
  assert.ok(next > open, 'could not find the end of the bulk-edit handler');
  return CODE.slice(open, next);
}

// ============================================================================
// 1. The batch spec
// ============================================================================

test('a batch refuses an absolute start or end BY NAME, never silently', () => {
  for (const key of ['start', 'end']) {
    const r = sched.validateBulkEdit({ [key]: '2026-10-04T01:00:00.000Z' });
    assert.strictEqual(r.valid, false);
    const codes = r.errors.map(e => e.code);
    assert.ok(codes.includes('ABSOLUTE_TIME_NOT_ALLOWED'),
      `${key} must be refused by name, got ${JSON.stringify(codes)}`);
    // The refusal has to say what to send instead, or somebody reads it as
    // "times cannot be changed in a batch".
    const msg = r.errors.find(e => e.code === 'ABSOLUTE_TIME_NOT_ALLOWED').message;
    assert.match(msg, /startTime|time of day/i, 'the refusal must name the shape that works');
  }
});

test('both ends of the time or neither — a batch holds shifts of different lengths', () => {
  for (const half of [{ startTime: '10:00' }, { endTime: '14:00' }]) {
    const r = sched.validateBulkEdit(half);
    assert.strictEqual(r.valid, false, JSON.stringify(half));
    assert.ok(r.errors.some(e => e.code === 'TIME_PAIR_REQUIRED'),
      'one end alone is ambiguous across a batch and must be refused');
  }
  assert.strictEqual(sched.validateBulkEdit({ startTime: '10:00', endTime: '14:00' }).valid, true);
});

test('an empty spec is refused — "update" with nothing to change is a mistake', () => {
  const r = sched.validateBulkEdit({});
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.code === 'NOTHING_TO_CHANGE'));
});

test('the client and the status are refused in a batch too, by name', () => {
  assert.ok(sched.validateBulkEdit({ clientId: 'c2' }).errors.some(e => e.code === 'CLIENT_NOT_EDITABLE'));
  assert.ok(sched.validateBulkEdit({ status: 'confirmed' }).errors.some(e => e.code === 'STATUS_NOT_EDITABLE'));
});

test('a malformed licence level or visibility is refused, and names what works', () => {
  const lvl = sched.validateBulkEdit({ requiredLicenseLevel: 'anyone' });
  assert.strictEqual(lvl.valid, false);
  assert.ok(lvl.errors.some(e => e.code === 'LICENSE_LEVEL_INVALID'));
  assert.match(lvl.errors.find(e => e.code === 'LICENSE_LEVEL_INVALID').message, /"any"/,
    'the refusal must name the token that opens a shift to everyone');
  assert.strictEqual(sched.validateBulkEdit({ poolVisibility: 'everyone' }).valid, false);
  assert.strictEqual(sched.validateBulkEdit({ poolVisibility: 'care_team' }).valid, true);
});

test('a bad time of day is refused rather than silently dropped', () => {
  const r = sched.validateBulkEdit({ startTime: '25:00', endTime: '14:00' });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.code === 'START_TIME_INVALID'));
});

// ============================================================================
// 2. Each shift's own date, in Georgia
// ============================================================================

const shift = (extra = {}) => ({
  id: 'shift-1', client_id: 'client-1', client_name: 'Margaret Whitfield', status: 'open',
  start: '2026-10-01T13:00:00.000Z', end: '2026-10-01T17:00:00.000Z',
  required_license_level: null, pool_visibility: 'all_eligible',
  care_tier: 'A2', notes: '', pay_rate: null, caregiver_id: null, ...extra
});

test('THE SHIFT KEEPS ITS OWN GEORGIA DATE — a UTC slice would move an evening shift a day', () => {
  // 9 PM Saturday 3 October in Georgia is already the 4th in UTC.
  const evening = shift({ start: '2026-10-04T01:00:00.000Z', end: '2026-10-04T06:00:00.000Z' });
  assert.strictEqual(evening.start.slice(0, 10), '2026-10-04',
    'precondition: the stored instant’s UTC date is the 4th');
  assert.strictEqual(gfcTime.zonedParts(evening.start).isoDate, '2026-10-03',
    'precondition: in Georgia it is still the 3rd');

  const body = sched.buildBulkEditBody(evening, { startTime: '10:00', endTime: '14:00' });
  assert.strictEqual(gfcTime.zonedParts(body.start).isoDate, '2026-10-03',
    'the new time must land on the shift’s own Georgia date, not its UTC one');
  assert.strictEqual(gfcTime.fmtTime(body.start), '10:00 AM');
  assert.strictEqual(gfcTime.fmtTime(body.end), '2:00 PM');
});

test('an overnight batch time ends on the NEXT day — 10pm to 6am is a real shift', () => {
  const body = sched.buildBulkEditBody(shift(), { startTime: '22:00', endTime: '06:00' });
  const sp = gfcTime.zonedParts(body.start);
  const ep = gfcTime.zonedParts(body.end);
  assert.strictEqual(sp.isoDate, '2026-10-01');
  assert.strictEqual(ep.isoDate, '2026-10-02', 'the end must roll to the next calendar day');
  assert.ok(new Date(body.end).getTime() > new Date(body.start).getTime());
});

test('each shift in a batch resolves against ITS OWN date, not the first one’s', () => {
  const days = ['2026-10-01T13:00:00.000Z', '2026-10-05T13:00:00.000Z', '2026-11-03T14:00:00.000Z'];
  const out = days.map(d => sched.buildBulkEditBody(shift({ start: d, end: d }), { startTime: '09:00', endTime: '13:00' }));
  assert.deepStrictEqual(out.map(o => gfcTime.zonedParts(o.start).isoDate),
    ['2026-10-01', '2026-10-05', '2026-11-03']);
  // AND the wall-clock hour survives the November change, which is the whole
  // reason this builds each instant from a calendar date rather than adding an
  // offset to the first one.
  assert.deepStrictEqual(out.map(o => gfcTime.fmtTime(o.start)), ['9:00 AM', '9:00 AM', '9:00 AM']);
});

test('an absent batch key is absent from the body — one field cannot blank another', () => {
  const s = shift({ notes: 'Front door code 4821', pay_rate: 22, care_tier: 'A2' });
  const body = sched.buildBulkEditBody(s, { requiredLicenseLevel: 'cna' });
  assert.deepStrictEqual(Object.keys(body), ['requiredLicenseLevel']);
  for (const k of ['notes', 'payRate', 'careTier', 'start', 'end']) {
    assert.ok(!(k in body), `${k} must not appear in the body when the batch did not name it`);
  }
  // And the single-shift validator, given that body, changes only the one.
  const r = sched.validateShiftEdit(s, body);
  assert.deepStrictEqual(r.changes, ['requiredLicenseLevel']);
});

test('a batch that names a field explicitly CAN clear it — blank is not absent', () => {
  const s = shift({ notes: 'old note' });
  const body = sched.buildBulkEditBody(s, { notes: '' });
  assert.ok('notes' in body);
  assert.deepStrictEqual(sched.validateShiftEdit(s, body).changes, ['notes']);
});

// ============================================================================
// 3. The route: one writer, per-shift outcomes, one email per person per case
// ============================================================================

function harness() {
  const store = new Map();
  const db = {
    get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
    set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); }
  };
  const notices = [];
  const activity = [];
  const users = [
    { id: 'mgr', email: 'manager@gfc.test', name: 'Office Manager', role: 'user', isManager: true },
    { id: 'cg1', email: 'cg1@gfc.test', name: 'Danielle Carter', role: 'vendor', licenseLevel: 'cna' },
    { id: 'cg2', email: 'cg2@gfc.test', name: 'Rosa Nunez', role: 'vendor', licenseLevel: 'lpn' },
    { id: 'client-1', email: 'family@gfc.test', name: 'Margaret Whitfield', role: 'client', enrollmentStatus: 'enrolled' },
    { id: 'cgonly', email: 'plain@gfc.test', name: 'Plain Caregiver', role: 'vendor', licenseLevel: 'cna' }
  ];
  const deps = {
    db,
    // The REAL config, not a thin fake. `isScheduleManager` reads
    // `config.ROLES.ADMIN`, and a harness missing what production supplies
    // exercises a different function — the shape that cost this repo the
    // cross-client leak, the Drive fake and actorFromReq.
    config: require('../config'),
    logActivity: async (userId, name, type, entity, entityId, meta) => {
      activity.push({ userId, name, type, entityId, meta });
    },
    queueNotification: async (type, rid, email, name, templateData, options) => {
      notices.push({ type, rid, email, name, templateData, options });
      return { id: `n${notices.length}` };
    },
    getUsers: async () => JSON.parse(JSON.stringify(users)),
    invalidateUsersCache: () => {},
    // `as` is set per-request by the caller below. Production's middleware
    // carries isManager and licenseLevel and the board's gate reads them, so a
    // harness missing them would exercise a different function.
    authenticateToken: (req, res, next) => {
      const u = users.find(x => x.id === req.headers['x-as']);
      if (!u) return res.status(401).json({ error: 'Access denied', code: 'AUTH_MISSING' });
      req.user = {
        id: u.id, email: u.email, name: u.name, role: u.role,
        isManager: u.isManager || false, hasClinicalAccess: u.hasClinicalAccess || false,
        licenseLevel: u.licenseLevel || null, assignedClients: u.assignedClients || [],
        careTeam: u.careTeam || null, familyOfClientId: u.familyOfClientId || null
      };
      next();
    },
    uuidv4: () => `id-${Math.random().toString(36).slice(2, 10)}`
  };
  const app = express();
  app.use(bodyParser.json({ limit: '5mb' }));
  app.use(require('../routes/scheduling')(deps));
  return { app, db, store, notices, activity, users };
}

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function post(port, urlPath, as, body) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-as': as },
    body: JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, body: json };
}

test('three shifts get the new hours, each on its own date, through the real route', async () => {
  const h = harness();
  await h.db.set('shifts', [
    shift({ id: 's1', start: '2026-10-01T13:00:00.000Z', end: '2026-10-01T17:00:00.000Z' }),
    shift({ id: 's2', start: '2026-10-05T13:00:00.000Z', end: '2026-10-05T17:00:00.000Z' }),
    // An evening shift whose UTC date is the NEXT day — the one a slice breaks.
    shift({ id: 's3', start: '2026-10-08T01:00:00.000Z', end: '2026-10-08T05:00:00.000Z' })
  ]);
  await h.db.set('time_logs', []);
  const { server, port } = await listen(h.app);
  try {
    const r = await post(port, '/api/scheduling/shifts/bulk-edit', 'mgr', {
      shiftIds: ['s1', 's2', 's3'], edit: { startTime: '10:00', endTime: '14:00' }
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.updated.length, 3, JSON.stringify(r.body));

    // STORED VALUES READ BACK, never a status code.
    const rows = await h.db.get('shifts');
    const byId = Object.fromEntries(rows.map(x => [x.id, x]));
    assert.deepStrictEqual(
      ['s1', 's2', 's3'].map(id => gfcTime.zonedParts(byId[id].start).isoDate),
      ['2026-10-01', '2026-10-05', '2026-10-07'],
      's3 was 9pm on the 7th in Georgia and must stay on the 7th'
    );
    for (const id of ['s1', 's2', 's3']) {
      assert.strictEqual(gfcTime.fmtTime(byId[id].start), '10:00 AM', id);
      assert.strictEqual(gfcTime.fmtTime(byId[id].end), '2:00 PM', id);
      assert.strictEqual(byId[id].edited_by_name, 'Office Manager', `${id} records who edited it`);
    }
  } finally { server.close(); }
});

test('ONE clashing shift is refused and the rest go through — the spec is all-or-nothing, the shifts are not', async () => {
  const h = harness();
  // cg1 holds s1 and, separately, a shift at the time s1 is being moved TO.
  await h.db.set('shifts', [
    shift({ id: 's1', status: 'confirmed', caregiver_id: 'cg1', caregiver_name: 'Danielle Carter',
      start: '2026-10-01T13:00:00.000Z', end: '2026-10-01T17:00:00.000Z' }),
    shift({ id: 'blocker', status: 'confirmed', caregiver_id: 'cg1', caregiver_name: 'Danielle Carter',
      client_id: 'client-9', client_name: 'Other Client',
      start: '2026-10-01T14:00:00.000Z', end: '2026-10-01T20:00:00.000Z' }),
    shift({ id: 's2', start: '2026-10-05T13:00:00.000Z', end: '2026-10-05T17:00:00.000Z' })
  ]);
  await h.db.set('time_logs', []);
  const { server, port } = await listen(h.app);
  try {
    const r = await post(port, '/api/scheduling/shifts/bulk-edit', 'mgr', {
      shiftIds: ['s1', 's2'], edit: { startTime: '10:00', endTime: '16:00' }
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.updated.length, 1, 's2 must still go through');
    assert.strictEqual(r.body.updated[0].shiftId, 's2');
    assert.strictEqual(r.body.refused.length, 1);
    assert.strictEqual(r.body.refused[0].shiftId, 's1');
    assert.strictEqual(r.body.refused[0].code, 'SHIFT_CONFLICT');
    // The refusal names the shift so somebody can act on it.
    assert.strictEqual(r.body.refused[0].clientName, 'Margaret Whitfield');

    const rows = await h.db.get('shifts');
    const s1 = rows.find(x => x.id === 's1');
    assert.strictEqual(s1.start, '2026-10-01T13:00:00.000Z', 'the refused shift must be untouched');
  } finally { server.close(); }
});

test('an edit that would release the holder is REFUSED with the next step, not applied', async () => {
  const h = harness();
  await h.db.set('shifts', [
    shift({ id: 's1', status: 'confirmed', caregiver_id: 'cg1', caregiver_name: 'Danielle Carter',
      required_license_level: 'cna' })
  ]);
  await h.db.set('time_logs', []);
  const { server, port } = await listen(h.app);
  try {
    // cg1 is a CNA; raising the bar to LPN would put the shift outside what
    // they may do.
    const r = await post(port, '/api/scheduling/shifts/bulk-edit', 'mgr', {
      shiftIds: ['s1'], edit: { requiredLicenseLevel: 'lpn' }
    });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'BULK_EDIT_NOTHING_CHANGED');
    assert.strictEqual(r.body.refused[0].code, 'SHIFT_HOLDER_INELIGIBLE');
    assert.ok(r.body.refused[0].hint, 'the editor’s own next step must survive into the batch result');
    const rows = await h.db.get('shifts');
    assert.strictEqual(rows[0].required_license_level, 'cna', 'nothing may be written');
  } finally { server.close(); }
});

test('a malformed spec writes NOTHING — the instruction itself is the mistake', async () => {
  const h = harness();
  await h.db.set('shifts', [shift({ id: 's1' }), shift({ id: 's2', start: '2026-10-05T13:00:00.000Z', end: '2026-10-05T17:00:00.000Z' })]);
  await h.db.set('time_logs', []);
  const { server, port } = await listen(h.app);
  try {
    const r = await post(port, '/api/scheduling/shifts/bulk-edit', 'mgr', {
      shiftIds: ['s1', 's2'], edit: { requiredLicenseLevel: 'anyone' }
    });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'BULK_EDIT_INVALID');
    const rows = await h.db.get('shifts');
    assert.ok(rows.every(x => !x.edited_at), 'not one shift may be touched');
  } finally { server.close(); }
});

test('ONE email per caregiver, not one per shift', async () => {
  const h = harness();
  const future = (d) => `2026-12-${d}T14:00:00.000Z`;
  await h.db.set('shifts', [1, 2, 3, 4].map(n => shift({
    id: `s${n}`, status: 'confirmed', caregiver_id: 'cg1', caregiver_name: 'Danielle Carter',
    start: future(`0${n}`), end: `2026-12-0${n}T18:00:00.000Z`
  })));
  await h.db.set('time_logs', []);
  const { server, port } = await listen(h.app);
  try {
    const r = await post(port, '/api/scheduling/shifts/bulk-edit', 'mgr', {
      shiftIds: ['s1', 's2', 's3', 's4'], edit: { startTime: '10:00', endTime: '14:00' }
    });
    assert.strictEqual(r.body.updated.length, 4, JSON.stringify(r.body));
    const toHolder = h.notices.filter(n => n.rid === 'cg1');
    assert.strictEqual(toHolder.length, 1,
      `four shifts, one decision, one email — got ${toHolder.length}`);
    assert.match(toHolder[0].templateData.subject, /4 shifts rescheduled/);
    // The schedule is the real answer; the email names the first and points there.
    assert.match(toHolder[0].templateData.body, /Open your schedule/i);
  } finally { server.close(); }
});

test('THE THREE CASES ARE NOT FLATTENED — a mixed batch gets the right sentence for each', async () => {
  const h = harness();
  await h.db.set('shifts', [
    // Future, confirmed: it has MOVED.
    shift({ id: 'future', status: 'confirmed', caregiver_id: 'cg1', caregiver_name: 'Danielle Carter',
      start: '2026-12-01T14:00:00.000Z', end: '2026-12-01T18:00:00.000Z' }),
    // An OFFER they have not answered: telling them it moved would say they are
    // committed to work they never accepted.
    shift({ id: 'offer', status: 'assigned', caregiver_id: 'cg1', caregiver_name: 'Danielle Carter',
      start: '2026-12-02T14:00:00.000Z', end: '2026-12-02T18:00:00.000Z' }),
    // Past: a RECORD CORRECTION, and the question is about their pay.
    shift({ id: 'past', status: 'completed', caregiver_id: 'cg1', caregiver_name: 'Danielle Carter',
      start: '2020-01-06T14:00:00.000Z', end: '2020-01-06T18:00:00.000Z' })
  ]);
  await h.db.set('time_logs', []);
  const { server, port } = await listen(h.app);
  try {
    const r = await post(port, '/api/scheduling/shifts/bulk-edit', 'mgr', {
      shiftIds: ['future', 'offer', 'past'], edit: { startTime: '10:00', endTime: '14:00' }
    });
    assert.strictEqual(r.body.updated.length, 3, JSON.stringify(r.body));
    const toHolder = h.notices.filter(n => n.rid === 'cg1');
    assert.strictEqual(toHolder.length, 3, 'three different cases need three sentences');
    const subjects = toHolder.map(n => n.templateData.subject).join(' | ');
    assert.match(subjects, /rescheduled/, 'the future shift has moved');
    assert.match(subjects, /offer/i, 'the offer still needs an answer');
    assert.match(subjects, /corrected/, 'the past shift is a record correction');

    const offerMail = toHolder.find(n => /offer/i.test(n.templateData.subject));
    assert.match(offerMail.templateData.body, /accept or decline/i,
      'an offer must still read as an offer');
    assert.ok(!/rescheduled/i.test(offerMail.templateData.body),
      'an unanswered offer must never be described as a shift that moved');

    const pastMail = toHolder.find(n => /corrected/.test(n.templateData.subject));
    assert.match(pastMail.templateData.body, /hours you clocked have not changed/i,
      'a past correction must answer the pay question');
  } finally { server.close(); }
});

test('two caregivers in one batch get one email each, and neither hears about the other', async () => {
  const h = harness();
  await h.db.set('shifts', [
    shift({ id: 'a1', status: 'confirmed', caregiver_id: 'cg1', caregiver_name: 'Danielle Carter',
      start: '2026-12-01T14:00:00.000Z', end: '2026-12-01T18:00:00.000Z' }),
    shift({ id: 'a2', status: 'confirmed', caregiver_id: 'cg1', caregiver_name: 'Danielle Carter',
      start: '2026-12-02T14:00:00.000Z', end: '2026-12-02T18:00:00.000Z' }),
    shift({ id: 'b1', status: 'confirmed', caregiver_id: 'cg2', caregiver_name: 'Rosa Nunez',
      start: '2026-12-03T14:00:00.000Z', end: '2026-12-03T18:00:00.000Z' })
  ]);
  await h.db.set('time_logs', []);
  const { server, port } = await listen(h.app);
  try {
    await post(port, '/api/scheduling/shifts/bulk-edit', 'mgr', {
      shiftIds: ['a1', 'a2', 'b1'], edit: { startTime: '10:00', endTime: '14:00' }
    });
    assert.strictEqual(h.notices.filter(n => n.rid === 'cg1').length, 1);
    assert.strictEqual(h.notices.filter(n => n.rid === 'cg2').length, 1);
    const rosa = h.notices.find(n => n.rid === 'cg2');
    assert.ok(!/Danielle/.test(JSON.stringify(rosa.templateData)),
      'one caregiver’s email must not name another');
  } finally { server.close(); }
});

test('an OPEN pool shift moves with nobody emailed — there is nobody on it', async () => {
  const h = harness();
  await h.db.set('shifts', [
    shift({ id: 'p1', status: 'open', start: '2026-12-01T14:00:00.000Z', end: '2026-12-01T18:00:00.000Z' }),
    shift({ id: 'p2', status: 'open', start: '2026-12-02T14:00:00.000Z', end: '2026-12-02T18:00:00.000Z' })
  ]);
  await h.db.set('time_logs', []);
  const { server, port } = await listen(h.app);
  try {
    const r = await post(port, '/api/scheduling/shifts/bulk-edit', 'mgr', {
      shiftIds: ['p1', 'p2'], edit: { startTime: '10:00', endTime: '14:00' }
    });
    assert.strictEqual(r.body.updated.length, 2, JSON.stringify(r.body));
    assert.strictEqual(r.body.notified, 0);
    assert.strictEqual(h.notices.length, 0, 'an open shift has no holder and no promised visit');
  } finally { server.close(); }
});

test('THE CLIENT hears only about visits still to come that they were promised', async () => {
  const h = harness();
  await h.db.set('shifts', [
    shift({ id: 'ahead', status: 'confirmed', caregiver_id: 'cg1', caregiver_name: 'Danielle Carter',
      start: '2026-12-01T14:00:00.000Z', end: '2026-12-01T18:00:00.000Z' }),
    // PAST AND STILL `confirmed` — a visit that happened and was never marked
    // completed, which is the ordinary state of last week's board. The status
    // filter alone cannot tell this from an upcoming visit, so without the
    // still-ahead check the client would be told it moved. A fixture whose
    // past shift was `completed` could not distinguish the two guards, and
    // this test passed under that mutation until it was rewritten.
    shift({ id: 'gone', status: 'confirmed', caregiver_id: 'cg1', caregiver_name: 'Danielle Carter',
      start: '2020-01-06T14:00:00.000Z', end: '2020-01-06T18:00:00.000Z' }),
    // Open: never promised to the client at all.
    shift({ id: 'open', status: 'open', start: '2026-12-05T14:00:00.000Z', end: '2026-12-05T18:00:00.000Z' })
  ]);
  await h.db.set('time_logs', []);
  const { server, port } = await listen(h.app);
  try {
    await post(port, '/api/scheduling/shifts/bulk-edit', 'mgr', {
      shiftIds: ['ahead', 'gone', 'open'], edit: { startTime: '10:00', endTime: '14:00' }
    });
    const toClient = h.notices.filter(n => n.rid === 'client-1');
    assert.strictEqual(toClient.length, 1, 'one notice about the one upcoming promised visit');
    assert.match(toClient[0].templateData.subject, /rescheduled/);
    assert.ok(!/2020/.test(toClient[0].templateData.body),
      'a client must never be told a visit that already happened has moved');
  } finally { server.close(); }
});

test('a shift already reading that way is "unchanged", not an error and not a second write', async () => {
  const h = harness();
  await h.db.set('shifts', [
    shift({ id: 's1', start: '2026-10-01T14:00:00.000Z', end: '2026-10-01T18:00:00.000Z' })
  ]);
  await h.db.set('time_logs', []);
  const { server, port } = await listen(h.app);
  try {
    // 10:00-14:00 Eastern on 1 October IS 14:00Z-18:00Z.
    const r = await post(port, '/api/scheduling/shifts/bulk-edit', 'mgr', {
      shiftIds: ['s1'], edit: { startTime: '10:00', endTime: '14:00' }
    });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'BULK_EDIT_NOTHING_CHANGED');
    assert.strictEqual(r.body.unchanged.length, 1);
    assert.strictEqual(h.notices.length, 0, 'nothing changed, so nobody is told');
  } finally { server.close(); }
});

test('THE TIME LOG FOLLOWS a batch edit, exactly as it follows a single one', async () => {
  const h = harness();
  await h.db.set('shifts', [
    shift({ id: 's1', status: 'completed', caregiver_id: 'cg1', caregiver_name: 'Danielle Carter',
      start: '2026-10-01T13:00:00.000Z', end: '2026-10-01T17:00:00.000Z' })
  ]);
  await h.db.set('time_logs', [{
    id: 'tl1', shift_id: 's1', caregiver_id: 'cg1', client_id: 'client-1',
    scheduled_start: '2026-10-01T13:00:00.000Z', scheduled_end: '2026-10-01T17:00:00.000Z',
    clock_in_at: '2026-10-01T14:00:00.000Z', clock_out_at: '2026-10-01T18:00:00.000Z',
    flags: ['late_clock_in'], geofence: { verdict: 'inside', distanceMeters: 12 }
  }]);
  const { server, port } = await listen(h.app);
  try {
    const r = await post(port, '/api/scheduling/shifts/bulk-edit', 'mgr', {
      shiftIds: ['s1'], edit: { startTime: '10:00', endTime: '14:00' }
    });
    assert.strictEqual(r.body.updated[0].timeLogsUpdated, 1, JSON.stringify(r.body));
    const logs = await h.db.get('time_logs');
    assert.strictEqual(logs[0].scheduled_start, (await h.db.get('shifts'))[0].start,
      'the log’s copy of the schedule must move with the shift');
    // The geofence is an OBSERVATION of where somebody stood and is never rewritten.
    assert.deepStrictEqual(logs[0].geofence, { verdict: 'inside', distanceMeters: 12 });
  } finally { server.close(); }
});

test('a caregiver cannot batch-edit the board', async () => {
  const h = harness();
  await h.db.set('shifts', [shift({ id: 's1' })]);
  await h.db.set('time_logs', []);
  const { server, port } = await listen(h.app);
  try {
    const r = await post(port, '/api/scheduling/shifts/bulk-edit', 'cgonly', {
      shiftIds: ['s1'], edit: { startTime: '10:00', endTime: '14:00' }
    });
    assert.ok(r.status === 403, `expected 403, got ${r.status} ${JSON.stringify(r.body)}`);
    const rows = await h.db.get('shifts');
    assert.ok(!rows[0].edited_at, 'nothing may be written');
  } finally { server.close(); }
});

test('an empty selection and an over-long one are both refused', async () => {
  const h = harness();
  await h.db.set('shifts', []);
  await h.db.set('time_logs', []);
  const { server, port } = await listen(h.app);
  try {
    const none = await post(port, '/api/scheduling/shifts/bulk-edit', 'mgr',
      { shiftIds: [], edit: { startTime: '10:00', endTime: '14:00' } });
    assert.strictEqual(none.body.code, 'NO_SHIFTS_SELECTED');
    const many = await post(port, '/api/scheduling/shifts/bulk-edit', 'mgr', {
      shiftIds: Array.from({ length: sched.MAX_BULK_OCCURRENCES + 1 }, (_, i) => `x${i}`),
      edit: { startTime: '10:00', endTime: '14:00' }
    });
    assert.strictEqual(many.body.code, 'TOO_MANY_SHIFTS');
  } finally { server.close(); }
});

test('the batch is recorded once in the activity log, with the fields and the count', async () => {
  const h = harness();
  await h.db.set('shifts', [
    shift({ id: 's1', start: '2026-12-01T14:00:00.000Z', end: '2026-12-01T18:00:00.000Z' }),
    shift({ id: 's2', start: '2026-12-02T14:00:00.000Z', end: '2026-12-02T18:00:00.000Z' })
  ]);
  await h.db.set('time_logs', []);
  const { server, port } = await listen(h.app);
  try {
    await post(port, '/api/scheduling/shifts/bulk-edit', 'mgr', {
      shiftIds: ['s1', 's2'], edit: { startTime: '10:00', endTime: '14:00' }
    });
    const batch = h.activity.filter(a => a.type === 'shifts_bulk_edited');
    assert.strictEqual(batch.length, 1, 'one row for the decision');
    assert.strictEqual(batch[0].meta.shiftCount, 2);
    assert.deepStrictEqual(batch[0].meta.fields.sort(), ['endTime', 'startTime']);
    // Each shift still gets its own per-shift row from the shared editor, so
    // the audit trail is not thinner for having been done in a batch.
    assert.strictEqual(h.activity.filter(a => a.type === 'shift_edited').length, 2);
  } finally { server.close(); }
});

// ============================================================================
// 4. Build enforcement — the rules a refactor could quietly undo
// ============================================================================

test('ONE WRITER: the batch route delegates to applyShiftEdit and writes no shift itself', () => {
  const body = bulkEditBody();
  assert.ok(/applyShiftEdit\(/.test(body), 'the batch must come through the shared editor');
  // A source scan cannot prove a line is REACHED, so this anchors on the shape
  // only an unconditional awaited statement has, the correction Session 4.11
  // recorded after two guards passed under `if (false)`.
  assert.ok(/\n\s*const result = await applyShiftEdit\(\{/.test(body),
    'the call must be an unconditional awaited statement, not one behind a condition');
  assert.ok(!/db\.set\(\s*['"]shifts['"]/.test(body),
    'the batch route must never write the shifts collection itself');
  assert.ok(!/db\.set\(\s*['"]time_logs['"]/.test(body),
    'the time log follows the shift inside the editor, not here');
});

test('SEQUENTIALLY, never in parallel — concurrent edits would drop each other’s writes', () => {
  const body = bulkEditBody();
  assert.ok(!/Promise\.all|Promise\.allSettled/.test(body),
    'applyShiftEdit read-modify-writes the whole blob; a parallel map silently loses rows');
  assert.ok(/for\s*\(const id of ids\)/.test(body), 'the loop must be a sequential for-of');
});

test('the batch route never restates the editor’s guards', () => {
  const body = bulkEditBody();
  for (const forbidden of ['isEligibleForShift', 'findShiftConflict', 'rederiveScheduleFlags', 'canEditShift']) {
    assert.ok(!body.includes(forbidden),
      `${forbidden} belongs to the shared editor; restating it is how the two start disagreeing`);
  }
});

test('deferNotice changes only whether an email is sent, never what is written', () => {
  const editor = CODE.slice(CODE.indexOf('async function applyShiftEdit'),
    CODE.indexOf("router.put('/api/scheduling/shifts/:id'"));
  assert.ok(editor.length > 500, 'could not slice the editor');
  const flag = editor.indexOf('const deferNotice');
  const write = editor.indexOf("await db.set('shifts', rows)");
  assert.ok(write > -1 && flag > -1, 'both the write and the flag must be present');
  assert.ok(write < flag,
    'the row, the time log and the audit entry are all written BEFORE the notice flag is read, '
    + 'so a deferred notice cannot change what is stored');
  assert.ok(/if \(timeMoved && !deferNotice\)/.test(editor),
    'the flag must gate only the notification block');
});

test('the batch route is behind the manager gate, like every other write on the board', () => {
  const decl = CODE.match(/router\.post\('\/api\/scheduling\/shifts\/bulk-edit',\s*([^)]*)\)/);
  assert.ok(decl, 'could not read the route declaration');
  assert.match(decl[1], /authenticateToken/);
  assert.match(decl[1], /requireScheduleManager/);
});

test('the page sends a time of day, never an absolute instant', () => {
  const page = stripComments(PAGE);
  const fn = page.slice(page.indexOf('const bulkEditApply'), page.indexOf('const editLog'));
  assert.ok(fn.length > 200, 'could not slice the page action');
  assert.ok(/edit\.startTime/.test(fn) && /edit\.endTime/.test(fn));
  assert.ok(!/edit\.start\s*=/.test(fn) && !/edit\.end\s*=/.test(fn),
    'the page must not send an absolute start or end');
  assert.ok(/bulk-edit/.test(fn), 'it must call the batch route');
});

test('the page sends only the boxes that were filled in', () => {
  const page = stripComments(PAGE);
  const fn = page.slice(page.indexOf('const bulkEditApply'), page.indexOf('const editLog'));
  // Every optional field is behind a truthiness check, so a blank box is
  // ABSENT from the body rather than clearing a value nobody meant to touch.
  for (const field of ['requiredLicenseLevel', 'poolVisibility']) {
    assert.ok(new RegExp(`if \\(bulkEdit\\.${field}\\) edit\\.${field}`).test(fn),
      `${field} must only be sent when it was actually chosen`);
  }
  assert.ok(/if \(bulkEdit\.payRate !== ''\) edit\.payRate/.test(fn),
    'a pay rate of 0 is a number somebody chose, so the check is against empty, not falsiness');
});

// REPOINTED, NOT DELETED (owner, 2026-10-05). This guard used to assert the
// mode switch between an "Edit together" panel and a "Take off the board"
// panel. The owner's instruction removed the switch — both acts belong in the
// one bar — so what the guard protects is unchanged and what it reads is not:
// the two acts must still be told apart, and now they are told apart by what
// each one ASKS FOR rather than by a mode somebody can misread.
test('both acts sit in one bar and are still told apart', () => {
  const page = stripComments(PAGE);
  assert.ok(!/selectAction/.test(page),
    'the mode switch is gone; a mode is not how these two are kept apart');
  assert.ok(/btn danger/.test(page) && /Reason — required to remove/.test(page),
    'removing keeps its own red button and its own required reason');
  assert.ok(/disabled=\{!removeReason\.trim\(\)/.test(page),
    'remove must not fire without a reason, which is what separates it from update');
  assert.ok(/time of day/.test(page),
    'the panel must say the times are a time of day, or somebody expects one instant');
});

test('the board filters by a Georgia date range and by status', () => {
  const page = stripComments(PAGE);
  const fn = page.slice(page.indexOf('const boardShifts = shifts.filter'),
    page.indexOf('const boardIds'));
  assert.ok(fn.length > 60 && fn.length < 900, 'the board filter moved; repoint this guard');
  assert.ok(/easternDayKey\(sh\.start\)/.test(fn),
    'the range must bucket by the day it is in GEORGIA — a UTC slice loses the evening shifts');
  assert.ok(/boardFrom/.test(fn) && /boardTo/.test(fn) && /statusFilter\.includes/.test(fn),
    'both ends of the range and the status filter answer one question, in one place');
  // The payroll range is a DIFFERENT range. Reusing it would mean narrowing the
  // board quietly changed what a payroll or billing export covers.
  assert.ok(!/\bfrom\b/.test(fn) && !/\bto\b/.test(fn),
    'the board filter must not read the payroll from/to');
  assert.ok(/exportCsv[\s\S]{0,400}payroll\.csv\?from=\$\{from\}&to=\$\{to\}/.test(page),
    'and the payroll export must still read its own range');
});

test('nothing the filter has hidden can be edited or removed', () => {
  const page = stripComments(PAGE);
  assert.ok(/const actOn = selected\.filter\(id => boardIds\.includes\(id\)\)/.test(page),
    'the acted-on set is the selection INTERSECTED with what is on screen');
  // Both handlers must send that set, never the raw selection: a tick that
  // survived the filter being narrowed is a shift nobody can see.
  for (const route of ['bulk-edit', 'bulk-remove']) {
    const i = page.indexOf(`/api/scheduling/shifts/${route}`);
    assert.ok(i > 0, `${route} call site missing`);
    const call = page.slice(i, i + 220);
    assert.ok(/shiftIds: actOn/.test(call), `${route} must post actOn, not selected`);
  }
  assert.ok(/Select all \{boardIds\.length\} shown/.test(page),
    'select-all takes what the board is showing, which is what makes the range the selector');
});

test('bulk REMOVAL still handles a pool shift as a deletion, not a tombstone', () => {
  // The half that already existed, pinned here because this session touched
  // its neighbour: a shift nobody ever held is a posting mistake, and forty
  // tombstones for a mistake nobody saw buries the cancellations that matter.
  const open = shift({ status: 'open' });
  assert.strictEqual(sched.isNeverHeld(open, []), true);
  assert.strictEqual(sched.isNeverHeld(shift({ status: 'open', claimed_at: 'x' }), []), false);
  assert.strictEqual(sched.isNeverHeld(open, [{ shift_id: 'shift-1' }]), false,
    'a shift with a time log against it was held, whatever its status says');
});
