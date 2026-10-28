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

// ── The Transfer-of-Care record release, through the same link
// (owner-directed, 2026-10-28: "so they can be submitted via the unique link
// AND via the enrollment wizard").
//
// A release is a SIGNED document naming the patient, so the link cannot work
// the way it does for a photo of an insurance card. Two rules keep the
// "upload only, reads nothing back" promise above intact:
//
//   1. Nothing is prefilled. The signer TYPES the patient's full name and date
//      of birth, and the server checks them against the record. A mismatch is
//      refused with one generic sentence that never says which part was
//      wrong, so the form cannot be used to confirm a date of birth.
//   2. Wrong guesses are capped per link per day, so the check above cannot be
//      walked through a calendar one date at a time.
//
// The signer's copy of the release is handed back in the submit response,
// built only from what they typed plus the record's name and DOB they just
// proved they knew. The record's address and phone never reach this page.

const MAX_ROI_FAILED_PER_DAY = 5;
const MAX_ROI_SUBMISSIONS_PER_DAY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const inLastDay = (list, now) =>
  (Array.isArray(list) ? list : []).filter(t => (now - new Date(t).getTime()) < DAY_MS).length;

// Which of the two ceilings, if any, this link has hit. Checked BEFORE the
// identity comparison, so a locked link answers the same way whether the
// next guess would have been right or wrong.
const roiLinkBlocked = (link, now = Date.now()) => {
  if (inLastDay(link && link.roiFailedAt, now) >= MAX_ROI_FAILED_PER_DAY) return 'ROI_LINK_LOCKED';
  if (inLastDay(link && link.roiSubmittedAt, now) >= MAX_ROI_SUBMISSIONS_PER_DAY) return 'ROI_LINK_RATE_LIMITED';
  return null;
};

// Stamp one attempt onto the link row. Old stamps are trimmed so the row
// does not grow forever on a link that lives for years.
const recordRoiAttempt = (link, kind, now = Date.now()) => {
  const key = kind === 'failed' ? 'roiFailedAt' : 'roiSubmittedAt';
  const kept = (Array.isArray(link[key]) ? link[key] : []).filter(t => (now - new Date(t).getTime()) < DAY_MS);
  return { ...link, [key]: [...kept, new Date(now).toISOString()] };
};

// Letters only, lower case, accents folded: "O'Brien" = "obrien", "José" = "jose".
const foldName = (v) => String(v || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z\s-]/g, '').replace(/-/g, ' ')
  .split(/\s+/).filter(Boolean);

// Any common date shape to YYYY-MM-DD, or '' if it is not one.
const normalizeDob = (v) => {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return '';
};

// Does what the signer typed name the patient on this record?
// The date of birth must match exactly. The name must share the LAST name and
// the FIRST name or initial, judged against every name on file (legal and
// preferred), so "Bob Smith" for a Robert Smith whose preferred name is Bob
// passes, while a stranger's surname does not. A record with no date of birth
// cannot be checked, so it is refused rather than waved through.
const roiIdentityMatches = (record, typed) => {
  const dobOnFile = normalizeDob(record && record.dob);
  const dobTyped = normalizeDob(typed && typed.dob);
  if (!dobOnFile || !dobTyped || dobOnFile !== dobTyped) return false;
  const typedParts = foldName(typed && typed.name);
  if (typedParts.length < 2) return false;
  const tFirst = typedParts[0];
  const tLast = typedParts[typedParts.length - 1];
  const names = (record && Array.isArray(record.names) ? record.names : []).map(foldName).filter(p => p.length);
  return names.some(parts => {
    const lastOk = parts.slice(1).includes(tLast) || parts[parts.length - 1] === tLast;
    const firstOk = parts[0] === tFirst || (tFirst.length === 1 && parts[0][0] === tFirst);
    return lastOk && firstOk;
  });
};

module.exports = {
  TOKEN_BYTES, MAX_UPLOADS_PER_DAY,
  generateToken, tokensMatch, liveLinkFor, findByToken, buildLink, revoke,
  uploadsInLast24h, rateLimited, identityHint, buildUrl,
  MAX_ROI_FAILED_PER_DAY, MAX_ROI_SUBMISSIONS_PER_DAY,
  roiLinkBlocked, recordRoiAttempt, roiIdentityMatches, normalizeDob
};
