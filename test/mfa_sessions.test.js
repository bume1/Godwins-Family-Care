// ============================================================
// Session 5.3 — MFA + session controls: build-fail guards
//
//   1. TOTP is RFC 6238 (the RFC test vector), accepts ±1 step, refuses a
//      replayed step, and recovery codes are single-use and stored hashed.
//   2. Sessions: a revoked session is denied on the next request; an idle
//      one is revoked at the limit; touch is throttled; revoke-all spares
//      the current session when asked; rows are per key, never one blob.
//   3. server.js: every login route issues its session through finishLogin
//      (exactly ONE issueSession), the auth middleware checks the session
//      before trusting the token, MFA-required roles never get a session
//      without verification, logout revokes, password change / admin
//      reset / deactivation revoke, and the MFA secret never leaves the
//      server (GET /api/users exposes the flag only).
//   4. Production refuses MFA_ENFORCE=false.
//   5. Every signed-in page carries the session guard; every login surface
//      carries the MFA step.
// ============================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mfa = require('../mfa');
const { createSessionStore, TOUCH_THROTTLE_MS } = require('../sessionStore');
const dataStore = require('../dataStore');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const serverSrc = read('server.js');

// ---- 1. TOTP + recovery ----
test('TOTP matches the RFC 6238 SHA-1 test vector and is stable across the base32 round-trip', () => {
  // RFC 6238 Appendix B: seed "12345678901234567890", T=59 → 94287082 (8 digits); 6-digit form is the last six.
  const seed = mfa._internal.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(mfa.totp(seed, 59 * 1000), '287082');
  assert.equal(mfa.totp(seed, 1111111109 * 1000), '081804');
  assert.equal(mfa._internal.base32Decode(seed).toString(), '12345678901234567890');
  const s = mfa.generateSecret(); assert.equal(s.length, 32); assert.match(s, /^[A-Z2-7]+$/);
});
test('verifyTotp accepts the current step and ±1 drift, refuses ±2, a replayed step, and malformed input', () => {
  const secret = mfa.generateSecret();
  const now = Date.parse('2026-09-10T12:00:15.000Z');
  const code = mfa.totp(secret, now);
  assert.equal(mfa.verifyTotp(secret, code, { now }).ok, true);
  assert.equal(mfa.verifyTotp(secret, mfa.totp(secret, now - 30000), { now }).ok, true, '-1 step');
  assert.equal(mfa.verifyTotp(secret, mfa.totp(secret, now + 30000), { now }).ok, true, '+1 step');
  assert.equal(mfa.verifyTotp(secret, mfa.totp(secret, now - 60000), { now }).ok, false, '-2 steps');
  const first = mfa.verifyTotp(secret, code, { now });
  assert.equal(mfa.verifyTotp(secret, code, { now, lastStep: first.step }).reason, 'replay');
  assert.equal(mfa.verifyTotp(secret, '12345', { now }).reason, 'format');
  assert.equal(mfa.verifyTotp(secret, 'abcdef', { now }).reason, 'format');
  assert.match(mfa.otpauthUri({ issuer: 'Godwins Family Care', account: 'a@b.c', secret }), /^otpauth:\/\/totp\/Godwins%20Family%20Care:a%40b\.c\?secret=[A-Z2-7]+&issuer=Godwins%20Family%20Care&algorithm=SHA1&digits=6&period=30$/);
});
test('recovery codes: ten, hashed at rest, each usable exactly once, whitespace/case-insensitive', () => {
  const codes = mfa.generateRecoveryCodes();
  assert.equal(codes.length, 10); assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
  const rec = mfa.buildRecoveryRecord(codes);
  assert.ok(!JSON.stringify(rec).includes(codes[0].replace(/-/g, '')), 'plaintext not stored');
  const r1 = mfa.consumeRecovery(rec, ` ${codes[3].toUpperCase()} `);
  assert.equal(r1.ok, true); assert.equal(r1.remaining, 9);
  assert.equal(mfa.consumeRecovery(r1.record, codes[3]).ok, false, 'single use');
  assert.equal(mfa.consumeRecovery(r1.record, 'zzzz-zzzz-zzzz').ok, false);
  assert.equal(mfa.consumeRecovery(null, codes[0]).ok, false);
});
test('MFA is required for admin, clinical and case-manager roles and for anyone with clinical access', () => {
  const roles = ['admin', 'user', 'caseManager'];
  assert.equal(mfa.mfaRequiredFor({ role: 'admin' }, roles), true);
  assert.equal(mfa.mfaRequiredFor({ role: 'caseManager' }, roles), true);
  assert.equal(mfa.mfaRequiredFor({ role: 'client' }, roles), false);
  assert.equal(mfa.mfaRequiredFor({ role: 'vendor', hasClinicalAccess: true }, roles), true);
  assert.equal(mfa.isEnrolled({ mfa: { secret: 'x', enrolledAt: 'y' } }), true);
  assert.equal(mfa.isEnrolled({ mfa: { secret: 'x' } }), false);
});

