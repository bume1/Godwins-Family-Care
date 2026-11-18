// scripts/demo/demo_env.js — boot the REAL app with an in-memory store and
// made-up people, for recording the employee feature video. Nothing here
// touches a real database, OpenEMR, Drive or email. TEST DATA ONLY.
process.env.PORT = process.env.PORT || '4777';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'demo-video-secret';
process.env.MFA_ENFORCE = 'false';
process.env.DATA_STORE = 'kv';
const Module = require('module');
const path = require('path');
const STORE = new Map();
class MemDb {
  async get(k) { return STORE.has(k) ? JSON.parse(JSON.stringify(STORE.get(k))) : null; }
  async set(k, v) { STORE.set(k, JSON.parse(JSON.stringify(v))); return true; }
  async delete(k) { STORE.delete(k); return true; }
  async list(p) { return [...STORE.keys()].filter(k => !p || k.startsWith(p)); }
  async empty() { STORE.clear(); return true; }
}
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...rest) {
  if (r === '@replit/database') return '__memdb__';
  return realResolve.call(this, r, ...rest);
};
require.cache['__memdb__'] = { id: '__memdb__', filename: '__memdb__', loaded: true, exports: MemDb };

const BASE = `http://localhost:${process.env.PORT}`;
async function call(method, url, token, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}
async function login(email, password) {
  const r = await call('POST', '/api/auth/login', null, { email, password });
  if (!r.body || !r.body.token) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`);
  return r.body;
}
async function waitUp() {
  for (let i = 0; i < 100; i++) { try { const r = await fetch(BASE + '/login'); if (r.ok) return; } catch (_) {} await new Promise(r => setTimeout(r, 300)); }
  throw new Error('server did not start');
}
async function boot() {
  require(path.join(__dirname, '..', '..', 'server.js'));
  await waitUp();
  await new Promise(r => setTimeout(r, 1500));
  return { BASE, STORE, call, login };
}
// Demo accounts skip the forced first-login password change.
function settleUsers() {
  const users = STORE.get('users') || [];
  for (const u of users) u.requirePasswordChange = false;
  STORE.set('users', users);
}
module.exports = { boot, BASE, STORE, call, login, settleUsers };
