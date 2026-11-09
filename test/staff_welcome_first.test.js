'use strict';
// The staff welcome packet is the first screen (owner, 2026-11-09): until a
// staff member signs it, signing in opens My GFC → Welcome Packet. Everyone,
// existing staff and the Super Admin included; caregivers keep their own
// packet. It can be skipped with the Portal Hub button.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const accountTypes = require('../accountTypes');
const appLinks = require('../appLinks');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const SERVER = read('server.js');

// Lift the real helper out of server.js and run it against a fake store.
function liftPending(store) {
  const a = SERVER.indexOf('const STAFF_WELCOME_TYPES');
  const b = SERVER.indexOf('const finishLogin = async');
  assert.ok(a > 0 && b > a, 'anchors moved');
  const db = { get: async (k) => store[k] || null };
  // eslint-disable-next-line no-new-func
  return new Function('db', 'accountTypes', SERVER.slice(a, b) + '\nreturn staffWelcomePending;')(db, accountTypes);
}

const NP = { id: 'np', role: 'user', accountType: 'provider', clinicalRole: 'provider', hasClinicalAccess: true };
const ADMIN = { id: 'ad', role: 'admin', accountType: 'admin' };
const LIAISON = { id: 'li', role: 'liaison', accountType: 'liaison' };
const COORD = { id: 'co', role: 'user', accountType: 'coordinator' };
const CG = { id: 'cg', role: 'vendor', accountType: 'caregiver', licenseLevel: 'pca' };
const CLIENT = { id: 'cl', role: 'client', accountType: 'client' };

test('every staff type without a signed packet is pending; caregivers, clients and family never are', async () => {
  const pending = liftPending({});
  for (const u of [NP, ADMIN, LIAISON, COORD]) assert.strictEqual(await pending(u), true, u.accountType);
  for (const u of [CG, CLIENT, null]) assert.strictEqual(await pending(u), false, u ? u.accountType : 'null');
});

test('signed means not pending; a started packet, or someone else\'s signed one, is still pending', async () => {
  assert.strictEqual(await liftPending({ staff_welcome_packets: [{ user_id: 'np', status: 'submitted' }] })(NP), false);
  assert.strictEqual(await liftPending({ staff_welcome_packets: [{ user_id: 'np', status: 'in_progress' }] })(NP), true);
  assert.strictEqual(await liftPending({ staff_welcome_packets: [{ user_id: 'other', status: 'submitted' }] })(NP), true);
});

test('a failed read never redirects anyone', async () => {
  const a = SERVER.indexOf('const STAFF_WELCOME_TYPES');
  const b = SERVER.indexOf('const finishLogin = async');
  const db = { get: async () => { throw new Error('down'); } };
  const pending = new Function('db', 'accountTypes', SERVER.slice(a, b) + '\nreturn staffWelcomePending;')(db, accountTypes);
  assert.strictEqual(await pending(NP), false);
});

test('the unified login sets the landing to the packet, before the session is issued', () => {
  const route = SERVER.slice(SERVER.indexOf("app.post('/api/auth/login'"));
  const set = route.indexOf('if (await staffWelcomePending(user)) userResponse.landing = appLinks.PATHS.STAFF_WELCOME;');
  const fin = route.indexOf('finishLogin({ user, req, surface: \'unified\', userResponse })');
  assert.ok(set > 0 && fin > set, 'landing is set on the response finishLogin carries (and the MFA challenge stores)');
  assert.strictEqual(appLinks.PATHS.STAFF_WELCOME, '/my#welcome');
});

test('the login page honours it for the Super Admin too, and the Portal Hub button still skips it', () => {
  const html = read('public/login.html');
  const fn = html.slice(html.indexOf('const directDestination = (u) => {'));
  const hub = fn.indexOf("get('hub') === '1') return null");
  const welcome = fn.indexOf("if (u.landing === '/my#welcome') return u.landing;");
  const admin = fn.indexOf("if (u.role === 'admin') return null;");
  assert.ok(hub > 0 && welcome > hub, 'the hub button skips the packet');
  assert.ok(admin > welcome, 'the packet comes before the Super Admin\'s hub');
});

test('My GFC opens the packet from the #welcome fragment', () => {
  assert.ok(/id: 'welcome'/.test(read('public/my-gfc.js')));
});
