// ============================================================
// Account recovery gains its last two buttons (owner: "Fix all", 2026-11-06)
//
// `POST /api/admin/reset-user-password/:userId` and
// `POST /api/users/:userId/sessions/revoke` have both shipped since Session 5
// with no control anywhere. Same class as the MFA reset and the EMR disconnect
// that got their first UI on 2026-09-27 — on this very card.
//
// The distinction that matters, and the reason BOTH exist: the password field
// already on the form SETS a password an admin then has to convey out of band,
// and revokes sessions. The reset route GENERATES one, emails a secure link,
// never returns the password, and revokes nothing. They are different actions
// for different situations and the copy has to say which is which.
// Run: npm test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-hub.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

// Each handler bounded at the NEXT declaration. A fixed character window
// reached into the neighbouring handler and matched its error handling, so two
// mutations survived — the bounded-scan trap this repo keeps paying for, here
// in a test of mine. Both ends are anchored and it throws if either moves.
const HANDLER_AFTER = {
  emailResetLink: 'const revokeUserSessions = async',
  revokeUserSessions: 'const handleDelete'
};
const handlerBody = (code, name) => {
  const a = code.indexOf(`const ${name} = async`);
  assert.ok(a > 0, `${name} not found`);
  const b = code.indexOf(HANDLER_AFTER[name], a + 1);
  assert.ok(b > a, `the anchor after ${name} moved: ${HANDLER_AFTER[name]}`);
  const body = code.slice(a, b);
  assert.ok(body.length > 200 && body.length < 2500, `${name} slice looks wrong (${body.length} chars)`);
  // The slice must not have swallowed the next handler.
  for (const other of Object.keys(HANDLER_AFTER)) {
    if (other !== name) assert.ok(!body.includes(`const ${other} = async`), `${name} slice swallowed ${other}`);
  }
  return body;
};

