// Service line and rate changes that wait for the owner (owner, 2026-10-19),
// the live consent banners, and the clinical enrollment step gate.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ec = require('../enrollmentChanges');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-enrollment.html'), 'utf8');
const ADMIN = { id: 'a1', name: 'Owner', role: 'admin' };
const COORD = { id: 'c1', name: 'Cora', role: 'user', isManager: true, clinicalRole: 'coordinator' };
const MGR = { id: 'm1', name: 'Morgan', role: 'user', isManager: true };
const sliceRoute = (start, end) => SERVER.slice(SERVER.indexOf(start), SERVER.indexOf(end, SERVER.indexOf(start) + 10));

test('only the Super Admin approves; managers and coordinators ask', () => {
  assert.strictEqual(ec.needsApproval(ADMIN), false);
  assert.strictEqual(ec.needsApproval(COORD), true);
  assert.strictEqual(ec.needsApproval(MGR), true);
  assert.strictEqual(ec.needsApproval(null), true);
  assert.strictEqual(ec.canApprove(ADMIN), true);
  assert.strictEqual(ec.canApprove({ ...ADMIN, accountStatus: 'inactive' }), false);
  assert.strictEqual(ec.canApprove(COORD), false);
  assert.strictEqual(ec.canApprove(MGR), false);
});

test('a request is stored, the client value is untouched, and a newer ask supersedes the older', () => {
  const client = { serviceLine: 'PHC' };
  const a = ec.fileRequest(client, { kind: 'service_line', value: 'BOTH', previous: 'PHC', actor: COORD });
  assert.strictEqual(client.serviceLine, 'PHC');
  assert.strictEqual(a.status, 'pending');
  assert.match(a.summary, /PHC → BOTH/);
  const b = ec.fileRequest(client, { kind: 'service_line', value: 'IHPC', previous: 'PHC', actor: MGR });
  assert.strictEqual(client.enrollmentChangeRequests.find(r => r.id === a.id).status, 'superseded');
  assert.strictEqual(ec.pendingOf(client, 'service_line').id, b.id);
  assert.strictEqual(ec.pendingCount(client), 1);
  // A rate request is its own kind and does not supersede a line request.
  ec.fileRequest(client, { kind: 'rate', value: { hourlyRate: 30, dailyMinimumHours: 4 }, previous: null, actor: COORD });
  assert.strictEqual(ec.pendingCount(client), 2);
  assert.throws(() => ec.fileRequest(client, { kind: 'nope', value: 1, actor: COORD }));
});

test('approving checks the value has not moved; declining needs a reason', () => {
  const client = { serviceLine: 'PHC' };
  const r = ec.fileRequest(client, { kind: 'service_line', value: 'BOTH', previous: 'PHC', actor: COORD });
  assert.strictEqual(ec.checkDecision(client, r.id, 'approve', '', 'PHC').ok, true);
  const stale = ec.checkDecision(client, r.id, 'approve', '', 'IHPC');
  assert.strictEqual(stale.ok, false); assert.strictEqual(stale.code, 'CHANGE_REQUEST_STALE');
  const noReason = ec.checkDecision(client, r.id, 'decline', '  ', 'PHC');
  assert.strictEqual(noReason.code, 'DECLINE_REASON_REQUIRED');
  assert.strictEqual(ec.checkDecision(client, r.id, 'maybe', '', 'PHC').code, 'BAD_DECISION');
  assert.strictEqual(ec.checkDecision(client, 'missing', 'approve', '', 'PHC').status, 404);
  ec.recordDecision(client, r.id, 'decline', ADMIN, 'Not yet');
  assert.strictEqual(ec.checkDecision(client, r.id, 'approve', '', 'PHC').code, 'CHANGE_REQUEST_DECIDED');
  const row = client.enrollmentChangeRequests.find(x => x.id === r.id);
  assert.strictEqual(row.status, 'declined'); assert.strictEqual(row.decisionNote, 'Not yet'); assert.strictEqual(row.decidedBy.id, 'a1');
});

test('a rate request compares on the two printed numbers, not the wording', () => {
  const prev = { hourlyRate: 30, dailyMinimumHours: 4, includedServices: 'x' };
  const client = { rateAgreement: prev };
  const r = ec.fileRequest(client, { kind: 'rate', value: { hourlyRate: 32, dailyMinimumHours: 4 }, previous: prev, actor: COORD });
  assert.strictEqual(ec.checkDecision(client, r.id, 'approve', '', { ...prev, includedServices: 'y' }).ok, true);
  assert.strictEqual(ec.checkDecision(client, r.id, 'approve', '', { ...prev, hourlyRate: 31 }).code, 'CHANGE_REQUEST_STALE');
});

test('the screen shows pending plus 30 days of answers, newest first', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const client = { enrollmentChangeRequests: [
    { id: '1', kind: 'rate', status: 'pending', requestedAt: '2026-10-18T00:00:00Z' },
    { id: '2', kind: 'rate', status: 'declined', requestedAt: '2026-10-10T00:00:00Z', decidedAt: '2026-10-11T00:00:00Z' },
    { id: '3', kind: 'rate', status: 'approved', requestedAt: '2026-08-01T00:00:00Z', decidedAt: '2026-08-02T00:00:00Z' },
    { id: '4', kind: 'rate', status: 'superseded', requestedAt: '2026-10-17T00:00:00Z', decidedAt: '2026-10-18T00:00:00Z' }
  ] };
  assert.deepStrictEqual(ec.forDisplay(client, now).map(r => r.id), ['1', '2']);
});

