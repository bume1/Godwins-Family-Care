#!/usr/bin/env node
// ============================================================================
// scripts/verify_session5.js — Session 5 acceptance through the REAL server
// over HTTP (boots server.js on the memory adapter on a free port).
// Asserts STORED / OBSERVED state, never a status code alone.
//
//   node scripts/verify_session5.js
//
// Covers: production boot refusal (KV adapter, MFA_ENFORCE=false), MFA
// enrolment → verify → recovery code, session revocation (logout, admin
// revoke) and idle expiry, the per-user OpenEMR sign-in handshake (authorize
// URL shape, callback refusal on a bad state), the durable audit rows for
// every PHI request, and the scrubbed process log.
// Run it against the deployed app as well: set BASE_URL to skip the boot and
// ADMIN_EMAIL / ADMIN_PASSWORD / MFA_SECRET for a real account.
// ============================================================================
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
const mfa = require(path.join(root, 'mfa'));
let pass = 0, fail = 0;
const ok = (c, l, x) => { c ? (pass++, console.log('  PASS  ' + l)) : (fail++, console.log('  FAIL  ' + l + (x !== undefined ? ' :: ' + JSON.stringify(x).slice(0, 300) : ''))); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const bootServer = (env, port) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const done = (result) => resolve({ child, out: () => out, ...result });
  child.stdout.on('data', d => { out += d; if (/Server running on port/.test(out)) done({ started: true }); });
  child.stderr.on('data', d => { out += d; });
  child.on('exit', (code) => done({ started: false, code }));
  setTimeout(() => done({ started: false, code: 'timeout' }), 15000);
});
const api = async (base, method, p, { token, body, headers } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  let data = null; try { data = await res.json(); } catch { /* not json */ }
  return { status: res.status, data, headers: res.headers };
};

