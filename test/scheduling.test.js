// ============================================================================
// PHCP scheduling (Session 7) — build-enforced invariants
//
// The rules that would break quietly and expensively if they regressed:
//
//   1. Availability inside 30 days is refused — server-side, so a direct API
//      call is refused exactly as the form is.
//   2. A caregiver never sees a shift above their license level.
//   3. A claim does not confirm a shift (Pathway A); a decline returns it to
//      the open pool (Pathway B). Every illegal transition is refused with a
//      specific code and NEVER coerced to a legal state.
//   4. An out-of-geofence clock-in is FLAGGED, never blocked — and a geofence
//      that cannot be checked says so rather than reporting "inside".
//   5. A time-log edit without a reason is impossible.
//   6. PHCP scheduling never touches OpenEMR.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sched = require('../schedulingRepository');
const cg = require('../caregiverRepository');

// ---- Fixtures --------------------------------------------------------------
const caregiver = (licenseLevel, extra = {}) => ({
  id: `cg-${licenseLevel}`, name: `Test ${licenseLevel}`, role: 'vendor', licenseLevel, ...extra
});

const client = (extra = {}) => ({
  id: 'client-1', name: 'Margaret Whitfield', role: 'client',
  address: { line1: '12 Oak St', city: 'Marietta', state: 'GA', zip: '30060', lat: 33.9526, lng: -84.5499 },
  careTeam: { assignedFNPs: [], assignedCaseManager: null, primaryCaregiver: null, backupCaregiver: null },
  ...extra
});

