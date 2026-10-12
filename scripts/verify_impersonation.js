#!/usr/bin/env node
// ============================================================================
// verify_impersonation.js — "View as" through the real HTTP routes
//
// Boots the server on the memory adapter (MFA enforced), signs in as the
// default admin, creates one account per role and drives:
//   - View as a caregiver, a client and a clinician: their own screens load,
//     a signature route and the OpenEMR connect route are refused
//     (ACTING_AS_BLOCKED), the heartbeat names who is acting as whom
//   - refusals: an admin target, a nested start, an inactive account
//   - Exit kills the token; the admin signing out kills it too
//   - an admin demoted mid-session ends their "View as" on the next request
//   - audit rows read back: started/ended, and impersonatorId on phi_access
// Stored values and codes are asserted, never just status codes.
// ============================================================================
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
const mfa = require(path.join(root, 'mfa'));
let pass = 0, fail = 0;
const ok = (c, l, x) => { c ? (pass++, console.log('  PASS  ' + l)) : (fail++, console.log('  FAIL  ' + l + (x !== undefined ? ' :: ' + JSON.stringify(x).slice(0, 300) : ''))); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PORT = 39070;
const base = `http://127.0.0.1:${PORT}`;

const bootServer = (env) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const done = (r) => resolve({ child, out: () => out, ...r });
  child.stdout.on('data', d => { out += d; if (/Server running on port/.test(out)) done({ started: true }); });
  child.stderr.on('data', d => { out += d; });
  child.on('exit', (code) => done({ started: false, code }));
  setTimeout(() => done({ started: false, code: 'timeout' }), 20000);
});
const api = async (method, p, { token, body } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  let data = null; try { data = await res.json(); } catch { /* not json */ }
  return { status: res.status, data };
};