test('a consent banner clears a line only when it is signed AFTER the banner went up', () => {
  const sat = (s) => s === 'signed' || s === 'signed_offline';
  const title = (t) => t.toUpperCase();
  const flag = { reason: 'rate_changed', at: '2026-10-10T00:00:00Z', consents: ['a', 'b'], titles: ['A', 'B'] };
  // Signed before the rate changed: that is exactly why the banner exists.
  const old = { a: { signedAt: '2026-10-01T00:00:00Z' }, b: { signedAt: '2026-10-01T00:00:00Z' } };
  assert.deepStrictEqual(ec.liveConsentFlag(flag, { a: 'signed', b: 'signed' }, old, sat, title).consents, ['a', 'b']);
  // Re-signed in the app after it went up.
  const resigned = { ...old, a: { signedAt: '2026-10-12T00:00:00Z' } };
  assert.deepStrictEqual(ec.liveConsentFlag(flag, { a: 'signed', b: 'signed' }, resigned, sat, title).consents, ['b']);
  // A paper copy dated earlier but RECORDED after the banner counts.
  const paper = { ...resigned, b: { signedAt: '2026-10-05T00:00:00Z', recordedAt: '2026-10-13T00:00:00Z' } };
  assert.strictEqual(ec.liveConsentFlag(flag, { a: 'signed', b: 'signed_offline' }, paper, sat, title), null);
  // Still pending is still listed, whatever its meta says.
  assert.deepStrictEqual(ec.liveConsentFlag(flag, { a: 'pending', b: 'signed_offline' }, paper, sat, title).consents, ['a']);
  assert.strictEqual(ec.liveConsentFlag(null, {}, {}, sat, title), null);
});

test('the routes: a manager or coordinator asks, an admin applies, one commit for both', () => {
  const sl = sliceRoute("app.put('/api/gfc/admin/enrollment/:clientId/service-line'", '\n});\n');
  assert.match(sl, /requireEnrollmentManager/);
  assert.ok(sl.indexOf('enrollmentChanges.needsApproval(req.user)') > 0 &&
    sl.indexOf('enrollmentChanges.needsApproval(req.user)') < sl.indexOf('await commitServiceLine('), 'the approval check runs before anything is applied');
  assert.match(sl, /status\(202\)/);
  const rate = sliceRoute("app.put('/api/gfc/admin/enrollment/:clientId/rate'", '\n});\n');
  assert.ok(rate.indexOf('enrollmentChanges.needsApproval(req.user)') > 0 &&
    rate.indexOf('enrollmentChanges.needsApproval(req.user)') < rate.indexOf('await commitRate('));
  assert.ok(!/rateAgreement = built/.test(rate), 'the rate route never writes the rate itself');
  const decide = sliceRoute("app.post('/api/gfc/admin/enrollment/:clientId/change-requests/:requestId/decide'", '\n});\n');
  assert.match(decide, /authenticateToken, requireAdmin,/);
  assert.match(decide, /await commitServiceLine\(users, idx, row\.value, req\.user, extraLog\)/);
  assert.match(decide, /await commitRate\(users, idx, row\.value, req\.user, extraLog\)/);
  assert.ok(decide.indexOf('checkDecision(') < decide.indexOf('recordDecision('), 'checked before it is recorded');
});

test('the detail serves live banners, the requests and who may approve', () => {
  assert.match(SERVER, /consentActionRequired: enrollmentChanges\.liveConsentFlag\(client\.consentActionRequired, consents, consentMeta,/);
  assert.match(SERVER, /consentReaffirmRequired: enrollmentChanges\.liveConsentFlag\(client\.consentReaffirmRequired/);
  assert.match(SERVER, /changeRequests: enrollmentChanges\.forDisplay\(client\)/);
  assert.match(SERVER, /canApproveChanges: enrollmentChanges\.canApprove\(req\.user\)/);
});

test('the clinical enrollment steps admit managers and coordinators as well as clinicians', () => {
  for (const p of ["app.post('/api/clinical/patients/:clientId/checklist/:stepKey'", "app.post('/api/clinical/patients/:clientId/activate'"]) {
    assert.match(SERVER.slice(SERVER.indexOf(p), SERVER.indexOf(p) + 160), /authenticateToken, requireClinicalEnrollmentStep,/, p);
  }
  const gate = SERVER.slice(SERVER.indexOf('const requireClinicalEnrollmentStep ='), SERVER.indexOf('const requireClinicalWrite ='));
  assert.match(gate, /patientRead\.canClinicalWrite\(req\.user\) \|\| canManageEnrollment\(req\.user\)/);
});

test('the page asks the server who approves, and offers approve only to them', () => {
  assert.match(PAGE, /client\.canApproveChanges && declining !== r\.id/);
  assert.match(PAGE, /client\.changesNeedApproval \? 'Send for Approval'/);
  assert.match(PAGE, /key: 'awaiting_approval'/);
  // canEditChecklist stays "manager or clinician", which now matches the route.
  assert.match(PAGE, /const canEditChecklist = canEdit \|\| !!\(user && user\.hasClinicalAccess\);/);
});
