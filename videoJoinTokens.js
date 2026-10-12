// ============================================================================
// videoJoinTokens.js — the one-tap video join link (T1 C4)
//
// A patient about to be seen by video should not have to remember a portal
// password while a clinician waits in the room. So there is one link they can
// tap: /v/<token>. That makes the token the only thing standing between a
// stranger and a live consultation, so unlike the upload link it is built to
// be as narrow as a door can be and still open:
//
//   - 256 bits of randomness, and STORED HASHED. The upload link keeps its
//     token in plaintext because it is a persistent upload-only channel; this
//     one opens a live clinical visit, so a copy of the store is not a copy of
//     the keys.
//   - BOUND TO ONE APPOINTMENT AND ONE RECIPIENT. A patient's token does not
//     open their POA's row and does not survive onto the next visit, so a link
//     forwarded in a family group chat is one visit's exposure, not a
//     standing key to every visit they ever have.
//   - WINDOW ONLY. It carries no expiry of its own and needs none: the caller
//     checks the SAME join window the portal's own button checks
//     (patientPublish.joinWindow), so one rule answers both doors and a link
//     that leaks is dead the hour after the visit.
//   - REVOKED, NOT DELETED, when the visit is cancelled or moved. A tombstone
//     answers "this link existed and was shut off" rather than "never heard
//     of it" — the same distinction the upload link and the password reset
//     both draw, because the two need different next steps from whoever is
//     holding the link.
//
// This module is the pure logic. server.js owns the route, the window check,
// the redirect and the store reads — the same split uploadLinks.js keeps.
// ============================================================================

'use strict';

const crypto = require('crypto');

// 32 bytes = 256 bits, base64url so it survives a text message and a QR code
// without percent-encoding. A hex token of the same entropy is 64 characters,
// which wraps in an SMS and gets broken by mail clients.
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const generateToken = () => crypto.randomBytes(TOKEN_BYTES).toString('base64url');

// Salted with the app's own secret, so a stolen store yields no usable link.
const hashToken = (token, salt) =>
  crypto.createHash('sha256').update(`${salt}:${String(token || '')}`).digest('hex');

// Constant-time compare on the DIGESTS, which are always the same length, so
// a malformed guess is refused the same way a well-formed wrong one is. A
// token of the wrong shape never reaches the compare at all — timingSafeEqual
// throws on a length mismatch rather than returning false.
const hashesMatch = (a, b) => {
  const bufA = Buffer.from(String(a || ''), 'hex');
  const bufB = Buffer.from(String(b || ''), 'hex');
  if (bufA.length !== 32 || bufB.length !== 32) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

const RECIPIENT_ROLES = Object.freeze(['patient', 'poa']);

const buildToken = ({ eid, clientId, recipientUserId, recipientRole, salt, now }) => {
  if (!eid) throw Object.assign(new Error('A join token needs an appointment id'), { code: 'JOIN_TOKEN_NO_EID' });
  if (!clientId) throw Object.assign(new Error('A join token needs a client'), { code: 'JOIN_TOKEN_NO_CLIENT' });
  if (!recipientUserId) throw Object.assign(new Error('A join token needs a recipient'), { code: 'JOIN_TOKEN_NO_RECIPIENT' });
  if (!RECIPIENT_ROLES.includes(recipientRole)) {
    throw Object.assign(new Error(`A join token's recipient is one of: ${RECIPIENT_ROLES.join(', ')}`), { code: 'JOIN_TOKEN_BAD_ROLE' });
  }
  if (!salt) throw Object.assign(new Error('A join token cannot be hashed without a secret'), { code: 'JOIN_TOKEN_NO_SALT' });
  const token = generateToken();
  const at = (now || (() => new Date()))().toISOString();
  return {
    token,
    // THE PLAINTEXT TOKEN IS NOT IN THE ROW. It is returned once, to be put
    // into one message, and never stored.
    row: {
      id: `vjt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      eid: String(eid),
      clientId: String(clientId),
      recipientUserId: String(recipientUserId),
      recipientRole,
      tokenHash: hashToken(token, salt),
      createdAt: at,
      revokedAt: null,
      revokedReason: null,
      lastUsedAt: null,
      useCount: 0
    }
  };
};

// Every row is a candidate, live or not, so a revoked link can still say it
// was shut off. The caller decides what a tombstone means.
// NOTE: the shape check below is belt-and-braces, and mutation-checking proved
// it rather than assuming it. A malformed token hashes to a perfectly valid
// 64-hex digest that matches no stored row, so correctness rests on
// `hashesMatch` and on the hash never colliding — not on this line. It is here
// to refuse an obviously wrong token before any hashing happens at all, which
// keeps a flood of junk from doing work. WHAT ACTUALLY DOES THE WORK is
// `hashesMatch`'s own length check: without it, timingSafeEqual THROWS on a
// length mismatch rather than returning false, and a truncated guess becomes a
// 500 instead of a refusal.
const findByToken = (rows, token, salt) => {
  if (!TOKEN_PATTERN.test(String(token || ''))) return null;
  const want = hashToken(token, salt);
  return (rows || []).find(r => r && r.tokenHash && hashesMatch(r.tokenHash, want)) || null;
};

const liveTokenFor = (rows, eid, recipientUserId) =>
  (rows || []).find(r => r && !r.revokedAt &&
    String(r.eid) === String(eid) && String(r.recipientUserId) === String(recipientUserId)) || null;

// Shut every live link for one appointment. Called when the visit is
// cancelled, marked no-show, moved, or stops being a video visit: a link that
// still opened a room after any of those is a door into a meeting nobody
// agreed to.
const revokeForEid = (rows, eid, reason, now) => {
  const at = (now || (() => new Date()))().toISOString();
  let revoked = 0;
  for (const r of rows || []) {
    if (r && !r.revokedAt && String(r.eid) === String(eid)) {
      r.revokedAt = at; r.revokedReason = reason || null; revoked += 1;
    }
  }
  return revoked;
};

// Move live links onto the eid the tombstone swap just created. A reschedule
// keeps the room, so it keeps the links — reminting would send a patient a
// second link while the first one still worked.
const migrateEid = (rows, oldEid, newEid) => {
  let moved = 0;
  for (const r of rows || []) {
    if (r && !r.revokedAt && String(r.eid) === String(oldEid)) {
      r.eid = String(newEid); r.movedFromEid = String(oldEid); moved += 1;
    }
  }
  return moved;
};

const stampUse = (row, now) => {
  row.lastUsedAt = (now || (() => new Date()))().toISOString();
  row.useCount = Number(row.useCount || 0) + 1;
  return row;
};

module.exports = {
  TOKEN_BYTES, TOKEN_PATTERN, RECIPIENT_ROLES,
  generateToken, hashToken, hashesMatch,
  buildToken, findByToken, liveTokenFor, revokeForEid, migrateEid, stampUse
};
