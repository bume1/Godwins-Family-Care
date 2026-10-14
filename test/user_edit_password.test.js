// Saving the Edit User form must never reset a password by accident
// (owner report, 2026-10-14: a case manager's password was reset by an
// ordinary edit). A browser fills a saved password into any password box,
// so both halves are guarded: the server only resets on resetPassword: true,
// and the edit form has no password box until the admin asks for one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const hub = fs.readFileSync(path.join(root, 'public', 'admin-hub.html'), 'utf8');

const putRoute = (() => {
  const i = server.indexOf("app.put('/api/users/:userId', authenticateToken, requireAdmin");
  assert.ok(i > 0, 'user PUT route not found');
  return strip(server.slice(i, server.indexOf('\n});', i)));
})();

test('the server resets a password only when the request says resetPassword: true', () => {
  assert.match(putRoute, /if \(password && resetPassword === true\) \{\s*users\[idx\]\.password = await bcrypt\.hash/);
  assert.doesNotMatch(putRoute, /if \(password\) \{/, 'a bare password must not reset the account');
  assert.match(putRoute, /passwordIgnored/, 'an ignored password is reported back, not silent');
});

test('the edit form sends a password only when "Set a new password" is ticked', () => {
  const i = hub.indexOf('const handleSubmit = async (e) => {', hub.indexOf('const [changePassword, setChangePassword]'));
  const body = hub.slice(i, hub.indexOf('} else {', i));
  assert.match(body, /delete updateData\.password;/);
  assert.match(body, /if \(changePassword && formData\.password\) \{\s*updateData\.password = formData\.password;\s*updateData\.resetPassword = true;/);
  assert.match(hub, /const handleEdit = \(user\) => \{\s*setChangePassword\(false\);/, 'every edit starts with the box unticked');
});

test('on an edit the password box is not rendered until asked for, and never invites autofill', () => {
  const i = hub.indexOf('{editingUser ? (', hub.indexOf('Set a new password for this user') - 2000);
  const block = hub.slice(i, hub.indexOf('Password *', i) + 400);
  assert.match(block, /\{changePassword && \(\s*<input type="password" autoComplete="new-password"/);
  const form = hub.slice(hub.indexOf('<form onSubmit={handleSubmit} className="p-6 space-y-6">'));
  const pw = form.slice(0, form.indexOf('</form>')).match(/<input type="password"[^>]*/g) || [];
  assert.ok(pw.length >= 2, 'expected the edit and create password boxes');
  for (const tag of pw) assert.match(tag, /autoComplete="new-password"/, `password box without autoComplete="new-password": ${tag}`);
});

test('the password-reset-request button still resets, explicitly', () => {
  assert.match(hub, /api\.updateUser\(token, userId, \{ password: newPassword, resetPassword: true \}\)/);
});
