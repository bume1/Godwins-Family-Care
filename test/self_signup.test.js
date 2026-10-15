// Self sign-up (owner, 2026-10-12): a request staff approve, never an account.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const S = require('../signupRequests');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const ok = (o) => Object.assign({ name: 'Jordan Smith', dob: '1960-05-01', email: 'J@Example.test', phone: '404-555-0100', password: 'longenough', who: 'self',
  address: { line1: '1 Main', city: 'Marietta', state: 'ga', zip: '30060-1234' }, interests: ['home_care'], agreeTerms: true }, o || {});

test('the form is checked field by field, and each refusal names its field', () => {
  const cases = [[{ name: 'Jordan' }, 'name'], [{ dob: '2999-01-01' }, 'dob'], [{ email: 'x' }, 'email'], [{ phone: '555' }, 'phone'], [{ password: 'short' }, 'password'],
    [{ who: 'neighbour' }, 'who'], [{ who: 'loved_one' }, 'patientName'], [{ address: { line1: '', city: '', zip: '' } }, 'address'], [{ interests: ['spa'] }, 'interests'], [{ agreeTerms: 'yes' }, 'agreeTerms']];
  for (const [over, field] of cases) assert.equal(S.normalizeSignup(ok(over), { today: '2026-10-12' }).field, field, JSON.stringify(over));
  const v = S.normalizeSignup(ok(), { today: '2026-10-12' }).value;
  assert.equal(v.email, 'j@example.test'); assert.equal(v.phone, '4045550100'); assert.equal(v.address.state, 'GA'); assert.equal(v.address.zip, '30060');
});

test('the stored row never holds the password or the plain token', () => {
  const v = S.normalizeSignup(ok(), { today: '2026-10-12' }).value;
  const row = S.buildSignupRow({ id: 'r1', value: v, passwordHash: 'HASH', token: 'tok123', at: '2026-10-12T00:00:00Z' });
  assert.ok(!('password' in row)); assert.equal(row.passwordHash, 'HASH');
  assert.ok(!JSON.stringify(row).includes('tok123')); assert.equal(row.verifyTokenHash, S.hashToken('tok123'));
  assert.equal(row.status, 'unverified');
  assert.ok(!('passwordHash' in S.staffRow(row)) && !('verifyTokenHash' in S.staffRow(row)));
});

test('a link works once, within its window, and a made-up one is refused', () => {
  const row = { id: 'r', verifyTokenHash: S.hashToken('t'), status: 'unverified', verifyExpiresAt: '2026-10-14T00:00:00Z' };
  assert.equal(S.findByToken([row], 'nope', '2026-10-12T00:00:00Z').code, 'SIGNUP_LINK_INVALID');
  assert.equal(S.findByToken([row], 't', '2026-10-15T00:00:00Z').code, 'SIGNUP_LINK_EXPIRED');
  assert.equal(S.findByToken([row], 't', '2026-10-12T00:00:00Z').idx, 0);
  assert.equal(S.findByToken([{ ...row, status: 'verified' }], 't', '2026-10-15T00:00:00Z').already, true);
});

test('a decision needs a confirmed email, a client to link to, or a reason', () => {
  const v = { status: 'verified' };
  assert.equal(S.checkDecision({ status: 'unverified' }, { action: 'approve_client' }).code, 'SIGNUP_NOT_VERIFIED');
  assert.equal(S.checkDecision({ status: 'approved' }, { action: 'approve_client' }).code, 'SIGNUP_ANSWERED');
  assert.equal(S.checkDecision(v, { action: 'link_family' }).code, 'SIGNUP_LINK_CLIENT_REQUIRED');
  assert.equal(S.checkDecision(v, { action: 'decline', reason: '  ' }).code, 'SIGNUP_DECLINE_REASON_REQUIRED');
  assert.equal(S.checkDecision(v, { action: 'approve_client' }), null);
});

test('the intake starts from the person the care is for, with insurance in the intake\'s own fields', () => {
  const self = S.intakeFor({ id: 'r', who: 'self', name: 'Mary Ann Smith', dob: '1950-01-01', phone: '4045550100', email: 'm@x.co', address: { line1: 'a' }, insurance: { coverage: 'Private insurance', carrier: 'Aetna', memberId: 'W1' } });
  assert.equal(self.firstName, 'Mary Ann'); assert.equal(self.lastName, 'Smith');
  assert.deepEqual(self.commercial, { carrier: 'Aetna', memberId: 'W1' });
  const lo = S.intakeFor({ id: 'r', who: 'loved_one', name: 'Kelvin Ume', phone: '1', email: 'k@x.co', address: {}, insurance: {}, patient: { name: 'Mary Ume', dob: '1938-01-10', relationship: 'Child' } });
  assert.equal(lo.firstName, 'Mary'); assert.equal(lo.dob, '1938-01-10'); assert.equal(lo.primaryContact.name, 'Kelvin Ume'); assert.equal(lo.phone, '');
  assert.equal(S.serviceLineFor(['home_care', 'primary_care']), 'BOTH'); assert.equal(S.serviceLineFor(['not_sure']), null);
});

test('the limiter caps one key per window', () => {
  const lim = S.makeLimiter({ max: 2, windowMs: 1000 });
  assert.equal(lim('a', 0), false); assert.equal(lim('a', 1), false); assert.equal(lim('a', 2), true); assert.equal(lim('b', 2), false); assert.equal(lim('a', 1500), false);
});

test('build guard: sign-in reveals a sign-up only to its password; an admin, manager or coordinator decides; accounts start at intake_pending; never a POA', () => {
  const login = server.slice(server.indexOf("app.post('/api/auth/login'"), server.indexOf("app.post('/api/auth/client-login'"));
  assert.match(login, /if \(pending && await bcrypt\.compare\(password, pending\.passwordHash\)\)/);
  assert.match(server, /app\.post\('\/api\/gfc\/admin\/signups\/:id\/decide', authenticateToken, requireEnrollmentManager, /);
  const decide = server.slice(server.indexOf("app.post('/api/gfc/admin/signups/:id/decide'"), server.indexOf('// Family invites waiting on staff'));
  assert.match(decide, /enrollmentStatus: 'intake_pending',/);
  assert.match(decide, /familyIsPoa: false,/);
  assert.ok(!/enrollmentStatus: 'enrolled'/.test(decide));
  // the public form answers the same for a known email
  const form = server.slice(server.indexOf("app.post('/api/auth/self-signup',"), server.indexOf("app.post('/api/auth/self-signup/verify'"));
  assert.match(form, /if \(taken\) return res\.json\(\{ message: SIGNUP_DONE \}\);/);
  assert.match(form, /if \(b\.website\) return res\.json\(\{ message: SIGNUP_DONE \}\);/);
});
