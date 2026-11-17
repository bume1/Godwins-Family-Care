#!/usr/bin/env node
/**
 * Self-service password reset (2026-11-17).
 *
 * Owner: "when the password is reset by admin after a request is sent ... that
 * password is never shared with the user ... turn this into an automated
 * password reset function that I don't have to go in and do the reset myself."
 *
 * Runs the REAL server and routes. Stubbed: the KV store and outgoing email
 * (captured, so the link the person would click is read back out of the
 * message). Every check reads stored state or a real sign-in, not a status.
 *
 *   node scripts/verify_password_reset.js
 */
process.env.PORT = process.env.PORT || '4617';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'password-reset-verification-secret';
process.env.AUTO_CHANGELOG = 'false';
process.env.MFA_ENFORCE = 'false';
process.env.DATA_STORE = 'kv';

const path = require('path');
const Module = require('module');
const bcrypt = require('bcryptjs');

const STORE = new Map();
class MemDb {
  async get(k) { return STORE.has(k) ? JSON.parse(JSON.stringify(STORE.get(k))) : null; }
  async set(k, v) { STORE.set(k, JSON.parse(JSON.stringify(v))); return true; }
  async delete(k) { STORE.delete(k); return true; }
  async list(p) { return [...STORE.keys()].filter(k => !p || k.startsWith(p)); }
  async empty() { STORE.clear(); return true; }
}
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...rest) { return r === '@replit/database' ? '__memdb__' : realResolve.call(this, r, ...rest); };
require.cache['__memdb__'] = { id: '__memdb__', filename: '__memdb__', loaded: true, exports: MemDb };

// Capture every email instead of sending it.
const SENT = [];
const email = require(path.join(__dirname, '..', 'email.js'));
email.sendEmail = async (to, subject, text, opts) => { SENT.push({ to, subject, text, html: (opts && opts.htmlBody) || '' }); return { ok: true }; };

