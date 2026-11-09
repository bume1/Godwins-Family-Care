'use strict';

// Clinician availability (owner, 2026-11-08): clinicians use the caregiver
// availability form, into the same records, and booking a clinical visit
// outside it is WARNED with a reason, never blocked.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sched = require('../schedulingRepository');
const t = require('../public/gfc-time');

const at = (d, hhmm, mins) => { const s = t.instantFromZoned(d, hhmm); return [s, new Date(Date.parse(s) + mins * 60000).toISOString()]; };
const ROWS = [
  { caregiver_id: 'np', submitted_at: '2026-10-01T12:00:00Z', effective_from: '2026-10-01', windows: [{ day: 'Mon', start: '08:00', end: '12:00' }], blackout_dates: [] },
  { caregiver_id: 'np', submitted_at: '2026-11-01T12:00:00Z', effective_from: '2026-11-01', windows: [{ day: 'Tue', start: '09:00', end: '17:00' }], blackout_dates: ['2026-11-17'] }
];

test('the submission in force is the newest, and it covers the whole visit or it does not', () => {
  assert.strictEqual(sched.availabilityVerdict(ROWS, 'np', ...at('2026-11-10', '10:00', 60)).status, 'INSIDE');
  assert.strictEqual(sched.availabilityVerdict(ROWS, 'np', ...at('2026-11-10', '16:30', 60)).status, 'OUTSIDE', 'runs past the window');
  assert.strictEqual(sched.availabilityVerdict(ROWS, 'np', ...at('2026-11-09', '09:00', 60)).status, 'OUTSIDE', 'Monday was the OLD submission');
  assert.strictEqual(sched.availabilityVerdict(ROWS, 'np', ...at('2026-11-17', '10:00', 60)).status, 'OUTSIDE', 'a blackout date');
  assert.strictEqual(sched.availabilityVerdict(ROWS, 'other', ...at('2026-11-10', '10:00', 60)).status, 'NONE');
});

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('booking and rescheduling both check availability before the slot conflict, and refuse only without a reason', () => {
  const fnAt = server.indexOf('async function clinicianAvailabilityCheck(');
  const fn = server.slice(fnAt, server.indexOf('\n}\n', fnAt));
  assert.ok(fnAt > 0);
  assert.match(fn, /availabilityVerdict\(/);
  assert.match(fn, /APPOINTMENT_OUTSIDE_AVAILABILITY/);
  assert.match(fn, /outsideAvailabilityReason/, 'a reason lets it through: a warning, never a block');
  assert.match(fn, /appointment_outside_availability/, 'and the reason is recorded');
  const calls = server.match(/await clinicianAvailabilityCheck\(providerId, body, built\.minutes, req\)/g) || [];
  assert.strictEqual(calls.length, 2, 'booking and rescheduling');
});

test('clinicians enter availability on the shared form, in the clinical Schedule view', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
  assert.match(page, /<script src="\/components\/caregiver-schedule\.js"><\/script>/);
  assert.match(page, /onlyTabs: \['availability'\]/);
  assert.match(page, /APPOINTMENT_OUTSIDE_AVAILABILITY/, 'the booking form asks for the reason');
});
