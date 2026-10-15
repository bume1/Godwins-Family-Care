#!/usr/bin/env node
// Live probe for the one account type (owner, 2026-10-15; accountTypes.js).
// Run against a server started with MFA_ENFORCE=false, e.g.
//   PORT=3199 DATA_STORE=memory MFA_ENFORCE=false node server.js
// Every assertion reads a stored value or a real route's answer back.

const BASE = process.env.PROBE_BASE || 'http://localhost:3199';
const ADMIN_EMAIL = process.env.PROBE_ADMIN_EMAIL || 'admin@godwinsfamilycarellc.com';
const ADMIN_PASSWORD = process.env.PROBE_ADMIN_PASSWORD || 'gfcforever2026';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? `\n         ${JSON.stringify(detail).slice(0, 600)}` : ''}`); }
};
const call = async (method, path, token, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
};
const login = async (email, password) => (await call('POST', '/api/auth/login', null, { email, password })).body || {};

const STAMP = Date.now();
const PW = 'Probe12345!';
const make = async (token, name, accountType, extra = {}) => {
  const email = `probe.at.${name.split(' ')[0].toLowerCase()}.${STAMP}@example.test`;
  const r = await call('POST', '/api/users', token, { email, password: PW, name: `${name} (TEST DATA)`, accountType, sendWelcomeEmail: false, ...extra });
  return { id: r.body && r.body.id, email, status: r.status, body: r.body };
};
const tileIds = (u) => (u.hubTiles || []).map(t => t.id).join(',');

(async () => {
  const adminLogin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const admin = adminLogin.token;
  if (!admin) { console.log('LOGIN FAILED — is the app running with MFA_ENFORCE=false?'); process.exit(1); }

  console.log('\n--- 1. the Super Admin ---');
  ok('admin lands on the hub', adminLogin.user.landing === null, adminLogin.user.landing);
  ok('  with Admin Hub, Clinical, Private Home Care, Service Portal, Client Portal Admin',
    tileIds(adminLogin.user) === 'admin,clinical,privateHomeCare,service,clientPortalAdmin', adminLogin.user.hubTiles);

  console.log('\n--- 2. each type stores exactly what it decides ---');
  const mgr = await make(admin, 'Mona Manager', 'manager');
  const mgrNone = await make(admin, 'Ned Nochart', 'manager', { managerClinicalAccess: 'none' });
  const coord = await make(admin, 'Cora Coordinator', 'coordinator');
  const prov = await make(admin, 'Paula Provider', 'provider');
  const rn = await make(admin, 'Ruth Nurse', 'rn');
  const lcsw = await make(admin, 'Lena Clinical', 'lcsw');
  const lmsw = await make(admin, 'Lou Casemgr', 'lmsw');
  // A body that still sends the retired checkboxes and a contradicting role.
  const sneaky = await make(admin, 'Sam Sneaky', 'rn', { role: 'admin', isManager: true, hasAdminHubAccess: true, hasClientPortalAdminAccess: true, hasServicePortalAccess: true });
  const bad = await make(admin, 'Bad Type', 'wizard');
  ok('an unknown account type is refused by name', bad.status === 400 && bad.body.code === 'ACCOUNT_TYPE_INVALID', bad.body);

  const users = (await call('GET', '/api/users', admin)).body;
  const get = (id) => users.find(u => u.id === id) || {};
  const expect = [
    [mgr, 'manager', 'user', true, 'readOnly'], [mgrNone, 'manager', 'user', true, null],
    [coord, 'coordinator', 'user', true, 'coordinator'], [prov, 'provider', 'user', false, 'provider'],
    [rn, 'rn', 'user', false, 'rn'], [lcsw, 'lcsw', 'user', false, 'lcsw'], [lmsw, 'lmsw', 'caseManager', false, 'lmsw'],
    [sneaky, 'rn', 'user', false, 'rn']
  ];
  for (const [u, type, role, isManager, clinicalRole] of expect) {
    const s = get(u.id);
    ok(`${type}: role ${role}, manager ${isManager}, clinical role ${clinicalRole}`,
      s.accountType === type && s.role === role && s.isManager === isManager && (s.clinicalRole || null) === clinicalRole, s);
  }
  ok('the body could not smuggle in admin, the manager flag or a checkbox', get(sneaky.id).role === 'user' && !get(sneaky.id).isManager, get(sneaky.id));
  ok('  a manager defaults to View only', get(mgr.id).managerClinicalAccess === 'view', get(mgr.id));

  console.log('\n--- 3. where each lands, and what the hub shows ---');
  const L = {};
  for (const [k, u] of Object.entries({ mgr, mgrNone, coord, prov, rn, lcsw, lmsw })) L[k] = await login(u.email, PW);
  for (const k of ['prov', 'rn', 'lcsw', 'lmsw']) ok(`${k} lands on /clinical`, L[k].user && L[k].user.landing === '/clinical', L[k].user && L[k].user.landing);
  for (const k of ['mgr', 'mgrNone', 'coord']) ok(`${k} lands on the hub`, L[k].user && L[k].user.landing === null, L[k].user);
  ok('coordinator sees Clinical Workspace and Private Home Care', tileIds(L.coord.user) === 'clinical,privateHomeCare', L.coord.user.hubTiles);
  ok('manager (View only) sees Clinical Workspace and Private Home Care', tileIds(L.mgr.user) === 'clinical,privateHomeCare', L.mgr.user.hubTiles);
  ok('manager (No access) sees Private Home Care only', tileIds(L.mgrNone.user) === 'privateHomeCare', L.mgrNone.user.hubTiles);
  const phc = L.mgr.user.hubTiles.find(t => t.id === 'privateHomeCare');
  ok('  which opens to Caregiver Management and Caregiver Scheduling',
    phc && phc.children.map(c => c.path).join(',') === '/caregivers,/scheduling', phc);

  console.log('\n--- 4. what each can open ---');
  const t = (k) => L[k].token;
  for (const k of ['mgr', 'coord']) {
    ok(`${k}: Admin Hub API refused`, (await call('GET', '/api/admin-hub/dashboard', t(k))).status === 403);
    ok(`${k}: scheduling board opens`, (await call('GET', '/api/scheduling/summary', t(k))).status === 200);
    ok(`${k}: caregiver management opens`, (await call('GET', '/api/caregiver/incidents', t(k))).status === 200);
  }
  ok('admin: Admin Hub API opens', (await call('GET', '/api/admin-hub/dashboard', admin)).status === 200);
  const st = async (k) => ((await call('GET', '/api/clinical/status', t(k))).body || {}).access || {};
  const mgrAccess = await st('mgr');
  ok('manager (View only): reads the chart, edits nothing', mgrAccess.canRead && !mgrAccess.canWrite && !mgrAccess.canDocument, mgrAccess);
  const coordAccess = await st('coord');
  ok('coordinator: writes and edits charts, holds no licence', coordAccess.canDocument && !coordAccess.canWrite, coordAccess);
  const provAccess = await st('prov');
  ok('provider: full clinical write', provAccess.canWrite, provAccess);

  console.log('\n--- 5. changing an account ---');
  const up = await call('PUT', `/api/users/${mgr.id}`, admin, { accountType: 'manager', managerClinicalAccess: 'edit' });
  ok('a manager can be granted chart editing', up.status === 200, up.body);
  const after = (await call('GET', '/api/users', admin)).body.find(u => u.id === mgr.id);
  ok('  stored as the coordinator clinical role, still a manager',
    after.clinicalRole === 'coordinator' && after.isManager && after.accountType === 'manager' && after.managerClinicalAccess === 'edit', after);
  const relog = await login(mgr.email, PW);
  const editAccess = ((await call('GET', '/api/clinical/status', relog.token)).body || {}).access || {};
  ok('  and can now document', editAccess.canDocument === true, editAccess);
  const badAccess = await call('PUT', `/api/users/${mgr.id}`, admin, { accountType: 'manager', managerClinicalAccess: 'everything' });
  ok('an unknown clinical access level is refused', badAccess.status === 400 && badAccess.body.code === 'MANAGER_ACCESS_INVALID', badAccess.body);
  await call('PUT', `/api/users/${prov.id}`, admin, { hasAdminHubAccess: true, hasServicePortalAccess: true });
  const prov2 = (await call('GET', '/api/users', admin)).body.find(u => u.id === prov.id);
  ok('a retired checkbox cannot be switched back on', prov2.hasAdminHubAccess === undefined || prov2.hasAdminHubAccess === false, prov2);

  const me = (await call('GET', '/api/users', admin)).body.find(u => u.email === ADMIN_EMAIL);
  const admins = (await call('GET', '/api/users', admin)).body.filter(u => u.role === 'admin' && u.accountStatus !== 'inactive');
  if (admins.length === 1) {
    const demote = await call('PUT', `/api/users/${me.id}`, admin, { accountType: 'manager' });
    ok('the only Super Admin cannot be demoted', demote.status === 409 && demote.body.code === 'LAST_SUPER_ADMIN', demote.body);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
