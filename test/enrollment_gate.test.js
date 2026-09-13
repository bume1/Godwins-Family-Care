// The enrollment gate on scheduling.
//
// Before this existed, `enrolled` was a decoration: intake_complete already
// unlocked the portal, and nothing checked enrollment before work was scheduled
// against a person. These tests hold the rule and, just as importantly, hold the
// override to being LOUD — an override that leaves no trace is the failure it
// was built to prevent.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const gate = require('../enrollmentGate');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const ADMIN = { id: 'a1', role: 'admin', name: 'GFC Admin' };
const STAFF = { id: 's1', role: 'user', name: 'Bethel Godwins' };
const client = (status) => ({ id: 'c1', role: 'client', name: 'Ada Bell', enrollmentStatus: status });

// ===========================================================================
// The rule
// ===========================================================================

test('only an enrolled client may have care scheduled against them', () => {
  assert.strictEqual(gate.schedulingEligibility(client('enrolled')).allowed, true);
  assert.strictEqual(gate.schedulingEligibility(client('intake_complete')).allowed, false);
  assert.strictEqual(gate.schedulingEligibility(client('intake_pending')).allowed, false);
});

test('a client with no status at all is treated as intake_pending, never as enrolled', () => {
  // Failing open here would mean a brand-new record schedules freely, which is
  // the exact state the gate exists to catch.
  const e = gate.schedulingEligibility({ id: 'c1', role: 'client', name: 'Ada Bell' });
  assert.strictEqual(e.allowed, false);
  assert.strictEqual(e.status, 'intake_pending');
});

test('a missing client is CLIENT_NOT_FOUND, which is a different fact from not enrolled', () => {
  const e = gate.schedulingEligibility(null);
  assert.strictEqual(e.allowed, false);
  assert.strictEqual(e.code, 'CLIENT_NOT_FOUND');
  assert.notStrictEqual(e.code, 'CLIENT_NOT_ENROLLED');
});

test('the refusal names which state the client is in, because the next action differs', () => {
  // intake_complete is waiting on STAFF. intake_pending is waiting on the
  // CLIENT. One message for both would send someone chasing the wrong person.
  const pending = gate.schedulingEligibility(client('intake_pending')).message;
  const complete = gate.schedulingEligibility(client('intake_complete')).message;
  assert.notStrictEqual(pending, complete);
  assert.match(complete, /approved|administrator/i);
  assert.match(pending, /consents|intake/i);
  // And it names the client, so an admin working a list knows which row it is.
  assert.match(pending, /Ada Bell/);
});

// ===========================================================================
// The override
// ===========================================================================

test('an admin can schedule over the gate with a reason', () => {
  const v = gate.checkSchedulingAllowed(
    client('intake_pending'), { override: true, overrideReason: 'Hospital discharge tomorrow' }, ADMIN, true);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.override.reason, 'Hospital discharge tomorrow');
  assert.strictEqual(v.override.byId, 'a1');
});

test('an override with no reason is refused, and nothing is allowed through', () => {
  for (const reason of [undefined, '', '   ']) {
    const v = gate.checkSchedulingAllowed(client('intake_pending'), { override: true, overrideReason: reason }, ADMIN, true);
    assert.strictEqual(v.ok, false, `reason ${JSON.stringify(reason)} should not pass`);
    assert.strictEqual(v.code, 'OVERRIDE_REASON_REQUIRED');
    assert.strictEqual(v.status, 400);
  }
});

test('a non-admin cannot override, and is told that rather than that the reason was wrong', () => {
  const v = gate.checkSchedulingAllowed(
    client('intake_pending'), { override: true, overrideReason: 'urgent' }, STAFF, false);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, 'OVERRIDE_ADMIN_ONLY');
  assert.strictEqual(v.status, 403);
});

test('the override FREEZES the status it overrode, so later progress cannot erase it', () => {
  // Recomputing this on read would make an override vanish the moment the
  // missing consent was filed — the record would then show a clean approval.
  const v = gate.checkSchedulingAllowed(
    client('intake_pending'), { override: true, overrideReason: 'urgent' }, ADMIN, true);
  assert.strictEqual(v.override.enrollmentStatus, 'intake_pending');
  assert.ok(v.override.at, 'the override is timestamped');
  assert.strictEqual(v.override.byName, 'GFC Admin');
});

test('no override is stamped when the client was enrolled anyway', () => {
  // An override flag on a request that did not need one must not leave a
  // record saying the gate was bypassed.
  const v = gate.checkSchedulingAllowed(
    client('enrolled'), { override: true, overrideReason: 'belt and braces' }, ADMIN, true);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.override, null);
});

test('without an override the refusal is 409 and tells an admin one exists', () => {
  const asAdmin = gate.checkSchedulingAllowed(client('intake_complete'), {}, ADMIN, true);
  assert.strictEqual(asAdmin.ok, false);
  assert.strictEqual(asAdmin.status, 409);
  assert.strictEqual(asAdmin.overridable, true);
  // A non-admin is not offered a door they cannot open.
  const asStaff = gate.checkSchedulingAllowed(client('intake_complete'), {}, STAFF, false);
  assert.strictEqual(asStaff.overridable, false);
});

test('an override reason is bounded, so a pasted document cannot land in the record', () => {
  const v = gate.checkSchedulingAllowed(
    client('intake_pending'), { override: true, overrideReason: 'x'.repeat(5000) }, ADMIN, true);
  assert.strictEqual(v.override.reason.length, 1000);
});

