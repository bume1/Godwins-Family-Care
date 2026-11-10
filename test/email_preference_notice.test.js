'use strict';

// When someone unsubscribes, the Super Admins are told (owner, 2026-11-10).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const N = require('../emailPreferenceNotice');

const OWNER = { id: 'a1', role: 'admin', name: 'Bianca', email: 'owner@gfc.test' };
const ADMIN2 = { id: 'a2', role: 'admin', name: 'Second Admin', email: 'a2@gfc.test' };
const OLD_ADMIN = { id: 'a3', role: 'admin', name: 'Gone', email: 'a3@gfc.test', accountStatus: 'inactive' };
const RN = { id: 'r1', role: 'user', name: 'Rae Nurse', email: 'rae@gfc.test' };
const CLIENT = { id: 'p1', role: 'client', name: 'Pat Client', email: 'pat@gfc.test' };
const USERS = [OWNER, ADMIN2, OLD_ADMIN, RN, CLIENT];
const AT = '2026-11-10T20:30:00.000Z';

test('an unsubscribe tells every active Super Admin who and when', () => {
  const out = N.noticesFor({ person: RN, unsubscribed: true, users: USERS, at: AT, ctaUrl: 'https://app/admin' });
  assert.deepStrictEqual(out.map(n => n.userId).sort(), ['a1', 'a2'], 'active admins only');
  for (const n of out) {
    assert.strictEqual(n.type, 'email_preference_changed');
    assert.match(n.data.body, /Rae Nurse \(staff, rae@gfc\.test\) unsubscribed/);
    assert.match(n.data.body, /Nov 10, 2026, 3:30 PM Eastern/, 'the time is Georgia time');
    assert.strictEqual(n.data.ctaUrl, 'https://app/admin');
  }
});

test('a client name never goes in the subject, and the notice is marked PHI', () => {
  const out = N.noticesFor({ person: CLIENT, unsubscribed: true, users: USERS, at: AT });
  for (const n of out) {
    assert.doesNotMatch(n.data.subject, /Pat/);
    assert.strictEqual(n.options.phi, true);
    assert.match(n.data.body, /Pat Client \(client/);
  }
});

test('turning email back on is announced too; an admin is never told about themselves', () => {
  const back = N.noticesFor({ person: RN, unsubscribed: false, users: USERS, at: AT });
  assert.match(back[0].data.subject, /back on/);
  assert.match(back[0].data.body, /turned automated GFC emails back on/);
  const self = N.noticesFor({ person: OWNER, unsubscribed: true, users: USERS, at: AT });
  assert.deepStrictEqual(self.map(n => n.userId), ['a2']);
});

test('the unsubscribe and resubscribe links announce only a real change', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const un = src.slice(src.indexOf("app.get('/api/unsubscribe'"), src.indexOf("app.get('/api/resubscribe'"));
  const re = src.slice(src.indexOf("app.get('/api/resubscribe'"), src.indexOf("// Get pending password reset requests"));
  assert.match(un, /if \(!wasOff\) await announceEmailPreferenceChange\(users\[idx\], true, users\);/);
  assert.match(re, /if \(wasOff\) await announceEmailPreferenceChange\(users\[idx\], false, users\);/);
});
