// ============================================================
// "View as" for the Super Admin (impersonation.js, 2026-10-12)
//
//   1. Who may start one: Super Admin only, MFA-verified, never into another
//      admin, never nested, never into an inactive account.
//   2. What stays blocked: every signature route and every account route,
//      and ordinary work (drafts, visit logs, messages) is NOT blocked.
//   3. The block list keeps up with the code: every signature route the
//      server registers is on it.
//   4. The session row and the audit row carry the admin behind the view.
//   5. server.js wiring: the parent session is checked, the impersonator is
//      re-checked against the fresh user record, OpenEMR is refused at the
//      token provider, and the block runs inside authenticateToken.
//   6. The browser: the banner reads the server, Exit restores the admin.
// The live half is scripts/verify_impersonation.js (real HTTP routes).
// ============================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const imp = require('../impersonation');
const { createSessionStore } = require('../sessionStore');
const { createAuditLog } = require('../auditLog');
const dataStore = require('../dataStore');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
// Raw source: a regex comment-stripper mangles server.js (glob strings read as block comments).
const serverSrc = read('server.js');

const admin = { id: 'a1', role: 'admin', name: 'Bianca' };
const verified = { id: 's1', userId: 'a1', mfaVerified: true };

// ---- 1. who may start one ----
test('a Super Admin with an MFA-verified session may view as a non-admin', () => {
  for (const role of ['user', 'client', 'family', 'vendor', 'caseManager']) {
    assert.deepEqual(imp.canStart({ admin, adminSession: verified, target: { id: 't', role }, mfaEnforced: true }), { ok: true }, role);
  }
});
test('refusals each carry their own code', () => {
  const t = { id: 't', role: 'client' };
  const code = (args) => imp.canStart({ admin, adminSession: verified, target: t, mfaEnforced: true, ...args }).code;
  assert.equal(code({ admin: { id: 'm', role: 'user', isManager: true } }), 'ADMIN_ONLY');
  assert.equal(code({ admin: null }), 'ADMIN_ONLY');
  assert.equal(code({ target: { id: 'a2', role: 'admin' } }), 'ACTING_AS_ADMIN_REFUSED');
  assert.equal(code({ target: { id: 'a1', role: 'client' } }), 'ACTING_AS_SELF');
  assert.equal(code({ target: null }), 'USER_NOT_FOUND');
  assert.equal(code({ target: { id: 't', role: 'client', accountStatus: 'inactive' } }), 'ACCOUNT_INACTIVE');
  assert.equal(code({ adminSession: { ...verified, impersonatorId: 'x' } }), 'ALREADY_ACTING_AS');
  assert.equal(code({ adminSession: { ...verified, mfaVerified: false } }), 'MFA_REQUIRED');
  assert.equal(imp.canStart({ admin, adminSession: { mfaVerified: false }, target: t, mfaEnforced: false }).ok, true, 'dev without MFA');
});
test('the cap is 60 minutes', () => {
  assert.equal(imp.IMPERSONATION_MINUTES, 60);
  assert.equal(new Date(imp.expiresAt(0)).getTime(), 60 * 60 * 1000);
});

// ---- 2. what stays blocked ----
const BLOCKED = [
  ['POST', '/api/clinical/patients/c1/encounters/e1/sign'],
  ['POST', '/api/clinical/patients/c1/encounters/e1/co-sign'],
  ['POST', '/api/clinical/patients/c1/encounters/e1/co-signatures'],
  ['POST', '/api/clinical/patients/c1/encounters/e1/addenda'],
  ['POST', '/api/clinical/patients/c1/encounters/e1/prescriptions'],
  ['POST', '/api/clinical/patients/c1/care-plan'],
  ['POST', '/api/clinical/patients/c1/care-plan/provider-cosign'],
  ['POST', '/api/clinical/orders/o1/co-sign'],
  ['POST', '/api/clinical/standing-orders'],
  ['POST', '/api/clinical/standing-orders/s1/revise'],
  ['POST', '/api/clinical/results/r1/acknowledge'],
  ['POST', '/api/gfc/consents'],
  ['POST', '/api/gfc/care-plan/cosign'],
  ['POST', '/api/gfc/transfer-roi/submit'],
  ['PUT', '/api/client/service-reports/x/sign'],
  ['POST', '/api/caregiver/welcome-packet/submit'],
  ['POST', '/api/caregiver/welcome-packet/attestations/backgroundCheck'],
  ['POST', '/api/auth/change-password'],
  ['POST', '/api/auth/mfa/recovery-codes/regenerate'],
  ['GET', '/api/emr/connect'],
  ['POST', '/api/emr/disconnect']
];
test('every signature and account route is blocked while acting as someone', () => {
  for (const [m, p] of BLOCKED) assert.ok(imp.blockedAction(m, p), `${m} ${p}`);
});
test('ordinary work is NOT blocked (full act-as)', () => {
  const open = [
    ['GET', '/api/clinical/patients'],
    ['POST', '/api/clinical/patients/c1/notes'],
    ['PUT', '/api/clinical/patients/c1/encounters/e1/note'],
    ['POST', '/api/caregiver/visit-logs'],
    ['POST', '/api/messaging/threads/t1/messages'],
    ['POST', '/api/scheduling/shifts/s1/clock-in'],
    ['POST', '/api/gfc/documents/upload'],
    ['GET', '/api/gfc/consents'],
    ['POST', '/api/auth/logout'],
    ['POST', '/api/auth/impersonate/end'],
    ['GET', '/api/auth/heartbeat'],
    ['POST', '/api/clinical/patients/c1/encounters/e1/signature-preview']
  ];
  for (const [m, p] of open) assert.equal(imp.blockedAction(m, p), null, `${m} ${p}`);
});