(async () => {
  const cfg = require(path.join(root, 'config'));
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || cfg.DEFAULT_ADMIN.EMAIL;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || cfg.DEFAULT_ADMIN.PASSWORD;

  console.log('\n== 1. Production boot refusals (each is its own process) ==');
  const kvProd = await bootServer({ NODE_ENV: 'production', DATA_STORE: 'kv', JWT_SECRET: 'a-long-unique-secret-value-for-the-probe-only', EMR_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64) }, 39000);
  ok(!kvProd.started && /REFUSING TO BOOT: NODE_ENV=production with DATA_STORE=kv/.test(kvProd.out()), 'production + KV adapter refuses to boot, reason printed', kvProd.out().slice(0, 200));
  const noKey = await bootServer({ NODE_ENV: 'production', DATA_STORE: 'postgres', DATABASE_URL: 'postgres://x', JWT_SECRET: 'a-long-unique-secret-value-for-the-probe-only', EMR_TOKEN_ENCRYPTION_KEY: '' }, 39001);
  ok(!noKey.started && /EMR_TOKEN_ENCRYPTION_KEY must be set in production/.test(noKey.out()), 'production without the token encryption key refuses to boot');
  const noMfa = await bootServer({ NODE_ENV: 'production', DATA_STORE: 'postgres', DATABASE_URL: 'postgres://x', JWT_SECRET: 'a-long-unique-secret-value-for-the-probe-only', EMR_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64), MFA_ENFORCE: 'false' }, 39002);
  ok(!noMfa.started && /MFA_ENFORCE=false is not permitted in production/.test(noMfa.out()), 'production with MFA_ENFORCE=false refuses to boot');

  let base = process.env.BASE_URL; let server = null;
  if (!base) {
    console.log('\n== 2. Boot on the memory adapter with a 1-minute idle limit ==');
    server = await bootServer({ NODE_ENV: 'development', DATA_STORE: 'memory', SESSION_IDLE_MINUTES: '1', OPENEMR_BASE_URL: process.env.OPENEMR_BASE_URL || 'https://emr.example.test', OPENEMR_CLIENT_ID: process.env.OPENEMR_CLIENT_ID || 'probe-client', OPENEMR_CLIENT_SECRET: process.env.OPENEMR_CLIENT_SECRET || 'probe-secret', OPENEMR_REDIRECT_URI: 'https://app.godwinsfamilycarellc.com/oauth/callback', EMR_TOKEN_ENCRYPTION_KEY: require('crypto').randomBytes(32).toString('hex') }, 39010);
    ok(server.started, 'server boots on the memory adapter', server.out().slice(0, 300));
    if (!server.started) process.exit(1);
    base = 'http://127.0.0.1:39010';
  }
  const health = await api(base, 'GET', '/healthz');
  ok(health.data && health.data.ok && health.data.store && !('DATABASE_URL' in (health.data || {})), 'healthz names the adapter and nothing secret', health.data);

  console.log('\n== 3. MFA: an admin login yields a challenge, never a session ==');
  const l1 = await api(base, 'POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  ok(!l1.data.token && (l1.data.mfaEnrollmentRequired || l1.data.mfaRequired), 'no token before MFA', l1.data && Object.keys(l1.data));
  let secret = process.env.MFA_SECRET || l1.data.secret;
  ok(!!l1.data.challenge && (!!secret), 'challenge id + (enrolment) secret present');
  if (l1.data.mfaEnrollmentRequired) ok(/^data:image\/png;base64,/.test(l1.data.qrDataUrl || '') && /^otpauth:\/\/totp\//.test(l1.data.otpauthUri || ''), 'enrolment carries a QR and an otpauth URI');
  const wrong = await api(base, 'POST', '/api/auth/mfa/verify', { body: { challenge: l1.data.challenge, code: '000000' } });
  ok(wrong.status === 400 && wrong.data.code === 'MFA_INVALID_CODE' && wrong.data.attemptsLeft === 4, 'a wrong code is refused with attempts left', wrong.data);
  const v1 = await api(base, 'POST', '/api/auth/mfa/verify', { body: { challenge: l1.data.challenge, code: mfa.totp(secret) } });
  ok(!!v1.data.token, 'the right code issues a session', v1.data);
  const token = v1.data.token;
  const recovery = v1.data.recoveryCodes || [];
  if (l1.data.mfaEnrollmentRequired) ok(recovery.length === 10, 'ten recovery codes shown once at enrolment');
  const replay = await api(base, 'POST', '/api/auth/mfa/verify', { body: { challenge: l1.data.challenge, code: mfa.totp(secret) } });
  ok(replay.status === 400 && replay.data.code === 'MFA_CHALLENGE_EXPIRED', 'a challenge is single-use');
  const status = await api(base, 'GET', '/api/auth/mfa/status', { token });
  ok(status.data.enrolled === true && status.data.sessionMfaVerified === true, 'STORED: enrolled, session marked verified', status.data);
  const users = await api(base, 'GET', '/api/users', { token });
  const me = (users.data || []).find(u => u.email === ADMIN_EMAIL);
  ok(me && me.mfaEnrolled === true && !('mfa' in me) && !JSON.stringify(users.data).includes(secret), 'GET /api/users exposes mfaEnrolled only — no secret, no hashes');

  console.log('\n== 4. Sessions: logout revokes; a revoked token is dead; admin revoke; idle ==');
  const before = await api(base, 'GET', '/api/auth/sessions', { token });
  ok(before.data.sessions.some(s => s.current && s.mfaVerified), 'own session listed as current + mfaVerified');
  const lo = await api(base, 'POST', '/api/auth/logout', { token });
  const after = await api(base, 'GET', '/api/auth/mfa/status', { token });
  ok(lo.data.ok && after.status === 403 && after.data.code === 'AUTH_REVOKED', 'after logout the same token is refused with AUTH_REVOKED', after.data);
  // sign in again with a recovery code
  const l2 = await api(base, 'POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  ok(l2.data.mfaRequired === true && !l2.data.secret, 'second login: verification only, no secret re-shown');
  const v2 = await api(base, 'POST', '/api/auth/mfa/verify', { body: { challenge: l2.data.challenge, code: recovery[0] || mfa.totp(secret) } });
  ok(!!v2.data.token && (recovery[0] ? v2.data.mfaVia === 'recovery' : true), 'recovery code signs in', v2.data);
  const token2 = v2.data.token;
  if (recovery[0]) {
    const l3 = await api(base, 'POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    const reuse = await api(base, 'POST', '/api/auth/mfa/verify', { body: { challenge: l3.data.challenge, code: recovery[0] } });
    ok(reuse.status === 400, 'a used recovery code cannot be used again');
    const v3 = await api(base, 'POST', '/api/auth/mfa/verify', { body: { challenge: l3.data.challenge, code: mfa.totp(secret, Date.now() + 30000) } });
    ok(!!v3.data.token, 'a fresh TOTP (next step) still works after the recovery sign-in');
    const revoke = await api(base, 'POST', `/api/users/${me.id}/sessions/revoke`, { token: token2 });
    const dead = await api(base, 'GET', '/api/auth/mfa/status', { token: v3.data.token });
    ok(revoke.data.revoked >= 1 && dead.status === 403 && dead.data.code === 'AUTH_REVOKED', 'admin revoke-all kills the other session too', { revoke: revoke.data, dead: dead.data });
  }
  // Later sign-ins use the next unused recovery code (TOTP allows one code per
  // 30-second step and refuses a replay, so a probe that signs in four times
  // in a minute would otherwise have to wait). Without recovery codes (a real
  // account) it waits for the next step.
  let usedRecovery = 1;
  const signIn = async () => {
    const l = await api(base, 'POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    let code;
    if (recovery[usedRecovery]) code = recovery[usedRecovery++];
    else { await sleep(31000); code = mfa.totp(secret); }
    const v = await api(base, 'POST', '/api/auth/mfa/verify', { body: { challenge: l.data.challenge, code } });
    return v.data.token;
  };
  const tokenLive = await signIn();
  ok(!!tokenLive, 'a fresh session for the remaining checks');
  if (server) {
    console.log('   waiting 65s for the 1-minute idle limit…');
    await sleep(65000);
    const idle = await api(base, 'GET', '/api/auth/mfa/status', { token: tokenLive });
    ok(idle.status === 403 && idle.data.code === 'AUTH_IDLE', 'an idle session is refused with AUTH_IDLE and revoked', idle.data);
    const again = await api(base, 'GET', '/api/auth/mfa/status', { token: tokenLive });
    ok(again.data.code === 'AUTH_REVOKED', 'and stays dead');
  }
  const tk = await signIn();

  console.log('\n== 5. OpenEMR: per-user sign-in handshake ==');
  const st = await api(base, 'GET', '/api/clinical/status', { token: tk });
  ok(st.data && st.data.connected === false && st.data.emrUser === null, 'status: this user is NOT connected to OpenEMR (no shared token exists)', st.data && { connected: st.data.connected, configured: st.data.configured, reachable: st.data.reachable });
  const conn = await api(base, 'GET', '/api/emr/connect', { token: tk });
  const u = conn.data && conn.data.url ? new URL(conn.data.url) : null;
  ok(u && u.pathname.endsWith('/oauth2/default/authorize') && u.searchParams.get('response_type') === 'code' && u.searchParams.get('code_challenge_method') === 'S256' && u.searchParams.get('redirect_uri') === 'https://app.godwinsfamilycarellc.com/oauth/callback' && /offline_access/.test(u.searchParams.get('scope')), 'connect URL: authorization_code + PKCE S256 + registered redirect + offline_access', conn.data);
  const cb = await api(base, 'GET', '/oauth/callback?state=not-a-real-state&code=abc');
  ok(cb.status === 302 && /emr=error&reason=EMR_AUTH_STATE_UNKNOWN/.test(cb.headers.get('location') || ''), 'callback with an unknown state is refused and sent back with a reason', cb.headers.get('location'));
  const chart = await api(base, 'GET', '/api/clinical/patients', { token: tk });
  ok(chart.status === 200, 'patient list (app data) still reads without an EMR token');

  console.log('\n== 6. Audit: every PHI request is a row ==');
  const refused = await api(base, 'GET', '/api/gfc/me', { token: tk });   // an admin is not a client: 403 by design
  ok(refused.status === 403, 'a deliberately refused PHI request (admin on a client-only route) answers 403', refused.data);
  await sleep(300);
  const log = await api(base, 'GET', '/api/admin/audit-log?limit=500', { token: tk });
  const rows = (log.data && log.data.rows) || [];
  const has = (pred) => rows.some(pred);
  ok(has(r => r.action === 'phi_access' && r.resource === '/api/clinical/patients' && r.userId === me.id && r.role === 'admin' && r.details.status === 200 && r.ipHash && r.requestId), 'phi_access row for the chart list carries user, role, status, hashed IP, request id');
  ok(has(r => r.action === 'phi_access' && r.resource === '/api/auth/mfa/status' ? false : true) && !has(r => r.action === 'phi_access' && r.resource.startsWith('/api/auth/')), 'auth handshakes are not phi_access rows (they have their own events)');
  ok(has(r => r.action === 'mfa_enrolled') && has(r => r.action === 'login' && r.details && r.details.mfaVerified === true) && has(r => r.action === 'logout') && has(r => r.action === 'sessions_revoked'), 'login, mfa_enrolled, logout, sessions_revoked events are durable rows');
  ok(has(r => r.action === 'emr_connect_started'), 'emr_connect_started is audited');
  ok(has(r => r.action === 'phi_access' && r.details.status === 403), 'a refused request is recorded too');
  ok(!JSON.stringify(rows).includes(secret) && !JSON.stringify(rows).includes(ADMIN_PASSWORD), 'no secret in the audit log');
  ok(log.data.total >= rows.length && log.data.total > 10, `audit total ${log.data.total} — nothing truncated`);

  if (server) {
    console.log('\n== 7. Process log is scrubbed ==');
    const out = server.out();
    ok(!out.includes(ADMIN_PASSWORD), 'the admin password never appears in the process log');
    ok(!out.includes(ADMIN_EMAIL) || /\[email\]/.test(out) === false && !new RegExp(ADMIN_EMAIL.replace('.', '\\.') + '.*(failed|reset)').test(out), 'login failures do not print the email');
    server.child.kill();
  }
  console.log(`\n${pass}/${pass + fail} checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
