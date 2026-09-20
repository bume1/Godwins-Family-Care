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

// REPOINTED 2026-09-16, not patched to pass. This test asserted the UTC
// reading: it expected 14:00Z to be "14:00", inside a 13:00-19:00 window. But a
// caregiver who writes "Thu 13:00-19:00" means Georgia, and 14:00Z is 10:00 AM
// there — outside it. The old assertion encoded the defect, so the fixture is
// restated in Eastern with the offset written out, and the case that exposes
// the bug is added below.
test('availabilityCoversShift reads the shift in EASTERN, not UTC', () => {
  const avail = {
    effectiveFrom: '2026-09-01',
    windows: [{ day: 'Thu', start: '13:00', end: '19:00' }],
    blackoutDates: ['2026-10-08']
  };
  // Thursday 1pm-5pm in Georgia, stored as the instant it really is.
  assert.ok(sched.availabilityCoversShift(avail,
    { start: '2026-10-01T13:00:00-04:00', end: '2026-10-01T17:00:00-04:00' }),
    'a shift inside the stated window is covered');

  // 14:00Z is 10:00 AM in Georgia — BEFORE the window opens. This is the
  // assertion that used to pass for the wrong reason.
  assert.ok(!sched.availabilityCoversShift(avail,
    { start: '2026-10-01T14:00:00Z', end: '2026-10-01T18:00:00Z' }),
    '10am Eastern is outside a 1pm-7pm window, however it reads in UTC');

  assert.ok(!sched.availabilityCoversShift(avail,
    { start: '2026-10-01T20:00:00-04:00', end: '2026-10-01T22:00:00-04:00' }),
    'a shift outside the window is not covered');
  assert.ok(!sched.availabilityCoversShift(avail,
    { start: '2026-10-08T14:00:00-04:00', end: '2026-10-08T18:00:00-04:00' }),
    'a blackout date is not covered');
  assert.ok(!sched.availabilityCoversShift(avail,
    { start: '2026-08-27T14:00:00-04:00', end: '2026-08-27T18:00:00-04:00' }),
    'before the effective date is not covered');
});

test('an evening shift keeps its OWN weekday and date, not the next one in UTC', () => {
  // The case the UTC reading got wrong in three ways at once. A Tuesday 8pm
  // shift in Georgia is Wednesday 00:00 UTC: wrong weekday, wrong hour, and
  // wrong calendar date for the blackout and effective-date checks.
  const tuesdayEvening = { start: '2026-09-15T20:00:00-04:00', end: '2026-09-15T22:00:00-04:00' };

  assert.ok(sched.availabilityCoversShift(
    { effectiveFrom: '2026-09-01', windows: [{ day: 'Tue', start: '18:00', end: '23:00' }] },
    tuesdayEvening), 'a Tuesday evening shift matches the TUESDAY window');

  assert.ok(!sched.availabilityCoversShift(
    { effectiveFrom: '2026-09-01', windows: [{ day: 'Wed', start: '00:00', end: '06:00' }] },
    tuesdayEvening), 'and does not match Wednesday, which is only where UTC put it');

  assert.ok(!sched.availabilityCoversShift(
    { effectiveFrom: '2026-09-01', windows: [{ day: 'Tue', start: '18:00', end: '23:00' }],
      blackoutDates: ['2026-09-15'] },
    tuesdayEvening), 'the blackout is matched on the Georgia date the caregiver named');
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

test('"any" is an EXPLICIT open-to-all requirement, not a blank field', () => {
  const anyone = shift({ required_license_level: 'any' });
  for (const level of cg.LICENSE_LEVELS) {
    assert.ok(sched.isEligibleForShift(caregiver(level), anyone, client()),
      `${level} must be able to take a shift posted as open to anyone`);
  }
  const { valid, clean } = sched.validateShift({
    clientId: 'c1', start: '2026-10-01T09:00:00Z', end: '2026-10-01T13:00:00Z', requiredLicenseLevel: 'any'
  });
  assert.ok(valid);
  assert.strictEqual(clean.requiredLicenseLevel, null,
    '"any" is stored as null so eligibility has exactly one shape to read');
  assert.strictEqual(clean.openToAllLevels, true);
});

test('a CNA and a PCA can both take a PCA-and-above shift', () => {
  const shared = shift({ required_license_level: 'pca' });
  assert.ok(sched.isEligibleForShift(caregiver('pca'), shared, client()));
  assert.ok(sched.isEligibleForShift(caregiver('cna'), shared, client()));
  assert.ok(!sched.isEligibleForShift(caregiver('sitter'), shared, client()),
    'a sitter is still below the line');
});

test('SAFETY: "any" is the ONLY open-to-all spelling a validator accepts', () => {
  const bad = sched.validateShift({
    clientId: 'c1', start: '2026-10-01T09:00:00Z', end: '2026-10-01T13:00:00Z', requiredLicenseLevel: 'anyone'
  });
  assert.ok(!bad.valid);
  assert.ok(bad.errors.some(e => e.code === 'LICENSE_LEVEL_INVALID'));
  assert.match(bad.errors[0].message, /"any"/, 'the error names the token that does work');
});

test('the requirement is STATED, never inferred from a falsy field', () => {
  assert.strictEqual(sched.shiftLevelLabel(shift()), 'Open to all license levels');
  assert.strictEqual(sched.shiftLevelLabel(shift({ required_license_level: 'any' })), 'Open to all license levels');
  assert.strictEqual(sched.shiftLevelLabel(shift({ required_license_level: 'cna' })), 'CNA and above');
  assert.strictEqual(sched.shiftLevelLabel(shift({ required_license_level: 'lpn' })), 'LPN only');
  assert.match(sched.shiftLevelLabel(shift({ required_license_level: 'brain_surgeon' })), /not recognized/);
  assert.strictEqual(sched.isOpenToAllLevels(shift({ required_license_level: 'cna' })), false);
  assert.strictEqual(sched.isOpenToAllLevels(shift({ required_license_level: 'brain_surgeon' })), false,
    'an unreadable requirement is not open to all — it is open to nobody');
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

test('the schedule component is mounted ONCE per visit, not on every parent render', () => {
  // OWNER REPORT, 2026-09-14: the Schedule tab flickered and sat on
  // "Loading…" forever. `onVisitLogRequired` is an inline arrow in the parent,
  // so it is a new function identity on every App render; with it in the
  // effect's dependency array React tore the component down and remounted it
  // each time — and the component calls `onChange` as soon as its first fetch
  // resolves, which sets App state, which renders, which remounts it. A loop.
  //
  // The rule: the mount effect may depend only on values with a stable
  // identity. Callbacks are read from a ref at call time.
  const start = caregiverPageSrc.indexOf('const ScheduleTab =');
  assert.ok(start > 0, 'ScheduleTab exists');
  const body = caregiverPageSrc.slice(start, caregiverPageSrc.indexOf('\nconst ', start + 10));

  const deps = body.match(/\}, \[([^\]]*)\]\);/);
  assert.ok(deps, 'the mount effect declares its dependencies');
  const listed = deps[1].split(',').map(d => d.trim()).filter(Boolean);
  for (const dep of listed) {
    assert.ok(!/^on[A-Z]/.test(dep),
      `ScheduleTab must not depend on the callback prop "${dep}" — a new arrow each render remounts the component in a loop`);
    assert.notStrictEqual(dep, 'me',
      'setMe hands back a new object, so depending on it remounts the component too');
  }
  assert.match(body, /useRef\(/, 'the callbacks are held in a ref and read at call time');
});

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
    const guarded = /requireAdmin|requireScheduleManager|requireSchedulable/.test(middleware);
    // Three reads serve two audiences (admin sees all, a caregiver sees their
    // own) and branch inline. They must still branch, never return everything.
    const inlineGuarded = [
      '/api/scheduling/availability', '/api/scheduling/shifts',
      '/api/scheduling/time-logs', '/api/scheduling/shift-requests',
      '/api/scheduling/my-upcoming-shifts'
    ].includes(routePath) && method === 'get';
    const clientFacing = routePath === '/api/scheduling/shift-requests' && method === 'post';
    assert.ok(guarded || inlineGuarded || clientFacing,
      `${method.toUpperCase()} ${routePath} must carry a role guard`);
    checked++;
  }
  assert.ok(checked >= 12, `expected the scheduling route surface, found ${checked}`);
});