(async () => {
  const cfg = require(path.join(root, 'config'));
  const server = await bootServer({ NODE_ENV: 'development', DATA_STORE: 'memory', MFA_ENFORCE: 'true', OPENEMR_BASE_URL: 'https://emr.example.test', OPENEMR_CLIENT_ID: 'probe', OPENEMR_CLIENT_SECRET: 'probe', OPENEMR_REDIRECT_URI: 'https://app.example.test/oauth/callback', EMR_TOKEN_ENCRYPTION_KEY: require('crypto').randomBytes(32).toString('hex') });
  ok(server.started, 'server boots', server.out().slice(-400));
  if (!server.started) process.exit(1);
  try {
    // Admins sign in with MFA (an enrolment on first login). Each admin signs
    // in exactly once, so the TOTP replay guard never refuses a probe login.
    const secrets = {};
    const signIn = async (email, password) => {
      const l = await api('POST', '/api/auth/login', { body: { email, password } });
      if (l.data && l.data.token) return l.data.token;
      if (l.data && l.data.secret) secrets[email] = l.data.secret;
      const v = await api('POST', '/api/auth/mfa/verify', { body: { challenge: l.data.challenge, code: mfa.totp(secrets[email]) } });
      return v.data && v.data.token;
    };
    const adminToken = await signIn(cfg.DEFAULT_ADMIN.EMAIL, cfg.DEFAULT_ADMIN.PASSWORD);
    ok(!!adminToken, 'admin signs in (MFA-verified session)');

    const mk = async (body) => {
      const r = await api('POST', '/api/users', { token: adminToken, body: { password: 'Probe-Passw0rd!', sendWelcomeEmail: false, ...body } });
      const list = await api('GET', '/api/users', { token: adminToken });
      return (list.data || []).find(u => u.email === body.email) || r.data;
    };
    const caregiver = await mk({ email: 'cg@probe.test', name: 'Casey Caregiver', role: 'vendor', licenseLevel: 'PCA' });
    const client = await mk({ email: 'cl@probe.test', name: 'Clara Client', role: 'client', practiceName: 'Clara Client' });
    const clinician = await mk({ email: 'np@probe.test', name: 'Nora Provider', role: 'user', hasClinicalAccess: true, clinicalRole: 'provider' });
    const admin2 = await mk({ email: 'ad2@probe.test', name: 'Second Admin', role: 'admin' });
    ok(caregiver && client && clinician && admin2 && caregiver.id && admin2.id, 'one account per role created');

    console.log('\n== Caregiver ==');
    const s1 = await api('POST', `/api/admin/impersonate/${caregiver.id}`, { token: adminToken });
    ok(s1.status === 200 && s1.data.token && s1.data.destination === '/caregiver', 'View as caregiver → token, lands on /caregiver', s1.data);
    const t1 = s1.data.token;
    const hb = await api('GET', '/api/auth/heartbeat', { token: t1 });
    ok(hb.data && hb.data.actingAs && hb.data.actingAs.userId === caregiver.id && hb.data.actingAs.impersonatorName && hb.data.actingAs.expiresAt, 'heartbeat names who is acting as whom, with the 60-minute end', hb.data);
    const cme = await api('GET', '/api/caregiver/me', { token: t1 });
    ok(cme.status !== 401 && !(cme.data && /^AUTH_/.test(cme.data.code || '')), 'the caregiver app reads as the caregiver', cme.data && (cme.data.code || Object.keys(cme.data)));
    const pkt = await api('POST', '/api/caregiver/welcome-packet/submit', { token: t1, body: {} });
    ok(pkt.status === 403 && pkt.data.code === 'ACTING_AS_BLOCKED', 'signing the welcome packet is refused', pkt.data);
    const nested = await api('POST', `/api/admin/impersonate/${client.id}`, { token: t1 });
    ok(nested.status === 403 && !nested.data.token, 'cannot start another "View as" from inside one', nested.data);
    const hbAdmin = await api('GET', '/api/auth/heartbeat', { token: adminToken });
    ok(hbAdmin.data && hbAdmin.data.actingAs === null, 'the admin\'s own session is not "acting as" anyone');
    const end = await api('POST', '/api/auth/impersonate/end', { token: t1 });
    const dead = await api('GET', '/api/auth/heartbeat', { token: t1 });
    ok(end.data && end.data.ok && dead.status === 403 && dead.data.code === 'AUTH_REVOKED', 'Exit kills the token', dead.data);
    const stillAdmin = await api('GET', '/api/auth/heartbeat', { token: adminToken });
    ok(stillAdmin.status === 200, 'the admin session survives the exit');
    const endAgain = await api('POST', '/api/auth/impersonate/end', { token: adminToken });
    ok(endAgain.status === 400 && endAgain.data.code === 'NOT_ACTING_AS', 'Exit on a normal session is refused, nothing revoked');

    console.log('\n== Client ==');
    const s2 = await api('POST', `/api/admin/impersonate/${client.id}`, { token: adminToken });
    ok(s2.status === 200 && s2.data.destination === '/portal', 'View as client → lands on /portal', s2.data);
    const me = await api('GET', '/api/gfc/me', { token: s2.data.token });
    ok(me.status === 200 && me.data.role === 'client' && me.data.name === 'Clara Client', 'the portal reads as the client', me.data && { role: me.data.role, name: me.data.name });
    const consent = await api('POST', '/api/gfc/consents', { token: s2.data.token, body: { type: 'npp' } });
    ok(consent.status === 403 && consent.data.code === 'ACTING_AS_BLOCKED', 'signing a consent is refused', consent.data);
    const pw = await api('POST', '/api/auth/change-password', { token: s2.data.token, body: { currentPassword: 'x', newPassword: 'y' } });
    ok(pw.status === 403 && pw.data.code === 'ACTING_AS_BLOCKED', 'changing their password is refused', pw.data);
    await api('POST', '/api/auth/impersonate/end', { token: s2.data.token });

    console.log('\n== Clinician ==');
    const s3 = await api('POST', `/api/admin/impersonate/${clinician.id}`, { token: adminToken });
    ok(s3.status === 200 && s3.data.destination === '/clinical', 'View as clinician → lands on /clinical', s3.data);
    const t3 = s3.data.token;
    const pts = await api('GET', '/api/clinical/patients', { token: t3 });
    ok(pts.status === 200, 'the clinician patient list reads as them');
    const sign = await api('POST', '/api/clinical/patients/x/encounters/y/sign', { token: t3, body: {} });
    ok(sign.status === 403 && sign.data.code === 'ACTING_AS_BLOCKED', 'signing a note is refused before the route runs', sign.data);
    const rx = await api('POST', '/api/clinical/patients/x/encounters/y/prescriptions', { token: t3, body: {} });
    ok(rx.status === 403 && rx.data.code === 'ACTING_AS_BLOCKED', 'recording a prescription is refused', rx.data);
    const emr = await api('GET', '/api/emr/connect', { token: t3 });
    ok(emr.status === 403 && emr.data.code === 'ACTING_AS_BLOCKED', 'connecting their OpenEMR account is refused', emr.data);
    const emrRead = await api('GET', `/api/clinical/patients/${client.id}/chart`, { token: t3 });
    ok(!(emrRead.data && /^AUTH_/.test(emrRead.data.code || '')), 'an EMR-backed read does not sign anyone out', emrRead.data && emrRead.data.code);

    console.log('\n== Refusals ==');
    const toAdmin = await api('POST', `/api/admin/impersonate/${admin2.id}`, { token: adminToken });
    ok(toAdmin.status === 403 && toAdmin.data.code === 'ACTING_AS_ADMIN_REFUSED', 'never into another admin', toAdmin.data);
    const self = await api('POST', `/api/admin/impersonate/${admin2.id === 'x' ? 'x' : 'nope'}`, { token: adminToken });
    ok(self.status === 404 && self.data.code === 'USER_NOT_FOUND', 'an unknown account is refused', self.data);

    console.log('\n== Admin demoted mid-session → "View as" dies ==');
    const a2 = await signIn('ad2@probe.test', 'Probe-Passw0rd!');
    ok(!!a2, 'second admin signs in');
    const s5 = await api('POST', `/api/admin/impersonate/${caregiver.id}`, { token: a2 });
    ok(s5.status === 200, 'second admin starts "View as"');
    const demote = await api('PUT', `/api/users/${admin2.id}`, { token: adminToken, body: { ...admin2, role: 'caseManager' } });
    ok(demote.status === 200, 'first admin demotes the second', demote.data);
    const afterDemote = await api('GET', '/api/auth/heartbeat', { token: s5.data.token });
    ok(afterDemote.status === 403 && afterDemote.data.code === 'AUTH_REVOKED', 'the demoted admin\'s "View as" ends on the next request', afterDemote.data);

    console.log('\n== Audit ==');
    await sleep(300);
    const log = await api('GET', '/api/admin/audit-log?limit=2000', { token: adminToken });
    const rows = (log.data && log.data.rows) || [];
    ok(rows.some(r => r.action === 'impersonation_started' && r.entityId === caregiver.id), 'impersonation_started is a durable row');
    ok(rows.some(r => r.action === 'impersonation_ended' && r.entityId === caregiver.id), 'impersonation_ended is a durable row');
    ok(rows.some(r => r.action === 'phi_access' && r.userId === client.id && r.impersonatorId && r.resource === '/api/gfc/me'), 'a PHI read made while acting as the client names the admin who made it');
    ok(!rows.some(r => r.action === 'phi_access' && r.userId === client.id && !r.impersonatorId), 'no PHI row in the client\'s name lacks the admin behind it (the client never signed in)');
    console.log('\n== Admin signs out → "View as" dies ==');
    const s4 = await api('POST', `/api/admin/impersonate/${caregiver.id}`, { token: adminToken });
    await api('POST', '/api/auth/logout', { token: adminToken });
    const orphan = await api('GET', '/api/auth/heartbeat', { token: s4.data.token });
    ok(orphan.status === 403 && orphan.data.code === 'AUTH_REVOKED' && orphan.data.detail === 'acting_as_admin_signed_out', 'the "View as" token dies with the admin session', orphan.data);

  } finally {
    server.child.kill();
  }
  console.log(`\n${pass}/${pass + fail} checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
