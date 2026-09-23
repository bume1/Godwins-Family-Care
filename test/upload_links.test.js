// ============================================================
// uploadLinks.js — the branded, no-login document upload link
//
// This file guards the pure logic: what makes a token unguessable and safe
// to compare, which link is "live" for a client, how a revoke tombstones
// rather than deletes, and the rate-limit arithmetic. The routes that wire
// this into server.js (the public GET/POST, the client's and staff's
// generate/revoke doors, the embedded `uploadLink` field on the two
// existing document-checklist reads) are covered end to end by
// scripts/verify_upload_link.js against the real HTTP routes.
// ============================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const uploadLinks = require('../uploadLinks');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const DATA_MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'dataMigration.js'), 'utf8');

// ── Token shape ──────────────────────────────────────────────────────────

test('a generated token is 192 bits of hex, not the password-reset size', () => {
  const t = uploadLinks.generateToken();
  assert.match(t, /^[0-9a-f]+$/);
  assert.strictEqual(t.length, uploadLinks.TOKEN_BYTES * 2);
  assert.strictEqual(uploadLinks.TOKEN_BYTES, 24, 'this link is persistent, not 24-hour — it needs more entropy than the password-reset token, not the same amount');
});

test('two tokens are never the same value', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(uploadLinks.generateToken());
  assert.strictEqual(seen.size, 200);
});

test('tokensMatch: a token matches itself and nothing else', () => {
  const a = uploadLinks.generateToken();
  const b = uploadLinks.generateToken();
  assert.strictEqual(uploadLinks.tokensMatch(a, a), true);
  assert.strictEqual(uploadLinks.tokensMatch(a, b), false);
});

test('tokensMatch: a malformed or wrong-length candidate is refused, never thrown', () => {
  const real = uploadLinks.generateToken();
  assert.strictEqual(uploadLinks.tokensMatch(real, ''), false);
  assert.strictEqual(uploadLinks.tokensMatch(real, 'short'), false);
  assert.strictEqual(uploadLinks.tokensMatch(real, real + 'ff'), false);
  assert.strictEqual(uploadLinks.tokensMatch(real, 'not-hex-at-all-'.repeat(4)), false);
  assert.strictEqual(uploadLinks.tokensMatch(null, real), false);
  assert.strictEqual(uploadLinks.tokensMatch(undefined, undefined), false);
});

// ── Which link is live ───────────────────────────────────────────────────