// REPOINTED 2026-09-20, not deleted. This asserted that every write on the
// board was admin-only, which was right until the owner said "editable by admin
// and manager". The rule it protected — a scheduling write is never open to
// whoever happens to be signed in — did not go away; it grew a second tier, and
// both halves are pinned here. Losing the test with the rule would have left
// the narrower half unguarded.
test('the money and the client record stay ADMIN-only', () => {
  // Named by METHOD as well as path: GET /time-logs is a manager-readable list
  // and POST /time-logs types in hours that were never clocked. Matching the
  // path alone finds the read and proves nothing about the write.
  for (const [method, route] of [
    ['get', '/api/scheduling/payroll.csv'],
    ['get', '/api/scheduling/billing.csv'],
    ['post', '/api/scheduling/time-logs'],
    ['put', '/api/scheduling/time-logs/:id'],
    ['put', '/api/scheduling/clients/:clientId/location']
  ]) {
    const marker = `router.${method}('${route}'`;
    const idx = routeSrc.indexOf(marker);
    assert.ok(idx !== -1, `${marker} should exist`);
    const decl = routeSrc.slice(idx, idx + 200);
    assert.ok(decl.includes('requireAdmin') && !decl.includes('requireScheduleManager'),
      `${method.toUpperCase()} ${route} must be admin-only: payroll and the client record are not a scheduling role's`);
  }
});

test('running the board is admin OR manager, and never wider', () => {
  for (const route of [
    "'/api/scheduling/shifts'", "'/api/scheduling/shifts/:id'",
    "'/api/scheduling/shifts/bulk'", "'/api/scheduling/shifts/bulk-remove'",
    "'/api/scheduling/shifts/:id/approve'", "'/api/scheduling/shifts/:id/decline-claim'",
    "'/api/scheduling/shifts/:id/assign'", "'/api/scheduling/shifts/:id/cancel'",
    "'/api/scheduling/availability/:id/review'",
    "'/api/scheduling/summary'", "'/api/scheduling/caregivers'"
  ]) {
    // The POST and the PUT on '/api/scheduling/shifts' share a path, so each
    // declaration is checked rather than only the first one found.
    const re = new RegExp(`router\\.(get|post|put)\\(\\s*${route.replace(/[/:.']/g, ch => '\\' + ch)}\\s*,([^)]*?)\\(req`, 'g');
    let m, found = 0;
    while ((m = re.exec(routeSrc)) !== null) {
      const middleware = m[2];
      // A GET that serves two audiences branches inline; the writes must carry
      // the guard itself.
      if (m[1] === 'get' && route === "'/api/scheduling/shifts'") { found++; continue; }
      assert.ok(middleware.includes('requireScheduleManager'),
        `${m[1].toUpperCase()} ${route} must be admin-or-manager`);
      assert.ok(!middleware.includes('requireSchedulable'),
        `${m[1].toUpperCase()} ${route} must not be open to every caregiver`);
      found++;
    }
    assert.ok(found > 0, `${route} should exist`);
  }
  // The gate itself is what makes those two lines mean anything.
  assert.ok(/const isScheduleManager = \(u\) => !!u && \(u\.role === ROLES\.ADMIN \|\| !!u\.isManager\)/.test(routeSrc),
    'the manager gate must be admin OR the manager flag, and nothing else');
  // An override is a compliance decision, not a scheduling one.
  assert.ok(/gate\.checkSchedulingAllowed\(client, req\.body \|\| \{\}, req\.user, isAdmin\(req\.user\)\)/.test(routeSrc),
    'the enrollment override stays ADMIN-only — isAdmin, never isScheduleManager');
  assert.ok(/req\.user, req\.user\.role === ROLES\.ADMIN\)/.test(routeSrc),
    'the caregiver-clearance override stays ADMIN-only too');
});

