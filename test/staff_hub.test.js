'use strict';
// The Portal Hub as the staff front door (owner, 2026-11-09): areas declared
// once in accountTypes.js, read by the hub and by the shared staff bar, every
// staff page carrying the bar, and the Admin Hub wearing the My GFC frame.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const at = require('../accountTypes');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1').replace(/<!--[\s\S]*?-->/g, '');

const STAFF_PAGES = ['admin-hub', 'admin-enrollment', 'scheduling', 'caregivers', 'clinical', 'billing',
  'messages', 'onboarding', 'audit', 'my'];

test('every staff page carries the shared staff bar exactly once', () => {
  for (const p of STAFF_PAGES) {
    const src = stripComments(read(`public/${p}.html`));
    const n = (src.match(/<script src="\/staff-nav\.js"><\/script>/g) || []).length;
    assert.equal(n, 1, `${p}.html`);
  }
  for (const p of ['portal', 'caregiver', 'signup', 'login']) {
    assert.ok(!read(`public/${p}.html`).includes('staff-nav.js'), `${p}.html is not a staff page`);
  }
});

test('the bar decides nothing about access: it draws the server\'s areas, and only for accounts that land on the hub', () => {
  const src = stripComments(read('public/staff-nav.js'));
  assert.match(src, /fetch\('\/api\/staff\/hub'/);
  assert.match(src, /d\.landing === null && Array\.isArray\(d\.areas\)\) render\(d\.areas\)/);
  assert.ok(!/role\s*===|isManager|clinicalRole|accountType/.test(src), 'no role rule of its own');
});

test('every link the hub offers resolves to a page this app serves', () => {
  const sources = [read('server.js')].concat(fs.readdirSync(path.join(__dirname, '..', 'routes'))
    .filter(f => f.endsWith('.js')).map(f => read(`routes/${f}`))).join('\n');
  const served = (p) => new RegExp(`\\.get\\(\\s*\\[?\\s*'${p.replace(/[/.]/g, '\\$&')}'`).test(sources);
  const types = ['admin', 'manager', 'coordinator', 'provider', 'rn', 'lcsw', 'lmsw', 'liaison'];
  const all = new Set();
  for (const t of types) for (const l of at.hubTilesFor(at.fieldsFor(t))) all.add(new URL(l.path, 'http://x').pathname);
  all.add('/caregiver');
  for (const p of all) assert.ok(served(p), `${p} is not served`);
  // The control: a path nobody serves must fail this check, or it proves nothing.
  assert.ok(!served('/admin-hub'), 'the check cannot tell a real route from a dead one');
});

test('the area list is not PHI and is not audited as PHI', () => {
  const { isPhiPath, NON_PHI_PREFIXES } = require('../auditLog');
  assert.ok(NON_PHI_PREFIXES.includes('/api/staff'));
  assert.ok(!isPhiPath('/api/staff/hub'));
});

// Load the bar in a stub browser to run its own area matcher.
function loadBar() {
  const window = { location: { pathname: '/', search: '', origin: 'http://x' } };
  const ctx = { window, document: { readyState: 'complete', querySelector: () => null }, localStorage: { getItem: () => null },
    URL, console, fetch: () => Promise.reject(new Error('no network')) };
  vm.runInNewContext(read('public/staff-nav.js'), ctx);
  return window.GFC_STAFF_NAV;
}

test('the bar names the area you are in, query string included', () => {
  const { currentArea } = loadBar();
  const areas = at.hubAreasFor(at.fieldsFor('admin'));
  const where = (pathname, search = '') => (currentArea(areas, { pathname, search, origin: 'http://x' }) || {}).id || null;
  assert.equal(where('/caregivers'), 'people');
  assert.equal(where('/scheduling'), 'people');
  assert.equal(where('/admin/enrollment'), 'clients');
  assert.equal(where('/admin', '?view=users&group=clients'), 'clients');
  assert.equal(where('/admin', '?view=users&group=staff'), 'people');
  assert.equal(where('/admin'), 'adminCompliance');
  assert.equal(where('/clinical'), 'clinical');
  assert.equal(where('/billing'), 'billing');
  assert.equal(where('/somewhere-else'), null);
});

test('the Admin Hub wears the My GFC frame, banner and all', () => {
  const hub = read('public/admin-hub.html');
  assert.match(hub, /<script type="text\/babel" src="\/my-gfc\.js"><\/script>/);
  assert.ok(hub.indexOf('src="/my-gfc.js"') < hub.indexOf("const { useState, useEffect, useRef } = React;"), 'the frame loads before the page');
  assert.match(hub, /<MG\.Shell sections=\{sections\}[^>]*tag="Admin Hub"/);
  assert.match(hub, /const view = activePage === 'dashboard' \? 'home' : activePage;/, 'the dashboard is the frame\'s home, which draws the banner');
  const shell = read('public/my-gfc.js');
  assert.match(shell, /tag = 'My GFC' \}\) \{/);
  assert.match(shell, /<div className="mg-tag">\{tag\}<\/div>/);
  assert.ok(!/banner-admin\.webp/.test(stripComments(hub.slice(hub.indexOf('const DashboardPage')))), 'the old dashboard banner is gone');
});

test('User Management opens on either side of the People / Clients split', () => {
  const hub = read('public/admin-hub.html');
  assert.match(hub, /return g === 'staff' \|\| g === 'clients' \? g : 'all';/);
  assert.match(hub, /roleFilter === 'staff' \? !isClientSide : roleFilter === 'clients' \? isClientSide/);
});
