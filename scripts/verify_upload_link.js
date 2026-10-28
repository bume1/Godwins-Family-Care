#!/usr/bin/env node
/**
 * The branded, no-login upload link — HTTP round trip.
 *
 * Runs the REAL server and the REAL routes, in the same style as
 * verify_document_exchange.js: the KV store and HIPAA Drive are stubbed
 * (the two pieces unreachable from a build sandbox), everything else — auth,
 * gating, the token lookup, the rate limit, the checklist derivation — is
 * the shipped code path.
 *
 * Every assertion reads STORED STATE back through a route, never a status
 * code alone.
 *
 *   node scripts/verify_upload_link.js
 */
process.env.PORT = process.env.PORT || '4601';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'upload-link-verification-secret';
process.env.AUTO_CHANGELOG = 'false';
// Session 5.3: every JWT is a pointer to a server-side session row (`sid`),
// checked on every request — a hand-signed token with no `sid` is refused
// as AUTH_INVALID/token_predates_sessions. `tok()` below creates a real
// session row so this probe exercises the same path a real login does,
// rather than a shape of auth the app stopped accepting a session ago.
// MFA_ENFORCE=false is the documented dev/probe convenience (config.js);
// refused outright in production.
process.env.MFA_ENFORCE = 'false';

const path = require('path');
const crypto = require('crypto');
const Module = require('module');

// ── in-memory KV, standing in for Replit DB ─────────────────────────────
const STORE = new Map();
class MemDb {
  async get(k) { return STORE.has(k) ? JSON.parse(JSON.stringify(STORE.get(k))) : null; }
  async set(k, v) { STORE.set(k, JSON.parse(JSON.stringify(v))); return true; }
  async delete(k) { STORE.delete(k); return true; }
  async list(prefix) { return [...STORE.keys()].filter(k => !prefix || k.startsWith(prefix)); }
  async empty() { STORE.clear(); return true; }
}

// ── in-memory Drive ─────────────────────────────────────────────────────
const DRIVE = new Map();
let driveShouldFail = false;

const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@replit/database') return '__memdb__';
  return realResolve.call(this, request, ...rest);
};
require.cache['__memdb__'] = { id: '__memdb__', filename: '__memdb__', loaded: true, exports: MemDb };

const gdrivePath = require.resolve(path.join(__dirname, '..', 'googledrive.js'));
const gdrive = require(gdrivePath);
gdrive.uploadClientDocumentFile = async (clientName, fileName, buf, mime) => {
  if (driveShouldFail) throw new Error('simulated Drive outage');
  const id = `drv_${DRIVE.size + 1}`;
  DRIVE.set(id, { buf, mime, fileName });
  return { fileId: id, webViewLink: `https://drive.test/${id}`, webContentLink: null };
};
gdrive.uploadProviderROIFile = async (folder, fileName, buf) => {
  const id = `roi_${DRIVE.size + 1}`;
  DRIVE.set(id, { buf, mime: 'application/pdf', fileName });
  return { webViewLink: `https://drive.test/${id}` };
};

const jwt = require('jsonwebtoken');
const config = require(path.join(__dirname, '..', 'config.js'));

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// Seeds a real `auth_session:<sid>` row (sessionStore.js's own shape) and
// signs a token pointing at it, so authenticateToken's session check passes
// exactly as it would for a real login.
const tok = (u) => {
  const sid = crypto.randomBytes(24).toString('base64url');
  const at = new Date().toISOString();
  STORE.set(`auth_session:${sid}`, {
    id: sid, userId: u.id, role: u.role, createdAt: at, lastSeenAt: at,
    absoluteExpiresAt: null, revokedAt: null, revokedReason: null,
    ipHash: null, userAgent: null, mfaVerified: true, surface: 'verify'
  });
  return jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, sid }, process.env.JWT_SECRET, { expiresIn: '1h' });
};

// `token` here is a SESSION token (or none, for the public routes) — never
// confused with the upload-link's own token, which travels in the URL path.
const call = async (method, url, token, body) => {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: Object.assign(
      token ? { 'Authorization': `Bearer ${token}` } : {},
      body ? { 'Content-Type': 'application/json' } : {}
    ),
    body: body ? JSON.stringify(body) : undefined
  });
  const ct = res.headers.get('content-type') || '';
  const payload = ct.includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, body: payload, contentType: ct };
};

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  Buffer.alloc(64, 7)
]);
const b64 = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

