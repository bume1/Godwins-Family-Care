'use strict';
// STAFF SHIFTS BY ROLE (owner, 2026-11-09): "We will assign shifts per role.
// Outside of caregivers. And RN and LMSW are both [client visits and office]."
// Providers stay on the EHR's clinical calendar. Managers and coordinators can
// still ask for a time adjustment after the shift.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const sched = require('../schedulingRepository');

const CLIENT = { id: 'client-1', name: 'Test Client', role: 'client', email: 'c@test.local', enrollmentStatus: 'enrolled', careTeam: {} };
const USERS = [
  { id: 'admin-1', name: 'GFC Admin', email: 'a@test.local', role: 'admin', accountType: 'admin' },
  { id: 'coord-1', name: 'Cory Coordinator', email: 'co@test.local', role: 'user', isManager: true, accountType: 'coordinator', employmentType: 'W2' },
  { id: 'rn-1', name: 'Rae Nurse', email: 'rn@test.local', role: 'user', clinicalRole: 'rn', hasClinicalAccess: true, accountType: 'rn', employmentType: 'W2' },
  { id: 'rn-c', name: 'Ray Contract', email: 'rc@test.local', role: 'user', clinicalRole: 'rn', hasClinicalAccess: true, accountType: 'rn', employmentType: '1099' },
  { id: 'lmsw-1', name: 'Lee Social', email: 'l@test.local', role: 'caseManager', clinicalRole: 'lmsw', hasClinicalAccess: true, accountType: 'lmsw', employmentType: 'W2' },
  { id: 'prov-1', name: 'Pat Provider', email: 'p@test.local', role: 'user', clinicalRole: 'provider', hasClinicalAccess: true, accountType: 'provider', employmentType: 'W2' },
  { id: 'cna-1', name: 'Cam CNA', email: 'cna@test.local', role: 'vendor', licenseLevel: 'cna', accountType: 'caregiver' },
  CLIENT
];
const hoursOut = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