const config = require(path.join(__dirname, '..', 'config.js'));
const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${d !== undefined ? ` — ${typeof d === 'string' ? d : JSON.stringify(d).slice(0, 300)}` : ''}`); } };
const call = async (m, u, body, tok) => {
  const r = await fetch(`${BASE}${u}`, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let b = null; try { b = await r.json(); } catch (_) {}
  return { status: r.status, body: b };
};
const linkFrom = (msg) => { const m = /password-reset-([0-9a-f]{64})/.exec((msg && msg.text) || ''); return m ? m[1] : null; };
const login = (e, p) => call('POST', '/api/auth/login', { email: e, password: p });

const OLD_PW = 'OldPassw0rd!';
const ALICE = { id: 'u_alice', role: 'user', email: 'alice@example.test', name: 'Alice Nurse', clinicalRole: 'rn', accountStatus: 'active' };
const OFF = { id: 'u_off', role: 'user', email: 'off@example.test', name: 'Off Person', accountStatus: 'inactive' };
const ADMIN = { id: 'u_admin', role: 'admin', email: 'admin@example.test', name: 'GFC Admin', accountStatus: 'active' };

(async () => {
  const hash = await bcrypt.hash(OLD_PW, 4);
  STORE.set('users', [ALICE, OFF, ADMIN].map(u => ({ ...u, password: hash })));
  require(path.join(__dirname, '..', 'server.js'));
  await new Promise(r => setTimeout(r, 3000));

  console.log('\n── Forgot password emails a link, with no admin step ──');
  let r = await call('POST', '/api/auth/forgot-password', { email: 'Alice@Example.test' });
  check('the reply is the generic sentence', r.status === 200 && /If an account uses that email/.test(r.body.message), r.body);
  const mail = SENT.filter(m => m.to === ALICE.email).pop();
  const token = linkFrom(mail);
  check('Alice is emailed a link to choose a new password', !!token && /Choose a new password|choose a new password/.test(mail.text), mail);
  check('the email carries no password', mail && !/OldPassw0rd|Temp[0-9a-f]{8}!/.test(mail.text + mail.html));
  const stored = STORE.get('password_set_links') || [];
  check('only a fingerprint of the link is stored, never the link itself', stored.length === 1 && stored[0].tokenHash && !JSON.stringify(stored).includes(token), stored);
  check('nothing is waiting in the admin Inbox', !(STORE.get('password_reset_requests') || []).some(x => x.status === 'pending'));
  check('asking for a link does not change the old password', (await login(ALICE.email, OLD_PW)).status === 200);

  console.log('\n── The link page and setting the password ──');
  r = await call('GET', `/api/auth/password-reset-link/${token}`);
  check('the page is told to show the "choose a password" form, with a first name only', r.status === 200 && r.body.mode === 'set_password' && r.body.firstName === 'Alice' && !r.body.email && !r.body.tempPassword, r.body);
  r = await call('POST', '/api/auth/reset-password', { token, newPassword: 'short' });
  check('a weak password is refused', r.status === 400 && r.body.code === 'PASSWORD_TOO_WEAK', r.body);
  r = await call('POST', '/api/auth/reset-password', { token, newPassword: 'NewPassw0rd!' });
  check('a good password is saved', r.status === 200, r.body);
  check('the new password signs in', (await login(ALICE.email, 'NewPassw0rd!')).status === 200);
  check('the old password no longer does', (await login(ALICE.email, OLD_PW)).status !== 200);
  check('Alice is told her password was changed', SENT.some(m => m.to === ALICE.email && /password was changed/i.test(m.subject)));
  r = await call('POST', '/api/auth/reset-password', { token, newPassword: 'Another1Pass' });
  check('the link works only once', r.status === 400 && r.body.code === 'RESET_LINK_USED', r.body);
  r = await call('POST', '/api/auth/reset-password', { token: 'f'.repeat(64), newPassword: 'Another1Pass' });
  check('a made-up link is refused', r.status === 400 && r.body.code === 'RESET_LINK_INVALID', r.body);

  console.log('\n── Unknown, switched-off and over-limit requests ──');
  const before = SENT.length;
  r = await call('POST', '/api/auth/forgot-password', { email: 'nobody@example.test' });
  check('an unknown email gets the same reply and no email', r.status === 200 && /If an account uses that email/.test(r.body.message) && SENT.length === before);
  r = await call('POST', '/api/auth/forgot-password', { email: OFF.email });
  check('a switched-off account gets the same reply and no link', r.status === 200 && !SENT.slice(before).some(m => m.to === OFF.email && linkFrom(m)));
  check('and the office is told, in the Inbox', (STORE.get('password_reset_requests') || []).some(x => x.userId === OFF.id && x.status === 'pending'));
  for (let i = 0; i < 4; i++) await call('POST', '/api/auth/forgot-password', { email: ALICE.email });
  const aliceLinks = SENT.filter(m => m.to === ALICE.email && linkFrom(m)).length;
  check('at most 3 links an hour (the first, plus 2 more)', aliceLinks === 3, aliceLinks);
  const links = STORE.get('password_set_links') || [];
  const live = links.filter(l => l.userId === ALICE.id && !l.usedAt && !l.supersededAt);
  check('a newer link supersedes the older ones', live.length === 1, live.length);
  const older = SENT.filter(m => m.to === ALICE.email && linkFrom(m)).map(linkFrom)[1];
  r = await call('POST', '/api/auth/reset-password', { token: older, newPassword: 'Another1Pass' });
  check('an older link says a newer one was sent', r.status === 400 && r.body.code === 'RESET_LINK_SUPERSEDED', r.body);

  console.log('\n── The admin buttons now send the same link ──');
  const adminTok = (await login(ADMIN.email, OLD_PW)).body.token;
  STORE.set('password_reset_requests', [...(STORE.get('password_reset_requests') || []), { id: 'legacy1', userId: ALICE.id, email: ALICE.email, status: 'pending', requestedAt: new Date().toISOString() }]);
  const n1 = SENT.length;
  r = await call('PUT', '/api/admin/password-reset-requests/legacy1', { status: 'completed' }, adminTok);
  check('the Inbox "Email Reset Link" button emails the person a link', r.status === 200 && SENT.slice(n1).some(m => m.to === ALICE.email && linkFrom(m)) && /Emailed/.test(r.body.message), r.body);
  r = await call('PUT', `/api/admin/password-reset-requests/${(STORE.get('password_reset_requests') || []).find(x => x.userId === OFF.id).id}`, { status: 'completed' }, adminTok);
  check('for a switched-off account the button says why instead', r.status === 409 && r.body.code === 'RESET_LINK_NOT_SENDABLE', r.body);
  const n2 = SENT.length;
  r = await call('POST', `/api/admin/reset-user-password/${ALICE.id}`, {}, adminTok);
  const adminLink = linkFrom(SENT.slice(n2).find(m => m.to === ALICE.email));
  check('the user form\'s "Email Reset Link" sends a choose-a-password link, no temp password', r.status === 200 && r.body.linkSent && !!adminLink && !(STORE.get('password_reset_links') || []).length, r.body);
  check('and, as the card says, the current password stops working', (await login(ALICE.email, 'NewPassw0rd!')).status !== 200);
  r = await call('POST', '/api/auth/reset-password', { token: adminLink, newPassword: 'Admin1Reset' });
  check('Alice gets back in with the admin\'s link', r.status === 200 && (await login(ALICE.email, 'Admin1Reset')).status === 200, r.body);

  console.log('\n── Audit ──');
  const acts = (STORE.get('activity_log') || []).map(a => a.action);
  for (const a of ['password_reset_link_sent', 'password_reset_by_link', 'password_reset_link_rate_limited']) check(`${a} is audited`, acts.includes(a), acts.slice(-10).join(','));

  console.log(`\n${pass}/${pass + fail} checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
