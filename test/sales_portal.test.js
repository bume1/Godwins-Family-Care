// The Sales Portal (owner, 2026-11-23): growth work moved off the public
// website into the app, under the staff login.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const at = require('../accountTypes');
const sp = require('../salesPortal');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('who has the Sales Portal: Super Admin, managers and the Community Care Liaison', () => {
  for (const t of ['admin', 'manager', 'liaison']) assert.ok(at.hasModule(at.fieldsFor(t), 'sales'), t);
  // Nobody else gained it; a coordinator gets it only as a grant.
  for (const t of ['coordinator', 'provider', 'rn', 'lcsw', 'lmsw', 'client', 'family']) assert.ok(!at.hasModule(at.fieldsFor(t), 'sales'), t);
  assert.ok(!at.hasModule({ ...at.fieldsFor('caregiver'), licenseLevel: 'cna' }, 'sales'));
  assert.ok(at.hasModule({ ...at.fieldsFor('coordinator'), moduleAccess: { granted: ['sales'], removed: [] } }, 'sales'));
  assert.ok(!at.hasModule({ ...at.fieldsFor('liaison'), moduleAccess: { granted: [], removed: ['sales'] } }, 'sales'));
  assert.ok(at.GRANTABLE_MODULES.includes('sales'));
});

test('the content route is gated on the Sales module and the page is served', () => {
  const src = read('server.js');
  assert.match(src, /app\.get\('\/api\/sales\/portal', authenticateToken, requireSalesPortal,/);
  assert.match(src, /accountTypes\.hasModule\(req\.user, 'sales'\)/);
  assert.match(src, /app\.get\('\/sales', \(req, res\) => \{\s*res\.sendFile\(__dirname \+ '\/public\/sales\.html'\);/);
  assert.ok(require('../auditLog').NON_PHI_PREFIXES.includes('/api/sales'));
});

test('no script or link points at the old website', () => {
  const walk = (v) => typeof v === 'string' ? [v] : (v && typeof v === 'object') ? Object.values(v).flatMap(walk) : [];
  for (const s of walk(sp.portal().sections)) {
    for (const url of s.match(/https?:\/\/[^\s)"']+/g) || []) assert.ok(!sp.OLD_SITE.test(url), url);
  }
  assert.ok(sp.OLD_SITE.test('https://godwinsfamilycarellc.com/sales'));
  assert.ok(!sp.OLD_SITE.test('https://app.godwinsfamilycarellc.com/sales'));
});

test('the page draws only what the server sends', () => {
  const page = read('public/sales.html');
  assert.match(page, /fetch\('\/api\/sales\/portal'/);
  assert.match(page, /<script src="\/staff-nav\.js"><\/script>/);
});
