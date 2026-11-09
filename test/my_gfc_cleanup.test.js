'use strict';
// Owner, 2026-11-09: My GFC clean-up — staff-only banners gone, Team Bios
// moved to User Management, the blank button fixed, one account area, and a
// Portal Hub button on every staff sidebar.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const at = require('../accountTypes');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const my = read('public/my-gfc.js');

test('the policies banner shows to the admin team only; the folders banner sits inside the admin-only manager', () => {
  assert.match(my, /\{isAdmin && <p className="mg-note"[^>]*>These always open the current version/);
  assert.match(my, /<Policies policies=\{policies\} isAdmin=\{!!profile\.isAdmin\} \/>/);
  const manage = my.slice(my.indexOf('function ManageFolders'));
  assert.ok(manage.indexOf('The folder has to be shared with the GFC admin') > 0);
  assert.match(my, /\{profile\.isAdmin && <Section title="Manage Shared Folders"/);
});

test('Team Bios is gone from My GFC; each bio shows on the person\'s User Management form', () => {
  assert.doesNotMatch(my, /Team Bios|function TeamBios|view === 'team'/);
  const hub = read('public/admin-hub.html');
  assert.match(hub, /const StaffBioSection = \(\{ token, userId, userName \}\) =>/);
  assert.match(hub, /<StaffBioSection token=\{token\} userId=\{editingUser\.id\} userName=\{editingUser\.name\} \/>/);
  assert.match(read('routes/staffPortal.js'), /router\.get\('\/api\/my\/admin\/bios\/:userId', authenticateToken, requireAdmin,/);
});

test('a link styled as a button keeps its text colour on every host page', () => {
  assert.match(my, /a\.mg-btn,a\.mg-btn:link,a\.mg-btn:visited,a\.mg-btn:hover\{color:#fff/);
  assert.match(my, /a\.mg-btn\.mg-ghost,[^{]*\{color:var\(--navy\)\}/);
});

test('one account area: My Profile renders the shared account cards; the admin hub and clinical links go there', () => {
  assert.match(my, /<window\.GFCAccount\.AccountCards \/>/);
  assert.match(my, /label: 'My Profile'/);
  assert.match(read('public/admin-hub.html'), /<a href="\/my#account"/);
  assert.doesNotMatch(read('public/admin-hub.html'), /<a href="\/account"/);
  assert.match(read('public/clinical.html'), /href="\/my#account"/);
});

test('every staff sidebar has a Portal Hub button, and the hub stays put when asked for on purpose', () => {
  assert.match(my, /const PORTAL_HUB = '\/login\?hub=1';/);
  assert.match(my, /onClick=\{\(\) => \{ window\.location\.href = PORTAL_HUB; \}\}><i className="ti ti-layout-grid" \/>Portal Hub/);
  assert.match(read('public/clinical.html'), /\{ key: 'hub', tab: 'Portal Hub', icon: 'ti-layout-grid', group: 'foot', href: '\/login\?hub=1' \}/);
  assert.match(read('public/onboarding.html'), /window\.location\.href = '\/login\?hub=1'; \}\}><i className="ti ti-layout-grid" \/>Portal Hub/);
  assert.match(read('public/login.html'), /new URLSearchParams\(window\.location\.search\)\.get\('hub'\) === '1'\) return null;/);
});

test('the hub lists what each staff member can open; clients and family get nothing', () => {
  const ids = (t, extra) => at.hubTilesFor(Object.assign(at.fieldsFor(t), extra || {})).map(x => x.id);
  for (const t of ['provider', 'rn', 'lcsw', 'lmsw']) assert.deepStrictEqual(ids(t), ['myGfc', 'clinical'], t);
  const cg = at.hubTilesFor(Object.assign(at.fieldsFor('caregiver'), { licenseLevel: 'pca' }));
  assert.deepStrictEqual(cg.map(x => [x.id, x.path]), [['myGfc', '/caregiver']]);
  assert.deepStrictEqual(ids('liaison'), ['myGfc']);
  assert.deepStrictEqual(ids('client'), []);
  assert.deepStrictEqual(ids('family'), []);
});