const CLIENT = {
  id: 'ulk_client_1', role: config.ROLES.CLIENT, email: 'juanita@example.test',
  name: 'Juanita Guess', slug: 'juanita-guess', serviceLine: 'PHC',
  enrollmentStatus: 'intake_complete', consents: {}, consentMeta: {},
  intake: { firstName: 'Juanita', lastName: 'Guess', dob: '1950-03-04', address: '123 Secret Lane, Atlanta, GA 30301', phone: '404-555-0000' }
};
// requireClientForIntake (not requireEnrolledClient) gates the upload-link
// management routes, same as the client's own document upload — most of
// what this link is FOR is needed BEFORE enrollment is approved. This
// client stays at intake_pending to prove exactly that.
const PENDING_CLIENT = {
  id: 'ulk_client_pending', role: config.ROLES.CLIENT, email: 'pending@example.test',
  name: 'Not Yet Enrolled', slug: 'not-yet-enrolled', serviceLine: 'PHC',
  enrollmentStatus: 'intake_pending', consents: {}, consentMeta: {},
  intake: { firstName: 'Not', lastName: 'Enrolled' }
};
const OTHER = {
  id: 'ulk_client_2', role: config.ROLES.CLIENT, email: 'other@example.test',
  name: 'Other Client', slug: 'other-client', serviceLine: 'PHC',
  enrollmentStatus: 'enrolled', consents: {}, consentMeta: {}, intake: {}
};
const STAFF = { id: 'ulk_staff_1', role: config.ROLES.ADMIN, email: 'staff@example.test', name: 'Verification Staff' };