// ---- 2. Sessions ----
const mkSessions = (idleMinutes = 15) => {
  let t = Date.parse('2026-09-10T12:00:00.000Z');
  const store = dataStore.createStore({ adapter: 'memory', env: { NODE_ENV: 'test' } });
  return { store, sessions: createSessionStore({ store, idleMinutes, now: () => t }), tick: (ms) => { t += ms; } };
};
test('a revoked session is denied on the next request; an idle one is revoked at the limit; touch is throttled', async () => {
  const { store, sessions, tick } = mkSessions(15);
  const row = await sessions.create({ userId: 'u1', role: 'admin', mfaVerified: true, surface: 'unified' });
  assert.ok((await store.list('auth_session:')).includes(`auth_session:${row.id}`), 'one row per session key');
  assert.equal((await sessions.check(row.id)).ok, true);
  tick(30 * 1000);
  await sessions.check(row.id);
  assert.equal((await store.get(`auth_session:${row.id}`)).lastSeenAt, row.lastSeenAt, 'touch throttled inside the window');
  tick(TOUCH_THROTTLE_MS);
  await sessions.check(row.id);
  assert.notEqual((await store.get(`auth_session:${row.id}`)).lastSeenAt, row.lastSeenAt, 'touched after the throttle window');
  assert.equal(await sessions.revoke(row.id, 'logout'), true);
  const denied = await sessions.check(row.id);
  assert.equal(denied.ok, false); assert.equal(denied.code, 'AUTH_REVOKED');
  const idle = await sessions.create({ userId: 'u1', role: 'admin' });
  tick(14 * 60 * 1000); assert.equal((await sessions.check(idle.id)).ok, true, '14 min is inside the limit (and that check counts as activity)');
  tick(16 * 60 * 1000);                                 // 16 min since the last touch
  const expired = await sessions.check(idle.id);
  assert.equal(expired.ok, false); assert.equal(expired.code, 'AUTH_IDLE');
  assert.equal((await store.get(`auth_session:${idle.id}`)).revokedReason, 'idle');
  assert.equal((await sessions.check(idle.id)).code, 'AUTH_REVOKED', 'stays dead');
  assert.equal((await sessions.check('nope')).code, 'AUTH_REVOKED');
  assert.equal((await sessions.check(null)).code, 'AUTH_INVALID');
});
test('absolute lifetime ends a session even when active; revoke-all spares the current one when asked; sweep deletes stale rows', async () => {
  const { store, sessions, tick } = mkSessions(15);
  const a = await sessions.create({ userId: 'u1', role: 'admin', absoluteExpiresAt: '2026-09-10T12:10:00.000Z' });
  tick(11 * 60 * 1000);
  assert.equal((await sessions.check(a.id)).code, 'AUTH_EXPIRED');
  const b = await sessions.create({ userId: 'u1', role: 'admin' }); const c = await sessions.create({ userId: 'u1', role: 'admin' }); const d = await sessions.create({ userId: 'u2', role: 'client' });
  assert.equal(await sessions.revokeAllForUser('u1', 'password_changed', { exceptSid: b.id }), 1);
  assert.equal((await sessions.check(b.id)).ok, true); assert.equal((await sessions.check(c.id)).ok, false); assert.equal((await sessions.check(d.id)).ok, true);
  assert.equal(await sessions.revokeAllForUser('u1', 'revoked'), 1);
  assert.equal((await sessions.listForUser('u1')).length, 3);
  tick(8 * 24 * 3600 * 1000);
  assert.equal(await sessions.sweep(), 4);
  assert.deepEqual(await store.list('auth_session:'), []);
});

