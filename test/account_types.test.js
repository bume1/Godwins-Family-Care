// One account type per user (owner, 2026-10-15). See accountTypes.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const at = require('../accountTypes');
const clinicalRoles = require('../clinicalRoles');
const messaging = require('../messagingRepository');

const root = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const loginSrc = fs.readFileSync(path.join(root, 'public', 'login.html'), 'utf8');
const hubSrc = fs.readFileSync(path.join(root, 'public', 'admin-hub.html'), 'utf8');

// ---- The ten types and what each stores --------------------------------

test('there are exactly the ten account types the owner listed', () => {
  assert.deepEqual(at.ALL_TYPES, ['admin', 'manager', 'provider', 'rn', 'lcsw', 'lmsw', 'coordinator', 'caregiver', 'client', 'family']);
  assert.equal(at.ACCOUNT_TYPES.find(t => t.value === 'lmsw').label, 'LMSW / Case Manager');
  assert.equal(at.ACCOUNT_TYPES.find(t => t.value === 'coordinator').label, 'Care Coordinator',
    'no "unlicensed" in the label (owner, 2026-10-15)');
});

test('every case manager is an LMSW: the LMSW type is the case-manager account', () => {
  const f = at.fieldsFor('lmsw');
  assert.equal(f.role, 'caseManager');
  assert.equal(f.clinicalRole, 'lmsw');
  assert.equal(f.isManager, false);
  assert.equal(f.hasClinicalAccess, true);
});

test('a care coordinator is a manager plus chart editing, never a case manager', () => {
  const f = at.fieldsFor('coordinator');
  assert.equal(f.role, 'user');
  assert.equal(f.isManager, true, 'manager gates (scheduling, billing, caregiver management) admit them');
  assert.equal(f.clinicalRole, 'coordinator');
  assert.equal(f.hasClinicalAccess, false, 'no clinical licence, so no signing');
  const u = { id: 'c', ...f };
  assert.equal(clinicalRoles.canSubmitBilling(u), true);
  assert.equal(clinicalRoles.canDocumentClinically(u), true, 'writes and edits charts');
  assert.equal(clinicalRoles.canClinicalWrite(u), false, 'still refused at the licensed write gate');
});

test('a manager is View only by default, and an admin can turn it off or grant chart editing', () => {
  const dflt = at.fieldsFor('manager');
  assert.equal(dflt.managerClinicalAccess, 'view');
  assert.equal(dflt.clinicalRole, 'readOnly');
  assert.equal(dflt.isManager, true);
  const m = (lvl) => ({ id: 'm', ...at.fieldsFor('manager', { managerClinicalAccess: lvl }) });
  assert.equal(clinicalRoles.canClinicalRead(m('view')), true);
  assert.equal(clinicalRoles.canDocumentClinically(m('view')), false, 'View only edits nothing');
  assert.equal(at.fieldsFor('manager', { managerClinicalAccess: 'none' }).clinicalRole, null);
  assert.equal(clinicalRoles.canDocumentClinically(m('edit')), true);
  assert.equal(clinicalRoles.canClinicalWrite(m('edit')), false, 'edit is the coordinator level, never a licence');
  assert.equal(at.fieldsFor('manager', { managerClinicalAccess: 'bogus' }).managerClinicalAccess, 'view', 'an unknown level falls back to the default');
});

test('licensed clinicians keep their credential and no manager flag', () => {
  for (const t of ['provider', 'rn', 'lcsw']) {
    const f = at.fieldsFor(t);
    assert.equal(f.role, 'user');
    assert.equal(f.clinicalRole, t);
    assert.equal(f.isManager, false);
    assert.equal(f.hasClinicalAccess, true);
  }
  assert.equal(at.fieldsFor('admin').role, 'admin');
  assert.equal(at.fieldsFor('caregiver').role, 'vendor');
  assert.equal(at.fieldsFor('nope'), null);
});

// ---- Where each lands and what the hub shows ---------------------------

test('Provider, RN, LCSW and LMSW / Case Manager land on /clinical', () => {
  for (const t of ['provider', 'rn', 'lcsw', 'lmsw']) {
    assert.equal(at.landingFor({ ...at.fieldsFor(t) }), '/clinical', t);
  }
});

test('the Super Admin, a manager and a care coordinator land on the hub', () => {
  for (const t of ['admin', 'manager', 'coordinator']) assert.equal(at.landingFor({ ...at.fieldsFor(t) }), null, t);
  assert.equal(at.landingFor({ ...at.fieldsFor('client'), slug: 'ada' }), '/portal/ada');
  assert.equal(at.landingFor({ ...at.fieldsFor('family') }), '/portal');
  assert.equal(at.landingFor({ ...at.fieldsFor('caregiver'), licenseLevel: 'cna' }), '/caregiver');
  assert.equal(at.landingFor({ ...at.fieldsFor('caregiver') }), null, 'no licence level, no caregiver app');
});

