// Self-service password reset (owner, 2026-11-17): "turn this into an
// automated password reset function that I don't have to go in and do."
// Pins the link rules in passwordSetLinks.js and how server.js uses them.
// The full flow runs over HTTP in scripts/verify_password_reset.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('../passwordSetLinks');
const config = require('../config');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const T0 = new Date('2026-11-17T15:00:00Z');
const later = (min) => new Date(T0.getTime() + min * 60000);

test('a link stores only a fingerprint of its token, and expires in 1 hour (24 for an admin link)', () => {
  const { token, record } = L.buildLink({ userId: 'u1', purpose: 'self_service', now: T0 });
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(record.tokenHash, L.hashToken(token));
  assert.ok(!JSON.stringify(record).includes(token), 'the token itself is never stored');
  assert.equal(record.expiresAt, later(60).toISOString());
  assert.equal(L.buildLink({ userId: 'u1', purpose: 'admin', now: T0 }).record.expiresAt, later(24 * 60).toISOString());
});

test('a link is found while live, and refused by name when expired, used, superseded or made up', () => {
  const a = L.buildLink({ userId: 'u1', purpose: 'self_service', now: T0 });
  let recs = L.addLink([], a.record, T0);
  assert.equal(L.findLink(recs, a.token, later(10)).record.id, a.record.id);
  assert.equal(L.findLink(recs, a.token, later(61)).error, 'expired');
  assert.equal(L.findLink(recs, 'f'.repeat(64), later(1)).error, 'invalid');
  assert.equal(L.findLink(recs, 'not-hex', later(1)).error, 'invalid');
  const used = L.markUsed(recs, a.record.id, later(2));
  assert.equal(L.findLink(used, a.token, later(3)).error, 'used');
  const b = L.buildLink({ userId: 'u1', purpose: 'self_service', now: later(5) });
  recs = L.addLink(recs, b.record, later(5));
  assert.equal(L.findLink(recs, a.token, later(6)).error, 'superseded', 'a newer link replaces the older one');
  assert.ok(L.findLink(recs, b.token, later(6)).record);
});

test('at most 3 self-service links per person per hour', () => {
  let recs = [];
  for (let i = 0; i < 3; i++) recs = L.addLink(recs, L.buildLink({ userId: 'u1', purpose: 'self_service', now: later(i) }).record, later(i));
  assert.equal(L.overSelfServiceLimit(recs, 'u1', later(5)), true);
  assert.equal(L.overSelfServiceLimit(recs, 'u2', later(5)), false, 'per person');
  assert.equal(L.overSelfServiceLimit(recs, 'u1', later(70)), false, 'the hour rolls over');
});

test('the password rules are the app\'s own', () => {
  const rules = { minLength: config.MIN_PASSWORD_LENGTH, regex: config.PASSWORD_REGEX };
  assert.ok(L.passwordProblem('short', rules));
  assert.ok(L.passwordProblem('alllowercase1', rules));
  assert.equal(L.passwordProblem('GoodPass1', rules), null);
});

test('forgot-password sends the link itself; the reply never says whether an account exists', () => {
  const route = SERVER.slice(SERVER.indexOf("app.post('/api/auth/forgot-password'"), SERVER.indexOf("app.post('/api/auth/reset-password'"));
  assert.match(route, /issuePasswordSetLink\(user, 'self_service', typed\)/);
  assert.match(route, /overSelfServiceLimit/);
  // Every reply is the one generic sentence.
  const replies = route.match(/res\.json\(\{ message: [A-Z_]+ \}\)/g) || [];
  assert.ok(replies.length >= 4 && replies.every(r => r.includes('FORGOT_PASSWORD_REPLY')), replies.join(' | '));
  assert.ok(!/tempPassword|generateTempPassword/.test(route), 'no temporary password on this path');
});

test('the Inbox "Email Reset Link" button actually emails the person (it used to only mark the request done)', () => {
  const route = SERVER.slice(SERVER.indexOf("app.put('/api/admin/password-reset-requests/:id'"), SERVER.indexOf("app.delete('/api/admin/password-reset-requests/:id'"));
  assert.match(route, /await issuePasswordSetLink\(user, 'admin'\)/);
});

test('setting a password from a link signs the person out everywhere and tells them', () => {
  const route = SERVER.slice(SERVER.indexOf("app.post('/api/auth/reset-password'"), SERVER.indexOf("// Public endpoint: look up a password reset link token"));
  assert.match(route, /passwordSetLinks\.findLink\(links, token\)/);
  assert.match(route, /markUsed/);
  assert.match(route, /sessions\.revokeAllForUser\(users\[idx\]\.id, 'password_reset_by_link'\)/);
  assert.match(route, /sendPasswordChangedEmail\(users\[idx\]\)/);
  assert.ok(!/mfa/i.test(route.replace(/\/\/.*$/gm, '')), 'a reset never touches MFA');
});
