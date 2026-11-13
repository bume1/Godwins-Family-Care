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

test('there are exactly the eleven account types the owner listed', () => {
  // Community Care Liaison added by the owner, 2026-11-08.
  assert.deepEqual(at.ALL_TYPES, ['admin', 'manager', 'provider', 'rn', 'lcsw', 'lmsw', 'coordinator', 'caregiver', 'liaison', 'client', 'family']);
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

// Owner, 2026-11-09: the Portal Hub is the front door for ALL internal staff.
test('Provider, RN, LCSW and LMSW / Case Manager land on the hub', () => {
  for (const t of ['provider', 'rn', 'lcsw', 'lmsw']) {
    assert.equal(at.landingFor({ ...at.fieldsFor(t) }), null, t);
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
const areas = (u) => at.hubAreasFor(u).map(a => [a.id, a.links.map(l => l.id)]);

test('the hub is grouped by area: My GFC, People, Clients, Clinical, Billing, Admin & Compliance (owner, 2026-11-09)', () => {
  assert.deepEqual(areas(at.fieldsFor('admin')), [
    ['myGfc', ['myGfc']],
    ['people', ['users', 'onboarding', 'caregiverManagement', 'caregiverScheduling']],
    ['clients', ['clients']],
    ['clinical', ['clinical', 'ime']],
    ['billing', ['billing', 'payroll']],
    ['adminCompliance', ['admin', 'audit', 'incidents', 'service', 'clientPortalAdmin']]
  ]);
  assert.deepEqual(at.hubAreasFor(at.fieldsFor('admin')).map(a => a.name),
    ['My GFC', 'People', 'Clients', 'Clinical', 'Billing', 'Admin & Compliance']);
  for (const t of ['provider', 'rn', 'lcsw', 'lmsw']) {
    assert.deepEqual(areas(at.fieldsFor(t)), [['myGfc', ['myGfc']], ['clinical', ['clinical', 'ime']]], t);
  }
  assert.deepEqual(areas({ ...at.fieldsFor('caregiver'), licenseLevel: 'cna' }), [['myGfc', ['myGfc']]]);
  assert.equal(at.hubTilesFor({ ...at.fieldsFor('caregiver'), licenseLevel: 'cna' })[0].path, '/caregiver');
  assert.deepEqual(areas(at.fieldsFor('caregiver')), [], 'no licence level, nothing on the hub');
  for (const t of ['client', 'family']) assert.deepEqual(areas(at.fieldsFor(t)), [], t);
  // An area with no link for this account is left out, never drawn empty.
  for (const t of ['admin', 'manager', 'coordinator', 'provider', 'rn', 'lcsw', 'lmsw', 'liaison']) {
    for (const a of at.hubAreasFor(at.fieldsFor(t))) assert.ok(a.links.length > 0, `${t} ${a.id}`);
  }
});

test('People is our team, Clients is who we serve (owner, 2026-11-09)', () => {
  const area = (t, id) => at.hubAreasFor(at.fieldsFor(t)).find(a => a.id === id);
  for (const t of ['admin', 'manager', 'coordinator']) {
    assert.equal(area(t, 'people').links.find(l => l.id === 'users').path, '/admin?view=users&group=staff', t);
    // One standalone Clients area (owner, 2026-11-09), not a filtered User Management.
    assert.deepEqual(area(t, 'clients').links.map(l => [l.id, l.path]), [['clients', '/clients']], t);
  }
});

test('only the Super Admin sees the Admin Hub, the Service Portal and the Client Portal Admin', () => {
  assert.deepEqual(ids(at.fieldsFor('admin')), ['myGfc', 'users', 'onboarding', 'caregiverManagement', 'caregiverScheduling',
    'clients', 'clinical', 'ime', 'billing', 'payroll', 'admin', 'audit', 'incidents', 'service', 'clientPortalAdmin']);
  for (const u of [at.fieldsFor('manager'), at.fieldsFor('coordinator'), at.fieldsFor('manager', { managerClinicalAccess: 'edit' })]) {
    for (const blocked of ['admin', 'service', 'clientPortalAdmin', 'payroll']) assert.ok(!ids(u).includes(blocked), blocked);
  }
});

test('a coordinator sees Clinical, Private Home Care, Enrollment, Billing and Messages; a manager sees Clinical only when granted', () => {
  // 'people' holds User Management, the one part of the Admin Hub open to
  // them (owner, 2026-11-04), and Staff Onboarding (owner, 2026-11-08).
  const office = ['myGfc', 'messages', 'users', 'onboarding', 'caregiverManagement', 'caregiverScheduling', 'clients'];
  // The Incident Log is theirs too (owner, 2026-11-09), alone in Admin & Compliance.
  assert.deepEqual(ids(at.fieldsFor('coordinator')), [...office, 'clinical', 'ime', 'billing', 'incidents']);
  assert.deepEqual(ids(at.fieldsFor('manager')), [...office, 'clinical', 'ime', 'billing', 'incidents'], 'View only by default');
  assert.deepEqual(ids(at.fieldsFor('manager', { managerClinicalAccess: 'none' })), [...office, 'ime', 'billing', 'incidents'],
    'Enrollment and Billing are their own modules, not inside clinical (owner, 2026-10-15)');
  for (const t of ['provider', 'rn', 'lcsw', 'lmsw', 'caregiver', 'client', 'family']) {
    assert.ok(!ids(at.fieldsFor(t)).includes('billing'), `${t} has no Billing tile`);
  }
  const tile = (id) => at.hubTilesFor(at.fieldsFor('manager')).find(t => t.id === id);
  assert.equal(tile('clients').path, '/clients');
  assert.equal(tile('billing').path, '/billing');
});

// Payroll had no tile anywhere on the hub (owner report, 2026-11-13). It is the
// Super Admin's alone, matching its requireAdmin routes.
test('the Super Admin has a Payroll tile under Billing; nobody else does', () => {
  const pay = at.hubTilesFor(at.fieldsFor('admin')).find(t => t.id === 'payroll');
  assert.ok(pay, 'admin sees Payroll');
  assert.equal(pay.path, '/payroll');
  for (const t of ['manager', 'coordinator', 'provider', 'rn', 'lcsw', 'lmsw', 'liaison', 'caregiver', 'client', 'family']) {
    assert.ok(!ids({ ...at.fieldsFor(t), licenseLevel: t === 'caregiver' ? 'cna' : undefined }).includes('payroll'), t);
  }
  const routes = fs.readFileSync(path.join(root, 'routes', 'payroll.js'), 'utf8');
  const regs = routes.match(/router\.(get|post|put|delete)\('\/api\/payroll\/admin[^\n]*/g) || [];
  assert.ok(regs.length > 10, 'the admin routes were found');
  for (const r of regs) assert.match(r, /authenticateToken, requireAdmin\b/, r);
});

// ---- Enrollment and Billing for managers and coordinators (owner, 2026-10-15)

const ENROLLMENT_WRITES = [
  "'/api/gfc/admin/signups/:id/decide'", "'/api/gfc/admin/enrollment/:clientId/family-invites/:inviteId/decide'",
  "'/api/gfc/admin/enrollment/:clientId/service-line'", "'/api/gfc/admin/enrollment/:clientId/documents/request'",
  "'/api/gfc/admin/enrollment/:clientId/documents/remind'",
  "'/api/gfc/admin/enrollment/:clientId/documents/:docId/move-to-caregiver'", "'/api/gfc/admin/enrollment/:clientId/documents/upload-link'",
  "'/api/gfc/admin/enrollment/:clientId/documents/upload-link/revoke'", "'/api/gfc/admin/enrollment/:clientId/review'",
  "'/api/gfc/admin/enrollment/:clientId/follow-up'", "'/api/gfc/admin/enrollment/:clientId/approve'",
  "'/api/gfc/admin/enrollment/offline'", "'/api/gfc/admin/enrollment/:clientId/rate'",
  "'/api/gfc/admin/enrollment/:clientId/consent/:type/offline'", "'/api/clinical/patients/:clientId/facility'"
];

test('every enrollment workflow write is open to a manager and a coordinator, and to nobody else new', () => {
  for (const p of ENROLLMENT_WRITES) {
    assert.match(serverSrc, new RegExp(`app\\.(post|put)\\(${p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}, authenticateToken, requireEnrollmentManager`), p);
  }
  // canManageEnrollment is the one predicate requireEnrollmentManager calls; run it.
  assert.match(serverSrc, /const requireEnrollmentManager = \(req, res, next\) => \{\s*if \(canManageEnrollment\(req\.user\)\) return next\(\);/);
  const i = serverSrc.indexOf('const canManageEnrollment = ');
  const pred = new Function('config', `${serverSrc.slice(i, serverSrc.indexOf(';', i) + 1)} return canManageEnrollment;`)(require('../config'));
  const can = (u) => pred(u);
  assert.equal(can({ role: 'admin' }), true);
  assert.equal(can(at.fieldsFor('manager', { managerClinicalAccess: 'none' })), true);
  assert.equal(can(at.fieldsFor('coordinator')), true);
  for (const t of ['provider', 'rn', 'lcsw', 'lmsw', 'caregiver', 'client', 'family']) assert.equal(can(at.fieldsFor(t)), false, t);
  assert.equal(can({ ...at.fieldsFor('manager'), accountStatus: 'inactive' }), false, 'a deactivated manager is refused');
});

test('a manager and a coordinator can correct the enrollment submission too', () => {
  assert.match(serverSrc, /const canEditEnrollment = \(user\) => !!user &&\s*\(user\.role === config\.ROLES\.ADMIN \|\| canManageEnrollment\(user\)/);
});

test('the enrollment page offers the workflow buttons to managers and coordinators', () => {
  const page = fs.readFileSync(path.join(root, 'public', 'admin-enrollment.html'), 'utf8');
  assert.match(page, /const canManageRole = \(user\) => !!user && \(user\.role === 'admin' \|\| user\.isManager === true\);/);
  assert.match(page, /const canEdit = canManageRole\(user\);/);
  assert.ok(!/isAdmin=\{isAdminRole\(user\)\}/.test(page), 'documents and family invites follow the same rule');
});

test('the Billing module is its own page on its own route, behind the billing gate', () => {
  assert.match(serverSrc, /app\.get\('\/billing', \(req, res\) => \{\s*res\.sendFile\(__dirname \+ '\/public\/billing\.html'\);/);
  const i = serverSrc.indexOf("app.get('/api/gfc/admin/billing-statements', authenticateToken, requireBilling");
  assert.ok(i > 0, 'the statement list is behind requireBilling');
  assert.ok(i < serverSrc.indexOf("app.get('/api/gfc/admin/billing/:clientId'"), 'and registered before the per-client route');
  const page = fs.readFileSync(path.join(root, 'public', 'billing.html'), 'utf8');
  // 2026-11-04: the claims workspace lives here, filtered by billing stage.
  for (const route of ['/api/clinical/encounters/queue?state=', '/api/gfc/admin/billing-statements',
    '/billing-submit', '/api/gfc/admin/billing/invoices/']) assert.ok(page.includes(route), route);
  assert.match(page, /\['awaiting_billing', 'Awaiting Billing'\]/, 'the worklist opens on what is waiting on billing');
  assert.match(page, /submit\(\{ attest: true \}\)/, 'Submit carries the attestation');
  const pred = require('../clinicalRoles').canSubmitBilling;
  assert.equal(pred({ ...at.fieldsFor('coordinator') }), true);
  assert.equal(pred({ ...at.fieldsFor('manager', { managerClinicalAccess: 'none' }) }), true);
  assert.equal(pred({ ...at.fieldsFor('provider') }), false);
});

test('Home Care Oversight and Caregiver Scheduling sit in People for now (owner, 2026-11-09)', () => {
  const people = at.hubAreasFor(at.fieldsFor('manager')).find(a => a.id === 'people');
  assert.deepEqual(people.links.filter(l => l.path === '/caregivers' || l.path === '/scheduling').map(c => [c.name, c.path]),
    [['Home Care Oversight', '/caregivers'], ['Staff Scheduling', '/scheduling']]);
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
  assert.match(serverSrc, /hubAreas: accountTypes\.hubAreasFor\(user\),/);
  assert.match(serverSrc, /app\.get\('\/api\/staff\/hub', authenticateToken,/, 'the hub and the staff bar re-read the areas');
  assert.match(loginSrc, /Array\.isArray\(user\.hubAreas\) \? user\.hubAreas : null/);
  assert.match(loginSrc, /fetch\('\/api\/staff\/hub'/);
  assert.ok(!/fallbackTiles|PHC_CHILDREN/.test(loginSrc), 'the login page keeps no second copy of who sees what');
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

test('a manager or coordinator messages as the office (not as admin) rather than having no messaging role', () => {
  assert.equal(messaging.actorRole({ role: 'user', isManager: true }), messaging.ROLE.MANAGER);
  assert.equal(messaging.actorRole({ ...at.fieldsFor('coordinator') }), messaging.ROLE.MANAGER);
  assert.equal(messaging.actorRole({ ...at.fieldsFor('lmsw') }), messaging.ROLE.CASE_MANAGER);
});

// Owner, 2026-10-16: approving a document is narrower than the other enrollment
// decisions: a care coordinator or the admin, never a plain manager.
test('document approval is the care coordinator\'s or the admin\'s alone', () => {
  assert.match(serverSrc, /app\.post\('\/api\/gfc\/admin\/enrollment\/:clientId\/documents\/:uploadId\/review', authenticateToken, requireDocumentApprover/);
  const roles = require('../clinicalRoles');
  assert.equal(roles.canApproveChartDocuments({ role: 'admin' }), true);
  assert.equal(roles.canApproveChartDocuments(at.fieldsFor('coordinator')), true);
  assert.equal(roles.canApproveChartDocuments(at.fieldsFor('manager', { managerClinicalAccess: 'view' })), false, 'a plain manager');
  for (const t of ['provider', 'rn', 'lcsw', 'lmsw', 'caregiver', 'client', 'family']) assert.equal(roles.canApproveChartDocuments(at.fieldsFor(t)), false, t);
  assert.equal(roles.canApproveChartDocuments({ ...at.fieldsFor('coordinator'), accountStatus: 'inactive' }), false);
});

test('People holds User Management, Staff Onboarding and the caregiver office (owner, 2026-11-08, 2026-11-09)', () => {
  for (const t of ['admin', 'manager', 'coordinator']) {
    const people = at.hubAreasFor(at.fieldsFor(t)).find(x => x.id === 'people');
    assert.deepEqual(people.links.map(c => [c.id, c.path]), [['users', '/admin?view=users&group=staff'], ['onboarding', '/onboarding'],
      ['caregiverManagement', '/caregivers'], ['caregiverScheduling', '/scheduling']], t);
  }
  for (const t of ['provider', 'rn', 'lcsw', 'lmsw', 'caregiver', 'client', 'family']) {
    assert.ok(!at.hubAreasFor(at.fieldsFor(t)).some(a => a.id === 'people' || a.id === 'clients'), t);
  }
});