const ids = (u) => at.hubTilesFor(u).map(t => t.id);

test('only the Super Admin sees the Admin Hub, the Service Portal and the Client Portal Admin', () => {
  assert.deepEqual(ids(at.fieldsFor('admin')), ['admin', 'clinical', 'privateHomeCare', 'service', 'clientPortalAdmin']);
  for (const u of [at.fieldsFor('manager'), at.fieldsFor('coordinator'), at.fieldsFor('manager', { managerClinicalAccess: 'edit' })]) {
    for (const blocked of ['admin', 'service', 'clientPortalAdmin']) assert.ok(!ids(u).includes(blocked), blocked);
  }
});

test('a coordinator sees Clinical Workspace and Private Home Care; a manager sees Clinical Workspace only when granted', () => {
  assert.deepEqual(ids(at.fieldsFor('coordinator')), ['clinical', 'privateHomeCare']);
  assert.deepEqual(ids(at.fieldsFor('manager')), ['clinical', 'privateHomeCare'], 'View only by default');
  assert.deepEqual(ids(at.fieldsFor('manager', { managerClinicalAccess: 'none' })), ['privateHomeCare']);
});

test('Private Home Care opens to Caregiver Management and Caregiver Scheduling', () => {
  const phc = at.hubTilesFor(at.fieldsFor('manager')).find(t => t.id === 'privateHomeCare');
  assert.deepEqual(phc.children.map(c => [c.name, c.path]),
    [['Caregiver Management', '/caregivers'], ['Caregiver Scheduling', '/scheduling']]);
});

// ---- The boot migration ------------------------------------------------

test('the migration clears the lab-era checkboxes on everyone', () => {
  const { users } = at.applyAccountTypeMigration([
    { id: 'a', role: 'admin', hasAdminHubAccess: true },
    { id: 'v', role: 'vendor', licenseLevel: 'pca', hasServicePortalAccess: true },
    { id: 'm', role: 'user', isManager: true, hasClientPortalAdminAccess: true }
  ]);
  for (const u of users) for (const f of at.LEGACY_FLAGS) assert.equal(!!u[f], false, `${u.id}.${f}`);
});

test('a coordinator stored as a case manager becomes the coordinator type', () => {
  const { users } = at.applyAccountTypeMigration([{ id: 'c', role: 'caseManager', clinicalRole: 'coordinator' }]);
  assert.equal(users[0].accountType, 'coordinator');
  assert.equal(users[0].role, 'user');
  assert.equal(users[0].isManager, true);
  assert.equal(users[0].clinicalRole, 'coordinator');
});

test('an LMSW set up as a clinical account becomes LMSW / Case Manager', () => {
  const { users } = at.applyAccountTypeMigration([{ id: 'l', role: 'user', clinicalRole: 'lmsw', hasClinicalAccess: true }]);
  assert.equal(users[0].accountType, 'lmsw');
  assert.equal(users[0].role, 'caseManager');
});

test('a manager keeps the access they had, and old clinical accounts stay providers', () => {
  const { users } = at.applyAccountTypeMigration([
    { id: 'm', role: 'user', isManager: true },
    { id: 'p', role: 'user', hasClinicalAccess: true }
  ]);
  assert.equal(users[0].accountType, 'manager');
  assert.equal(users[0].managerClinicalAccess, 'none', 'a manager with no chart access is not widened by the migration');
  assert.equal(users[0].clinicalRole ?? null, null);
  assert.equal(users[1].accountType, 'provider');
});

test('anything that does not map cleanly is flagged, never guessed', () => {
  const { users, needsReview } = at.applyAccountTypeMigration([
    { id: 'cm', role: 'caseManager', clinicalRole: 'readOnly' },   // an admin deliberately set read-only
    { id: 'tm', role: 'user' },                                    // a lab-era team member
    { id: 'ro', role: 'user', clinicalRole: 'readOnly' }
  ]);
  assert.deepEqual(needsReview.map(r => r.id), ['cm', 'tm', 'ro']);
  assert.equal(users[0].clinicalRole, 'readOnly', 'a read-only case manager is not widened to LMSW');
  assert.equal(users[0].role, 'caseManager');
  for (const u of users) assert.equal(u.accountTypeNeedsReview, true);
  assert.equal(at.landingFor(users[0]), '/clinical', 'they keep the landing they had while they wait');
});

