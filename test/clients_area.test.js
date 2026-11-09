'use strict';
// ONE STANDALONE CLIENTS AREA (owner, 2026-11-09). The enrollment view became
// the Clients page, and everything User Management did for a client or family
// account moved onto it. User Management is our team only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const at = require('../accountTypes');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const UI = read('public/client-account-ui.js');
const PAGE = read('public/admin-enrollment.html');
const HUB = read('public/admin-hub.html');

test('the Portal Hub has one Clients tile, to /clients', () => {
  for (const t of ['admin', 'manager', 'coordinator']) {
    const clients = at.hubAreasFor(at.fieldsFor(t)).find(a => a.id === 'clients');
    assert.deepStrictEqual(clients.links.map(l => l.path), ['/clients'], t);
  }
});

test('/clients serves the page and the old address redirects with its deep link', () => {
  const server = read('server.js');
  assert.match(server, /app\.get\('\/clients', \(req, res\) => \{\s*res\.sendFile\(__dirname \+ '\/public\/admin-enrollment\.html'\);/);
  assert.match(server, /app\.get\('\/admin\/enrollment', \(req, res\) => \{[\s\S]{0,200}res\.redirect\(302, '\/clients' \+ \(q === -1 \? '' : req\.originalUrl\.slice\(q\)\)\);/);
});

test('every client detail and action User Management had is on the Clients page', () => {
  const carried = [
    // Account
    'Name and Contact', 'No login (placeholder)', 'Deactivate', 'Unsubscribe', 'Client Portal URL', 'Earlier addresses still work',
    'Client Photo', 'Enrollment Status', 'This login is used by the patient\'s POA', 'Move This Login to the POA', 'moved to their POA on',
    'Project Access', 'View As', 'Reset Authenticator', 'Email Reset Link', 'Sign Out Everywhere', 'Set a New Password', 'Delete Client',
    'A patient\'s account type can\'t be changed',
    // Care team
    'Primary Caregiver', 'Backup Caregiver', 'Assigned Case Manager', 'Assigned FNPs', 'Care Coordinators',
    // Family
    'Designated Power of Attorney', 'Remove Link', 'Link an existing family account', 'Add a New Family Contact', 'Patients They Can See',
    // Adding
    'No email for this patient', 'Agreed rate (private home care)', 'Add to an existing portal', 'Send welcome email',
    'already has a family login with this email', 'Move the Login to', 'already a staff login',
    // Page level
    'pay or rate change', 'may be used by a POA', 'Password reset requests', 'gfc-clients-'
  ];
  for (const s of carried) assert.ok(UI.includes(s) || PAGE.includes(s), `missing on the Clients page: ${s}`);
  for (const s of ['<CA.ClientAccountSection', '<CA.CareTeamSection', '<CA.FamilySection', '<CA.FamilyList', '<CA.AddClientForm',
    '<CA.AddFamilyForm', '<CA.FamilyEditor', '<CA.ResetRequests', '<CA.FinancialChangeQueue', '<CA.PossiblePoaLogins', 'CA.exportClients(users)', 'CA.bulkResetClients(']) {
    assert.ok(PAGE.includes(s), `the page does not use ${s}`);
  }
  assert.match(PAGE, /<script type="text\/babel" src="\/client-account-ui\.js"><\/script>/);
});

test('each save sends only the keys it changes', () => {
  assert.match(UI, /save\(\{ accountStatus: active \? 'inactive' : 'active' \}/);
  assert.match(UI, /save\(\{ practiceName: portalName \}/);
  assert.match(UI, /save\(\{ enrollmentStatus: status \}/);
  assert.match(UI, /updateUser\(client\.id, \{ careTeam: team \}\)/);
  assert.match(UI, /updateUser\(family\.id, \{ familyLinks: links \}\)/);
  assert.ok(!/updateUser\([^)]*\.\.\.client/.test(UI), 'never round-trips the whole user');
});

test('the account sections are the office\'s; recovery and delete are the Super Admin\'s', () => {
  assert.match(UI, /const isOffice = \(me\) => !!me && \(me\.role === 'admin' \|\| me\.isManager === true\);/);
  assert.match(PAGE, /const office = !!\(CA && CA\.isOffice\(user\) && people && people\.users\);/);
  // The record draws each account section whenever the account is there.
  for (const id of ['cl-account', 'cl-careteam']) assert.match(PAGE, new RegExp(`\\{acct && \\(\\s*<Section id="${id}"`), id);
  assert.match(UI, /if \(!isSuperAdmin\(me\)\) return null;/);
  assert.match(UI, /\{isSuperAdmin\(me\) && \(\s*<Block title="Delete Client">/);
});

test('User Management is our team: client and family rows open the Clients page, and it adds neither', () => {
  assert.match(HUB, /if \(user && user\.role === 'client'\) \{ window\.location\.href = `\/clients\?client=\$\{encodeURIComponent\(user\.id\)\}`; return; \}/);
  assert.match(HUB, /if \(user && user\.role === 'family'\) \{ window\.location\.href = `\/clients\?family=\$\{encodeURIComponent\(user\.id\)\}`; return; \}/);
  assert.ok(!/<option value="clients">/.test(HUB.slice(HUB.indexOf('placeholder="Search users..."'), HUB.indexOf('placeholder="Search users..."') + 1500)));
  assert.ok(!HUB.includes('Client Settings</h3>'), 'the old client form is gone, so there are never two editors');
  assert.ok(!/const PoaCutoverDialog = \(/.test(HUB), 'one copy of the POA dialog');
});

test('the address carries where you are, so back lands there', () => {
  assert.match(PAGE, /if \(p\.get\('client'\)\) return \{ page: 'detail', id: p\.get\('client'\) \};/);
  assert.match(PAGE, /window\.history\.pushState\(null, '', urlFor\(v, nextTab\)\)/);
  assert.match(PAGE, /window\.addEventListener\('popstate', onPop\)/);
  assert.match(PAGE, /<nav aria-label="Sections of this record"/);
});

test('User Management shows internal staff only: no client or family account anywhere on it', () => {
  assert.match(HUB, /const isStaffAccount = \(u\) => !!u && !\['client', 'family'\]\.includes\(u\.role\);/);
  assert.match(HUB, /const filteredUsers = users\.filter\(isStaffAccount\)/, 'the list');
  assert.match(HUB, /Users \(\{users\.filter\(isStaffAccount\)/, 'the count');
  assert.match(HUB, /const exportData = users\.filter\(isStaffAccount\)/, 'the export');
  assert.match(HUB, /const staffResets = passwordResets\.filter\(r => isStaffAccount\(users\.find\(u => u\.id === r\.userId\)\)\);/, 'the reset requests');
  assert.match(HUB, /\{staffResets\.map\(req =>/);
  assert.ok(!/<option value="clients">Clients Only<\/option>/.test(HUB), 'bulk reset has no clients option here');
  assert.match(HUB, /useState\('users'\);/);
  assert.match(read('server.js'), /if \(userType === 'users' && \(user\.role === config\.ROLES\.CLIENT \|\| user\.role === 'family'\)\) \{/);
});