const shift = (extra = {}) => ({
  id: 'shift-1', client_id: 'client-1', status: 'open',
  start: '2026-10-01T14:00:00.000Z', end: '2026-10-01T18:00:00.000Z',
  required_license_level: null, pool_visibility: 'all_eligible', ...extra
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const plusDays = (n) => new Date(NOW.getTime() + n * 86400000).toISOString().slice(0, 10);

// ============================================================================
// 1. Availability — the 30-day rule
// ============================================================================

test('SAFETY: availability fewer than 30 days out is REFUSED', () => {
  for (const days of [0, 1, 14, 29]) {
    const r = sched.validateAvailability(
      { effectiveFrom: plusDays(days), windows: [{ day: 'Mon', start: '09:00', end: '17:00' }] }, NOW);
    assert.strictEqual(r.valid, false, `${days} days out must be refused`);
    const lead = r.errors.find(e => e.code === 'AVAILABILITY_LEAD_TIME');
    assert.ok(lead, 'the refusal names the lead-time rule');
    assert.strictEqual(lead.daysOut, days);
    assert.strictEqual(lead.required, 30);
  }
});

test('availability exactly 30 days out is accepted; 31 too', () => {
  for (const days of [30, 31, 90]) {
    const r = sched.validateAvailability(
      { effectiveFrom: plusDays(days), windows: [{ day: 'Mon', start: '09:00', end: '17:00' }] }, NOW);
    assert.strictEqual(r.valid, true, `${days} days out is fine: ${JSON.stringify(r.errors)}`);
  }
});

test('the lead-time boundary is measured in whole days, not by clock time', () => {
  // A submission at 23:59 must not count as a day later than one at 00:01.
  const early = new Date('2026-09-09T00:01:00.000Z');
  const late = new Date('2026-09-09T23:59:00.000Z');
  const body = { effectiveFrom: '2026-10-09', windows: [{ day: 'Mon', start: '09:00', end: '17:00' }] };
  assert.strictEqual(sched.validateAvailability(body, early).valid, true);
  assert.strictEqual(sched.validateAvailability(body, late).valid, true);
  assert.strictEqual(sched.daysUntil('2026-10-09', early), sched.daysUntil('2026-10-09', late));
});

test('availability with no windows, a bad day, or a bad time is refused per field', () => {
  const noWindows = sched.validateAvailability({ effectiveFrom: plusDays(40), windows: [] }, NOW);
  assert.ok(noWindows.errors.some(e => e.code === 'NO_WINDOWS'));

  const bad = sched.validateAvailability({
    effectiveFrom: plusDays(40),
    windows: [{ day: 'Funday', start: '09:00', end: '17:00' }, { day: 'Mon', start: '9am', end: '5pm' }]
  }, NOW);
  assert.ok(bad.errors.some(e => e.code === 'DAY_INVALID'));
  assert.ok(bad.errors.some(e => e.code === 'TIME_INVALID'));
  assert.strictEqual(bad.clean.windows.length, 0, 'an invalid window is not silently stored');
});

test('an overnight window is legitimate; a zero-length one is not', () => {
  const overnight = sched.validateAvailability(
    { effectiveFrom: plusDays(40), windows: [{ day: 'Fri', start: '22:00', end: '06:00' }] }, NOW);
  assert.strictEqual(overnight.valid, true, 'overnight shifts exist');
  assert.strictEqual(overnight.clean.windows[0].overnight, true);

  const empty = sched.validateAvailability(
    { effectiveFrom: plusDays(40), windows: [{ day: 'Fri', start: '09:00', end: '09:00' }] }, NOW);
  assert.ok(empty.errors.some(e => e.code === 'WINDOW_EMPTY'));
});

test('day names are accepted in the forms people actually type', () => {
  assert.strictEqual(sched.normalizeDay('monday'), 'Mon');
  assert.strictEqual(sched.normalizeDay('TUES'), 'Tue');
  assert.strictEqual(sched.normalizeDay('  wed '), 'Wed');
  assert.strictEqual(sched.normalizeDay('someday'), null);
});

test('availabilityCoversShift respects windows, blackout dates and the effective date', () => {
  const avail = {
    effectiveFrom: '2026-09-01',
    windows: [{ day: 'Thu', start: '13:00', end: '19:00' }],
    blackoutDates: ['2026-10-08']
  };
  assert.ok(sched.availabilityCoversShift(avail, { start: '2026-10-01T14:00:00Z', end: '2026-10-01T18:00:00Z' }));
  assert.ok(!sched.availabilityCoversShift(avail, { start: '2026-10-01T20:00:00Z', end: '2026-10-01T22:00:00Z' }),
    'a shift outside the window is not covered');
  assert.ok(!sched.availabilityCoversShift(avail, { start: '2026-10-08T14:00:00Z', end: '2026-10-08T18:00:00Z' }),
    'a blackout date is not covered');
  assert.ok(!sched.availabilityCoversShift(avail, { start: '2026-08-27T14:00:00Z', end: '2026-08-27T18:00:00Z' }),
    'before the effective date is not covered');
});

// ============================================================================
// 2. Open-pool eligibility
// ============================================================================

test('SAFETY: a caregiver below the required license level cannot see the shift', () => {
  const skilled = shift({ required_license_level: 'cna' });
  assert.ok(!sched.isEligibleForShift(caregiver('sitter'), skilled, client()));
  assert.ok(!sched.isEligibleForShift(caregiver('pca'), skilled, client()));
  assert.ok(sched.isEligibleForShift(caregiver('cna'), skilled, client()));
  assert.ok(sched.isEligibleForShift(caregiver('lpn'), skilled, client()), 'higher levels qualify');
});

test('a shift with no stated requirement is open to any caregiver', () => {
  for (const level of cg.LICENSE_LEVELS) {
    assert.ok(sched.isEligibleForShift(caregiver(level), shift(), client()));
  }
});

test('SAFETY: an UNRECOGNIZED requirement is not read as "no requirement"', () => {
  const weird = shift({ required_license_level: 'brain_surgeon' });
  for (const level of cg.LICENSE_LEVELS) {
    assert.ok(!sched.isEligibleForShift(caregiver(level), weird, client()),
      'a requirement the app cannot read must fail closed, not open the shift to everyone');
  }
});

test('a care-team-only shift is invisible to a caregiver who is not on that team', () => {
  const teamOnly = shift({ pool_visibility: 'care_team' });
  const c = client({ careTeam: { primaryCaregiver: 'cg-pca' } });
  assert.ok(sched.isEligibleForShift(caregiver('pca'), teamOnly, c), 'the primary caregiver sees it');
  assert.ok(!sched.isEligibleForShift(caregiver('cna'), teamOnly, c), 'someone else does not');
  assert.ok(sched.isEligibleForShift(caregiver('cna'), shift(), c), 'and the pool shift is still visible');
});

test('an inactive account and a non-caregiver are never eligible', () => {
  assert.ok(!sched.isEligibleForShift(caregiver('pca', { accountStatus: 'inactive' }), shift(), client()));
  assert.ok(!sched.isEligibleForShift({ role: 'admin', licenseLevel: 'lpn' }, shift(), client()));
  assert.ok(!sched.isEligibleForShift(caregiver(null), shift(), client()), 'a vendor with no level is not a caregiver');
});

test('eligibilityReason explains a refusal in words', () => {
  const reason = sched.eligibilityReason(caregiver('pca'), shift({ required_license_level: 'lpn' }), client());
  assert.match(reason, /below the required/);
  assert.strictEqual(sched.eligibilityReason(caregiver('lpn'), shift(), client()), null);
});

test('overlapping shifts for one caregiver are detected; a cancelled one never blocks', () => {
  const held = { id: 'a', caregiver_id: 'cg-pca', status: 'confirmed', start: '2026-10-01T14:00:00Z', end: '2026-10-01T18:00:00Z' };
  const overlapping = { id: 'b', start: '2026-10-01T16:00:00Z', end: '2026-10-01T20:00:00Z' };
  const after = { id: 'c', start: '2026-10-01T18:00:00Z', end: '2026-10-01T22:00:00Z' };

  assert.ok(sched.findShiftConflict([held], 'cg-pca', overlapping));
  assert.ok(!sched.findShiftConflict([held], 'cg-pca', after), 'back-to-back is not an overlap');
  assert.ok(!sched.findShiftConflict([held], 'cg-cna', overlapping), 'another caregiver is not a conflict');
  assert.ok(!sched.findShiftConflict([{ ...held, status: 'cancelled' }], 'cg-pca', overlapping));
  assert.ok(!sched.findShiftConflict([{ ...held, status: 'completed' }], 'cg-pca', overlapping));
});

// ============================================================================
// 3. Lifecycle — the state machine
// ============================================================================

test('Pathway A: a claim does NOT confirm the shift', () => {
  assert.ok(sched.canTransitionShift('open', 'claimed'));
  assert.ok(!sched.canTransitionShift('open', 'confirmed'),
    'a shift cannot jump straight to confirmed — somebody has to take it and admin has to approve');
  assert.ok(sched.canTransitionShift('claimed', 'confirmed'), 'admin approval confirms it');
  assert.ok(sched.canTransitionShift('claimed', 'open'), 'admin declining returns it to the pool');
});

test('Pathway B: an assignment is accepted or declined, and a decline reopens it', () => {
  assert.ok(sched.canTransitionShift('open', 'assigned'));
  assert.ok(sched.canTransitionShift('assigned', 'confirmed'), 'accept');
  assert.ok(sched.canTransitionShift('assigned', 'open'), 'decline returns it to the open pool');
});

test('work only starts from confirmed and only ends by completing', () => {
  assert.ok(sched.canTransitionShift('confirmed', 'in_progress'));
  assert.ok(!sched.canTransitionShift('open', 'in_progress'), 'you cannot clock in on an unconfirmed shift');
  assert.ok(!sched.canTransitionShift('claimed', 'in_progress'));
  assert.ok(!sched.canTransitionShift('assigned', 'in_progress'));
  assert.ok(sched.canTransitionShift('in_progress', 'completed'));
  assert.deepStrictEqual(sched.SHIFT_TRANSITIONS.in_progress, ['completed'],
    'an in-progress shift can only be completed');
});

test('terminal states are terminal', () => {
  assert.deepStrictEqual(sched.SHIFT_TRANSITIONS.completed, []);
  assert.deepStrictEqual(sched.SHIFT_TRANSITIONS.cancelled, []);
  assert.ok(!sched.canTransitionShift('completed', 'open'));
  assert.ok(!sched.canTransitionShift('cancelled', 'confirmed'));
});

test('SAFETY: every illegal transition is refused with a SPECIFIC code, never coerced', () => {
  const cases = [
    ['completed', 'open', 'SHIFT_COMPLETED'],
    ['cancelled', 'confirmed', 'SHIFT_CANCELLED'],
    ['in_progress', 'open', 'SHIFT_IN_PROGRESS'],
    ['open', 'confirmed', 'SHIFT_NOT_TAKEN'],
    ['open', 'completed', 'INVALID_SHIFT_TRANSITION'],
    ['confirmed', 'claimed', 'INVALID_SHIFT_TRANSITION']
  ];
  for (const [from, to, code] of cases) {
    const refusal = sched.transitionRefusal(from, to);
    assert.ok(refusal, `${from} → ${to} must be refused`);
    assert.strictEqual(refusal.code, code, `${from} → ${to}`);
    assert.ok(refusal.message && refusal.message.length > 10, 'the refusal says something a person can read');
  }
  assert.strictEqual(sched.transitionRefusal('open', 'claimed'), null, 'a legal transition is not refused');
  assert.strictEqual(sched.transitionRefusal('open', 'teleported').code, 'UNKNOWN_STATUS');
});

test('every non-terminal status stamps a timestamp when entered', () => {
  for (const status of sched.SHIFT_STATUSES) {
    assert.ok(sched.SHIFT_STATUS_TIMESTAMP[status],
      `entering "${status}" must record when — a lifecycle with no times is not a trail`);
  }
});

test('shift validation refuses an inverted, over-long or unclienting shift', () => {
  const base = { clientId: 'client-1', start: '2026-10-01T14:00:00Z', end: '2026-10-01T18:00:00Z' };
  assert.strictEqual(sched.validateShift(base).valid, true);
  assert.ok(sched.validateShift({ ...base, end: '2026-10-01T10:00:00Z' })
    .errors.some(e => e.code === 'END_BEFORE_START'));
  assert.ok(sched.validateShift({ ...base, end: '2026-10-04T18:00:00Z' })
    .errors.some(e => e.code === 'SHIFT_TOO_LONG'), 'live-in care is consecutive shifts, not one 72-hour row');
  assert.ok(sched.validateShift({ ...base, clientId: '' }).errors.some(e => e.code === 'CLIENT_REQUIRED'));
  assert.ok(sched.validateShift({ ...base, requiredLicenseLevel: 'wizard' })
    .errors.some(e => e.code === 'LICENSE_LEVEL_INVALID'));
});

// ============================================================================
// 4. Geofence — flag, never block; and never claim what cannot be observed
// ============================================================================

test('distanceMeters is a real haversine', () => {
  // 12 Oak St Marietta → a point ~1.1km north.
  const a = { lat: 33.9526, lng: -84.5499 };
  const b = { lat: 33.9626, lng: -84.5499 };
  const d = sched.distanceMeters(a, b);
  assert.ok(d > 1050 && d < 1160, `expected ~1.1km, got ${d}m`);
  assert.strictEqual(sched.distanceMeters(a, a), 0);
});

test('a clock-in inside the radius reads inside; outside reads outside with the distance', () => {
  const c = client();
  const inside = sched.evaluateGeofence(c, { lat: 33.9527, lng: -84.5500 });
  assert.strictEqual(inside.verdict, 'inside');
  assert.strictEqual(inside.radius, 150);

  const outside = sched.evaluateGeofence(c, { lat: 33.9626, lng: -84.5499 });
  assert.strictEqual(outside.verdict, 'outside');
  assert.ok(outside.distance > 150, 'the distance is reported so admin can judge it');
});

test('the geofence radius is per-client and defaults to 150m', () => {
  assert.strictEqual(sched.geofenceRadiusFor(client()), 150);
  assert.strictEqual(sched.geofenceRadiusFor(client({ geofenceRadiusMeters: 500 })), 500);
  assert.strictEqual(sched.geofenceRadiusFor(client({ geofenceRadiusMeters: 0 })), 150, 'a zero radius is not a radius');
  assert.strictEqual(sched.geofenceRadiusFor(client({ geofenceRadiusMeters: 'wide' })), 150);
});

test('SAFETY: a geofence that cannot be checked says so — it never reports "inside"', () => {
  const noCoords = sched.evaluateGeofence(client({ address: { line1: '12 Oak St' } }), { lat: 33.95, lng: -84.55 });
  assert.strictEqual(noCoords.verdict, 'unverifiable');
  assert.strictEqual(noCoords.reason, 'NO_CLIENT_COORDINATES');

  const noGps = sched.evaluateGeofence(client(), null);
  assert.strictEqual(noGps.verdict, 'unverifiable');
  assert.strictEqual(noGps.reason, 'NO_DEVICE_GPS');

  // 0,0 is the Gulf of Guinea — an unset field, not a Georgia home visit.
  const nullIsland = sched.evaluateGeofence(client({ address: { lat: 0, lng: 0 } }), { lat: 33.95, lng: -84.55 });
  assert.strictEqual(nullIsland.verdict, 'unverifiable');
});

test('SAFETY: an out-of-geofence clock-in is FLAGGED, and flagging is all it does', () => {
  const s = { start: '2026-10-01T14:00:00Z', end: '2026-10-01T18:00:00Z' };
  const { flags, geo } = sched.clockInFlags({
    shift: s, client: client(), gps: { lat: 33.9626, lng: -84.5499 }, at: '2026-10-01T14:00:00Z'
  });
  assert.ok(flags.includes('outside_geofence'));
  assert.strictEqual(geo.verdict, 'outside');
  // The helper returns flags. There is no "blocked" or "refused" in its answer,
  // because a caregiver transporting the client must still be able to clock in.
  assert.ok(!('blocked' in geo) && !('refused' in geo));
});

test('late clock-in and early/late clock-out are flagged past the grace window', () => {
  const s = { start: '2026-10-01T14:00:00Z', end: '2026-10-01T18:00:00Z' };
  const gps = { lat: 33.9527, lng: -84.5500 };

  assert.ok(!sched.clockInFlags({ shift: s, client: client(), gps, at: '2026-10-01T14:09:00Z' })
    .flags.includes('late_clock_in'), 'inside the 10-minute grace');
  assert.ok(sched.clockInFlags({ shift: s, client: client(), gps, at: '2026-10-01T14:25:00Z' })
    .flags.includes('late_clock_in'));

  assert.ok(sched.clockOutFlags({ shift: s, client: client(), gps, at: '2026-10-01T16:00:00Z' })
    .flags.includes('early_clock_out'));
  assert.ok(sched.clockOutFlags({ shift: s, client: client(), gps, at: '2026-10-01T19:00:00Z' })
    .flags.includes('late_clock_out'));
  assert.strictEqual(sched.clockOutFlags({ shift: s, client: client(), gps, at: '2026-10-01T18:00:00Z' })
    .flags.length, 0, 'on time and on site is unflagged');
});

test('totalMinutes never invents hours', () => {
  assert.strictEqual(sched.totalMinutes('2026-10-01T14:00:00Z', '2026-10-01T18:00:00Z'), 240);
  assert.strictEqual(sched.totalMinutes('2026-10-01T14:00:00Z', null), null, 'an open shift has no total, not zero');
  assert.strictEqual(sched.totalMinutes('2026-10-01T14:00:00Z', 'nonsense'), null);
  assert.strictEqual(sched.totalMinutes('2026-10-01T18:00:00Z', '2026-10-01T14:00:00Z'), null,
    'negative time is not zero hours, it is no answer');
  assert.strictEqual(sched.minutesToHours(240), 4);
  assert.strictEqual(sched.minutesToHours(null), null);
});

// ============================================================================
// 5. Pay periods and the payroll CSV
// ============================================================================

test('pay periods are contiguous bi-weekly blocks', () => {
  const p = sched.payPeriodFor('2026-01-05');
  assert.strictEqual(p.start, '2026-01-05');
  assert.strictEqual(p.end, '2026-01-18');
  assert.deepStrictEqual(sched.payPeriodFor('2026-01-18'), p, 'the last day is in the same period');
  assert.strictEqual(sched.payPeriodFor('2026-01-19').start, '2026-01-19', 'the next one starts the day after');
  assert.strictEqual(sched.payPeriodFor('2025-12-31').index, -1, 'dates before the anchor still resolve');
});

test('SAFETY: the payroll CSV neutralizes formula injection and quotes properly', () => {
  assert.strictEqual(sched.csvCell('=SUM(A1:A9)'), "'=SUM(A1:A9)", 'a leading = must not evaluate in Excel');
  assert.strictEqual(sched.csvCell('+1'), "'+1");
  assert.strictEqual(sched.csvCell('@here'), "'@here");
  assert.strictEqual(sched.csvCell('Smith, Jane'), '"Smith, Jane"');
  assert.strictEqual(sched.csvCell('He said "hi"'), '"He said ""hi"""');
  assert.strictEqual(sched.csvCell('line\nbreak'), '"line\nbreak"');
  assert.strictEqual(sched.csvCell(null), '');
  assert.strictEqual(sched.csvCell(0), '0', 'zero is a value, not an empty cell');
});

test('the payroll CSV carries no clinical content', () => {
  const keys = sched.PAYROLL_CSV_COLUMNS.map(c => c.key).join(' ').toLowerCase();
  for (const forbidden of ['diagnos', 'condition', 'careplan', 'note', 'visitlog', 'medication', 'tier']) {
    assert.ok(!keys.includes(forbidden), `payroll must not export "${forbidden}"`);
  }
  const csv = sched.toPayrollCsv([{ caregiverName: 'Pat', hours: 4 }]);
  assert.ok(csv.startsWith('Caregiver,License Level,Client,'));
  assert.ok(csv.endsWith('\r\n'), 'CRLF — the destination is Excel');
});

// ============================================================================
// 6. Wiring, ownership and lane
// ============================================================================

const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'scheduling.js'), 'utf8');
const repoSrc = fs.readFileSync(path.join(__dirname, '..', 'schedulingRepository.js'), 'utf8');
const componentSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'caregiver-schedule.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const caregiverPageSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'caregiver.html'), 'utf8');