test('the migration is idempotent', () => {
  const first = at.applyAccountTypeMigration([
    { id: 'c', role: 'caseManager', clinicalRole: 'coordinator', hasAdminHubAccess: true },
    { id: 'p', role: 'user', clinicalRole: 'provider' },
    { id: 'm', role: 'user', isManager: true, clinicalRole: 'readOnly' }
  ]);
  const second = at.applyAccountTypeMigration(first.users);
  assert.equal(second.changed.length, 0);
  assert.deepEqual(second.users, first.users);
  for (const u of second.users) assert.equal(at.isConsistent(u), true, u.id);
});

// ---- The server --------------------------------------------------------

const lift = (anchor) => {
  const i = serverSrc.indexOf(anchor);
  assert.ok(i > 0, anchor);
  const body = serverSrc.slice(i, serverSrc.indexOf('\n};', i) + 3);
  // eslint-disable-next-line no-new-func
  return new Function('config', `${body}; return ${anchor.replace('const ', '').replace(' = ', '')};`)(require('../config'));
};

test('the Admin Hub and Client Portal Admin gates admit only the Super Admin', () => {
  for (const name of ['requireAdminHubAccess', 'requireClientPortalAdmin']) {
    const gate = lift(`const ${name} = `);
    const run = (user) => { let passed = false; const res = { status: () => ({ json: () => {} }) }; gate({ user }, res, () => { passed = true; }); return passed; };
    assert.equal(run({ role: 'admin' }), true, name);
    assert.equal(run({ role: 'user', isManager: true }), false, `${name}: a manager`);
    assert.equal(run({ role: 'user', hasAdminHubAccess: true, hasClientPortalAdminAccess: true }), false, `${name}: an old checkbox`);
  }
});

test('the user routes let the account type decide role, manager flag and clinical role', () => {
  for (const sig of ["app.post('/api/users', authenticateToken", "app.put('/api/users/:userId', authenticateToken"]) {
    const i = serverSrc.indexOf(sig);
    const body = serverSrc.slice(i, i + 6000);
    assert.match(body, /accountTypes\.fieldsFor\(accountType, \{ managerClinicalAccess \}\)/, sig);
    assert.match(body, /const role = typed \? typed\.role : req\.body\.role;/, sig);
    assert.match(body, /const isManager = typed \? typed\.isManager : req\.body\.isManager;/, sig);
    assert.match(body, /const clinicalRole = typed \? typed\.clinicalRole : req\.body\.clinicalRole;/, sig);
    assert.match(body, /ACCOUNT_TYPE_INVALID/, `${sig} refuses an unknown type by name`);
  }
  const put = serverSrc.slice(serverSrc.indexOf("app.put('/api/users/:userId', authenticateToken"));
  assert.match(put.slice(0, 9000), /users\[idx\]\.hasAdminHubAccess = false;/, 'any save clears the retired checkboxes');
  assert.match(put.slice(0, 9000), /LAST_SUPER_ADMIN/, 'the only Super Admin cannot be demoted');
});

test('the login response carries the landing and the hub tiles, and the page reads them', () => {
  assert.match(serverSrc, /landing: accountTypes\.landingFor\(user\),/);
  assert.match(serverSrc, /hubTiles: accountTypes\.hubTilesFor\(user\),/);
  assert.match(loginSrc, /Array\.isArray\(user\.hubTiles\) \? user\.hubTiles : fallbackTiles\(\)/);
  assert.match(loginSrc, /hasOwnProperty\.call\(u, 'landing'\)\) return u\.landing \|\| null;/);
  assert.ok(!/hasAdminHubAccess|hasClientPortalAdminAccess|hasServicePortalAccess/.test(loginSrc), 'the login page reads no retired checkbox');
});

test('the user form has no lab-era checkboxes and no role list of its own', () => {
  for (const id of ['serviceAccess', 'adminHubAccess', 'clientPortalAdmin']) {
    assert.ok(!hubSrc.includes(`id="${id}"`), id);
  }
  const form = hubSrc.slice(hubSrc.indexOf('Account Type *'), hubSrc.indexOf('Account Type *') + 4000);
  assert.ok(!/<option value="(admin|user|manager|coordinator|caseManager|vendor|client|family)">/.test(form), 'types are served, not listed');
});

test('a manager or coordinator messages as the office rather than having no messaging role', () => {
  assert.equal(messaging.actorRole({ role: 'user', isManager: true }), messaging.ROLE.ADMIN);
  assert.equal(messaging.actorRole({ ...at.fieldsFor('coordinator') }), messaging.ROLE.ADMIN);
  assert.equal(messaging.actorRole({ ...at.fieldsFor('lmsw') }), messaging.ROLE.CASE_MANAGER);
});