(async () => {
  STORE.set('users', [CLIENT, OTHER, STAFF, PENDING_CLIENT]);
  require(path.join(__dirname, '..', 'server.js'));
  await new Promise(r => setTimeout(r, 2500));

  const ct = tok(CLIENT), st = tok(STAFF), ot = tok(OTHER);

  console.log('\n── The static page route serves, unauthenticated ──');
  let page = await fetch(`${BASE}/upload/anything`);
  check('the branded page loads with no login', page.status === 200);
  check('and is the upload-link page, not a 404 fallthrough',
    (await page.text()).includes('Send a Document'));

  console.log('\n── No link exists yet ──');
  let r = await call('GET', '/api/gfc/documents', ct);
  check('a client with no link sees uploadLink: null', r.body.uploadLink === null, JSON.stringify(r.body.uploadLink));
  r = await call('GET', `/api/gfc/admin/enrollment/${CLIENT.id}/documents`, st);
  check('staff sees the same null, from the same field', r.body.uploadLink === null);

  console.log('\n── A made-up token is refused, never confused with "no link" ──');
  r = await call('GET', '/api/gfc/upload/deadbeef', null);
  check('an unknown token is 404, not 410 or 200', r.status === 404 && r.body.code === 'LINK_NOT_FOUND', JSON.stringify(r.body));
  r = await call('POST', '/api/gfc/upload/deadbeef', null, { kind: 'photoId', fileName: 'a.png', fileDataB64: b64(PNG) });
  check('and cannot be posted to either', r.status === 404);

  console.log('\n── The client generates their own link ──');
  r = await call('POST', '/api/gfc/documents/upload-link', ct);
  check('created', r.status === 200 && r.body.created === true, JSON.stringify(r.body));
  const url1 = r.body.link.url;
  check('the URL is absolute and points at /upload/', /^https?:\/\/.+\/upload\/[0-9a-f]{48}$/.test(url1), url1);
  const token1 = url1.split('/upload/')[1];

  r = await call('POST', '/api/gfc/documents/upload-link', ct);
  check('asking again returns the SAME link rather than minting a second one',
    r.status === 200 && r.body.created === false && r.body.link.url === url1, JSON.stringify(r.body));

  console.log('\n── The public info route: minimal identity, the real checklist, no PHI ──');
  r = await call('GET', `/api/gfc/upload/${token1}`, null);
  check('resolves', r.status === 200, JSON.stringify(r.body));
  check('first name only, never the full name string', r.body.firstName === 'Juanita' && !('name' in r.body), JSON.stringify(r.body));
  check('a last initial, not the full surname', r.body.lastInitial === 'G', r.body.lastInitial);
  check('org name for branding', r.body.orgName === config.BRAND.COMPANY_NAME);
  const raw = JSON.stringify(r.body);
  check('never leaks the client id', !raw.includes(CLIENT.id));
  check('never leaks an email address', !raw.includes('@'));
  const kinds = r.body.checklist.map(x => x.kind);
  check('a PHC client is asked for ID and insurance', kinds.includes('photoId') && kinds.includes('insuranceCard'), kinds.join(','));
  check('never offered a VISIT-scoped kind — this channel has no encounter context',
    !kinds.includes('dischargeSummary'), kinds.join(','));
  check('checklist rows carry no review state, only have/not', r.body.checklist.every(c => !('status' in c) && !('files' in c)));

  console.log('\n── The link works before enrollment is approved ──');
  const pt = tok(PENDING_CLIENT);
  r = await call('POST', '/api/gfc/documents/upload-link', pt);
  check('a client still at intake_pending can generate their own link',
    r.status === 200 && r.body.created === true, JSON.stringify(r.body));
  const pendingToken = r.body.link.url.split('/upload/')[1];
  r = await call('POST', `/api/gfc/upload/${pendingToken}`, null, { kind: 'photoId', fileName: 'id.png', fileDataB64: b64(PNG) });
  check('and someone can send a document through it — most of what this link is for is needed before approval',
    r.status === 200, JSON.stringify(r.body));

  console.log('\n── Uploading through the link, with no session at all ──');
  r = await call('POST', `/api/gfc/upload/${token1}`, null, { kind: 'photoId', fileName: 'license.png', fileDataB64: b64(PNG) });
  check('accepted with no Authorization header', r.status === 200, JSON.stringify(r.body));
  check('status is "received" — an anonymous submission still needs staff review, same as a logged-in client',
    r.body.document.status === 'received', r.body.document.status);
  const uploadId = r.body.document.id;

  r = await call('GET', `/api/gfc/upload/${token1}`, null);
  check('the checklist now shows it on file', r.body.checklist.find(c => c.kind === 'photoId').have === true);

  console.log('\n── It lands in the SAME store an authenticated upload uses ──');
  r = await call('GET', '/api/gfc/documents', ct);
  const row = (r.body.checklist || []).find(x => x.kind === 'photoId');
  check('the client\'s own portal sees it, exactly like their own upload would', row && row.status === 'received', JSON.stringify(row));
  r = await call('GET', `/api/gfc/admin/enrollment/${CLIENT.id}/documents`, st);
  check('staff sees it too, in the review queue', (r.body.awaitingReview || 0) >= 1, r.body.awaitingReview);

  console.log('\n── A per-visit document is refused on this channel ──');
  r = await call('POST', `/api/gfc/upload/${token1}`, null, { kind: 'dischargeSummary', fileName: 'ds.pdf', fileDataB64: b64(PNG) });
  check('refused by name, never silently filed against the standing file',
    r.status === 400 && r.body.code === 'LINK_VISIT_DOCUMENT_NOT_ALLOWED', JSON.stringify(r.body));

  console.log('\n── An unknown kind is refused, same rule as the authenticated route ──');
  r = await call('POST', `/api/gfc/upload/${token1}`, null, { kind: 'made_up_kind', fileName: 'a.png', fileDataB64: b64(PNG) });
  check('refused', r.status === 400 && r.body.code === 'DOCUMENT_KIND_UNKNOWN', JSON.stringify(r.body));

  console.log('\n── A Drive failure refuses the upload — no phantom row ──');
  driveShouldFail = true;
  r = await call('POST', `/api/gfc/upload/${token1}`, null, { kind: 'insuranceCard', fileName: 'card.png', fileDataB64: b64(PNG) });
  check('502, nothing recorded', r.status === 502 && r.body.code === 'DOCUMENT_STORAGE_UNAVAILABLE', JSON.stringify(r.body));
  driveShouldFail = false;
  r = await call('GET', `/api/gfc/upload/${token1}`, null);
  check('the checklist confirms nothing landed', r.body.checklist.find(c => c.kind === 'insuranceCard').have === false);

  console.log('\n── Regenerating tombstones the old token ──');
  r = await call('POST', '/api/gfc/documents/upload-link', ct, { regenerate: true });
  check('a new link is minted', r.status === 200 && r.body.created === true && r.body.link.url !== url1, JSON.stringify(r.body));
  const token2 = r.body.link.url.split('/upload/')[1];
  check('the two tokens are different', token2 !== token1);

  r = await call('GET', `/api/gfc/upload/${token1}`, null);
  check('the OLD token now answers 410, not 404 — it existed, it was turned off',
    r.status === 410 && r.body.code === 'LINK_REVOKED', JSON.stringify(r.body));
  r = await call('POST', `/api/gfc/upload/${token1}`, null, { kind: 'photoId', fileName: 'x.png', fileDataB64: b64(PNG) });
  check('and cannot be posted to either', r.status === 410);

  r = await call('GET', `/api/gfc/upload/${token2}`, null);
  check('the NEW token works and shows the document already sent',
    r.status === 200 && r.body.checklist.find(c => c.kind === 'photoId').have === true, JSON.stringify(r.body));

  console.log('\n── The client revokes their own link outright ──');
  r = await call('POST', '/api/gfc/documents/upload-link/revoke', ct);
  check('revoked', r.status === 200, JSON.stringify(r.body));
  r = await call('GET', `/api/gfc/upload/${token2}`, null);
  check('now 410', r.status === 410);
  r = await call('POST', '/api/gfc/documents/upload-link/revoke', ct);
  check('revoking again with nothing live is refused, not a silent 200',
    r.status === 404 && r.body.code === 'NO_ACTIVE_LINK', JSON.stringify(r.body));
  r = await call('GET', '/api/gfc/documents', ct);
  check('the client\'s own view confirms it is off', r.body.uploadLink === null);

  console.log('\n── Staff generate/revoke — admin only ──');
  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/documents/upload-link`, ct);
  check('a client cannot generate a link on the staff route', r.status === 403, String(r.status));
  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/documents/upload-link`, st);
  check('an admin can', r.status === 200 && r.body.created === true, JSON.stringify(r.body));
  const staffMinted = r.body.link.url.split('/upload/')[1];
  r = await call('GET', '/api/gfc/documents', ct);
  check('the CLIENT sees the link staff generated for them — one store, either door',
    r.body.uploadLink && r.body.uploadLink.url.endsWith(staffMinted), JSON.stringify(r.body.uploadLink));
  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/documents/upload-link/revoke`, st);
  check('staff revoke works', r.status === 200);
  r = await call('GET', `/api/gfc/upload/${staffMinted}`, null);
  check('and the token is dead', r.status === 410);

  console.log('\n── Another client\'s document link is never touched ──');
  r = await call('POST', '/api/gfc/documents/upload-link', ot);
  check('the other client mints their own', r.status === 200);
  r = await call('GET', '/api/gfc/documents', ct);
  check('the first client still has no link — regenerating one client\'s link never touches another\'s',
    r.body.uploadLink === null);

  console.log('\n── The rate limit ──');
  const uploadsNow = (await new MemDb().get('client_document_uploads')) || [];
  const flooded = uploadsNow.concat(Array.from({ length: 30 }, (_, i) => ({
    id: `flood_${i}`, clientId: CLIENT.id, kind: 'photoId', channel: 'link',
    uploadedAt: new Date().toISOString(), status: 'received'
  })));
  await new MemDb().set('client_document_uploads', flooded);
  r = await call('POST', '/api/gfc/documents/upload-link', ct);
  const freshUrl = r.body.link.url;
  const freshToken = freshUrl.split('/upload/')[1];
  r = await call('POST', `/api/gfc/upload/${freshToken}`, null, { kind: 'insuranceCard', fileName: 'c.png', fileDataB64: b64(PNG) });
  check('a 31st upload in the window is refused', r.status === 429 && r.body.code === 'LINK_RATE_LIMITED', JSON.stringify(r.body));

  console.log('\n── The activity trail ──');
  const log = (await new MemDb().get('activity_log')) || [];
  const actions = log.map(e => e.action);
  for (const a of ['client_upload_link_created', 'client_upload_link_regenerated', 'client_upload_link_revoked', 'client_document_uploaded_via_link']) {
    check(`${a} is audited`, actions.includes(a), actions.join(','));
  }
  const viaLink = log.find(e => e.action === 'client_document_uploaded_via_link');
  check('the anonymous upload is attributed to the LINK, not a real session', viaLink && viaLink.userId === null, JSON.stringify(viaLink));

  console.log('\n── The uploaded row itself carries provenance ──');
  const uploads = (await new MemDb().get('client_document_uploads')) || [];
  const linkRow = uploads.find(u => u.id === uploadId);
  check('channel: link, source: client — the client\'s own document, just without a session',
    linkRow && linkRow.channel === 'link' && linkRow.source === 'client', JSON.stringify(linkRow));
  check('status received, not accepted — an anonymous submission still gets reviewed',
    linkRow && linkRow.status === 'received');

  console.log('\n── Record release (Transfer-of-Care ROI) through the link ──');
  const roiBase = `/api/gfc/upload/${freshToken}/transfer-roi`;
  r = await call('GET', roiBase, null);
  check('the form info loads with no login', r.status === 200, JSON.stringify(r.body));
  const roiInfo = JSON.stringify(r.body);
  check('it reads nothing about the patient back — no DOB, no address, no providers',
    !roiInfo.includes('1950') && !roiInfo.includes('Secret') && !('priorProviders' in r.body) && !('patient' in r.body), roiInfo);
  check('it carries the record categories and who the records go to',
    Array.isArray(r.body.recordCategories) && r.body.releaseTo && r.body.releaseTo.fax);

  // A real 1x1 PNG padded past the validator's "a stroke was drawn" length (as verify_roi.js does).
  const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' + 'A'.repeat(120);
  const roiBody = (over) => Object.assign({
    patientName: 'Juanita Guess', patientDOB: '1950-03-04',
    providers: [{ name: 'Northside Hospital', dept: 'Medical Records', fax: '404-555-1234' }],
    categories: { hp: true, lab: true },
    signatureImageB64: SIG, printedName: 'Ada Guess', relationship: 'Daughter'
  }, over || {});
  const eventsBefore = ((await new MemDb().get('consent_events')) || []).length;

  r = await call('POST', `${roiBase}/submit`, null, roiBody({ patientDOB: '' }));
  check('a blank date of birth is a field error, not a wrong guess', r.status === 400 && r.body.code === 'ROI_508_INCOMPLETE', JSON.stringify(r.body));
  r = await call('POST', `${roiBase}/submit`, null, roiBody({ patientDOB: '1950-03-05' }));
  check('a wrong date of birth is refused', r.status === 400 && r.body.code === 'ROI_LINK_IDENTITY_MISMATCH', JSON.stringify(r.body));
  check('and the refusal does not say which part was wrong', !/birth.*wrong|name.*wrong/i.test(r.body.error));
  r = await call('POST', `${roiBase}/submit`, null, roiBody({ patientName: 'Somebody Else' }));
  check('a wrong name is refused the same way', r.status === 400 && r.body.code === 'ROI_LINK_IDENTITY_MISMATCH');
  check('nothing was filed by any refused attempt',
    ((await new MemDb().get('consent_events')) || []).length === eventsBefore);

  r = await call('POST', `${roiBase}/submit`, null, roiBody({ patientDOB: '03/04/1950' }));
  check('the right name and date of birth file the release', r.status === 200 && r.body.providerCount === 1, JSON.stringify(r.body).slice(0, 300));
  const copies = r.body.copies || [];
  check('the signer gets their copy back, a real PDF',
    copies.length === 1 && Buffer.from(copies[0].pdfB64, 'base64').subarray(0, 5).toString() === '%PDF-');
  const linkEventId = r.body.eventId;
  const linkEvent = ((await new MemDb().get('consent_events')) || []).find(e => e.id === linkEventId);
  check('stored as an online-form release that came through the link',
    linkEvent && linkEvent.source === 'portal_online_form' && linkEvent.channel === 'link', JSON.stringify(linkEvent && { s: linkEvent.source, c: linkEvent.channel }));
  check('the record\'s name and DOB print; the record\'s address and phone do NOT (only what was typed)',
    linkEvent && linkEvent.patient_snapshot.patientName === 'Juanita Guess' && linkEvent.patient_snapshot.patientDOB === '1950-03-04'
      && !linkEvent.patient_snapshot.patientAddress && !linkEvent.patient_snapshot.patientPhone, JSON.stringify(linkEvent && linkEvent.patient_snapshot));
  const afterUsers = await new MemDb().get('users');
  const afterClient = afterUsers.find(u => u.id === CLIENT.id);
  check('the client\'s release status is now signed', afterClient.consents.roiTransfer === 'signed');
  check('the provider joined the client\'s prior-provider list',
    (afterClient.priorProviders || []).some(p => p.name === 'Northside Hospital'));

  r = await call('GET', '/api/gfc/transfer-roi', ct);
  check('ONE store, either door: the signed-in client sees the link release in the portal',
    r.status === 200 && r.body.authorizations.some(a => a.providerName === 'Northside Hospital'), JSON.stringify(r.body.authorizations));

  r = await call('POST', `${roiBase}/upload`, null, { fileName: 'release.png', fileDataB64: b64(PNG), patientName: 'Juanita Guess', patientDOB: '1950-03-04' });
  check('a signed scan can be sent through the link too', r.status === 200, JSON.stringify(r.body));
  const scanEvent = ((await new MemDb().get('consent_events')) || []).find(e => e.id === r.body.eventId);
  check('stored as an upload that came through the link', scanEvent && scanEvent.source === 'portal_upload' && scanEvent.channel === 'link');
  r = await call('POST', `${roiBase}/upload`, null, { fileName: 'release.png', fileDataB64: b64(PNG), patientName: 'Juanita Guess', patientDOB: '1951-01-01' });
  check('a scan with the wrong date of birth is refused too', r.status === 400 && r.body.code === 'ROI_LINK_IDENTITY_MISMATCH');

  console.log('\n── The signed-in portal release still works after the refactor ──');
  r = await call('POST', '/api/gfc/transfer-roi/submit', ct, roiBody({ providers: [{ name: 'Piedmont Clinic', fax: '404-555-9999' }] }));
  check('portal submit files', r.status === 200 && r.body.providerCount === 1, JSON.stringify(r.body).slice(0, 300));
  check('and returns no inline copies (the portal has its own download)', !('copies' in r.body));
  const portalEvent = ((await new MemDb().get('consent_events')) || []).find(e => e.id === r.body.eventId);
  check('stored with channel portal, and the record address prints as before',
    portalEvent && portalEvent.channel === 'portal' && /Secret Lane/.test(portalEvent.patient_snapshot.patientAddress || ''), JSON.stringify(portalEvent && portalEvent.patient_snapshot));

  console.log('\n── Wrong guesses lock the link\'s release form for the day ──');
  // Three wrong guesses so far (two on the form, one on the scan).
  r = await call('POST', `${roiBase}/submit`, null, roiBody({ patientDOB: '1940-01-01' }));
  r = await call('POST', `${roiBase}/submit`, null, roiBody({ patientDOB: '1940-01-02' }));
  check('the fifth wrong guess is still answered as a mismatch', r.status === 400 && r.body.code === 'ROI_LINK_IDENTITY_MISMATCH', JSON.stringify(r.body));
  r = await call('POST', `${roiBase}/submit`, null, roiBody());
  check('after five, even the RIGHT answer is refused, so the lock cannot be used as an oracle',
    r.status === 429 && r.body.code === 'ROI_LINK_LOCKED', JSON.stringify(r.body));
  r = await call('POST', `/api/gfc/upload/${freshToken}`, null, { kind: 'insuranceCard', fileName: 'c.png', fileDataB64: b64(PNG) });
  check('the lock is on the release form only; the document checklist answers as before', r.status === 429 && r.body.code === 'LINK_RATE_LIMITED');

  r = await call('POST', '/api/gfc/documents/upload-link/revoke', ct);
  r = await call('GET', roiBase, null);
  check('a turned-off link answers 410 on the release form as well', r.status === 410);
  r = await call('POST', `${roiBase}/submit`, null, roiBody());
  check('and cannot file one', r.status === 410);

  const roiLog = ((await new MemDb().get('activity_log')) || []).find(e => e.action === 'roi_transfer_signed' && e.details && e.details.channel === 'link');
  check('the link release is audited and attributed to the link, not a session', roiLog && roiLog.userId === null, JSON.stringify(roiLog));

  console.log(`\n${pass}/${pass + fail} checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
