// ============================================================================
// mfa.js — TOTP multi-factor authentication + recovery codes (Session 5.3)
//
// Dependency-free RFC 6238 (SHA-1, 30-second step, 6 digits, ±1 step of
// drift), the profile every authenticator app implements (Google
// Authenticator, Authy, 1Password, Microsoft Authenticator). The secret is
// base32 for the otpauth:// URI and is stored ENCRYPTED on the user record
// under the same key as the per-user OpenEMR tokens; recovery codes are stored
// as salted SHA-256 hashes and are single-use.
//
// What is enforced and where:
//   - who must have MFA:          mfaRequiredFor() — the role floor in
//                                 config.MFA_REQUIRED_ROLES, any clinical role,
//                                 and manager-level access
//   - login gating:               server.js login routes (5.3) — a required
//                                 role gets a short-lived MFA challenge token
//                                 instead of a session until the code verifies
//   - replay:                     the last accepted time-step is stored and a
//                                 code from the same step is refused
// ============================================================================
'use strict';
const crypto = require('crypto');
const { canClinicalRead } = require('./clinicalRoles');

const STEP_SECONDS = 30;
const DIGITS = 6;
const DRIFT_STEPS = 1;
const RECOVERY_CODE_COUNT = 10;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const base32Encode = (buf) => {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
};
const base32Decode = (str) => {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
};

const generateSecret = () => base32Encode(crypto.randomBytes(20));   // 160-bit, RFC 4226 recommended

const hotp = (secretBuf, counter) => {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const offset = h[h.length - 1] & 0xf;
  const code = ((h[offset] & 0x7f) << 24) | ((h[offset + 1] & 0xff) << 16) | ((h[offset + 2] & 0xff) << 8) | (h[offset + 3] & 0xff);
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
};
const stepFor = (ms) => Math.floor(ms / 1000 / STEP_SECONDS);
const totp = (secretB32, atMs = Date.now()) => hotp(base32Decode(secretB32), stepFor(atMs));

// verifyTotp(secret, code, { now, lastStep }) → { ok, step } — step is the
// time-step the code matched so the caller can store it against replay.
const verifyTotp = (secretB32, code, { now = Date.now(), lastStep = null } = {}) => {
  const digits = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(digits)) return { ok: false, reason: 'format' };
  const secretBuf = base32Decode(secretB32);
  const current = stepFor(now);
  for (let d = -DRIFT_STEPS; d <= DRIFT_STEPS; d++) {
    const step = current + d;
    const expected = hotp(secretBuf, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(digits))) {
      if (lastStep !== null && step <= lastStep) return { ok: false, reason: 'replay' };
      return { ok: true, step };
    }
  }
  return { ok: false, reason: 'mismatch' };
};

const otpauthUri = ({ issuer, account, secret }) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;

// ---- Recovery codes: 10 × "xxxx-xxxx-xxxx" (crockford-ish alphabet), hashed ----
const RC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const formatRecovery = (raw) => String(raw).toLowerCase().replace(/[^a-z0-9]/g, '');
const generateRecoveryCodes = (n = RECOVERY_CODE_COUNT) => Array.from({ length: n }, () => {
  const bytes = crypto.randomBytes(12);
  const s = [...bytes].map(b => RC_ALPHABET[b % RC_ALPHABET.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
});
const hashRecovery = (code, salt) => crypto.createHash('sha256').update(`${salt}:${formatRecovery(code)}`).digest('hex');
const buildRecoveryRecord = (codes) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hashes: codes.map(c => ({ hash: hashRecovery(c, salt), usedAt: null })) };
};
// consumeRecovery(record, code) → { ok, record } — marks the matching code used.
const consumeRecovery = (record, code) => {
  if (!record || !Array.isArray(record.hashes)) return { ok: false, record };
  const h = hashRecovery(code, record.salt);
  const idx = record.hashes.findIndex(r => !r.usedAt && crypto.timingSafeEqual(Buffer.from(r.hash), Buffer.from(h)));
  if (idx < 0) return { ok: false, record };
  const hashes = record.hashes.map((r, i) => (i === idx ? { ...r, usedAt: new Date().toISOString() } : r));
  return { ok: true, record: { ...record, hashes }, remaining: hashes.filter(r => !r.usedAt).length };
};

// ---- Policy ----
// MFA follows what a person can reach, not their account type: any clinical
// role opens a chart, and these flags open the admin hub, the user list and
// the enrollment records. Clients, family and caregivers stay ungated.
const MANAGER_LEVEL_FLAGS = Object.freeze(['isManager', 'hasAdminHubAccess', 'hasClientPortalAdminAccess']);
const mfaRequiredFor = (user, requiredRoles) => {
  if (!user) return false;
  if ((requiredRoles || []).includes(user.role)) return true;
  if (user.hasClinicalAccess || canClinicalRead(user)) return true;
  return MANAGER_LEVEL_FLAGS.some(flag => !!user[flag]);
};
const isEnrolled = (user) => !!(user && user.mfa && user.mfa.enrolledAt && user.mfa.secret);

module.exports = {
  STEP_SECONDS, DIGITS, DRIFT_STEPS, RECOVERY_CODE_COUNT,
  generateSecret, totp, verifyTotp, otpauthUri, stepFor,
  generateRecoveryCodes, buildRecoveryRecord, consumeRecovery, formatRecovery,
  mfaRequiredFor, isEnrolled, MANAGER_LEVEL_FLAGS,
  _internal: { base32Encode, base32Decode, hotp }
};