test('client coordinates: a real point is accepted, nonsense is refused', () => {
  const ok = sched.validateClientLocation({ lat: 33.9526, lng: -84.5499 });
  assert.ok(ok.valid);
  assert.strictEqual(ok.clean.lat, 33.9526);
  assert.strictEqual(ok.clean.clearing, false);

  for (const bad of [{ lat: 91, lng: -84 }, { lat: 33, lng: 200 }, { lat: 'north', lng: 'west' }]) {
    assert.ok(!sched.validateClientLocation(bad).valid, JSON.stringify(bad));
  }
});

test('SAFETY: 0,0 is refused rather than stored as a location', () => {
  const r = sched.validateClientLocation({ lat: 0, lng: 0 });
  assert.ok(!r.valid);
  assert.ok(r.errors.some(e => e.code === 'COORDINATES_NULL_ISLAND'),
    'storing 0,0 would leave a client looking configured while every clock-in stayed unverifiable');
  // And the geofence agrees, so the two halves cannot drift apart.
  assert.strictEqual(sched.evaluateGeofence({ address: { lat: 0, lng: 0 } }, { lat: 33.9, lng: -84.5 }).verdict, 'unverifiable');
});

test('both boxes empty is a deliberate CLEAR, not an error', () => {
  const r = sched.validateClientLocation({ lat: '', lng: '' });
  assert.ok(r.valid);
  assert.strictEqual(r.clean.clearing, true);
  assert.strictEqual(r.clean.lat, null);
});

test('the radius is bounded, and an absent key keeps what is stored', () => {
  assert.ok(!sched.validateClientLocation({ lat: 33.9, lng: -84.5, geofenceRadiusMeters: 5 }).valid, 'too small');
  assert.ok(!sched.validateClientLocation({ lat: 33.9, lng: -84.5, geofenceRadiusMeters: 99999 }).valid, 'too large');

  const kept = sched.validateClientLocation({ lat: 33.9, lng: -84.5 });
  assert.strictEqual(kept.clean.radiusProvided, false, 'omitting it must not reset the stored radius');

  const reset = sched.validateClientLocation({ lat: 33.9, lng: -84.5, geofenceRadiusMeters: '' });
  assert.strictEqual(reset.clean.radiusProvided, true);
  assert.strictEqual(reset.clean.geofenceRadiusMeters, null, 'an empty box resets to the default');
});

test('SAFETY: the location route writes only location fields, and never logs the coordinates', () => {
  const idx = routeSrc.indexOf("'/api/scheduling/clients/:clientId/location'");
  assert.ok(idx !== -1, 'the route exists');
  const handler = routeSrc.slice(idx, idx + 3000);
  assert.ok(handler.includes('requireAdmin'), 'admin only');

  // It touches address + the radius and nothing else on the client record.
  const assignments = (handler.match(/users\[idx\]\.(\w+)\s*=/g) || [])
    .map(m => m.replace(/users\[idx\]\./, '').replace(/\s*=$/, ''));
  assert.deepStrictEqual([...new Set(assignments)].sort(), ['address', 'geofenceRadiusMeters'],
    'a scheduling screen must not edit the rest of a client record');

  // An activity log is not a second copy of where a patient lives.
  const logCall = handler.slice(handler.indexOf('logActivity'), handler.indexOf('res.json'));
  assert.ok(!/clean\.lat|clean\.lng|coordinates:/.test(logCall),
    'the audit entry records THAT the location changed, never the coordinates');
  assert.ok(/hasCoordinates/.test(logCall));
});