test('both routes are reachable from the Account recovery card', () => {
  const code = strip(PAGE);
  assert.match(code, /\/api\/admin\/reset-user-password\//, 'nothing calls the reset-link route');
  assert.match(code, /\/api\/users\/\$\{encodeURIComponent\(userId\)\}\/sessions\/revoke/, 'nothing calls the revoke route');
  // Buttons, with labels: an unlabelled control is an invisible one.
  assert.match(code, />\s*Email Reset Link\s*</);
  assert.match(code, />\s*Sign Out Everywhere\s*</);
  // Wired to the handlers, not just present.
  assert.match(code, /onClick=\{\(\) => emailResetLink\(editingUser\)\}/);
  assert.match(code, /onClick=\{\(\) => revokeUserSessions\(editingUser\)\}/);
});

test('the reset-link copy never implies the admin learns the password', () => {
  const code = strip(PAGE);
  const i = code.indexOf('Password reset link');
  assert.ok(i > 0, 'the card is missing');
  const card = code.slice(i, i + 900);
  // The route returns no password — only a message. Saying otherwise would
  // have an admin waiting for something that never arrives.
  assert.match(card, /not shown the new password|not be shown the new password/i);
  assert.match(card, /they choose their own|they set their own/i);
  // And it must say what it does to the CURRENT password, or an admin will not
  // know the person is locked out until they ring.
  assert.match(card, /stops their current password working|current password/i);
});

test('the server really does email a link and return no password', () => {
  // The copy above is only honest if this stays true.
  const i = SERVER.indexOf("app.post('/api/admin/reset-user-password/:userId'");
  assert.ok(i > 0);
  const route = SERVER.slice(i, SERVER.indexOf('\n});', i));
  assert.match(route, /createPasswordResetLink/, 'the route must create a reset link');
  assert.match(route, /sendPasswordResetEmail/, 'the route must email it');
  assert.doesNotMatch(route, /res\.json\(\{[\s\S]{0,200}newPassword/, 'the response must not carry the password');
});

test('the sessions copy says the password is NOT changed', () => {
  const code = strip(PAGE);
  const i = code.indexOf('Active sessions');
  assert.ok(i > 0, 'the card is missing');
  const card = code.slice(i, i + 900);
  // Without this, an admin reads "sign out everywhere" as "lock the account"
  // and leaves a lost device holding a working password.
  assert.match(card, /password is unchanged/i);
  assert.match(card, /reset the password as well|reset the password too/i);
});

test('signing yourself out everywhere says so, on the card and in the dialog', () => {
  const code = strip(PAGE);
  // The route passes no exceptSid, so this ends the session doing the clicking.
  assert.match(SERVER, /sessions\.revokeAllForUser\(req\.params\.userId, 'revoked_by_admin'\)/);
  assert.doesNotMatch(SERVER, /revokeAllForUser\(req\.params\.userId, 'revoked_by_admin', \{ exceptSid/,
    'if the route ever spares the caller, this warning should be revisited');
  const handler = handlerBody(code, 'revokeUserSessions');
  assert.match(handler, /me && me\.id === user\.id/, 'the dialog must detect the self case');
  assert.match(handler, /ends THIS session too/, 'and say what happens');
  assert.match(code, /This is your own account, so it will sign you out of this session too/,
    'the card must say it too, not only the dialog');
});

test('the current user is threaded as a prop, never read from localStorage', () => {
  const code = strip(PAGE);
  assert.match(code, /const UsersPage = \(\{ token, isSuperAdmin, user: me \}\)/, 'UsersPage must accept the user');
  // Both render sites must pass it, or the self-warning silently never fires.
  const sites = code.match(/<UsersPage [^>]*\/>/g) || [];
  assert.equal(sites.length, 2, `expected 2 UsersPage render sites, found ${sites.length}`);
  for (const s of sites) assert.match(s, /user=\{user\}/, `a render site does not pass the user: ${s}`);
  // PR #113's rule: an inline localStorage read that misses is
  // indistinguishable from one that hits until somebody is surprised.
  const body = code.slice(code.indexOf('const UsersPage = '), code.indexOf('const revokeUserSessions = async'));
  assert.doesNotMatch(body, /localStorage\.getItem\(['"]admin_user/, 'do not read the signed-in user from localStorage here');
});

test('a zero count reads as nothing to sign out, not as a failure', () => {
  const code = strip(PAGE);
  const handler = handlerBody(code, 'revokeUserSessions');
  // revokeAllForUser returns a NUMBER, and 0 is a real answer.
  assert.match(handler, /result\.revoked\s*\n?\s*\?/, 'the count must branch');
  assert.match(handler, /had no active sessions/i, 'zero needs its own sentence');
  assert.match(handler, /session\$\{result\.revoked === 1 \? '' : 's'\}/, 'and the plural must agree');
});

test('a refusal shows the server sentence, which names the fix', () => {
  const code = strip(PAGE);
  // RESET_PLACEHOLDER_LOGIN names the POA whose account to reset instead. A
  // generic "could not reset" sends somebody to the wrong account.
  assert.match(SERVER, /code: 'RESET_PLACEHOLDER_LOGIN'/);
  for (const fn of ['emailResetLink', 'revokeUserSessions']) {
    const body = handlerBody(code, fn);
    assert.match(body, /if \(result\.error\) \{ setMessage\(`Error: \$\{result\.error\}`\); return; \}/,
      `${fn} must surface the server's own message`);
  }
});

test('both actions confirm first, and neither touches the other', () => {
  const code = strip(PAGE);
  for (const fn of ['emailResetLink', 'revokeUserSessions']) {
    const body = handlerBody(code, fn);
    // `if (!window.confirm(...)) return;` — the REFUSAL path, not the mere
    // presence of the call. `if (false && window.confirm(...))` would pass a
    // looser check while confirming nothing.
    assert.match(body, /if \(!window\.confirm\(|if \(!\w+\)\) return;/, `${fn} must confirm before firing`);
    assert.ok(!/if \(false/.test(body), `${fn} has a disabled guard`);
    assert.match(body, /setAccessActionBusy\(true\)/, `${fn} must disable the buttons while it runs`);
  }
  // The reset route revokes nothing and the revoke route changes no password.
  // If either changes, the copy above becomes wrong.
  const reset = SERVER.slice(SERVER.indexOf("app.post('/api/admin/reset-user-password/:userId'"));
  assert.doesNotMatch(reset.slice(0, reset.indexOf('\n});')), /revokeAllForUser/,
    'the reset-link route does not revoke sessions; the copy says the old password stops working, not that they are signed out');
  const revoke = SERVER.slice(SERVER.indexOf("app.post('/api/users/:userId/sessions/revoke'"));
  assert.doesNotMatch(revoke.slice(0, revoke.indexOf('\n});')), /bcrypt|password/,
    'the revoke route must not touch the password');
});
