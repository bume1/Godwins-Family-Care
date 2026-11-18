// The office reset link goes by text or email, and the office picks when an
// account has both (owner report 2026-11-18: Dorothy signs in by phone and
// has an email on file, and Account Recovery offered only "Email Reset Link").
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const phoneLogin = require('../phoneLogin');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const UI = fs.readFileSync(path.join(ROOT, 'public/client-account-ui.js'), 'utf8');

const both = { id: 'u1', role: 'client', accountStatus: 'active', email: 'poa@example.test', loginPhone: '+17062730040' };
const phoneOnly = { ...both, email: 'client+u1@placeholder.local' };
const emailOnly = { ...both, loginPhone: null };

test('an account with both can be reached either way, and the default stays email', () => {
  assert.strictEqual(phoneLogin.resetChannel(both), 'email');
  assert.strictEqual(phoneLogin.resetChannel(both, both.loginPhone), 'sms');
  assert.strictEqual(phoneLogin.resetChannel(both, both.email), 'email');
});

test('a channel the account cannot take is not available', () => {
  assert.strictEqual(phoneLogin.resetChannel(phoneOnly, phoneOnly.email), null);
  assert.strictEqual(phoneLogin.resetChannel(emailOnly, ''), 'email', 'empty typed falls back');
  assert.notStrictEqual(phoneLogin.resetChannel(emailOnly, emailOnly.loginPhone || ''), 'sms');
});

test('the route refuses a channel it cannot honour, before touching the password', () => {
  const i = SERVER.indexOf("app.post('/api/admin/reset-user-password/:userId'");
  const route = SERVER.slice(i, SERVER.indexOf('\n});', i));
  const refuse = route.indexOf("code: 'RESET_CHANNEL_UNAVAILABLE'");
  const hash = route.indexOf("users[userIndex].password = await bcrypt.hash(require('crypto')");
  assert.ok(refuse > 0, 'refusal missing');
  assert.ok(refuse < hash, 'must refuse before the current password is stopped');
  assert.match(route, /phoneLogin\.resetChannel\(user, typed\) !== wantChannel/);
});

test('Account Recovery shows Text Reset Link whenever the person signs in by phone', () => {
  const block = UI.slice(UI.indexOf('const AccountRecovery'), UI.indexOf('Sign Out Everywhere</button>'));
  assert.match(block, /const canText = !!\(person\.loginPhone && !person\.noLogin\)/);
  assert.match(block, /\{canText && <button[^>]*onClick=\{\(\) => sendLink\('sms'\)\}>Text Reset Link<\/button>\}/);
  assert.match(block, /sendLink\('email'\)\}>Email Reset Link/);
  assert.match(block, /body: \{ channel \}/, 'the choice must reach the server');
  assert.doesNotMatch(block, /emailIsPlaceholder\);\s*\n\s*return/, 'the old phone-AND-no-email gate is gone');
});