// ---- 3. server.js wiring ----
test('every login route issues its session through finishLogin, and there is exactly one issueSession', () => {
  const logins = ['/api/auth/login', '/api/auth/client-login', '/api/auth/service-login', '/api/auth/admin-login'];
  for (const route of logins) {
    const i = serverSrc.indexOf(`app.post('${route}'`);
    assert.ok(i > 0, `${route} exists`);
    const body = serverSrc.slice(i, serverSrc.indexOf('\n});', i));
    assert.match(body, /finishLogin\(\{ user, req, surface: '[a-z]+', userResponse/, `${route} must finish through finishLogin`);
    assert.doesNotMatch(body, /jwt\.sign\(/, `${route} must not mint its own token`);
  }
  assert.equal((serverSrc.match(/await issueSession\(/g) || []).length, 2, 'issueSession is called from finishLogin (no-MFA path) and mfa/verify only');
  assert.equal((serverSrc.match(/jwt\.sign\(\{ id: user\.id/g) || []).length, 1, 'one JWT mint for sessions');
  const issue = serverSrc.slice(serverSrc.indexOf('const issueSession'), serverSrc.indexOf('const finishLogin'));
  assert.match(issue, /sid: row\.id/, 'the JWT names its session');
});
test('the auth middleware checks the session before trusting the token, with distinct codes, and enforces MFA for required roles', () => {
  const mw = serverSrc.slice(serverSrc.indexOf('const authenticateToken = async'), serverSrc.indexOf('// Authorization helper to check project access'));
  assert.match(mw, /if \(!tokenUser\.sid\) return res\.status\(403\)/, 'a token without a session id is dead');
  assert.match(mw, /await sessions\.check\(tokenUser\.sid\)/);
  assert.ok(mw.indexOf('sessions.check(') < mw.indexOf('const users = await getUsers()'), 'session checked before the user lookup');
  assert.match(mw, /req\.session = sess\.row/);
  assert.match(mw, /AUTH_MFA_REQUIRED/);
  assert.match(mw, /sess\.row\.mfaVerified/);
});
test('finishLogin never issues a session to an MFA-required user before verification; verify issues it with mfaVerified: true', () => {
  const fl = serverSrc.slice(serverSrc.indexOf('const finishLogin'), serverSrc.indexOf("app.post('/api/auth/mfa/verify'"));
  assert.match(fl, /const needsMfa = config\.MFA_ENFORCE && mfa\.mfaRequiredFor\(user, config\.MFA_REQUIRED_ROLES\)/);
  assert.match(fl, /if \(!needsMfa\) \{\s*const token = await issueSession\(user, req, \{ surface, mfaVerified: false \}\)/);
  assert.equal((fl.match(/issueSession\(/g) || []).length, 1, 'the only session finishLogin issues is the no-MFA one');
  assert.match(fl, /sealSecret\(secret\)/, 'the enrolment secret is sealed on the challenge row');
  const verify = serverSrc.slice(serverSrc.indexOf("app.post('/api/auth/mfa/verify'"), serverSrc.indexOf("app.get('/api/auth/mfa/status'"));
  assert.match(verify, /issueSession\(user, req, \{ surface: pending\.surface, mfaVerified: true \}\)/);
  assert.match(verify, /MFA_TOO_MANY_ATTEMPTS/); assert.match(verify, /MFA_CHALLENGE_EXPIRED/);
  assert.match(verify, /lastStep: v\.step/, 'the accepted step is stored against replay');
  assert.match(verify, /consumeRecovery/);
  assert.match(verify, /recoveryCodes = mfa\.generateRecoveryCodes\(\)/);
});
test('logout, password change, admin reset, admin revoke and deactivation all revoke server-side', () => {
  assert.match(serverSrc, /app\.post\('\/api\/auth\/logout', authenticateToken/);
  assert.match(serverSrc.slice(serverSrc.indexOf("app.post('/api/auth/logout'")), /sessions\.revoke\(req\.session\.id, 'logout'\)/);
  assert.match(serverSrc, /sessions\.revokeAllForUser\(user\.id, 'password_changed', \{ exceptSid: req\.session && req\.session\.id \}\)/);
  assert.match(serverSrc, /app\.post\('\/api\/users\/:userId\/mfa\/reset', authenticateToken, requireAdmin/);
  assert.match(serverSrc, /revokeAllForUser\(users\[idx\]\.id, 'mfa_reset_by_admin'\)/);
  assert.match(serverSrc, /app\.post\('\/api\/users\/:userId\/sessions\/revoke', authenticateToken, requireAdmin/);
  assert.match(serverSrc, /revokeAllForUser\(users\[idx\]\.id, 'account_deactivated'\)/);
  assert.match(serverSrc, /revokeAllForUser\(users\[idx\]\.id, 'password_reset_by_admin'\)/);
});
test('the MFA secret never leaves the server: GET /api/users exposes mfaEnrolled only, and no response serializes user.mfa', () => {
  const i = serverSrc.indexOf("app.get('/api/users', authenticateToken");
  const body = serverSrc.slice(i, serverSrc.indexOf('\n});', i));
  assert.match(body, /mfaEnrolled: mfa\.isEnrolled\(u\)/);
  assert.doesNotMatch(body, /mfa: u\.mfa|\.\.\.u[,\s}]/, 'no whole-user spread and no mfa object in the list');
  assert.doesNotMatch(serverSrc, /res\.json\(\{[^)]*\bmfa: (user|u|users\[idx\])\.mfa/, 'no route returns the mfa record');
  assert.doesNotMatch(serverSrc, /secret: (user|u)\.mfa\.secret/);
});

// ---- 4. production ----
test('production refuses MFA_ENFORCE=false and a missing EMR_TOKEN_ENCRYPTION_KEY', () => {
  const cfg = read('config.js');
  assert.match(cfg, /if \(!MFA_ENFORCE\) throw new Error\('MFA_ENFORCE=false is not permitted in production/);
  assert.match(cfg, /EMR_TOKEN_ENCRYPTION_KEY must be set in production/);
  assert.equal(require('../config').SESSION_IDLE_MINUTES, 15);
  assert.deepEqual(require('../config').MFA_REQUIRED_ROLES, ['admin', 'user', 'caseManager']);
});

// ---- 5. pages ----
test('every signed-in page carries the session guard and every login surface carries the MFA step', () => {
  for (const p of ['index', 'admin-hub', 'portal', 'clinical', 'caregiver', 'scheduling', 'admin-enrollment', 'service-portal']) {
    assert.match(read(`public/${p}.html`), /<script src="\/session-guard\.js"><\/script>/, `${p}.html lacks the session guard`);
  }
  for (const p of ['login', 'portal', 'admin-hub', 'admin-enrollment', 'service-portal']) {
    const html = read(`public/${p}.html`);
    assert.match(html, /<script src="\/mfa-step\.js"><\/script>/, `${p}.html lacks the MFA step`);
    assert.match(html, /GFC_MFA\.complete\(/, `${p}.html login does not pass through the MFA step`);
  }
  const guard = read('public/session-guard.js');
  assert.match(guard, /IDLE_MIN = Number\(.*\|\| 15\)/);
  assert.match(guard, /'\/api\/auth\/logout'/);
  for (const code of ['AUTH_IDLE', 'AUTH_REVOKED', 'AUTH_EXPIRED', 'AUTH_MFA_REQUIRED']) assert.match(guard, new RegExp(code));
  const step = read('public/mfa-step.js');
  assert.match(step, /\/api\/auth\/mfa\/verify/); assert.match(step, /recoveryCodes/);
});
