'use strict';
// ============================================================================
// payrollCrypto.js — field encryption for payroll secrets (spec v1 "Security").
//
// SSNs, TINs, bank routing and account numbers, and the QuickBooks tokens are
// stored ENCRYPTED, AES-256-GCM, under PAYROLL_ENCRYPTION_KEY (32 bytes, as 64
// hex chars or base64). The key lives in the environment (AWS Secrets
// Manager on the box), never in the code or the database. A separate key from
// the OpenEMR token key, so rotating one never touches the other.
//
// With no key set, nothing secret can be SAVED (the route answers 503 and
// says so). It never falls back to storing a value in the clear.
// ============================================================================
const crypto = require('crypto');

const parseKey = (raw) => {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  const b = Buffer.from(s, 'base64');
  if (b.length === 32) return b;
  throw new Error('PAYROLL_ENCRYPTION_KEY must be 32 bytes, as 64 hex chars or base64');
};

let cache = { raw: undefined, key: null };
const keyFor = (env) => {
  const raw = (env || process.env).PAYROLL_ENCRYPTION_KEY;
  if (raw !== cache.raw) cache = { raw, key: parseKey(raw) };
  return cache.key;
};

class PayrollKeyMissing extends Error {
  constructor() { super('PAYROLL_ENCRYPTION_KEY is not set, so bank and tax ID numbers cannot be stored.'); this.code = 'PAYROLL_KEY_MISSING'; this.status = 503; }
}

const configured = (env) => { try { return !!keyFor(env); } catch (e) { return false; } };

function seal(plain, env) {
  const key = keyFor(env);
  if (!key) throw new PayrollKeyMissing();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `p1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

function open(packed, env) {
  if (!packed) return null;
  const key = keyFor(env);
  if (!key) throw new PayrollKeyMissing();
  const [v, iv, tag, enc] = String(packed).split('.');
  if (v !== 'p1') throw new Error('unrecognised payroll ciphertext');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

// Last four only, for screens, stubs and emails.
const last4 = (s) => (String(s || '').replace(/\D/g, '').slice(-4) || null);
const mask = (l4) => (l4 ? `•••${l4}` : null);

module.exports = { seal, open, configured, last4, mask, PayrollKeyMissing };