// ===========================================================================
// Build enforcement — the gate has to be CALLED, not merely available
// ===========================================================================

test('every route that creates work against a client passes through the gate', () => {
  const src = read('routes/scheduling.js');
  // Posting a shift and requesting one are the two write paths that name a
  // client. Both must gate before anything is written.
  for (const route of ["router.post('/api/scheduling/shifts'", "router.post('/api/scheduling/shift-requests'"]) {
    const at = src.indexOf(route);
    assert.notStrictEqual(at, -1, `${route} still exists`);
    const body = src.slice(at, src.indexOf('router.', at + 10));
    const gateAt = body.indexOf('gateScheduling(');
    const writeAt = body.indexOf('db.set(');
    assert.ok(gateAt !== -1, `${route} calls the gate`);
    assert.ok(writeAt === -1 || gateAt < writeAt, `${route} gates BEFORE it writes`);
  }
});

test('the clinical appointment booking route enforces the same gate from the same module', () => {
  const src = read('server.js');
  const at = src.indexOf("app.post('/api/clinical/patients/:clientId/appointments'");
  assert.notStrictEqual(at, -1);
  const body = src.slice(at, at + 6000);
  assert.match(body, /enrollmentGate\.checkSchedulingAllowed/,
    'clinical booking calls the shared gate — a second copy of the rule would drift from the PHCP one');
});

test('the gate does NOT block finishing work already in flight', () => {
  // Care that was given gets documented whatever the paperwork says. Refusing
  // the clock-out loses the visit and the caregiver's pay without un-giving
  // the care.
  const src = read('routes/scheduling.js');
  for (const route of ["shifts/:id/clock-in'", "shifts/:id/clock-out'"]) {
    const at = src.indexOf(route);
    assert.notStrictEqual(at, -1, `${route} still exists`);
    const body = src.slice(at, src.indexOf('router.', at + 10));
    assert.ok(!body.includes('gateScheduling('), `${route} must not be gated`);
  }
});

test('the schedulable status is named once, not inlined at each call site', () => {
  assert.strictEqual(gate.SCHEDULABLE_STATUS, 'enrolled');
  const src = read('routes/scheduling.js');
  assert.ok(!/enrollmentStatus\s*===\s*['"]enrolled['"]/.test(src),
    'scheduling routes read the rule from enrollmentGate, they do not restate it');
});

// ===========================================================================
// The approval override — the same decision, one layer up
//
// `enrolled` is now what unlocks scheduling, so the button that grants it needs
// the same documented way through, for the same reason: a gate with no visible
// bypass gets bypassed invisibly. The dropdown on the user form is the other
// door onto this status and is dealt with below.
// ===========================================================================

test('approving over missing items requires a reason, and freezes what was missing', () => {
  const src = read('server.js');
  const at = src.indexOf("app.post('/api/gfc/admin/enrollment/:clientId/approve'");
  assert.notStrictEqual(at, -1);
  const body = src.slice(at, src.indexOf('\napp.', at + 10));

  assert.match(body, /OVERRIDE_REASON_REQUIRED/, 'an override with no reason is refused');
  assert.match(body, /overridable: true/, 'the 409 tells an admin the override exists');
  // Frozen onto the record, not recomputed. Recomputing would erase the
  // override the moment somebody filed the missing consent.
  assert.match(body, /missingConsents: comp\.missingConsentLabels/);
  assert.match(body, /missingFields: comp\.missingFieldLabels/);
});

test('a complete approval records no override at all', () => {
  const src = read('server.js');
  const at = src.indexOf("app.post('/api/gfc/admin/enrollment/:clientId/approve'");
  const body = src.slice(at, src.indexOf('\napp.', at + 10));
  assert.match(body, /override: overrode \? \{/,
    'an override flag on an already-complete file must not leave a record saying the gate was bypassed');
});

test('the approval notifies the client, which it never used to', () => {
  const src = read('server.js');
  const at = src.indexOf("app.post('/api/gfc/admin/enrollment/:clientId/approve'");
  const body = src.slice(at, src.indexOf('\napp.', at + 10));
  assert.match(body, /phcNotify\.enrollmentApproved\(/);
  assert.match(body, /overridden: overrode/,
    'an overridden approval must not tell the client their file is complete');
});

test('an override is written to the activity log with its reason', () => {
  const src = read('server.js');
  const at = src.indexOf("app.post('/api/gfc/admin/enrollment/:clientId/approve'");
  const body = src.slice(at, src.indexOf('\napp.', at + 10));
  const logAt = body.indexOf("'enrollment_approved'");
  assert.notStrictEqual(logAt, -1);
  assert.match(body.slice(logAt, logAt + 400), /override: true[\s\S]*reason:/);
});

test('the override reaches every reader of the board, not just the store', () => {
  // A stamp that lives only in the KV row is barely better than a silent
  // override. The live probe caught this: the shift stored it and the API
  // projection dropped it, so no screen could ever show it.
  const src = read('routes/scheduling.js');
  const at = src.indexOf('const publicShift =');
  assert.notStrictEqual(at, -1);
  const body = src.slice(at, src.indexOf('const publicTimeLog', at));
  assert.match(body, /enrollmentOverride: r\.enrollment_override/);
});
