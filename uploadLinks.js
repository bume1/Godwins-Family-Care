// ============================================================================
// uploadLinks.js — the branded, no-login document upload link
// (owner-directed, 2026-09-23: "a branded upload link the patient can submit
// documents to without signing in and it automatically appears in their
// documents and in our records")
//
// Every other door onto a client's file needs a password (the portal) or a
// staff login (the enrollment view). This is the one door that deliberately
// does not: a family member standing in a hallway with a phone should not
// have to remember a portal password to hand over an insurance card.
//
// That means the SAFETY has to live in the token, not in a login, so:
//   - the token is 192 bits of randomness, not a short code — this link is
//     PERSISTENT (owner decision: reusable, not one-time), so unlike the
//     24-hour password-reset token it never expires on its own and needs the
//     entropy to still be a locked door in a year.
//   - a client has exactly one LIVE token at a time. Regenerating or revoking
//     tombstones the old row rather than deleting it — the same rule shift
//     edits and quarantined messages already follow — so a leaked link's
//     history survives being shut off.
//   - the channel is UPLOAD ONLY. There is no read route behind a token: it
//     cannot list what is already on file, cannot open another document, and
//     cannot stand in for a login anywhere else in the app.
//   - what arrives through it lands exactly where a logged-in client's own
//     upload lands (`client_document_uploads`, `received`, staff review) —
//     nothing here writes anywhere the authenticated path does not already
//     write, and nothing here skips the review an authenticated upload gets.
//
// This module is the pure logic: token shape, which link is "live", rate
// limiting. server.js owns the routes, the Drive call and the DB reads —
// the same split as enrollmentGate.js and clinicalRoles.js keep.
// ============================================================================

'use strict';

const crypto = require('crypto');

// 24 bytes = 192 bits. The password-reset token (20 bytes, 24-hour expiry)
// is the wrong size to copy: that link is dead in a day, this one is not
// dead until someone revokes it, so it carries more entropy for the same
// reason a safe with no combination lock left on it forever needs a longer
// combination than one that resets every morning.
const TOKEN_BYTES = 24;

const generateToken = () => crypto.randomBytes(TOKEN_BYTES).toString('hex');

// Constant-time compare against a KNOWN-LENGTH hex token. A `token` of the
// wrong length is refused before ever reaching timingSafeEqual, which throws
// on a length mismatch rather than returning false — so a malformed or
// truncated guess is rejected the same way a well-formed wrong guess is,
// with no early exit either could be timed against.
const tokensMatch = (a, b) => {
  const bufA = Buffer.from(String(a || ''), 'hex');
  const bufB = Buffer.from(String(b || ''), 'hex');
  if (bufA.length !== TOKEN_BYTES || bufB.length !== TOKEN_BYTES) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

// The one link a client's token may currently work — everything else for
// that client in the same list is a tombstone. `revokedAt` is what makes a
// row a tombstone rather than a second live door.
const liveLinkFor = (clientId, links) =>
  (links || []).find(l => l.clientId === clientId && !l.revokedAt) || null;

// Every row in the list is a candidate, live or not, so a revoked link can
// still answer "this token existed and was shut off" (410) rather than
// "never heard of it" (404) — the same distinction the password-reset link
// draws between expired and invalid, because the two need different next
// steps from whoever is holding the link.
const findByToken = (token, links) =>
  (links || []).find(l => tokensMatch(l.token, token)) || null;

const buildLink = ({ clientId, actor }) => ({
  id: `ulk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  clientId,
  token: generateToken(),
  createdAt: new Date().toISOString(),
  createdById: (actor && actor.id) || null,
  createdByName: (actor && (actor.name || actor.email)) || null,
  revokedAt: null,
  revokedById: null
});

const revoke = (link, actor) => ({
  ...link,
  revokedAt: new Date().toISOString(),
  revokedById: (actor && actor.id) || null
});

// Not a security boundary — the token is that. A ceiling on an
// unauthenticated channel so a link that DOES leak (forwarded past the
// person it was meant for, scraped out of a compromised inbox) cannot flood
// Drive and the staff review queue before anyone notices and revokes it.
const MAX_UPLOADS_PER_DAY = 30;

const uploadsInLast24h = (clientId, uploads) => {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  return (uploads || []).filter(u =>
    u.clientId === clientId && u.channel === 'link' &&
    new Date(u.uploadedAt).getTime() >= since
  ).length;
};

const rateLimited = (clientId, uploads) => uploadsInLast24h(clientId, uploads) >= MAX_UPLOADS_PER_DAY;

// The only identity confirmation shown to an anonymous bearer of the link —
// enough that a family member knows they have the right person's link,
// never enough to be worth intercepting on its own. No DOB, no full name in
// one string, no client id.
const identityHint = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastInitial: '' };
  const firstName = parts[0];
  const lastInitial = parts.length > 1 ? parts[parts.length - 1][0].toUpperCase() : '';
  return { firstName, lastInitial };
};

const buildUrl = (baseUrl, token) => `${baseUrl}/upload/${token}`;

module.exports = {
  TOKEN_BYTES, MAX_UPLOADS_PER_DAY,
  generateToken, tokensMatch, liveLinkFor, findByToken, buildLink, revoke,
  uploadsInLast24h, rateLimited, identityHint, buildUrl
};
