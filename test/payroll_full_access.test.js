'use strict';
// "Run payroll in full" (owner, 2026-11-27): the Super Admin can turn on, per
// person, the same payroll powers the Super Admin holds, for a future
// financial manager. Off, a Payroll grant stays prepare only.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const at = require('../accountTypes');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const coord = (ma) => ({ id: 'c1', ...at.fieldsFor('coordinator'), ...(ma ? { moduleAccess: ma } : {}) });
const admin = () => ({ id: 'a1', ...at.fieldsFor('admin') });

test('hasFullPayroll: the Super Admin, or a Payroll grant with the switch on, and nobody else', () => {
  assert.equal(at.hasFullPayroll(admin()), true);
  assert.equal(at.hasFullPayroll(coord()), false, 'no grant');
  assert.equal(at.hasFullPayroll(coord({ granted: ['payroll'], removed: [] })), false, 'a grant alone is prepare only');
  assert.equal(at.hasFullPayroll(coord({ granted: ['payroll'], removed: [], payrollFull: true })), true);
  assert.equal(at.hasFullPayroll(coord({ granted: [], removed: [], payrollFull: true })), false, 'the switch never stands without Payroll');
  assert.equal(at.hasFullPayroll(coord({ granted: ['payroll'], payrollFull: 'yes' })), false, 'only a literal true counts');
  assert.equal(at.hasFullPayroll({ ...coord({ granted: ['payroll'], payrollFull: true }), accountStatus: 'inactive' }), false);
  assert.equal(at.hasFullPayroll({ ...at.fieldsFor('client'), moduleAccess: { granted: ['payroll'], payrollFull: true } }), false, 'never a client');
});

test('the grid save keeps the switch only with Payroll ticked, and the stored shape is unchanged when off', () => {
  const c = coord();
  const on = at.moduleAccessFromChecks(c, [...at.modulesFor(c), 'payroll'], { payrollFull: true });
  assert.deepStrictEqual(on, { granted: ['payroll'], removed: [], payrollFull: true });
  assert.deepStrictEqual(at.moduleAccessFromChecks(c, at.modulesFor(c), { payrollFull: true }), { granted: [], removed: [] }, 'unticking Payroll turns it off');
  assert.deepStrictEqual(at.moduleAccessFromChecks(c, [...at.modulesFor(c), 'payroll']), { granted: ['payroll'], removed: [] });
  assert.deepStrictEqual(at.moduleAccessOf({ moduleAccess: { granted: [], removed: [], payrollFull: true } }), { granted: [], removed: [] });
});

test('the grid shows the switch on the Payroll row, and its note follows it', () => {
  const row = (u) => at.moduleGridFor(u).find(r => r.id === 'payroll');
  assert.equal(row(coord()).fullRun.on, false);
  assert.match(row(coord({ granted: ['payroll'] })).note, /Prepare only/);
  const full = row(coord({ granted: ['payroll'], payrollFull: true }));
  assert.equal(full.fullRun.on, true);
  assert.match(full.note, /same as a Super Admin/);
  assert.equal(row(admin()).fullRun, undefined, 'a Super Admin has no switch to turn');
});

test('nobody but the Super Admin sets it: it lives in moduleAccess, an access field, behind the admin-only grid route', () => {
  const v = at.checkUserWrite(coord(), { existing: { id: 'x', ...at.fieldsFor('caregiver') }, body: { name: 'A', moduleAccess: { granted: ['payroll'], payrollFull: true } } });
  assert.ok(!v.ok || !('moduleAccess' in v.body));
  const server = read('server.js');
  assert.match(server, /app\.put\('\/api\/users\/:userId\/modules', authenticateToken, requireAdmin,/);
  assert.match(server, /const requirePayrollRunner = \(req, res, next\) => \{\s*if \(req\.user && accountTypes\.hasFullPayroll\(req\.user\)\) return next\(\);/);
  assert.match(server, /requirePayrollRunner: \(req, res, next\) => requirePayrollRunner\(req, res, next\)/);
  const routes = read('routes/payroll.js');
  assert.doesNotMatch(routes, /router\.(get|post|put|delete)\([^\n]*authenticateToken, requireAdmin\b/, 'no payroll route is left on the bare Super Admin gate');
});

// Through the real payroll router: the settings write is a Super-Admin-only
// step. A preparer is refused; the same person with the switch on is not;
// switching it off refuses them again on the next request.
function harness(users, who) {
  const store = new Map();
  const db = { get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
  const requireAdmin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'no' }));
  const routes = require('../routes/payroll')({
    db, env: { PAYROLL_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64') }, payrollKey: 'k'.repeat(40),
    logActivity: async () => {}, getUsers: async () => users,
    authenticateToken: (req, res, next) => { req.user = users.find(u => u.id === who()); next(); },
    requireAdmin,
    requirePayrollPreparer: (req, res, next) => (req.user.role === 'admin' || at.hasModule(req.user, 'payroll') ? next() : res.status(403).json({ error: 'no' })),
    requirePayrollRunner: (req, res, next) => (at.hasFullPayroll(req.user) ? next() : res.status(403).json({ error: 'no', code: 'PAYROLL_RUNNER_ONLY' })),
    uuidv4: (() => { let n = 0; return () => `id${++n}`; })(), accountTypeOf: (u) => at.accountTypeOf(u), localDate: (v) => String(v).slice(0, 10),
    resolvePayRate: () => ({ rate: null }), queueNotification: async () => {}, hashIp: () => 'h',
    pdf: require('../pdf-generator'), drive: {}, roleFolderFor: () => 'F', personFolderName: (n) => n, getAppBaseUrl: async () => 'https://app'
  });
  const app = express(); app.use(express.json()); app.use(routes);
  return app;
}
const call = async (app, method, url, body) => {
  const srv = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  } finally { srv.close(); }
};

test('the payroll routes: a preparer is refused a Super Admin step, the switch admits them, and turning it off refuses them again', async () => {
  const fm = { id: 'fm', name: 'Fin Manager', email: 'f@x', ...at.fieldsFor('coordinator'), moduleAccess: { granted: ['payroll'], removed: [] } };
  const users = [{ id: 'own', name: 'Owner', email: 'o@x', ...at.fieldsFor('admin') }, fm];
  let who = 'fm';
  const app = harness(users, () => who);

  let r = await call(app, 'PUT', '/api/payroll/admin/settings', { frequency: 'biweekly' });
  assert.equal(r.status, 403, 'prepare only');
  r = await call(app, 'GET', '/api/payroll/admin/overview');
  assert.equal(r.status, 200); assert.equal(r.body.superAdmin, false);

  fm.moduleAccess.payrollFull = true;
  r = await call(app, 'PUT', '/api/payroll/admin/settings', { frequency: 'biweekly' });
  assert.notEqual(r.status, 403, 'full payroll admits them');
  r = await call(app, 'GET', '/api/payroll/admin/overview');
  assert.equal(r.body.superAdmin, true, 'the page shows them the Super Admin\'s buttons');
  r = await call(app, 'POST', '/api/payroll/admin/runs/none/approve', {});
  assert.notEqual(r.status, 403, 'approving a run');

  delete fm.moduleAccess.payrollFull;
  r = await call(app, 'POST', '/api/payroll/admin/runs/none/approve', {});
  assert.equal(r.status, 403, 'revoked on the next request');
  who = 'own';
  r = await call(app, 'PUT', '/api/payroll/admin/settings', { frequency: 'biweekly' });
  assert.notEqual(r.status, 403, 'the Super Admin is unchanged');
});