// ---- 3. the list keeps up with the code ----
test('every signature route the server registers is on the block list', () => {
  const sources = [read('server.js'), ...fs.readdirSync(path.join(root, 'routes')).map(f => read(path.join('routes', f)))].join('\n');
  const re = /(?:app|router)\.(post|put)\('([^']+)'/g;
  const signy = /(\/sign$|co-sign|cosign|co-signatures|addenda$|\/prescriptions$|\/consents$|attestations\/|welcome-packet\/submit$|transfer-roi\/submit$|standing-orders(\/:id\/revise)?$|\/acknowledge$|change-password$|recovery-codes)/;
  const missing = [];
  let m; let seen = 0;
  while ((m = re.exec(sources))) {
    const [, method, route] = m;
    if (!signy.test(route)) continue;
    if (/^\/api\/(admin|auth\/(signup|forgot))/.test(route) || /\/api\/gfc\/admin\//.test(route)) continue; // admin-only or pre-login: a viewed account can never reach them
    if (/^\/api\/gfc\/upload\/:token\//.test(route)) continue; // the no-login upload link reads no session at all: the signer is whoever holds the link, never a viewed account
    seen++;
    const sample = route.replace(/:[A-Za-z]+/g, 'x');
    if (!imp.blockedAction(method.toUpperCase(), sample)) missing.push(`${method.toUpperCase()} ${route}`);
  }
  assert.deepEqual(missing, [], 'add these to BLOCKED_WHILE_ACTING_AS in impersonation.js');
  assert.ok(seen >= 15, `the sweep must actually find the signature routes (found ${seen})`);
});

// ---- 4. the session row and the audit row carry the admin ----
test('a View-as session row names the admin behind it; a normal one does not', async () => {
  const store = dataStore.createStore({ adapter: 'memory', env: { NODE_ENV: 'test' } });
  const sessions = createSessionStore({ store });
  const normal = await sessions.create({ userId: 'u1', role: 'client' });
  assert.equal(normal.impersonatorId, undefined);
  assert.equal(imp.isActingAs(normal), false);
  const row = await sessions.create({ userId: 'u1', role: 'client', impersonatorId: 'a1', impersonatorName: 'Bianca', impersonatorSid: 's1' });
  const back = (await sessions.check(row.id)).row;
  assert.equal(back.impersonatorId, 'a1'); assert.equal(back.impersonatorSid, 's1');
  assert.equal(imp.isActingAs(back), true);
  assert.deepEqual(imp.describe(back, { id: 'u1', name: 'Clara', role: 'client' }), { impersonatorId: 'a1', impersonatorName: 'Bianca', userId: 'u1', userName: 'Clara', role: 'client', roleLabel: 'client', expiresAt: null });
  assert.equal(imp.roleLabel('vendor'), 'caregiver');
  assert.equal(imp.roleLabel('user'), 'clinician');
});
test('every audit row written during a View-as request names the admin', async () => {
  const store = dataStore.createStore({ adapter: 'memory', env: { NODE_ENV: 'test' } });
  const audit = createAuditLog({ store, salt: 's' });
  const req = { method: 'GET', path: '/api/gfc/me', headers: {}, socket: {} };
  const res = { setHeader() {} };
  await new Promise(resolve => audit.contextMiddleware(req, res, async () => {
    audit.bindUser({ id: 'u1', name: 'Clara', role: 'client' }, { id: 'sx', impersonatorId: 'a1', impersonatorName: 'Bianca' });
    await audit.record({ action: 'something', details: { a: 1 } });
    resolve();
  }));
  await new Promise(resolve => audit.contextMiddleware(req, res, async () => {
    audit.bindUser({ id: 'u1', name: 'Clara', role: 'client' }, { id: 'sy' });
    await audit.record({ action: 'normal' });
    resolve();
  }));
  const rows = await audit.read({ limit: 10 });
  const list = Array.isArray(rows) ? rows : rows.rows;
  const acted = list.find(r => r.action === 'something');
  assert.equal(acted.userId, 'u1');
  assert.equal(acted.impersonatorId, 'a1');
  assert.equal(acted.details.actingAsByName, 'Bianca');
  assert.equal(acted.details.a, 1);
  assert.equal(list.find(r => r.action === 'normal').impersonatorId, undefined);
});

// ---- 5. server.js wiring ----
const authBlock = (() => {
  const a = serverSrc.indexOf('const authenticateToken = async');
  const b = serverSrc.indexOf('const requireAdmin = ', a);
  assert.ok(a > 0 && b > a, 'authenticateToken anchors moved');
  return serverSrc.slice(a, b);
})();
test('authenticateToken ties the View-as session to the admin\'s own session', () => {
  assert.match(authBlock, /sessions\.check\(sess\.row\.impersonatorSid\)/);
  assert.match(authBlock, /parent\.row\.userId !== sess\.row\.impersonatorId/);
  assert.match(authBlock, /acting_as_admin_signed_out/);
});
test('authenticateToken re-checks the admin and the target against fresh records', () => {
  assert.match(authBlock, /admin\.role !== 'admin'/);
  assert.match(authBlock, /admin\.accountStatus === 'inactive'/);
  assert.match(authBlock, /freshUser\.role === 'admin'/);
});
test('the block runs inside authenticateToken, after the user is bound, and is not an AUTH_ code', () => {
  const bind = authBlock.indexOf('audit.bindUser(req.user, req.session)');
  const block = authBlock.indexOf('impersonation.blockedAction(req.method, req.path)');
  assert.ok(bind > 0 && block > bind);
  assert.match(authBlock, /code: 'ACTING_AS_BLOCKED'/);
  assert.ok(!/AUTH_[A-Z_]*BLOCK/.test(authBlock), 'a blocked action must not sign anyone out');
});
test('OpenEMR is refused at the token provider for a View-as request', () => {
  const a = serverSrc.indexOf('const emrTokenProvider = (actor) =>');
  const body = serverSrc.slice(a, serverSrc.indexOf('emrTokenProvider.invalidate', a));
  assert.match(body, /impersonatorId/);
  assert.match(body, /EMR_BLOCKED_WHILE_ACTING_AS/);
  assert.ok(body.indexOf('impersonatorId') < body.indexOf('emrAuth.getAccessTokenFor'), 'the check comes before any token is read');
});
test('the start route is Super Admin only and goes through canStart', () => {
  const a = serverSrc.indexOf("app.post('/api/admin/impersonate/:userId'");
  const route = serverSrc.slice(a, serverSrc.indexOf('app.post(', a + 10));
  assert.match(route, /authenticateToken, requireAdmin/);
  assert.match(route, /impersonation\.canStart\(/);
  assert.match(route, /impersonatorSid: req\.session\.id/);
  assert.match(route, /impersonation\.expiresAt\(\)/);
  assert.match(route, /'impersonation_started'/);
});

// ---- 6. the browser ----
test('the banner reads the server and Exit restores the admin', () => {
  const guard = stripComments(read('public/session-guard.js'));
  assert.match(guard, /data && data\.actingAs\) showViewAsBanner\(data\.actingAs\)/);
  assert.match(guard, /'\/api\/auth\/impersonate\/end'/);
  assert.match(guard, /restoreAdmin\(\)\) window\.location\.replace\('\/admin\?view_as=ended'\)/);
  assert.match(guard, /if \(readStash\(\)\) return endViewAs\(\)/, 'any sign-out while viewing returns to the admin');
  assert.match(guard, /Emails still send/);
  assert.ok(!/innerHTML\s*=\s*[^'"]/.test(guard), 'names are set as text, never HTML');
});
test('the hub offers View as only to a Super Admin, never on an admin row', () => {
  const hub = read('public/admin-hub.html');
  assert.match(hub, /isSuperAdmin && user\.role !== 'admin' && user\.accountStatus !== 'inactive' && \(/);
  assert.match(hub, /<UsersPage token=\{token\} isSuperAdmin=\{isSuperAdmin\} \/>/);
  assert.match(hub, /localStorage\.setItem\('gfc_view_as_return'/);
});
