'use strict';
// The Modules grid on Edit User (owner, 2026-11-13): a module the account
// type includes can be taken away, one it does not include can be granted,
// and locked rows never move. accountTypes.hasModule is the one answer, read
// by the hub and by every module's route gate.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const at = require('../accountTypes');
const roles = require('../clinicalRoles');
const mfa = require('../mfa');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const coord = () => ({ id: 'c1', ...at.fieldsFor('coordinator') });
const rn = () => ({ id: 'r1', ...at.fieldsFor('rn') });
const cg = () => ({ id: 'g1', ...at.fieldsFor('caregiver'), licenseLevel: 'cna' });
const ids = (u) => at.hubTilesFor(u).map(t => t.id);

test('a grant adds a module the role does not include; a removal takes away one it does', () => {
  const r = { ...rn(), moduleAccess: at.moduleAccessFromChecks(rn(), [...at.modulesFor(rn()), 'billing', 'payroll']) };
  assert.deepStrictEqual(r.moduleAccess, { granted: ['billing', 'payroll'], removed: [] }, 'only the difference is stored');
  assert.ok(at.hasModule(r, 'billing') && at.hasModule(r, 'payroll'));
  assert.ok(ids(r).includes('billing') && ids(r).includes('payroll'), 'and the hub shows them');
  assert.equal(roles.canSubmitBilling(r), true, 'the billing gate follows the grant');

  const c = { ...coord(), moduleAccess: at.moduleAccessFromChecks(coord(), at.modulesFor(coord()).filter(id => id !== 'billing')) };
  assert.deepStrictEqual(c.moduleAccess, { granted: [], removed: ['billing'] });
  assert.equal(at.hasModule(c, 'billing'), false);
  assert.ok(!ids(c).includes('billing'), 'the tile goes');
  assert.equal(roles.canSubmitBilling(c), false, 'and so does the route');
  assert.equal(roles.canSubmitBilling(coord()), true, 'an untouched coordinator keeps it');
});

test('locked modules never move: My GFC, Messages, the Admin Hub and the lab-era screens', () => {
  for (const id of ['myGfc', 'messages', 'admin', 'service', 'clientPortalAdmin']) assert.ok(!at.GRANTABLE_MODULES.includes(id), id);
  // Ticking the Admin Hub for a coordinator stores nothing; a raw stored grant is ignored.
  assert.deepStrictEqual(at.moduleAccessFromChecks(coord(), [...at.modulesFor(coord()), 'admin']), { granted: [], removed: [] });
  const forged = { ...coord(), moduleAccess: { granted: ['admin', 'service'], removed: ['myGfc'] } };
  assert.equal(at.hasModule(forged, 'admin'), false, 'nobody gives themselves the Admin Hub');
  assert.equal(at.hasModule(forged, 'myGfc'), true);
  assert.deepStrictEqual(at.moduleAccessOf(forged), { granted: [], removed: [] });
  // The Super Admin cannot be narrowed.
  const admin = { ...at.fieldsFor('admin'), moduleAccess: { removed: ['billing', 'payroll', 'users'] } };
  for (const id of ['billing', 'payroll', 'users', 'admin', 'audit']) assert.equal(at.hasModule(admin, id), true, id);
});

test('the grid lists every module with who it comes from, and none for a client or family', () => {
  const g = at.moduleGridFor({ ...rn(), moduleAccess: { granted: ['payroll'], removed: ['ime'] } });
  const row = (id) => g.find(r => r.id === id);
  assert.equal(g.length, at.MODULE_IDS.length);
  assert.equal(row('clinical').state, 'role');
  assert.equal(row('ime').state, 'removed');
  assert.equal(row('payroll').state, 'granted');
  assert.match(row('payroll').note, /Prepare only/);
  assert.equal(row('billing').state, 'off');
  assert.ok(row('admin').locked, 'the Admin Hub row is locked');
  for (const t of ['client', 'family']) assert.deepStrictEqual(at.moduleGridFor(at.fieldsFor(t)), [], t);
  const a = at.moduleGridFor(at.fieldsFor('admin'));
  assert.ok(a.every(r => r.locked), 'a Super Admin row is locked: they have every module');
  // A client or family record carrying a stray grant gets nothing from it.
  assert.equal(at.hasModule({ ...at.fieldsFor('client'), moduleAccess: { granted: ['billing'] } }, 'billing'), false);
});

test('a Clinical Workspace grant is view only; a removal closes the chart', () => {
  const g = { ...cg(), moduleAccess: { granted: ['clinical'], removed: [] } };
  assert.equal(roles.resolveClinicalRole(g), 'readOnly');
  assert.equal(roles.canClinicalRead(g), true);
  assert.equal(roles.canClinicalWrite(g), false, 'a tick box confers no licence');
  const r = { ...rn(), moduleAccess: { granted: [], removed: ['clinical'] } };
  assert.equal(roles.resolveClinicalRole(r), null);
  assert.equal(roles.canClinicalRead(r), false);
  assert.equal(roles.resolveClinicalRole(rn()), 'rn', 'an untouched RN keeps her role');
  // The 4.8 migration is untouched by grants.
  assert.equal(roles.resolveClinicalRole({ role: 'admin', moduleAccess: { removed: ['clinical'] } }), 'provider');
});

test('a caregiver or liaison given a module lands on the Portal Hub, where its tile is', () => {
  assert.equal(at.landingFor(cg()), '/caregiver');
  const g = { ...cg(), moduleAccess: { granted: ['caregiverScheduling'], removed: [] } };
  assert.equal(at.landingFor(g), null);
  assert.deepStrictEqual(ids(g), ['myGfc', 'caregiverScheduling']);
  assert.equal(at.hubTilesFor(g)[0].path, '/caregiver', 'their My GFC is still the caregiver app');
});

