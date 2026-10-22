// Probe: the office ends or adjusts a visit that is UNDER WAY.
//
// Owner request, 2026-10-22: admin and manager need to be able to delete or
// adjust shifts that are in progress for caregivers.
//
// Driven through the REAL Express router over REAL HTTP against the shipped
// modules, asserting STORED VALUES READ BACK — never a status code. The whole
// risk in this change is a time log: a cancel that does not close the open
// clock leaves a caregiver unable to clock out for ever and their worked hours
// out of payroll, and a status code cannot tell you whether that happened.
//
// Run: node scripts/verify_end_visit.js
const express = require('express');
const bodyParser = require('body-parser');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const eq = (label, actual, expected) => ok(label, actual === expected, `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);

function harness() {
  const store = new Map();
  const db = {
    get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
    set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); }
  };
  const notices = [];
  const activity = [];
  const users = [
    { id: 'adm', email: 'admin@gfc.test', name: 'GFC Admin', role: 'admin' },
    { id: 'mgr', email: 'manager@gfc.test', name: 'Office Manager', role: 'user', isManager: true },
    { id: 'cg1', email: 'cg1@gfc.test', name: 'Danielle Carter', role: 'vendor', licenseLevel: 'cna' },
    { id: 'client-1', email: 'family@gfc.test', name: 'Margaret Whitfield', role: 'client', enrollmentStatus: 'enrolled' }
  ];
  const deps = {
    db,
    // THE REAL config, not a fake. A harness missing what production supplies
    // exercises a different function — the shape that cost this repo the
    // cross-client leak, the Drive fake and actorFromReq.
    config: require(path.join(ROOT, 'config')),
    logActivity: async (userId, name, type, entity, entityId, meta) => { activity.push({ userId, name, type, entity, entityId, meta }); },
    queueNotification: async (type, rid, email, name, templateData, options) => {
      notices.push({ type, rid, email, name, templateData, options }); return { id: `n${notices.length}` };
    },
    getUsers: async () => JSON.parse(JSON.stringify(users)),
    invalidateUsersCache: () => {},
    authenticateToken: (req, res, next) => {
      const u = users.find(x => x.id === req.headers['x-as']);
      if (!u) return res.status(401).json({ error: 'Access denied' });
      req.user = {
        id: u.id, email: u.email, name: u.name, role: u.role, isManager: u.isManager || false,
        hasClinicalAccess: false, licenseLevel: u.licenseLevel || null,
        assignedClients: [], careTeam: null, familyOfClientId: null
      };
      next();
    },
    uuidv4: () => `id-${Math.random().toString(36).slice(2, 10)}`
  };
  const app = express();
  app.use(bodyParser.json({ limit: '5mb' }));
  app.use(require(path.join(ROOT, 'routes/scheduling'))(deps));
  return { app, db, notices, activity };
}

const call = (app, method, url, body, as) => new Promise((resolve, reject) => {
  const srv = http.createServer(app).listen(0, () => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      port: srv.address().port, path: url, method,
      headers: Object.assign({ 'x-as': as || 'mgr' },
        data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {})
    }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { srv.close(); let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', (e) => { srv.close(); reject(e); });
    if (data) req.write(data); req.end();
  });
});

const MIN = 60 * 1000;

async function seedLiveVisit(h, { id = 's-live', documented = false, startedMinsAgo = 60 } = {}) {
  const startedAt = new Date(Date.now() - startedMinsAgo * MIN).toISOString();
  await h.db.set('users', [{
    id: 'client-1', name: 'Margaret Whitfield', role: 'client',
    enrollmentStatus: 'enrolled', address: { lat: 33.9, lng: -84.4 }
  }]);
  const existingShifts = (await h.db.get('shifts')) || [];
  await h.db.set('shifts', existingShifts.concat([{
    id, client_id: 'client-1', client_name: 'Margaret Whitfield', status: 'in_progress',
    start: new Date(Date.now() - (startedMinsAgo + 30) * MIN).toISOString(),
    end: new Date(Date.now() + 150 * MIN).toISOString(),
    required_license_level: 'cna', pool_visibility: 'all_eligible', care_tier: 'A2',
    notes: '', pay_rate: null, caregiver_id: 'cg1', caregiver_name: 'Danielle Carter',
    confirmed_at: startedAt, started_at: startedAt
  }]));
  const existingLogs = (await h.db.get('time_logs')) || [];
  await h.db.set('time_logs', existingLogs.concat([{
    id: `tl-${id}`, shift_id: id, caregiver_id: 'cg1', caregiver_name: 'Danielle Carter',
    client_id: 'client-1', clock_in_at: startedAt, clock_out_at: null,
    clock_in_gps: { lat: 33.9, lng: -84.4 }, total_minutes: null, flags: [],
    scheduled_start: new Date(Date.now() - (startedMinsAgo + 30) * MIN).toISOString(),
    scheduled_end: new Date(Date.now() + 150 * MIN).toISOString()
  }]));
  const vl = (await h.db.get('caregiver_visit_logs')) || [];
  await h.db.set('caregiver_visit_logs', documented
    ? vl.concat([{ id: `vl-${id}`, shift_id: id, caregiver_id: 'cg1', client_id: 'client-1', status: 'submitted' }])
    : vl);
  return startedAt;
}

(async () => {
  console.log('\n=== A. The gap this closes: a caregiver clocked in, nothing could take the shift off the board ===');
  {
    const h = harness();
    await seedLiveVisit(h);

    // A1 — ADJUSTING already worked before this change. Pinned so it is not lost.
    const edit = await call(h.app, 'PUT', '/api/scheduling/shifts/s-live',
      { end: new Date(Date.now() + 30 * MIN).toISOString() }, 'mgr');
    eq('A1 a manager can still adjust an in-progress shift', edit.status, 200);
    const afterEdit = await h.db.get('time_logs');
    ok('A2 the time log followed the corrected schedule', !!afterEdit[0].scheduled_end);
    eq('A3 the shift is still under way after an adjustment', (await h.db.get('shifts'))[0].status, 'in_progress');
  }

  console.log('\n=== B. The office ends a visit under way (single door) ===');
  {
    const h = harness();
    const startedAt = await seedLiveVisit(h, { startedMinsAgo: 95 });
    const res = await call(h.app, 'POST', '/api/scheduling/shifts/s-live/cancel',
      { reason: 'Client taken to hospital by family' }, 'mgr');
    eq('B1 the route accepts it (was 409 SHIFT_IN_PROGRESS before this change)', res.status, 200);

    const shift = (await h.db.get('shifts'))[0];
    eq('B2 the shift is cancelled', shift.status, 'cancelled');
    eq('B3 the reason is kept on the row', shift.cancel_reason, 'Client taken to hospital by family');
    ok('B4 it is a TOMBSTONE, not a delete — the row survives', !!shift.id);
    ok('B5 the caregiver is still named on it (who was there is a fact)', shift.caregiver_name === 'Danielle Carter');

    const log = (await h.db.get('time_logs'))[0];
    ok('B6 the clock is STOPPED — the log is not orphaned', !!log.clock_out_at);
    eq('B7 clock_in_at is untouched', log.clock_in_at, startedAt);
    ok('B8 the hours worked are recorded and reach payroll', typeof log.total_minutes === 'number' && log.total_minutes >= 94 && log.total_minutes <= 96,
      `total_minutes=${log.total_minutes}`);
    ok('B9 flagged ended_by_office, so payroll can tell it from a caregiver clock-out', (log.flags || []).includes('ended_by_office'));
    ok('B10 NO early_clock_out — the caregiver did not leave early, the office stopped the clock',
      !(log.flags || []).includes('early_clock_out'), JSON.stringify(log.flags));
    ok('B11 an undocumented visit is flagged for supervision', (log.flags || []).includes('no_visit_log'));
    eq('B12 who ended it is recorded', log.ended_by_office_name, 'Office Manager');
    ok('B13 when it was ended is recorded', !!log.ended_by_office_at);
    eq('B14 why it was ended is recorded', log.ended_by_office_reason, 'Client taken to hospital by family');
    ok('B15 no clock-out location is invented', log.clock_out_gps === null &&
      log.clock_out_geofence && log.clock_out_geofence.verdict === 'unverifiable');

    const notice = h.notices.find(n => n.options && String(n.options.relatedEntityId).endsWith(':office-ended'));
    ok('B16 the caregiver is told', !!notice && notice.email === 'cg1@gfc.test');
    ok('B17 the notice says their hours are kept', !!notice && /recorded and will be paid|hours are recorded/i.test(notice.templateData.body));
    ok('B18 the notice tells them not to clock out themselves', !!notice && /do not need to clock out/i.test(notice.templateData.body));
    ok('B19 the notice carries the reason', !!notice && notice.templateData.body.includes('hospital'));
    ok('B20 the response reports the hours kept', !!res.body && /hours/i.test(res.body.message || ''), JSON.stringify(res.body && res.body.message));
    ok('B21 the act is audited as its own kind of event',
      h.activity.some(a => a.type === 'time_log_ended_by_office'));
    const audit = h.activity.find(a => a.type === 'time_log_ended_by_office');
    ok('B22 the audit row carries the minutes and the flags', !!audit && typeof audit.meta.totalMinutes === 'number' && Array.isArray(audit.meta.flags));

    // B23 — the caregiver is NOT left stranded. Their clock-out would refuse
    // (the shift is cancelled), and that is fine ONLY because the log is
    // already closed. This is the exact failure the design exists to prevent.
    const stranded = await call(h.app, 'POST', '/api/scheduling/shifts/s-live/clock-out', { gps: { lat: 33.9, lng: -84.4 } }, 'cg1');
    eq('B23 the caregiver\'s own clock-out now refuses', stranded.status, 409);
    const stillClosed = (await h.db.get('time_logs'))[0];
    ok('B24 ...and that is harmless, because their clock was already stopped for them', !!stillClosed.clock_out_at);
    ok('B25 the refused clock-out did not disturb the closed log', stillClosed.total_minutes === log.total_minutes);
  }

  console.log('\n=== C. A DOCUMENTED visit ended by the office ===');
  {
    const h = harness();
    await seedLiveVisit(h, { documented: true });
    const res = await call(h.app, 'POST', '/api/scheduling/shifts/s-live/cancel', { reason: 'Caregiver sent home unwell' }, 'adm');
    eq('C1 admin can end it too', res.status, 200);
    const log = (await h.db.get('time_logs'))[0];
    ok('C2 still flagged ended_by_office', (log.flags || []).includes('ended_by_office'));
    ok('C3 NOT flagged no_visit_log — the visit WAS documented', !(log.flags || []).includes('no_visit_log'), JSON.stringify(log.flags));
  }

  console.log('\n=== D. Bulk remove ends an in-progress shift the same way ===');
  {
    const h = harness();
    await seedLiveVisit(h, { id: 's-live', startedMinsAgo: 45 });
    // A plain open shift alongside it, to prove the two outcomes stay distinct.
    const shifts = await h.db.get('shifts');
    shifts.push({
      id: 's-open', client_id: 'client-1', client_name: 'Margaret Whitfield', status: 'open',
      start: new Date(Date.now() + 3 * 24 * 60 * MIN).toISOString(),
      end: new Date(Date.now() + 3 * 24 * 60 * MIN + 240 * MIN).toISOString(),
      required_license_level: 'cna', pool_visibility: 'all_eligible', caregiver_id: null, caregiver_name: null
    });
    await h.db.set('shifts', shifts);

    const res = await call(h.app, 'POST', '/api/scheduling/shifts/bulk-remove',
      { shiftIds: ['s-live', 's-open'], reason: 'Client hospitalised' }, 'mgr');
    eq('D1 bulk remove accepts an in-progress shift', res.status, 200);
    eq('D2 the in-progress one is reported cancelled, not refused', (res.body.refused || []).length, 0);

    const live = (await h.db.get('shifts')).find(r => r.id === 's-live');
    ok('D3 the in-progress shift is cancelled, never deleted', !!live && live.status === 'cancelled');
    ok('D4 the never-held open shift IS deleted', !(await h.db.get('shifts')).some(r => r.id === 's-open'));

    const log = (await h.db.get('time_logs')).find(l => l.shift_id === 's-live');
    ok('D5 its clock was stopped by the same one writer', !!log.clock_out_at && log.ended_by_office === true);
    ok('D6 the hours survive', log.total_minutes >= 44 && log.total_minutes <= 46, `total_minutes=${log.total_minutes}`);
    ok('D7 no early_clock_out awarded', !(log.flags || []).includes('early_clock_out'));

    const ended = h.notices.filter(n => n.options && String(n.options.relatedEntityId).endsWith(':office-ended'));
    const grouped = h.notices.filter(n => n.options && String(n.options.relatedEntityId).endsWith(':bulk-cancelled'));
    eq('D8 the office-ended visit gets its own message', ended.length, 1);
    eq('D9 ...and is NOT also in the grouped "shifts cancelled" email', grouped.length, 0);
    ok('D10 the response says how many were ended under way', /under way/i.test(res.body.message || ''), res.body.message);
    ok('D11 the row reports the hours kept', (res.body.cancelled || []).some(c => c.shiftId === 's-live' && c.hoursKept));
  }

  console.log('\n=== E. What did NOT widen ===');
  {
    const h = harness();
    await h.db.set('users', [{ id: 'client-1', name: 'Margaret Whitfield', role: 'client', enrollmentStatus: 'enrolled' }]);
    await h.db.set('shifts', [{
      id: 's-done', client_id: 'client-1', client_name: 'Margaret Whitfield', status: 'completed',
      start: new Date(Date.now() - 300 * MIN).toISOString(), end: new Date(Date.now() - 60 * MIN).toISOString(),
      required_license_level: 'cna', caregiver_id: 'cg1', caregiver_name: 'Danielle Carter'
    }]);
    await h.db.set('time_logs', []);
    const done = await call(h.app, 'POST', '/api/scheduling/shifts/s-done/cancel', { reason: 'nope' }, 'mgr');
    eq('E1 a COMPLETED shift is still refused', done.status, 409);
    eq('E2 ...with the finished-shift code, not the in-progress one', done.body.code, 'SHIFT_COMPLETED');
    eq('E3 the completed shift is untouched', (await h.db.get('shifts'))[0].status, 'completed');

    const h2 = harness();
    await seedLiveVisit(h2);
    const cg = await call(h2.app, 'POST', '/api/scheduling/shifts/s-live/cancel', { reason: 'I want to go home' }, 'cg1');
    eq('E4 a CAREGIVER cannot end their own visit this way', cg.status, 403);
    ok('E5 ...and nothing was written', !(await h2.db.get('time_logs'))[0].clock_out_at &&
      (await h2.db.get('shifts'))[0].status === 'in_progress');

    const h3 = harness();
    await seedLiveVisit(h3);
    const noReason = await call(h3.app, 'POST', '/api/scheduling/shifts/s-live/cancel', {}, 'mgr');
    eq('E6 a reason is still required', noReason.status, 400);
    ok('E7 ...and a refused cancel leaves the clock running', !(await h3.db.get('time_logs'))[0].clock_out_at);
  }

  console.log('\n=== F. A later schedule correction must not re-award early_clock_out ===');
  {
    const sched = require(path.join(ROOT, 'schedulingRepository'));
    const startedAt = new Date(Date.now() - 95 * MIN).toISOString();
    const endedAt = new Date().toISOString();
    const log = {
      clock_in_at: startedAt, clock_out_at: endedAt,
      scheduled_start: startedAt,
      scheduled_end: new Date(Date.now() + 150 * MIN).toISOString(),
      flags: ['ended_by_office', 'no_visit_log'], ended_by_office: true
    };
    const flags = sched.rederiveScheduleFlags(log, {
      start: startedAt, end: new Date(Date.now() + 150 * MIN).toISOString()
    });
    ok('F1 re-deriving an office-ended log never puts early_clock_out back',
      !flags.includes('early_clock_out'), JSON.stringify(flags));
    ok('F2 ended_by_office survives the re-derivation', flags.includes('ended_by_office'));
    ok('F3 no_visit_log survives the re-derivation', flags.includes('no_visit_log'));

    // The control: a caregiver who genuinely left early STILL earns the flag.
    const normal = sched.rederiveScheduleFlags(
      { clock_in_at: startedAt, clock_out_at: endedAt, flags: [] },
      { start: startedAt, end: new Date(Date.now() + 150 * MIN).toISOString() }
    );
    ok('F4 CONTROL: a genuine early clock-out still earns the flag',
      normal.includes('early_clock_out'), JSON.stringify(normal));
  }

  console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('PROBE CRASHED:', e); process.exit(1); });