test('liveLinkFor: finds the one row for a client with no revokedAt', () => {
  const links = [
    { id: 'a', clientId: 'c1', token: 't1', revokedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b', clientId: 'c1', token: 't2', revokedAt: null },
    { id: 'c', clientId: 'c2', token: 't3', revokedAt: null }
  ];
  const live = uploadLinks.liveLinkFor('c1', links);
  assert.strictEqual(live.id, 'b');
});

test('liveLinkFor: null when every row for this client is revoked, or there are none', () => {
  assert.strictEqual(uploadLinks.liveLinkFor('c1', []), null);
  assert.strictEqual(uploadLinks.liveLinkFor('c1', [{ id: 'a', clientId: 'c1', token: 't', revokedAt: '2026-01-01T00:00:00.000Z' }]), null);
  assert.strictEqual(uploadLinks.liveLinkFor('c1', [{ id: 'a', clientId: 'c2', token: 't', revokedAt: null }]), null, 'another client\'s live link must not answer for c1');
});

test('findByToken: matches a REVOKED row too — the caller decides 404 vs 410', () => {
  const link = uploadLinks.buildLink({ clientId: 'c1', actor: null });
  const revoked = uploadLinks.revoke(link, null);
  const found = uploadLinks.findByToken(link.token, [revoked]);
  assert.strictEqual(found.id, revoked.id);
  assert.ok(found.revokedAt, 'findByToken does not filter revoked rows out — that distinction belongs to the route');
});

test('findByToken: null for an unknown token or an empty list', () => {
  assert.strictEqual(uploadLinks.findByToken(uploadLinks.generateToken(), []), null);
  const link = uploadLinks.buildLink({ clientId: 'c1', actor: null });
  assert.strictEqual(uploadLinks.findByToken(uploadLinks.generateToken(), [link]), null);
});

// ── buildLink / revoke ───────────────────────────────────────────────────

test('buildLink: a fresh, live row naming its client and its creator', () => {
  const actor = { id: 'staff1', name: 'Verification Staff' };
  const link = uploadLinks.buildLink({ clientId: 'client9', actor });
  assert.strictEqual(link.clientId, 'client9');
  assert.strictEqual(link.revokedAt, null);
  assert.strictEqual(link.createdById, 'staff1');
  assert.strictEqual(link.createdByName, 'Verification Staff');
  assert.match(link.token, new RegExp(`^[0-9a-f]{${uploadLinks.TOKEN_BYTES * 2}}$`));
  assert.ok(link.createdAt);
});

test('buildLink: a missing actor (the seed / a system action) never throws', () => {
  const link = uploadLinks.buildLink({ clientId: 'client9', actor: null });
  assert.strictEqual(link.createdById, null);
  assert.strictEqual(link.createdByName, null);
});

test('revoke: a NEW object — the tombstone rule. The original row is untouched', () => {
  const link = uploadLinks.buildLink({ clientId: 'c1', actor: null });
  const revoked = uploadLinks.revoke(link, { id: 'admin1' });
  assert.strictEqual(link.revokedAt, null, 'the row passed in must not be mutated in place');
  assert.ok(revoked.revokedAt);
  assert.strictEqual(revoked.revokedById, 'admin1');
  assert.strictEqual(revoked.token, link.token, 'the token itself is kept on the tombstone, so a 410 can still name what was turned off');
  assert.strictEqual(revoked.id, link.id, 'same row, not a new one — this is a tombstone, not a delete');
});

// ── Rate limiting ────────────────────────────────────────────────────────

test('rateLimited: counts only THIS client\'s link-channel uploads inside 24h', () => {
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const rows = [
    ...Array.from({ length: 29 }, (_, i) => ({ clientId: 'c1', channel: 'link', uploadedAt: iso(i * 1000) })),
    { clientId: 'c1', channel: 'app', uploadedAt: iso(0) },          // authenticated upload — different channel, must not count
    { clientId: 'c2', channel: 'link', uploadedAt: iso(0) },         // another client — must not count
    { clientId: 'c1', channel: 'link', uploadedAt: iso(48 * 3600 * 1000) } // 2 days old — outside the window
  ];
  assert.strictEqual(uploadLinks.uploadsInLast24h('c1', rows), 29);
  assert.strictEqual(uploadLinks.rateLimited('c1', rows), false);
  rows.push({ clientId: 'c1', channel: 'link', uploadedAt: iso(0) });
  assert.strictEqual(uploadLinks.uploadsInLast24h('c1', rows), 30);
  assert.strictEqual(uploadLinks.rateLimited('c1', rows), true, `the ${uploadLinks.MAX_UPLOADS_PER_DAY}th upload trips the limit`);
});

test('rateLimited: an empty or undefined upload list is never limited', () => {
  assert.strictEqual(uploadLinks.rateLimited('c1', []), false);
  assert.strictEqual(uploadLinks.rateLimited('c1', undefined), false);
});

// ── Identity hint: the ONLY thing an anonymous bearer of the link sees ────

test('identityHint: first name plus a last initial, never the full name in one string', () => {
  assert.deepStrictEqual(uploadLinks.identityHint('Juanita Guess'), { firstName: 'Juanita', lastInitial: 'G' });
});

test('identityHint: a middle name does not become the "last" initial', () => {
  assert.deepStrictEqual(uploadLinks.identityHint('Mary Ann Smith'), { firstName: 'Mary', lastInitial: 'S' });
});

test('identityHint: a single name yields no last initial rather than guessing one', () => {
  assert.deepStrictEqual(uploadLinks.identityHint('Cher'), { firstName: 'Cher', lastInitial: '' });
});

test('identityHint: blank or missing name fails safe to empty strings, not "undefined"', () => {
  assert.deepStrictEqual(uploadLinks.identityHint(''), { firstName: '', lastInitial: '' });
  assert.deepStrictEqual(uploadLinks.identityHint(null), { firstName: '', lastInitial: '' });
  assert.deepStrictEqual(uploadLinks.identityHint('   '), { firstName: '', lastInitial: '' });
});

test('buildUrl: the token in the path, not a query string', () => {
  const link = uploadLinks.buildLink({ clientId: 'c1', actor: null });
  assert.strictEqual(uploadLinks.buildUrl('https://app.godwinsfamilycarellc.com', link.token),
    `https://app.godwinsfamilycarellc.com/upload/${link.token}`);
});

// ── Build-enforcement: how this is wired into server.js ────────────────

test('the collection is claimed in COLLECTION_REGISTRY, or the migration would refuse it', () => {
  assert.match(DATA_MIGRATION, /key:\s*'client_upload_links'/);
});

test('the public routes carry no authenticateToken — that is the whole point of this door', () => {
  assert.match(SERVER, /app\.get\('\/api\/gfc\/upload\/:token',\s*async \(req, res\) => \{/);
  assert.match(SERVER, /app\.post\('\/api\/gfc\/upload\/:token',\s*async \(req, res\) => \{/);
});

test('the two management doors gate correctly: the client on their own record, staff admin-only', () => {
  assert.match(SERVER, /app\.post\('\/api\/gfc\/documents\/upload-link',\s*authenticateToken,\s*requireClientForIntake/);
  assert.match(SERVER, /app\.post\('\/api\/gfc\/documents\/upload-link\/revoke',\s*authenticateToken,\s*requireClientForIntake/);
  assert.match(SERVER, /app\.post\('\/api\/gfc\/admin\/enrollment\/:clientId\/documents\/upload-link',\s*authenticateToken,\s*requireAdmin/);
  assert.match(SERVER, /app\.post\('\/api\/gfc\/admin\/enrollment\/:clientId\/documents\/upload-link\/revoke',\s*authenticateToken,\s*requireAdmin/);
});

test('there is no read route behind a bare token — upload only, never a list or a file read', () => {
  // The only two ROUTES registered under /api/gfc/upload/:token are the
  // info GET and the submit POST asserted above. A third verb, or a nested
  // path like /api/gfc/upload/:token/file, would be a read channel this
  // door was never meant to have. (One more mention of the bare path is
  // expected — a comment on the static page route saying where it fetches.)
  const registrations = (SERVER.match(/app\.(get|post|put|delete)\('\/api\/gfc\/upload\/:token'/g) || []).length;
  assert.strictEqual(registrations, 2, `expected exactly the GET and the POST, found ${registrations} route registrations`);
});

test('a VISIT-scoped kind is refused on the public route by name', () => {
  assert.match(SERVER, /LINK_VISIT_DOCUMENT_NOT_ALLOWED/);
});

test('a per-clientId rate limit guards the public upload route', () => {
  const start = SERVER.indexOf("app.post('/api/gfc/upload/:token'");
  assert.notStrictEqual(start, -1);
  const body = SERVER.slice(start, start + 3000);
  assert.match(body, /uploadLinks\.rateLimited\(/);
});