test('a granted module brings two-step sign-in, even for a caregiver', () => {
  const req = ['admin', 'user', 'caseManager'];
  assert.equal(mfa.mfaRequiredFor(cg(), req), false);
  assert.equal(mfa.mfaRequiredFor({ ...cg(), moduleAccess: { granted: ['payroll'] } }, req), true);
});

test('User Management follows the module: a grant manages caregiver accounts only, a removal manages none', () => {
  const r = { ...rn(), moduleAccess: { granted: ['users'], removed: [] } };
  assert.equal(at.canManageAccountType(r, 'caregiver'), true);
  assert.equal(at.canManageAccountType(r, 'rn'), false, 'never staff');
  assert.equal(at.canManageAccountType(rn(), 'caregiver'), false, 'no grant, no account management');
  assert.equal(at.canManageAccountType({ ...coord(), moduleAccess: { granted: [], removed: ['users'] } }, 'caregiver'), false, 'a removal takes it away');
  assert.equal(at.checkUserWrite(r, { existing: { id: 'x', ...at.fieldsFor('caregiver') }, body: { name: 'A' } }).ok, true);
  assert.equal(at.checkUserWrite(rn(), { existing: { id: 'x', ...at.fieldsFor('caregiver') }, body: { name: 'A' } }).ok, false);
  const c = { ...coord(), moduleAccess: { granted: [], removed: ['users'] } };
  assert.equal(at.checkUserWrite(c, { existing: { id: 'x', ...at.fieldsFor('caregiver') }, body: { name: 'A' } }).ok, false);
  // Nobody but the Super Admin writes the grid through the user form either.
  const v = at.checkUserWrite(coord(), { existing: { id: 'x', ...at.fieldsFor('caregiver') }, body: { name: 'A', moduleAccess: { granted: ['payroll'] } } });
  assert.ok(!v.ok || !('moduleAccess' in v.body), 'moduleAccess is an access field');
});

test('the grid routes are the Super Admin\'s, and every module gate reads hasModule', () => {
  const server = read('server.js');
  assert.match(server, /app\.get\('\/api\/users\/:userId\/modules', authenticateToken, requireAdmin,/);
  assert.match(server, /app\.put\('\/api\/users\/:userId\/modules', authenticateToken, requireAdmin,/);
  assert.match(server, /moduleAccess: accountTypes\.moduleAccessOf\(freshUser\)/, 'req.user carries the grants, read fresh');
  assert.match(server, /const canManageEnrollment = [^;]*accountTypes\.hasModule\(u, 'clients'\)/);
  assert.match(server, /if \(accountTypes\.hasModule\(req\.user, 'ime'\)\) return next\(\);/);
  assert.match(server, /req\.user\.role !== config\.ROLES\.ADMIN && !accountTypes\.hasModule\(req\.user, 'users'\)/);
  assert.match(read('routes/scheduling.js'), /const isScheduleManager = \(u\) => !!u && \(u\.role === ROLES\.ADMIN \|\| accountTypes\.hasModule\(u, 'caregiverScheduling'\)\);/);
  assert.match(read('routes/onboarding.js'), /const isOffice = \(u\) => !!u && \(u\.role === 'admin' \|\| accountTypes\.hasModule\(u, 'onboarding'\)\);/);
  const cgSrc = read('routes/caregiver.js');
  assert.match(cgSrc, /const isCaregiverOffice = \(u\) => accountTypes\.hasModule\(u, 'caregiverManagement'\);/);
  assert.match(cgSrc, /router\.get\('\/api\/caregiver\/incidents', authenticateToken, requireIncidentReader,/);
  assert.match(cgSrc, /router\.post\('\/api\/caregiver\/incidents\/:id\/close', authenticateToken, requireIncidentOffice,/);
  // The page reads the server's answer, never its own rule.
  const hub = read('public/admin-hub.html');
  assert.match(hub, /fetch\(`\/api\/users\/\$\{encodeURIComponent\(userId\)\}\/modules`/);
  assert.ok(!/GRANTABLE|moduleDefault/.test(hub), 'the page restates no module rule');
});

test('a payroll preparer sees no Super Admin button on the page', () => {
  const page = read('public/payroll.html');
  assert.match(page, /SUPER = d\.superAdmin !== false;/);
  assert.match(page, /\{SUPER \? <button className="btn gold"[\s\S]{0,1400}?Approve Payroll<\/button>/);
  assert.match(page, /SUPER && <button className="underline" onClick=\{\(\) => reveal\('routing'\)\}>show<\/button>/);
  assert.match(page, /\{SUPER && <GustoImport/);
  assert.match(read('routes/payroll.js'), /superAdmin: !!req\.user && req\.user\.role === 'admin',/);
});

// Owner report, 2026-11-13: "employees click the pay setup and don't get
// anything". The form drew below the whole checklist, off-screen, so Start
// looked dead. It opens under the item clicked now, and scrolls into view.
test('Pay Setup opens each form under the item clicked, in view', () => {
  const src = read('public/my-pay.js');
  const list = src.indexOf('{p.checklist.map((c, i) => (');
  const card = src.indexOf('{open === c.key && (');
  const listEnd = src.indexOf('))}', card);
  assert.ok(list > 0 && card > list && listEnd > card, 'the form renders inside the checklist, beside its item');
  assert.ok(!/\n      \{open && \(\n        <div className="mg-card"/.test(src), 'not after the whole list');
  assert.match(src, /openRef\.current\.scrollIntoView\(/, 'and it is brought into view');
});