test('SAFETY: PHCP scheduling never touches OpenEMR — two systems by design', () => {
  for (const [label, src] of [['routes/scheduling.js', routeSrc], ['schedulingRepository.js', repoSrc], ['caregiver-schedule.js', componentSrc]]) {
    assert.ok(!/require\(\s*['"][./]*openemr['"]\s*\)/i.test(src), `${label} must not require the EMR client`);
    assert.ok(!/\bopenemr\s*\.\s*(?!js\b)[a-z]/i.test(src), `${label} must not call the EMR client`);
    assert.ok(!/\/api\/clinical\//.test(src), `${label} must not reach into the clinical scheduling routes`);
  }
});

test('every /api/scheduling route authenticates and carries a role guard', () => {
  const re = /router\.(get|post|put|delete)\(\s*'(\/api\/scheduling[^']*)'\s*,([^)]*?)(?:async\s*)?\(req/g;
  let m, checked = 0;
  while ((m = re.exec(routeSrc)) !== null) {
    const [, method, routePath, middleware] = m;
    assert.ok(middleware.includes('authenticateToken'), `${method.toUpperCase()} ${routePath} must authenticate`);
    const guarded = /requireAdmin|requireSchedulable/.test(middleware);
    // Three reads serve two audiences (admin sees all, a caregiver sees their
    // own) and branch inline. They must still branch, never return everything.
    const inlineGuarded = [
      '/api/scheduling/availability', '/api/scheduling/shifts',
      '/api/scheduling/time-logs', '/api/scheduling/shift-requests'
    ].includes(routePath) && method === 'get';
    const clientFacing = routePath === '/api/scheduling/shift-requests' && method === 'post';
    assert.ok(guarded || inlineGuarded || clientFacing,
      `${method.toUpperCase()} ${routePath} must carry a role guard`);
    checked++;
  }
  assert.ok(checked >= 12, `expected the scheduling route surface, found ${checked}`);
});

test('the payroll export and every write that changes the board are admin-only', () => {
  for (const route of [
    "'/api/scheduling/payroll.csv'", "'/api/scheduling/shifts'",
    "'/api/scheduling/shifts/:id/approve'", "'/api/scheduling/shifts/:id/decline-claim'",
    "'/api/scheduling/shifts/:id/assign'", "'/api/scheduling/shifts/:id/cancel'",
    "'/api/scheduling/time-logs/:id'", "'/api/scheduling/caregivers'"
  ]) {
    const idx = routeSrc.indexOf(route);
    assert.ok(idx !== -1, `${route} should exist`);
    const decl = routeSrc.slice(idx, idx + 160);
    assert.ok(decl.includes('requireAdmin'), `${route} must be admin-only`);
  }
});

test('there is no route that edits a time log without a reason', () => {
  const idx = routeSrc.indexOf("'/api/scheduling/time-logs/:id'");
  const handler = routeSrc.slice(idx, idx + 3200);
  assert.ok(handler.includes('EDIT_REASON_REQUIRED'), 'the edit route refuses a missing reason');
  assert.ok(handler.includes('logActivity'), 'and writes the change to the activity log');
  assert.ok(/before/.test(handler) && /after/.test(handler), 'with before and after values');
  // The only PUT/PATCH on time logs is that one.
  const writes = routeSrc.match(/router\.(put|patch)\(\s*'\/api\/scheduling\/time-logs/g) || [];
  assert.strictEqual(writes.length, 1, 'exactly one time-log write path, and it demands a reason');
});

test('server.js registers scheduling with exactly one require and one mount', () => {
  assert.strictEqual((serverSrc.match(/require\('\.\/routes\/scheduling'\)/g) || []).length, 1);
  assert.strictEqual((serverSrc.match(/app\.use\(schedulingRoutes\(/g) || []).length, 1);
  // Session 6's registration is untouched — the parallel-build protocol.
  assert.strictEqual((serverSrc.match(/app\.use\(caregiverRoutes\(/g) || []).length, 1);
});

test('SAFETY: the caregiver component ships UNMOUNTED', () => {
  assert.ok(/GFCCaregiverSchedule\s*=\s*\{/.test(componentSrc), 'it exports a mount function');
  // Session 6 owns caregiver.html and its mount point is still a placeholder.
  // The wiring session mounts this; Session 7 does not.
  assert.ok(!/GFCCaregiverSchedule/.test(caregiverPageSrc),
    'public/caregiver.html must not reference the component — a follow-up session wires it');
  assert.ok(!/caregiver-schedule\.js/.test(caregiverPageSrc),
    'and must not load it');
  assert.ok(/id="gfc-mount-schedule"/.test(caregiverPageSrc),
    'the mount point Session 6 left is still there for it');

  // Nothing anywhere in public/ calls mount() on it yet.
  const publicDir = path.join(__dirname, '..', 'public');
  const callers = fs.readdirSync(publicDir)
    .filter(f => f.endsWith('.html'))
    .filter(f => /GFCCaregiverSchedule\s*\.\s*mount/.test(fs.readFileSync(path.join(publicDir, f), 'utf8')));
  assert.deepStrictEqual(callers, [], `nothing should mount it yet, found: ${callers.join(', ')}`);
});

test('the component documents its mount contract', () => {
  for (const needle of ['MOUNT CONTRACT', 'caregiverId', 'authToken', 'gfc-mount-schedule', 'GET /api/caregiver/me']) {
    assert.ok(componentSrc.includes(needle), `the contract must document: ${needle}`);
  }
  assert.ok(/SHIPPED UNMOUNTED/.test(componentSrc), 'and say plainly that it is not mounted');
});

test('Session 7 does not edit files Session 6 or Session 9 own', () => {
  // Session 6 owns public/caregiver.html. Session 7 added nothing to it: the
  // page calls no scheduling API and loads no script of ours. (Its prose does
  // say "coming with scheduling" — that is Session 6's own placeholder copy.)
  assert.ok(!/\/api\/scheduling/.test(caregiverPageSrc),
    'caregiver.html must not call a scheduling route — the component does that, once mounted');
  assert.ok(!/components\//.test(caregiverPageSrc),
    'caregiver.html must not load a component script from this session');
  // Session 9 owns messaging. The invariant is its STORE and ROUTES, not the
  // word — a confirmation response legitimately carries a `message` field.
  assert.ok(!/gfc_messages|\/api\/gfc\/messages|\/api\/messages/.test(routeSrc + repoSrc),
    'Session 9 owns the message store and its routes');
  assert.ok(!/db\.set\(\s*['"]gfc_messages/.test(routeSrc),
    'scheduling must never write to the message store');
});

test('scheduling rides the existing notification queue and activity log', () => {
  assert.ok(routeSrc.includes('queueNotification'), 'confirmations ride pending_notifications');
  assert.ok(routeSrc.includes('logActivity'), 'every action leaves an audit trail');
  assert.ok(!/db\.set\('pending_notifications'/.test(routeSrc), 'no second notification queue');
});

test('the license enum is REQUIRED from Session 6, not restated', () => {
  assert.ok(/require\('\.\/caregiverRepository'\)/.test(repoSrc),
    'one license vocabulary — a second copy is the thing that drifts');
  assert.ok(!/'sitter'\s*,\s*'pca'\s*,\s*'cna'\s*,\s*'lpn'/.test(repoSrc),
    'the level list must not be duplicated here');
});