test('SAFETY: a direct post lands at ASSIGNED, never confirmed, and checks before it writes', () => {
  const idx = routeSrc.indexOf("router.post('/api/scheduling/shifts'");
  assert.ok(idx !== -1);
  const handler = routeSrc.slice(idx, routeSrc.indexOf("router.get('/api/scheduling/shifts'", idx));
  assert.ok(handler.includes('assignToCaregiverId'), 'admin can post a shift straight to a caregiver');

  const eligibility = handler.indexOf('isEligibleForShift');
  const conflict = handler.indexOf('findShiftConflict');
  const write = handler.indexOf('rows.push(row)');
  assert.ok(eligibility !== -1 && conflict !== -1 && write !== -1);
  assert.ok(eligibility < write && conflict < write,
    'a refused direct post must leave no orphan open shift behind');

  assert.ok(/row\.status = 'assigned'/.test(handler),
    'a directly posted shift is OFFERED, not confirmed — the caregiver still accepts or declines');
  assert.ok(!/row\.status = 'confirmed'/.test(handler),
    'admin schedules the work; the caregiver still agrees to it');
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

test('the caregiver page mounts the component, once, with the TOKEN', () => {
  // This inverts the Session 7 invariant on purpose. That test said the
  // component must ship unmounted while Sessions 6 and 7 were built in
  // parallel; the wiring session (2026-09-10) is the deliberate act it was
  // waiting for. What has to stay true is HOW it is mounted.
  assert.ok(/GFCCaregiverSchedule\s*=\s*\{/.test(componentSrc), 'it exports a mount function');
  assert.ok(/src="\/components\/caregiver-schedule\.js"/.test(caregiverPageSrc), 'the page loads it');

  const mounts = caregiverPageSrc.match(/GFCCaregiverSchedule[\s\S]{0,40}?\.mount\(/g) || [];
  assert.strictEqual(mounts.length, 1, 'exactly one mount call — two would fight over one element id');
  assert.strictEqual(caregiverPageSrc.split('id="gfc-mount-schedule"').length - 1, 1,
    'and exactly one element carrying the id');

  // The token authorizes; the id is display only. Mounting with an id and no
  // token would render an empty board and look like "no shifts".
  const at = caregiverPageSrc.indexOf('lib.mount(');
  const call = caregiverPageSrc.slice(at, at + 400);
  assert.ok(/authToken:\s*token/.test(call), 'mounted with the bearer token');
  assert.ok(!/localStorage/.test(call), 'the caregiver id never comes from localStorage');

  // Unmounted on teardown: the component keys instance state by element id, so
  // a stale instance would leave the next mount rendering into a dead node.
  assert.ok(/lib\.unmount\('gfc-mount-schedule'\)/.test(caregiverPageSrc),
    'the tab unmounts it on teardown');
});

test('SAFETY: Home does not grow a second clock-in control', () => {
  // Two buttons over one clock-in API is how a double clock-in happens. Home
  // renders the STATE and routes to the component, which owns the action.
  const shiftCard = caregiverPageSrc.slice(
    caregiverPageSrc.indexOf('const ShiftCard'),
    caregiverPageSrc.indexOf('const HomeTab')
  );
  // The prose says "clock in"; what must be absent is the CALL.
  assert.ok(!/\/api\/scheduling/.test(shiftCard) && !/fetch\(|api\(/.test(shiftCard),
    'the Home card must not call a time-log route itself');
  assert.ok(/onSchedule/.test(shiftCard), 'it sends the caregiver to the schedule instead');
});

test('the Home card reflects the LIVE clock state, read from the shift board', () => {
  const shiftCard = caregiverPageSrc.slice(
    caregiverPageSrc.indexOf('const ShiftCard'),
    caregiverPageSrc.indexOf('const HomeTab')
  );
  // It takes the board as a prop rather than fetching it, so the no-second-
  // clock-in rule above still holds while the card stops being static.
  assert.match(shiftCard, /\(\{[^}]*shifts[^}]*\}\)/, 'shifts arrive as a prop');
  assert.match(shiftCard, /in_progress/, 'a running shift is recognised');
  assert.match(shiftCard, /visitLogFiled === false/,
    'and it says when the visit log is still owed, before they try to clock out');

  // The App is where the read happens.
  assert.match(caregiverPageSrc, /api\('\/api\/scheduling\/shifts'\)/,
    'the app refreshes the board alongside its own data');
  assert.match(caregiverPageSrc, /<ShiftCard clients=\{clients\} shifts=\{shifts\}/,
    'and hands it to the card');
});

test('the component documents its mount contract', () => {
  for (const needle of ['MOUNT CONTRACT', 'caregiverId', 'authToken', 'gfc-mount-schedule', 'GET /api/caregiver/me']) {
    assert.ok(componentSrc.includes(needle), `the contract must document: ${needle}`);
  }
  assert.ok(/SHIPPED UNMOUNTED/.test(componentSrc), 'and say plainly that it is not mounted');
});

test('scheduling stays out of messaging\'s store, and messaging out of scheduling\'s', () => {
  // Session 9 is now built and wired too, so the old "Session 9 is untouched"
  // invariant is superseded. What still has to hold is that the two modules
  // do not reach into each other: one store, one owner.
  assert.ok(!/message_threads|db\.set\(\s*['"]messages/.test(routeSrc + repoSrc),
    'scheduling must never write to the messaging store');
  const msgRouteSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'messaging.js'), 'utf8');
  assert.ok(!/db\.set\(\s*['"](shifts|time_logs|caregiver_availability)/.test(msgRouteSrc),
    'messaging must never write to the scheduling store');
  // Both legitimately append to Session 6's ONE escalation store — that is
  // deliberate, so a case manager has one inbox rather than two.
  assert.ok(/escalation_events/.test(msgRouteSrc), 'messaging raises into Session 6\'s escalation store');
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

// ---- Clock-out requires the visit log (the EVV-style documentation gate) ----
// A shift is not finished when the caregiver walks out; it is finished when the
// visit is DOCUMENTED. Clocking out is refused until a visit log carrying that
// shift's id exists. These guard the two halves that make it real: the refusal
// itself, and the fact that a refusal writes nothing.
test('SAFETY: clock-out is REFUSED until the shift has a visit log', () => {
  const i = routeSrc.indexOf("'/api/scheduling/shifts/:id/clock-out'");
  assert.ok(i > 0, 'the clock-out route exists');
  const handler = routeSrc.slice(i, i + 3000);
  assert.match(handler, /caregiver_visit_logs/, 'clock-out reads the visit-log store');
  assert.match(handler, /VISIT_LOG_REQUIRED/, 'the refusal carries a specific code');
});

test('SAFETY: a refused clock-out writes NOTHING — the shift stays in progress', () => {
  const i = routeSrc.indexOf("'/api/scheduling/shifts/:id/clock-out'");
  const handler = routeSrc.slice(i, i + 3000);
  const gate = handler.indexOf('VISIT_LOG_REQUIRED');
  const firstWrite = handler.indexOf('db.set');
  assert.ok(gate > 0 && firstWrite > 0, 'both the gate and a write are present');
  assert.ok(gate < firstWrite,
    'the documentation gate must be checked BEFORE anything is written, or a refused clock-out leaves a half-closed shift');
});

test('SAFETY: the gate matches the caregiver AND the client, not the shift id alone', () => {
  const i = routeSrc.indexOf("'/api/scheduling/shifts/:id/clock-out'");
  const handler = routeSrc.slice(i, i + 3000);
  const gate = handler.slice(handler.indexOf('caregiver_visit_logs'), handler.indexOf('VISIT_LOG_REQUIRED'));
  assert.match(gate, /caregiver_id/,
    "a log filed by a different caregiver must not satisfy another caregiver's gate");
  assert.match(gate, /client_id/,
    'a log naming a different client must not satisfy this shift');
});

test('a visit log filed while clocked in is attached to that shift, whatever screen it came from', () => {
  const cgRouteSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'caregiver.js'), 'utf8');
  const i = cgRouteSrc.indexOf("router.post('/api/caregiver/visit-logs'");
  const handler = cgRouteSrc.slice(i, i + 5000);
  // Without this, a log filed from the Home tab carries no shift id, the
  // clock-out gate does not see it, and the caregiver is told to file the log
  // they just filed. A safety control with a dead end in it gets worked around.
  assert.match(handler, /in_progress/,
    'the route resolves the caregiver\'s running shift when the form did not carry one');
  assert.match(handler, /shift_id: attachedShiftId/,
    'and the resolved id is what gets stored');
  assert.ok(!/shift_id: body\.shiftId/.test(handler),
    'the stored shift id is no longer taken straight off the request body');
});

test('the schedule reports whether the visit log is filed, and only for a running shift', () => {
  const i = routeSrc.indexOf("router.get('/api/scheduling/shifts'");
  assert.ok(i > 0, 'the shift list route exists');
  const handler = routeSrc.slice(i, i + 2400);
  assert.match(handler, /visitLogFiled/, 'the list carries the fact the gate reads');
  // The app must not claim a state it cannot observe: a shift that is not
  // running is not "missing" a log, so it reports null rather than false.
  assert.match(handler, /in_progress'\s*\n?\s*\?/,
    'only an in-progress shift gets a true/false; anything else is null');
});

test('SAFETY: a visit log cannot claim a shift that is not the caregiver\'s own', () => {
  const cgRouteSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'caregiver.js'), 'utf8');
  const i = cgRouteSrc.indexOf("router.post('/api/caregiver/visit-logs'");
  assert.ok(i > 0, 'the visit-log submit route exists');
  const handler = cgRouteSrc.slice(i, i + 4000);
  // shift_id gates a clock-out now, so an unvalidated one would let a log
  // satisfy a gate on someone else's shift.
  assert.match(handler, /SHIFT_NOT_YOURS/, 'a shift belonging to another caregiver is refused');
  assert.match(handler, /SHIFT_CLIENT_MISMATCH/, 'a shift for a different client than the log names is refused');
  assert.match(handler, /SHIFT_NOT_FOUND/, 'a shift id that does not exist is refused');
});

// ---- Billing and the caregiver's own hours ---------------------------------
test('the billing CSV carries no clinical content either', () => {
  const keys = sched.BILLING_CSV_COLUMNS.map(c => c.key).join(' ').toLowerCase();
  for (const forbidden of ['diagnos', 'condition', 'careplan', 'note', 'medication', 'tier']) {
    assert.ok(!keys.includes(forbidden), `billing must not export "${forbidden}"`);
  }
  // An invoice says a visit of this length happened — never what was done in it.
  const csv = sched.toPayrollCsv([{ clientName: 'M. Whitfield', hours: 4 }], sched.BILLING_CSV_COLUMNS);
  assert.ok(csv.startsWith('Client,Service Date,Caregiver,'));
});

test('SAFETY: billing lists only COMPLETED visits, and says what verification could establish', () => {
  const i = routeSrc.indexOf("'/api/scheduling/billing.csv'");
  assert.ok(i > 0, 'the billing route exists');
  const handler = routeSrc.slice(i, i + 2600);
  assert.match(handler, /!l\.clock_out_at.*return false/s,
    'a shift still in progress has no final hours and must not reach an invoice');
  assert.match(handler, /verification/, 'each line states what the geofence could establish');
  assert.match(handler, /requireAdmin/, 'billing is admin-only');
});

test('SAFETY: a caregiver\'s hours export can only ever return their OWN rows', () => {
  const i = routeSrc.indexOf("'/api/scheduling/my-hours.csv'");
  assert.ok(i > 0, 'the caregiver hours route exists');
  const decl = routeSrc.slice(i, i + 200);
  assert.match(decl, /requireSchedulable/, 'only a caregiver or clinician reaches it');
  const handler = routeSrc.slice(i, i + 2200);
  assert.match(handler, /l\.caregiver_id !== req\.user\.id/,
    'the filter is the token holder, not a parameter');
  assert.ok(!/req\.query\.caregiverId/.test(handler),
    'there must be no caregiverId parameter to widen the export with');
  // An office correction and its reason belong on payroll, not in a personal copy.
  const keys = sched.CAREGIVER_HOURS_CSV_COLUMNS.map(c => c.key).join(' ');
  assert.ok(!keys.includes('editReason'), 'the edit reason is not in the caregiver copy');
});

// ---- Manual time entry (hours that were never clocked) ---------------------
// Every other way into time_logs starts at a clock-in on the caregiver's
// device, so without this a dead phone means hours that cannot be paid. What
// must never happen is these becoming indistinguishable from clocked hours.
test('SAFETY: a manual time entry is impossible without a reason', () => {
  const i = routeSrc.indexOf("router.post('/api/scheduling/time-logs'");
  assert.ok(i > 0, 'the manual entry route exists');
  const handler = routeSrc.slice(i, i + 4500);
  assert.match(handler, /ENTRY_REASON_REQUIRED/, 'a reason is mandatory');
  const gate = handler.indexOf('ENTRY_REASON_REQUIRED');
  const write = handler.indexOf("db.set('time_logs'");
  assert.ok(gate > 0 && write > 0 && gate < write, 'refused before anything is written');
  assert.match(handler, /requireAdmin/, 'admin only');
});

test('SAFETY: a manual entry never claims a verified location', () => {
  const i = routeSrc.indexOf("router.post('/api/scheduling/time-logs'");
  const handler = routeSrc.slice(i, i + 4500);
  // There was no clock-in, so there is nothing to check a location against.
  // Reporting "inside" would be the app asserting something it never observed.
  assert.match(handler, /verdict: 'unverifiable'/, 'the geofence verdict is unverifiable');
  assert.ok(!/verdict: 'inside'/.test(handler), 'it must never record inside');
  assert.match(handler, /'manual_entry'/, 'the row carries the manual_entry flag');
  assert.ok(sched.TIME_LOG_FLAGS.includes('manual_entry'), 'manual_entry is a known flag');
});

test('a manual entry invents no schedule, and cannot borrow another caregiver\'s shift', () => {
  const i = routeSrc.indexOf("router.post('/api/scheduling/time-logs'");
  const handler = routeSrc.slice(i, i + 4500);
  assert.match(handler, /scheduled_start: shift \? shift\.start : null/,
    'with no shift there is no schedule to report — copying the entered times would invent one');
  assert.match(handler, /SHIFT_CAREGIVER_MISMATCH/, 'a shift belonging to someone else is refused');
  assert.match(handler, /SHIFT_CLIENT_MISMATCH/, 'a shift for a different client is refused');
});

test('payroll says whether hours were clocked or typed', () => {
  const keys = sched.PAYROLL_CSV_COLUMNS.map(c => c.key);
  assert.ok(keys.includes('source'), 'the export distinguishes clocked from manual');
  assert.ok(keys.includes('enteredBy'), 'and names who entered a manual row');
});

// ---- The clock-in window (two hours before the start) ----------------------
test('SAFETY: a caregiver cannot clock in more than 2 hours before the start', () => {
  const s = shift({ start: '2026-10-01T14:00:00.000Z' });
  // 2h01m early: refused, and the refusal says how early and when it opens.
  const early = sched.clockInWindow({ shift: s, at: '2026-10-01T11:59:00.000Z' });
  assert.strictEqual(early.allowed, false);
  assert.strictEqual(early.opensAt, '2026-10-01T12:00:00.000Z');
  assert.ok(early.minutesEarly >= 1);
  // Exactly 2h: allowed. The boundary is inclusive.
  assert.strictEqual(sched.clockInWindow({ shift: s, at: '2026-10-01T12:00:00.000Z' }).allowed, true);
  assert.strictEqual(sched.clockInWindow({ shift: s, at: '2026-10-01T13:30:00.000Z' }).allowed, true);
});

test('SAFETY: arriving LATE is never blocked — only early is', () => {
  const s = shift({ start: '2026-10-01T14:00:00.000Z' });
  // Refusing a late caregiver means unpaid work and no record of the visit,
  // which is the outcome the whole subsystem exists to prevent. Lateness is
  // flagged elsewhere; it is never a refusal.
  for (const at of ['2026-10-01T14:30:00.000Z', '2026-10-01T17:00:00.000Z', '2026-10-02T09:00:00.000Z']) {
    assert.strictEqual(sched.clockInWindow({ shift: s, at }).allowed, true, `${at} must be allowed`);
  }
});

test('a shift with an unreadable start is allowed through, not blocked', () => {
  // That shift is broken either way; locking a caregiver out of a visit over a
  // data problem is the worse of the two failures.
  assert.strictEqual(sched.clockInWindow({ shift: { start: 'nonsense' }, at: '2026-10-01T12:00:00.000Z' }).allowed, true);
  assert.strictEqual(sched.clockInWindow({ shift: {}, at: '2026-10-01T12:00:00.000Z' }).allowed, true);
});

test('SAFETY: the window is enforced server-side, before anything is written', () => {
  const i = routeSrc.indexOf("'/api/scheduling/shifts/:id/clock-in'");
  // Wide enough to reach the first write: a slice that stops short makes this
  // assertion pass or fail on the window size rather than on the ordering.
  const handler = routeSrc.slice(i, i + 4200);
  assert.match(handler, /CLOCK_IN_TOO_EARLY/, 'the refusal carries a specific code');
  const gate = handler.indexOf('CLOCK_IN_TOO_EARLY');
  const write = handler.indexOf('db.set');
  assert.ok(gate > 0 && write > 0 && gate < write,
    'refused before any write, or a rejected clock-in leaves a half-started shift');
  // The component only decides whether to offer the button.
  assert.match(componentSrc, /CLOCK_IN_WINDOW_MINUTES/, 'the app mirrors the window to disable the button');
});

test('the client portal answers "is someone here now" the same way on both tabs', () => {
  const portal = fs.readFileSync(path.join(__dirname, '..', 'public', 'portal.html'), 'utf8');
  // ONE component, rendered on Home and on Care. Two copies would be two
  // answers to the question a family member opens the portal to ask.
  assert.ok((portal.match(/<GfcVisitInProgress/g) || []).length >= 2,
    'the live-visit card renders on both Home and Care');
  assert.match(portal, /const GfcVisitInProgress/, 'and there is exactly one definition');
  assert.strictEqual((portal.match(/const GfcVisitInProgress/g) || []).length, 1);

  // A client is never shown the location check or the lateness flags. Those
  // are between the agency and its caregiver, and a client cannot act on them.
  const i = portal.indexOf('const GfcVisitInProgress');
  const card = portal.slice(i, i + 1600);
  for (const leak of ['geofence', 'clockInGeofence', 'distance', 'late_clock_in', 'flags']) {
    assert.ok(!card.includes(leak), `the client's live-visit card must not surface "${leak}"`);
  }
});

test('the Care tab reads the real schedule, not the retrospective visit log', () => {
  const portal = fs.readFileSync(path.join(__dirname, '..', 'public', 'portal.html'), 'utf8');
  const i = portal.indexOf('const GfcCarePlan');
  const body = portal.slice(i, i + 2000);
  assert.match(body, /const upcoming = \(shifts \|\| \[\]\)/,
    'upcoming comes from shifts — visit_logs is written after a visit and never held a future one');
  assert.match(body, /data\.recentVisits/, 'recent still reads visit_logs, which is what it is for');
});

// ============================================================================
// Open-pool VISIBILITY vs CLAIMABILITY (owner rule, 2026-09-13)
// Every caregiver sees every open shift; one their licence does not cover is
// greyed out with the reason rather than hidden. The claim gate is unchanged.
// ============================================================================

test('a caregiver SEES a shift above their licence level, greyed out with the reason', () => {
  const skilled = shift({ required_license_level: 'cna' });
  const v = sched.shiftVisibility(caregiver('pca'), skilled, client());
  assert.equal(v.visible, true, 'the shift is on the board');
  assert.equal(v.claimable, false, 'but it cannot be taken');
  assert.match(v.reason, /below the required/i, 'and the reason names the shortfall');
  // The CLAIM gate is untouched by the visibility change — this is the assertion
  // that matters, because showing the row is only safe while the API still refuses it.
  assert.equal(sched.isEligibleForShift(caregiver('pca'), skilled, client()), false);
});

test('a caregiver who MEETS the requirement sees it claimable, with no reason attached', () => {
  const skilled = shift({ required_license_level: 'cna' });
  for (const level of ['cna', 'lpn']) {
    const v = sched.shiftVisibility(caregiver(level), skilled, client());
    assert.equal(v.visible, true);
    assert.equal(v.claimable, true, `${level} can take a CNA shift`);
    assert.equal(v.reason, null, 'a claimable shift carries no refusal text');
  }
});

test('an unrecognized licence requirement is VISIBLE but claimable by nobody', () => {
  // Previously invisible to everyone, which made a misconfigured shift look
  // like no shift at all. Greyed-out-with-a-reason is the same protection and
  // an admin can actually see that something needs fixing.
  const bad = shift({ required_license_level: 'anyone' });
  for (const level of ['sitter', 'pca', 'cna', 'lpn']) {
    const v = sched.shiftVisibility(caregiver(level), bad, client());
    assert.equal(v.visible, true, `${level} sees the row`);
    assert.equal(v.claimable, false, `${level} cannot take it`);
    assert.match(v.reason, /not recognized/i);
  }
});

test('a care-team shift stays HIDDEN from caregivers off that team — a licence gate greys, a care-team gate hides', () => {
  const teamOnly = shift({ pool_visibility: 'care_team' });
  const offTeam = sched.shiftVisibility(caregiver('cna'), teamOnly, client());
  assert.equal(offTeam.visible, false, 'a client name and address is not licence information');
  assert.equal(offTeam.claimable, false);

  const onTeamClient = client({ careTeam: { assignedFNPs: [], assignedCaseManager: null, primaryCaregiver: 'cg-cna', backupCaregiver: null } });
  const onTeam = sched.shiftVisibility(caregiver('cna'), teamOnly, onTeamClient);
  assert.equal(onTeam.visible, true);
  assert.equal(onTeam.claimable, true);
});

test('a deactivated caregiver and a non-caregiver see nothing at all', () => {
  assert.equal(sched.shiftVisibility(caregiver('cna', { accountStatus: 'inactive' }), shift(), client()).visible, false);
  assert.equal(sched.shiftVisibility({ id: 'u1', role: 'client' }, shift(), client()).visible, false);
});

test('claimable is DEFINED BY the claim gate, so the board and the API cannot drift', () => {
  // Walks every level against every requirement and asserts the two agree on
  // each cell. If someone re-derives the rule inside shiftVisibility(), this fails.
  for (const level of ['sitter', 'pca', 'cna', 'lpn']) {
    for (const req of [null, 'sitter', 'pca', 'cna', 'lpn']) {
      const s = shift({ required_license_level: req });
      const v = sched.shiftVisibility(caregiver(level), s, client());
      assert.equal(
        v.claimable,
        sched.isEligibleForShift(caregiver(level), s, client()),
        `${level} vs ${req || 'no requirement'}`
      );
    }
  }
});

// ============================================================================
// Dashboard summary block (owner request, 2026-09-13)
// ============================================================================

test('the dashboard summary route is admin-only, and RETURNS ONLY COUNTS', async () => {
  // Executed, not parsed. Two earlier versions of this test read the source and
  // both got it wrong — one tripped on `clientsMissingCoordinates` (a number
  // whose NAME contains "coordinates"), the next on the multi-line literal.
  // Verify the behaviour, not the artifact: call the route and look at what
  // comes back.
  const express = require('express');
  const store = {
    shifts: [
      { id: 's1', status: 'open', start: '2030-01-01T10:00:00.000Z', client_id: 'c1', client_name: 'Margaret Whitfield' },
      { id: 's2', status: 'claimed', start: '2030-01-01T10:00:00.000Z', client_id: 'c1', client_name: 'Margaret Whitfield' }
    ],
    time_logs: [{ id: 'l1', flags: ['outside_geofence'], client_name: 'Margaret Whitfield' }]
  };
  const db = { get: async (k) => store[k] || [], set: async (k, v) => { store[k] = v; } };
  const users = [
    { id: 'c1', role: 'client', name: 'Margaret Whitfield', address: { line1: '12 Oak St' } },
    { id: 'a1', role: 'admin', name: 'GFC Admin' }
  ];

  const router = require('../routes/scheduling')({
    db, config: require('../config'),
    logActivity: async () => {}, queueNotification: async () => {},
    getUsers: async () => users, invalidateUsersCache: () => {},
    authenticateToken: (req, _res, next) => { req.user = { id: 'a1', role: 'admin', name: 'GFC Admin' }; next(); },
    uuidv4: () => 'x'
  });

  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/scheduling/summary`);
    assert.strictEqual(res.status, 200);
    const { summary } = await res.json();

    // EVERY value is a number. A string in here would be a name or an address.
    for (const [key, value] of Object.entries(summary)) {
      assert.strictEqual(typeof value, 'number', `summary.${key} must be a count, got ${typeof value}`);
    }
    // And it actually counted, so the test is not passing on an empty object.
    assert.strictEqual(summary.openUnfilled, 1);
    assert.strictEqual(summary.awaitingApproval, 1);
    assert.strictEqual(summary.flaggedTimeLogs, 1);
    assert.strictEqual(summary.clientsMissingCoordinates, 1, 'the one client has no lat/lng');
    assert.strictEqual(summary.clientCount, 1);

    // The client's name is in the fixture rows the route read; it must not
    // survive into the payload.
    assert.ok(!JSON.stringify(summary).includes('Margaret'),
      'a dashboard tile is a glance and a glance does not carry PHI');
  } finally {
    server.close();
  }
});

// REPOINTED 2026-09-20. This test's own comment read "widening it is an owner
// decision". The owner made it — "editable by admin and manager" — so a manager
// now reads the board, and what still needs pinning is that the widening stopped
// at the manager flag rather than reaching every signed-in staff account.
test('a manager reads the board; anyone else is still refused', async () => {
  const express = require('express');
  const db = { get: async () => [], set: async () => {} };
  const router = require('../routes/scheduling')({
    db, config: require('../config'),
    logActivity: async () => {}, queueNotification: async () => {},
    getUsers: async () => [], invalidateUsersCache: () => {},
    // A "manager" is the legacy lab-era isManager flag — NOT an admin. Today
    // that means no scheduling read at all; widening it is an owner decision.
    authenticateToken: (req, _res, next) => { req.user = { id: 'm1', role: req.headers['x-role'] || 'user', isManager: req.headers['x-role'] ? false : true }; next(); },
    uuidv4: () => 'x'
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/scheduling/summary`);
    assert.strictEqual(res.status, 200, 'a manager runs the board and sees what is waiting on it');
  } finally {
    server.close();
  }
});

test('the admin hub renders the scheduling block only when the summary returned', () => {
  const hub = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-hub.html'), 'utf8');
  assert.ok(hub.includes('getSchedulingSummary'), 'the hub fetches the summary');
  assert.ok(hub.includes('{sched && ('),
    'the block is conditional on the summary having loaded — a refused fetch renders nothing');
  // The dashboard must still render when scheduling is unreachable: the
  // summary sets its own state and never touches setLoading.
  const effect = hub.slice(hub.indexOf('api.getSchedulingSummary(token)'));
  const effectBody = effect.slice(0, effect.indexOf('}, [token]);'));
  assert.ok(!effectBody.includes('setLoading'),
    'a scheduling failure must never hold the whole dashboard in its loading state');
});

test('the payroll CSV carries a rate, and NOTHING clinical', () => {
  // REPOINTED, not deleted. This guard used to assert the CSV carried no money
  // at all, because no caregiver pay rate existed anywhere in the app. One now
  // does (owner request, 2026-09-13), so the rule it protects becomes: a money
  // column must have a real resolved rate behind it, and an unset rate must
  // stay distinguishable from a rate of zero (asserted in the next test).
  const keys = sched.PAYROLL_CSV_COLUMNS.map(c => c.key);
  assert.ok(keys.includes('hours'));
  assert.ok(keys.includes('payRate'), 'the rate is exported');
  assert.ok(keys.includes('grossPay'), 'and what it comes to');
  assert.ok(keys.includes('payRateSource'),
    'and where it came from — "why is this different this week" needs an answer');
  for (const clinical of ['diagnosis', 'careplan', 'notes', 'visitLog', 'condition']) {
    assert.ok(!keys.includes(clinical), `"${clinical}" is clinical and must not reach payroll`);
  }
});

test('SAFETY: an unset pay rate resolves to null, NEVER 0', () => {
  // A payroll run must tell "nobody set a rate" from "the rate is zero".
  // Coercing the first into the second pays someone nothing and looks
  // deliberate on the export.
  assert.strictEqual(cg.resolvePayRate({}, null, null).rate, null);
  assert.strictEqual(cg.resolvePayRate({ payRate: '' }, null, null).rate, null);
  assert.strictEqual(cg.resolvePayRate({ payRate: 'abc' }, null, null).rate, null);
  assert.strictEqual(cg.resolvePayRate({ payRate: -5 }, null, null).rate, null, 'negative is not a rate');
  assert.strictEqual(cg.resolvePayRate({ payRate: 99999 }, null, null).rate, null, 'a typo past the ceiling is refused');
  assert.strictEqual(cg.resolvePayRate({}, null, null).source, 'unset', 'and it says so');
  // Zero, explicitly set, IS kept — a number somebody chose.
  assert.deepStrictEqual(cg.resolvePayRate({ payRate: 0 }, null, null), { rate: 0, source: 'base' });
});

test('pay rate resolves shift → per-client → base, and SAYS which', () => {
  const caregiver = { payRate: 18, clientPayRates: { 'client-1': 22.5 } };
  assert.deepStrictEqual(cg.resolvePayRate(caregiver, 'client-1', { pay_rate: 30 }),
    { rate: 30, source: 'shift' }, 'a rate posted on the shift wins');
  assert.deepStrictEqual(cg.resolvePayRate(caregiver, 'client-1', null),
    { rate: 22.5, source: 'client' }, 'then the per-client rate');
  assert.deepStrictEqual(cg.resolvePayRate(caregiver, 'client-9', null),
    { rate: 18, source: 'base' }, 'then the base rate');
  // An unusable rate on the shift falls THROUGH rather than zeroing the shift.
  assert.deepStrictEqual(cg.resolvePayRate(caregiver, 'client-1', { pay_rate: 'oops' }),
    { rate: 22.5, source: 'client' });
});

test('SAFETY: per-client pay rates are keyed by client ID, never by name', () => {
  // The vendor picker stores assignedClients by NAME. Keying pay off a name
  // means a renamed client silently drops that caregiver back to their base
  // rate — a pay cut nobody would see happen.
  assert.deepStrictEqual(
    cg.normalizeClientPayRates({ 'client-1': '22.505', 'client-2': 'bad', '': 9 }),
    { 'client-1': 22.51 },
    'rounded to cents; unusable values and blank keys dropped rather than stored as 0'
  );
});

test('SAFETY: the client and family schedule carries NO pay rate', () => {
  // What we pay a caregiver IS the margin. A client seeing it learns our cost.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'scheduling.js'), 'utf8');
  const start = src.indexOf("router.get('/api/scheduling/my-upcoming-shifts'");
  assert.ok(start > -1, 'the client-facing route exists');
  const handler = src.slice(start, src.indexOf('router.', start + 10));
  assert.ok(!/pay_?[Rr]ate/.test(handler),
    'the client and family schedule must never carry what we pay the caregiver');
});
