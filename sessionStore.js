// ============================================================================
// sessionStore.js — server-side sessions with idle timeout and revocation
// (Session 5.3)
//
// The app's JWTs were stateless: a token stayed valid until its 24-hour
// expiry no matter what happened in between, so "log out" cleared the
// browser and nothing else, and an idle screen never expired. Now every
// issued token names a session row (sid), and the auth middleware looks the
// row up on every request:
//   - missing or revoked  → AUTH_REVOKED  (the token is dead, whatever its exp)
//   - idle past the limit → AUTH_IDLE     (revoked on the spot)
//   - otherwise           → lastSeenAt is refreshed (throttled, so a busy
//                           screen does not write the row on every request)
//
// One row per session under `auth_session:<sid>` — never one blob for all
// sessions, so two concurrent requests cannot lose each other's writes.
// ============================================================================
'use strict';
const crypto = require('crypto');

const PREFIX = 'auth_session:';
const TOUCH_THROTTLE_MS = 60 * 1000;

const createSessionStore = ({ store, idleMinutes = 15, now = () => Date.now() }) => {
  const key = (sid) => `${PREFIX}${sid}`;
  const idleMs = () => Math.max(1, idleMinutes) * 60 * 1000;

  const create = async ({ userId, role, ipHash = null, userAgent = null, mfaVerified = false, surface = null, absoluteExpiresAt = null }) => {
    const sid = crypto.randomBytes(24).toString('base64url');
    const at = new Date(now()).toISOString();
    const row = { id: sid, userId, role, createdAt: at, lastSeenAt: at, absoluteExpiresAt, revokedAt: null, revokedReason: null, ipHash, userAgent: userAgent ? String(userAgent).slice(0, 200) : null, mfaVerified, surface };
    await store.set(key(sid), row);
    return row;
  };

  // check(sid) → { ok, row } | { ok:false, code, reason }
  const check = async (sid) => {
    if (!sid) return { ok: false, code: 'AUTH_INVALID', reason: 'no session id in token' };
    const row = await store.get(key(sid));
    if (!row) return { ok: false, code: 'AUTH_REVOKED', reason: 'session not found' };
    if (row.revokedAt) return { ok: false, code: 'AUTH_REVOKED', reason: row.revokedReason || 'revoked' };
    const t = now();
    if (row.absoluteExpiresAt && new Date(row.absoluteExpiresAt).getTime() <= t) {
      await store.set(key(sid), { ...row, revokedAt: new Date(t).toISOString(), revokedReason: 'expired' });
      return { ok: false, code: 'AUTH_EXPIRED', reason: 'session lifetime reached' };
    }
    if (t - new Date(row.lastSeenAt).getTime() > idleMs()) {
      await store.set(key(sid), { ...row, revokedAt: new Date(t).toISOString(), revokedReason: 'idle' });
      return { ok: false, code: 'AUTH_IDLE', reason: `inactive for more than ${idleMinutes} minutes` };
    }
    if (t - new Date(row.lastSeenAt).getTime() > TOUCH_THROTTLE_MS) {
      row.lastSeenAt = new Date(t).toISOString();
      await store.set(key(sid), row);
    }
    return { ok: true, row };
  };

  const revoke = async (sid, reason = 'logout') => {
    const row = await store.get(key(sid));
    if (!row) return false;
    if (!row.revokedAt) await store.set(key(sid), { ...row, revokedAt: new Date(now()).toISOString(), revokedReason: reason });
    return true;
  };
  const revokeAllForUser = async (userId, reason = 'revoked', { exceptSid = null } = {}) => {
    let n = 0;
    for (const k of await store.list(PREFIX)) {
      const row = await store.get(k);
      if (row && row.userId === userId && !row.revokedAt && row.id !== exceptSid) {
        await store.set(k, { ...row, revokedAt: new Date(now()).toISOString(), revokedReason: reason }); n++;
      }
    }
    return n;
  };
  const listForUser = async (userId) => {
    const out = [];
    for (const k of await store.list(PREFIX)) { const row = await store.get(k); if (row && row.userId === userId) out.push(row); }
    return out.sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
  };
  // Rows revoked or idle for longer than `olderThanMs` are deleted.
  const sweep = async ({ olderThanMs = 7 * 24 * 3600 * 1000 } = {}) => {
    let n = 0; const t = now();
    for (const k of await store.list(PREFIX)) {
      const row = await store.get(k);
      const last = new Date((row && (row.revokedAt || row.lastSeenAt)) || 0).getTime();
      if (!row || t - last > olderThanMs) { await store.delete(k); n++; }
    }
    return n;
  };
  const markMfaVerified = async (sid) => {
    const row = await store.get(key(sid));
    if (row) await store.set(key(sid), { ...row, mfaVerified: true });
  };

  return { create, check, revoke, revokeAllForUser, listForUser, sweep, markMfaVerified, PREFIX, idleMinutes };
};

module.exports = { createSessionStore, PREFIX, TOUCH_THROTTLE_MS };
