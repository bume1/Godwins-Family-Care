'use strict';
// Password reset and change notices (owner, 2026-10-28).
//  - A placeholder login (nobody signs in with it) cannot be reset: the reset
//    would email a link nowhere, and giving the patient's password to the POA
//    would put the POA back to signing in AS the patient. The refusal names
//    the POA's own account instead.
//  - Changing your own password sends a "your password was changed" notice.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const familyLinks = require('../familyLinks');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function lift(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} must exist in server.js`);
  const isAsync = SRC.slice(start - 6, start) === 'async ';
  let i = SRC.indexOf('{', SRC.indexOf(')', start)), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) break;
  }
  return (isAsync ? 'async ' : '') + SRC.slice(start, i + 1);
}

const config = { ROLES: { CLIENT: 'client' }, BRAND: { COMPANY_NAME: 'Godwins Family Care' } };
const refusalOf = new Function('familyLinks', 'config', `${lift('placeholderResetRefusal')}; return placeholderResetRefusal;`)(familyLinks, config);

const patient = { id: 'c1', role: 'client', name: 'Juanita Guess', email: familyLinks.placeholderEmailFor('client', 'c1') };
const poa = { id: 'f1', role: 'family', name: 'Dana Guess', email: 'dana@example.com', familyLinks: [{ clientId: 'c1', isPoa: true }] };
const cousin = { id: 'f2', role: 'family', name: 'Cousin', email: 'cousin@example.com', familyLinks: [{ clientId: 'c1', isPoa: false }] };

test('a placeholder patient login is refused and names the POA account to reset', () => {
  const r = refusalOf([patient, poa, cousin], patient);
  assert.ok(r, 'must refuse');
  assert.strictEqual(r.code, 'RESET_PLACEHOLDER_LOGIN');
  assert.deepStrictEqual(r.poas, ['Dana Guess'], 'only the POA, never other family');
  assert.match(r.error, /Dana Guess signs in with their own account/);
});

test('a placeholder login with no POA on file says to add a real email', () => {
  const r = refusalOf([patient], patient);
  assert.ok(r);
  assert.match(r.error, /Add a real email address/);
});

test('a real email address is never refused', () => {
  assert.strictEqual(refusalOf([poa], poa), null);
  assert.strictEqual(refusalOf([], { id: 'c2', role: 'client', email: 'pat@example.com' }), null);
});

function routeBody(marker) {
  const start = SRC.indexOf(marker);
  assert.ok(start !== -1, `route ${marker} must exist`);
  return SRC.slice(start, SRC.indexOf('\napp.', start + 10));
}

test('every reset path checks for a placeholder BEFORE the password changes', () => {
  const put = SRC.slice(SRC.indexOf("if (password && resetPassword === true) {"));
  assert.ok(put.indexOf('placeholderResetRefusal(') < put.indexOf('bcrypt.hash'), 'user edit PUT');
  const single = routeBody("app.post('/api/admin/reset-user-password/:userId'");
  assert.ok(single.indexOf('placeholderResetRefusal(') !== -1 && single.indexOf('placeholderResetRefusal(') < single.indexOf('bcrypt.hash'), 'single reset');
  const bulk = routeBody("app.post('/api/admin/bulk-password-reset'");
  assert.ok(bulk.indexOf('placeholderResetRefusal(') !== -1 && bulk.indexOf('placeholderResetRefusal(') < bulk.indexOf('bcrypt.hash'), 'bulk reset');
});

test('changing your own password sends the changed notice, after the save', () => {
  const body = routeBody("app.post('/api/auth/change-password'");
  const save = body.indexOf("await db.set('users'");
  const send = body.indexOf('\n    sendPasswordChangedEmail(');
  assert.ok(save !== -1 && send > save, 'notice is sent unconditionally, after the password is saved');
});

test('the changed notice: right recipient, no link, never a placeholder', async () => {
  const sent = [];
  const fn = new Function('familyLinks', 'config', 'consentText', 'emailTemplates', 'sendEmail',
    `${lift('sendPasswordChangedEmail')}; return sendPasswordChangedEmail;`)(
    familyLinks, config, { ORG: { phone: '404-913-6705' } },
    { renderGfcEmail: (o) => ({ html: JSON.stringify(o) }) },
    async (to, subject, text, opts) => { sent.push({ to, subject, text, opts }); });
  await fn({ name: 'Dana Guess', email: 'dana@example.com' });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].to, 'dana@example.com');
  assert.match(sent[0].subject, /password was changed/);
  assert.match(sent[0].text, /404-913-6705/);
  assert.ok(!/https?:\/\//.test(sent[0].text + sent[0].opts.htmlBody), 'carries no link');
  assert.ok(!/ctaUrl/.test(sent[0].opts.htmlBody), 'no button');
  await fn(patient);
  assert.strictEqual(sent.length, 1, 'a placeholder login is never emailed');
});