function harness(seed = {}) {
  const store = new Map(Object.entries({ users: USERS, ...seed }));
  const db = { get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
  const notifications = [];
  const router = require('../routes/scheduling')({
    db, config: require('../config'), logActivity: async () => {},
    queueNotification: async (type, id, email, name, tpl) => { notifications.push({ type, email, tpl }); },
    getUsers: async () => await db.get('users'), invalidateUsersCache: () => {},
    authenticateToken: (req, _res, next) => { const u = USERS.find(x => x.id === (req.headers['x-as'] || 'admin-1')); req.user = { ...u }; next(); },
    uuidv4: () => `id-${Math.random().toString(36).slice(2, 10)}`
  });
  const app = express(); app.use(express.json()); app.use(router);
  const server = app.listen(0); const port = server.address().port;
  const call = async (method, url, body, as) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(as ? { 'x-as': as } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch (e) { /* empty */ }
    return { status: res.status, body: json };
  };
  return { call, db, notifications, close: () => server.close() };
}
const post = (body, as = 'coord-1') => ['POST', '/api/scheduling/shifts', { start: hoursOut(0.5), end: hoursOut(4), ...body }, as];

test('a staff shift names a role, goes to a person in that role, and never to a provider, a contractor or a caregiver', async () => {
  const h = harness();
  try {
    assert.equal((await h.call(...post({ staffRole: 'rn', clientId: 'client-1' }))).body.code, 'STAFF_SHIFT_NEEDS_PERSON');
    assert.equal((await h.call(...post({ staffRole: 'rn', clientId: 'client-1', assignToCaregiverId: 'cna-1' }))).body.code, 'STAFF_SHIFT_WRONG_PERSON');
    assert.equal((await h.call(...post({ staffRole: 'rn', assignToCaregiverId: 'lmsw-1' }))).body.code, 'STAFF_SHIFT_WRONG_PERSON');
    assert.equal((await h.call(...post({ staffRole: 'rn', assignToCaregiverId: 'rn-c' }))).body.code, 'STAFF_SHIFT_WRONG_PERSON', 'a 1099 keeps their own time');
    const prov = await h.call(...post({ staffRole: 'provider', assignToCaregiverId: 'prov-1' }));
    assert.equal(prov.body.errors[0].code, 'STAFF_ROLE_PROVIDER', 'providers are on the EHR calendar');
    const office = await h.call(...post({ staffRole: 'coordinator', clientId: 'client-1', assignToCaregiverId: 'coord-1' }));
    assert.equal(office.body.errors[0].code, 'STAFF_ROLE_NO_CLIENT', 'office roles carry no client');
    // RN and LMSW: a client visit OR office time.
    const visit = await h.call(...post({ staffRole: 'rn', clientId: 'client-1', assignToCaregiverId: 'rn-1' }));
    assert.equal(visit.status, 200, JSON.stringify(visit.body));
    assert.deepEqual([visit.body.shift.status, visit.body.shift.staffRole, visit.body.shift.clientId], ['assigned', 'rn', 'client-1']);
    const lmswOffice = await h.call(...post({ staffRole: 'lmsw', assignToCaregiverId: 'lmsw-1' }));
    assert.equal(lmswOffice.status, 200, JSON.stringify(lmswOffice.body));
    assert.equal(lmswOffice.body.shift.clientId, null);
    assert.ok(h.notifications.some(n => n.email === 'l@test.local' && /LMSW \/ Case Manager shift/.test(n.tpl.subject)), 'the email names the role when there is no client');
    // Never in a caregiver's open pool, never claimable.
    const pool = await h.call('GET', '/api/scheduling/shifts/open', undefined, 'cna-1');
    assert.ok(!pool.body.shifts.some(s => s.staffRole), 'caregivers do not see staff shifts');
    assert.equal(sched.isEligibleForShift(USERS.find(u => u.id === 'cna-1'), { staff_role: 'rn' }, CLIENT), false);
    assert.equal((await h.call('POST', '/api/scheduling/shifts/bulk', { staffRole: 'rn' }, 'coord-1')).body.code, 'STAFF_SHIFT_NOT_BULK');
  } finally { h.close(); }
});

test('the person accepts, clocks in and out with no caregiver visit log, and the hours are staff time', async () => {
  const h = harness();
  try {
    const id = (await h.call(...post({ staffRole: 'rn', clientId: 'client-1', assignToCaregiverId: 'rn-1' }))).body.shift.id;
    assert.equal((await h.call('POST', `/api/scheduling/shifts/${id}/accept`, {}, 'lmsw-1')).body.code, 'SHIFT_NOT_YOURS');
    assert.equal((await h.call('POST', `/api/scheduling/shifts/${id}/accept`, {}, 'rn-1')).body.shift.status, 'confirmed');
    const mine = await h.call('GET', '/api/scheduling/shifts', undefined, 'rn-1');
    assert.equal(mine.body.shifts[0].visitLogFiled, null);
    const inn = await h.call('POST', `/api/scheduling/shifts/${id}/clock-in`, {}, 'rn-1');
    assert.equal(inn.status, 200, JSON.stringify(inn.body));
    const out = await h.call('POST', `/api/scheduling/shifts/${id}/clock-out`, {}, 'rn-1');
    assert.equal(out.status, 200, 'no VISIT_LOG_REQUIRED on a staff shift');
    const log = (await h.db.get('time_logs'))[0];
    assert.deepEqual([log.kind, log.staff_role, log.client_id, log.license_level], ['staff', 'rn', 'client-1', null]);
    // A coordinator can still ask for an adjustment after the shift.
    const adj = await h.call('POST', `/api/scheduling/time-logs/${log.id}/adjustment-requests`, { clockInAt: new Date(Date.parse(log.clock_in_at) - 15 * 60000).toISOString(), reason: 'Arrived early to prep' }, 'coord-1');
    assert.equal(adj.status, 200, JSON.stringify(adj.body));
    // Staff time is never a client invoice line, even on a client visit.
    const today = log.clock_in_at.slice(0, 10);
    const bill = await h.call('GET', `/api/scheduling/billing?from=${today}&to=${today}`, undefined, 'coord-1');
    assert.equal(bill.status, 200, JSON.stringify(bill.body));
    assert.ok(!JSON.stringify(bill.body).includes('Rae Nurse'), 'staff hours are payroll only');
  } finally { h.close(); }
});

test('office time has no geofence to check, and one person runs one clock at a time', async () => {
  const h = harness();
  try {
    const id = (await h.call(...post({ staffRole: 'coordinator', assignToCaregiverId: 'coord-1' }))).body.shift.id;
    await h.call('POST', `/api/scheduling/shifts/${id}/accept`, {}, 'coord-1');
    assert.equal((await h.call('POST', '/api/scheduling/staff-clock/clock-in', {}, 'coord-1')).status, 200);
    assert.equal((await h.call('POST', `/api/scheduling/shifts/${id}/clock-in`, {}, 'coord-1')).body.code, 'ALREADY_CLOCKED_IN', 'not on two clocks');
    await h.call('POST', '/api/scheduling/staff-clock/clock-out', {}, 'coord-1');
    const inn = await h.call('POST', `/api/scheduling/shifts/${id}/clock-in`, {}, 'coord-1');
    assert.equal(inn.status, 200, JSON.stringify(inn.body));
    const log = (await h.db.get('time_logs')).find(l => l.shift_id === id);
    assert.equal(log.clock_in_geofence.verdict, 'not_applicable');
    assert.ok(!log.flags.includes('geofence_unverifiable'), 'office time is not flagged as unverifiable');
    assert.equal((await h.call('POST', '/api/scheduling/staff-clock/clock-in', {}, 'coord-1')).body.code, 'ALREADY_CLOCKED_IN', 'and not the other way round');
  } finally { h.close(); }
});

test('a declined staff shift asks the office to assign someone else, and reassigning checks the role', async () => {
  const h = harness();
  try {
    const id = (await h.call(...post({ staffRole: 'lmsw', clientId: 'client-1', assignToCaregiverId: 'lmsw-1' }))).body.shift.id;
    await h.call('POST', `/api/scheduling/shifts/${id}/decline`, { reason: 'conflict' }, 'lmsw-1');
    assert.ok(h.notifications.some(n => /assign someone else/.test(n.tpl.subject)));
    const pool = await h.call('GET', '/api/scheduling/shifts/open', undefined, 'cna-1');
    assert.ok(!pool.body.shifts.some(x => x.id === id), 'a declined staff shift is open, but never in a caregiver\'s pool');
    assert.equal((await h.call('POST', `/api/scheduling/shifts/${id}/assign`, { caregiverId: 'cna-1' }, 'coord-1')).body.code, 'STAFF_SHIFT_WRONG_PERSON');
    assert.equal((await h.call('POST', `/api/scheduling/shifts/${id}/assign`, { caregiverId: 'lmsw-1' }, 'coord-1')).status, 200);
  } finally { h.close(); }
});

// ---------------------------------------------------------------------------
// EXPORTS MATCH THE APP (owner, 2026-11-09)
// ---------------------------------------------------------------------------
test('the payroll hours export reads what payroll reads: the person\'s pay schedule, the staff rate, and the run that paid it', async () => {
  const log = (id, uid, extra) => ({ id, caregiver_id: uid, caregiver_name: uid, clock_in_at: '2026-11-04T14:00:00Z', clock_out_at: '2026-11-04T18:00:00Z', total_minutes: 240, flags: [], ...extra });
  const h = harness({
    payroll_settings: { frequency: 'biweekly', anchor: '2026-01-05', payDateOffsetDays: 5 },
    payroll_profiles: { 'rn-1': { userId: 'rn-1', workerType: 'W2', payType: 'hourly', hourlyRateCents: 4500 }, 'coord-1': { userId: 'coord-1', workerType: 'W2', payType: 'salary', salaryAnnualCents: 5200000 } },
    payroll_runs: [{ id: 'run-1', status: 'paid', period: { start: '2026-11-02', end: '2026-11-08', payDate: '2026-11-13' } }],
    shifts: [{ id: 'cg-shift', client_id: 'client-1', client_name: 'Test Client', caregiver_id: 'cna-1', status: 'completed', start: '2026-11-04T14:00:00Z', end: '2026-11-04T18:00:00Z', pay_rate: 18 }],
    time_logs: [
      log('t-rn', 'rn-1', { shift_id: 's-rn', client_id: 'client-1', client_name: 'Test Client', kind: 'staff', staff_role: 'rn' }),
      log('t-co', 'coord-1', { shift_id: null, client_id: null, kind: 'staff' }),
      log('t-cg', 'cna-1', { shift_id: 'cg-shift', client_id: 'client-1', client_name: 'Test Client', license_level: 'cna', payroll_run_id: 'run-1' })
    ]
  });
  try {
    const r = await h.call('GET', '/api/scheduling/payroll?from=2026-11-01&to=2026-11-30', undefined, 'coord-1');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const by = Object.fromEntries(r.body.rows.map(x => [x.timeLogId, x]));
    // Staff at the payroll profile rate, labelled by role; a salary is not paid by the hour.
    assert.deepEqual([by['t-rn'].payRate, by['t-rn'].payRateSource, by['t-rn'].grossPay, by['t-rn'].licenseLevel, by['t-rn'].workerType], ['45.00', 'payroll profile', '180.00', 'RN', 'W-2 staff']);
    assert.deepEqual([by['t-co'].payRate, by['t-co'].grossPay], ['', '']);
    assert.match(by['t-co'].payRateSource, /salary/);
    // The pay period is the person's own schedule.
    assert.deepEqual([by['t-cg'].payPeriodStart, by['t-cg'].payPeriodEnd], ['2026-11-02', '2026-11-08'], 'a caregiver is weekly');
    assert.deepEqual([by['t-rn'].payPeriodStart, by['t-rn'].payPeriodEnd], ['2026-10-26', '2026-11-08'], 'everyone else every two weeks');
    assert.match(by['t-cg'].paySchedule, /Caregivers \(weekly\)/);
    assert.equal(by['t-cg'].payrollRun, 'Paid · pay date 2026-11-13');
    assert.equal(by['t-rn'].payrollRun, '');
    const headers = r.body.columns.map(c => c.header);
    assert.deepEqual(headers.slice(-3), ['Worker Type', 'Pay Schedule', 'Paid In Payroll Run'], 'appended, so earlier columns keep their place');
  } finally { h.close(); }
});

test('a payroll run never pays a visit\'s minutes twice when the clinician was already on the clock', () => {
  const engine = require('../payrollEngine');
  const period = { start: '2026-11-02', end: '2026-11-15' };
  const g = engine.gatherItems({
    period, users: [{ id: 'rn-1' }], profilesById: new Map([['rn-1', { userId: 'rn-1', workerType: 'W2', payType: 'hourly', hourlyRateCents: 4000 }]]),
    timeLogs: [{ id: 'c1', caregiver_id: 'rn-1', kind: 'staff', shift_id: null, client_id: null, clock_in_at: '2026-11-03T13:00:00Z', clock_out_at: '2026-11-03T21:00:00Z', total_minutes: 480 }],
    shifts: [], imeCases: [], paidRefs: new Set(), localDate: (iso) => String(iso).slice(0, 10), resolvePayRate: () => ({ rate: null }),
    visitTimings: [
      { id: 'v-in', byId: 'rn-1', startedAt: '2026-11-03T15:00:00Z', endedAt: '2026-11-03T16:00:00Z' },
      { id: 'v-out', byId: 'rn-1', startedAt: '2026-11-04T15:00:00Z', endedAt: '2026-11-04T16:00:00Z' }
    ]
  });
  assert.deepEqual(g.byUser.get('rn-1').map(i => i.ref).sort(), ['log:c1', 'visit:v-out'], 'the visit inside the clocked day is not paid again; the one outside it is');
});
