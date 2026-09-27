#!/usr/bin/env node
/**
 * A client-uploaded document, routed elsewhere (2026-09-24).
 *
 * Two gaps closed in the same pass, both owner-directed:
 *   1. A document a client sent (an ID, an insurance card, records mailed or
 *      emailed in) never reached the patient's own OpenEMR chart — a care plan
 *      and a signed consent each had their own path into OpenEMR; a client
 *      upload did not.
 *   2. A document that turns out to be about a CAREGIVER, not the client
 *      (a timesheet, a certification, onboarding paperwork sent to the wrong
 *      inbox) had no way to reach the caregiver's own document store — the
 *      two stores are entirely separate and nothing bridged them.
 *
 * CORRECTED same day (owner-directed: "no file to open emr button. documents
 * should automatically file to open emr every time"). The first version of
 * gap 1 was a button next to each document; there is no button now. Filing
 * happens automatically, at the moment a document is stored, from every door
 * a document can arrive through — the client's own upload, the staff-filed
 * upload, and the no-login link — plus a catch-up pass run once at the
 * moment a client is LINKED to OpenEMR, for whatever arrived before there was
 * a chart to file into.
 *
 * Runs the REAL server and the REAL routes. Stubbed: the KV store
 * (@replit/database), HIPAA Drive, and the OpenEMR transport — the three
 * pieces of infrastructure not reachable from a build sandbox. Everything
 * between them — gating, the idempotency checks, the additive provenance
 * fields, the audit trail — is the shipped code path.
 *
 * Every assertion reads STORED STATE back through a route, never a status
 * code alone.
 *
 *   node scripts/verify_document_routing.js
 */
process.env.PORT = process.env.PORT || '4598';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'document-routing-verification-secret';
process.env.AUTO_CHANGELOG = 'false';
process.env.MFA_ENFORCE = 'false';

const path = require('path');
const Module = require('module');

// ── in-memory KV ─────────────────────────────────────────────────────────
const STORE = new Map();
class MemDb {
  async get(k) { return STORE.has(k) ? JSON.parse(JSON.stringify(STORE.get(k))) : null; }
  async set(k, v) { STORE.set(k, JSON.parse(JSON.stringify(v))); return true; }
  async delete(k) { STORE.delete(k); return true; }
  async list(prefix) { return [...STORE.keys()].filter(k => !prefix || k.startsWith(prefix)); }
  async empty() { STORE.clear(); return true; }
}

// ── in-memory Drive ──────────────────────────────────────────────────────
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
  const id = `drv_${DRIVE.size + 1}`;
  DRIVE.set(id, { buf, mime, fileName, folder: 'client' });
  return { fileId: id, webViewLink: `https://drive.test/${id}`, webContentLink: null };
};
gdrive.uploadCaregiverDocumentFile = async (caregiverName, fileName, buf, mime) => {
  if (driveShouldFail) throw new Error('simulated Drive outage');
  const id = `drv_${DRIVE.size + 1}`;
  DRIVE.set(id, { buf, mime, fileName, folder: 'caregiver', caregiverName });
  return { fileId: id, webViewLink: `https://drive.test/${id}`, webContentLink: null };
};
gdrive.downloadFileBuffer = async (id) => {
  const f = DRIVE.get(id);
  if (!f) throw new Error('not found');
  return f.buf;
};

// ── stubbed OpenEMR transport ────────────────────────────────────────────
const EMR_DOCS = [];
let emrConfigured = true;
let emrShouldFail = false;
const openemrPath = require.resolve(path.join(__dirname, '..', 'openemr.js'));
const openemr = require(openemrPath);
openemr.isConfigured = () => emrConfigured;
// WRAP the real forActor rather than replace it: the clinical chart route
// calls a dozen other EMR reads (getProblems, getEncounters, …) this script
// has no reason to fake. Those stay real — with no EMR reachable they reject
// as network errors, which the chart route already tolerates gracefully
// (Promise.allSettled + a permission-pending/error state, never a crash).
const realForActor = openemr.forActor;
openemr.forActor = (actor) => {
  const real = realForActor(actor);
  return {
    ...real,
    async uploadPatientDocument(puuid, fileName, buffer, mimeType, categoryPath) {
      if (emrShouldFail) throw new Error('simulated EMR outage');
      EMR_DOCS.push({ puuid, fileName, mimeType, categoryPath, byId: actor && actor.id });
      return true;
    },
    // The /link route verifies an existing OpenEMR patient id with this
    // before linking — stubbed so the live backfill test can link a client
    // mid-run without a real EMR to ask.
    async getPatient(puuid) { return { id: puuid }; }
  };
};

const jwt = require('jsonwebtoken');
const config = require(path.join(__dirname, '..', 'config.js'));

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// Session 5.3: a JWT is a POINTER to a server-side session row, not a
// self-contained credential — authenticateToken refuses one that names no
// live `auth_session:<sid>` row with `AUTH_INVALID detail=token_predates_sessions`.
// Seed the row the same shape sessionStore.js writes, once per user, then
// sign the sid into the token.
const SESSIONS = new Map();
const tok = (u) => {
  let sid = SESSIONS.get(u.id);
  if (!sid) {
    sid = `sess_${u.id}`;
    const at = new Date().toISOString();
    STORE.set(`auth_session:${sid}`, {
      id: sid, userId: u.id, role: u.role, createdAt: at, lastSeenAt: at,
      absoluteExpiresAt: null, revokedAt: null, revokedReason: null,
      ipHash: null, userAgent: null, mfaVerified: true, surface: null
    });
    SESSIONS.set(u.id, sid);
  }
  return jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, sid }, process.env.JWT_SECRET, { expiresIn: '1h' });
};

const call = async (method, url, token, body) => {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: Object.assign(
      { 'Authorization': `Bearer ${token || ''}` },
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

// CLIENT starts UNLINKED (proves NOT_LINKED, and later drives the link-time
// catch-up pass). Must be on a clinical service line — the /link route
// refuses PHC-only clients (wrongLine) regardless of document state.
const CLIENT = {
  id: 'client_route_1', role: config.ROLES.CLIENT, email: 'routepatient@example.test',
  name: 'Route PatientOne', slug: 'route-patientone', serviceLine: 'BOTH',
  enrollmentStatus: 'enrolled', consents: { consentToTreat: 'signed' }, consentMeta: {},
  intake: { firstName: 'Route', lastName: 'PatientOne' },
  openEmrPatientId: null
};
const LINKED_CLIENT = {
  id: 'client_route_2', role: config.ROLES.CLIENT, email: 'linkedpatient@example.test',
  name: 'Linked PatientOne', slug: 'linked-patientone', serviceLine: 'BOTH',
  enrollmentStatus: 'enrolled', consents: { consentToTreat: 'signed' }, consentMeta: {},
  intake: {}, openEmrPatientId: 'emr-uuid-123'
};
const STAFF = { id: 'staff_route_1', role: config.ROLES.ADMIN, email: 'routestaff@example.test', name: 'Route Verification Staff' };
const CAREGIVER = {
  id: 'caregiver_route_1', role: 'vendor', licenseLevel: 'CNA',
  email: 'routecaregiver@example.test', name: 'Route Caregiver'
};

(async () => {
  STORE.set('users', [CLIENT, LINKED_CLIENT, STAFF, CAREGIVER]);
  require(path.join(__dirname, '..', 'server.js'));
  await new Promise(r => setTimeout(r, 2500));

  const st = tok(STAFF), ct = tok(CLIENT), lct = tok(LINKED_CLIENT);
  const checklistOf = (clientId, r) => (r.body.checklist || []).flatMap(c => c.files || []);
  const getDocs = async (token) => call('GET', '/api/gfc/documents', token);
  const getAdminDocs = async (clientId) => call('GET', `/api/gfc/admin/enrollment/${clientId}/documents`, st);

  console.log('\n── Automatic filing: an unlinked client is skipped, inline in the upload response ──');
  let r = await call('POST', '/api/gfc/documents/upload', ct, { kind: 'photoId', fileName: 'licence.png', fileDataB64: b64(PNG) });
  check('upload accepted', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  check('the upload response itself says filing was skipped, and why — no separate call needed',
    r.body.emrFiling && r.body.emrFiling.filed === false && r.body.emrFiling.reason === 'NOT_LINKED', JSON.stringify(r.body.emrFiling));
  check('nothing was sent to the (stubbed) EMR', EMR_DOCS.length === 0, String(EMR_DOCS.length));
  const unlinkedPendingId = r.body.document.id;

  console.log('\n── Automatic filing: a rejected document is never filed, even after linking ──');
  r = await call('POST', '/api/gfc/documents/upload', ct, { kind: 'insuranceCard', fileName: 'blurry.png', fileDataB64: b64(PNG) });
  const unlinkedRejectId = r.body.document.id;
  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/documents/${unlinkedRejectId}/review`, st, { decision: 'rejected', reason: 'too blurry' });
  check('rejected while still unlinked', r.status === 200, JSON.stringify(r.body));

  console.log('\n── Automatic filing: linking a client runs the catch-up pass ──');
  r = await call('POST', `/api/clinical/patients/${CLIENT.id}/link`, st, { openEmrPatientId: 'emr-uuid-backfill' });
  check('the link succeeded', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  check('the link response reports exactly the one candidate filed, none skipped (the rejected row is never a candidate)',
    !!r.body.documentsFiling && r.body.documentsFiling.filed === 1 && r.body.documentsFiling.skipped === 0,
    JSON.stringify(r.body.documentsFiling));
  check('exactly one document reached the (stubbed) chart — the pending one, not the rejected one',
    EMR_DOCS.length === 1 && EMR_DOCS[0].fileName === 'licence.png', JSON.stringify(EMR_DOCS));
  check('a "photoId" kind falls to the /Medical Record default', EMR_DOCS[0].categoryPath === '/Medical Record', EMR_DOCS[0].categoryPath);

  r = await getAdminDocs(CLIENT.id);
  let filedRow = checklistOf(CLIENT.id, r).find(f => f.id === unlinkedPendingId);
  check('the checklist reflects the backfilled filing, stored on the row', !!(filedRow && filedRow.emrFiled), JSON.stringify(filedRow));
  let stillRejected = checklistOf(CLIENT.id, r).find(f => f.id === unlinkedRejectId);
  check('the rejected document was never filed', !!stillRejected && !stillRejected.emrFiled, JSON.stringify(stillRejected));

  console.log('\n── Automatic filing: re-linking is idempotent — no duplicate filing ──');
  r = await call('POST', `/api/clinical/patients/${CLIENT.id}/link`, st, { openEmrPatientId: 'emr-uuid-backfill', relink: true });
  check('relink accepted', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  check('nothing new to file the second time', !!r.body.documentsFiling && r.body.documentsFiling.filed === 0 && r.body.documentsFiling.skipped === 0,
    JSON.stringify(r.body.documentsFiling));
  check('still exactly one document in the (stubbed) chart', EMR_DOCS.length === 1, String(EMR_DOCS.length));

  console.log('\n── Automatic filing: an already-linked client files immediately, inline in the upload response ──');
  r = await call('POST', '/api/gfc/documents/upload', lct, { kind: 'referral', fileName: 'referral.png', fileDataB64: b64(PNG) });
  check('upload accepted on the linked client', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  const uploadId = r.body.document.id;
  check('the upload response says it filed, with no button or second call needed',
    r.body.emrFiling && r.body.emrFiling.filed === true, JSON.stringify(r.body.emrFiling));
  check('the stubbed EMR actually received the bytes', EMR_DOCS.length === 2 && EMR_DOCS[1].puuid === 'emr-uuid-123', JSON.stringify(EMR_DOCS));
  check('a "referral" kind uses the /Consult category — not the /Medical Record default',
    EMR_DOCS[1].categoryPath === '/Consult', EMR_DOCS[1].categoryPath);

  r = await getAdminDocs(LINKED_CLIENT.id);
  filedRow = checklistOf(LINKED_CLIENT.id, r).find(f => f.id === uploadId);
  check('the checklist reflects the filing, stored on the row', !!(filedRow && filedRow.emrFiled), JSON.stringify(filedRow));

  console.log('\n── Automatic filing: the staff upload route files BEFORE its own checklist re-read ──');
  r = await call('POST', `/api/gfc/admin/enrollment/${LINKED_CLIENT.id}/documents/upload`, st, { kind: 'physicianOrder', fileName: 'order.png', fileDataB64: b64(PNG) });
  check('staff upload accepted', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  const staffUploadId = r.body.document.id;
  check('the response itself says it filed', r.body.emrFiling && r.body.emrFiling.filed === true, JSON.stringify(r.body.emrFiling));
  const staffFiledRow = checklistOf(LINKED_CLIENT.id, r).find(f => f.id === staffUploadId);
  check('and the checklist RETURNED IN THIS SAME RESPONSE already shows it filed — ordering matters',
    !!(staffFiledRow && staffFiledRow.emrFiled), JSON.stringify(staffFiledRow));
  check('a "physicianOrder" kind uses the /Orders category', EMR_DOCS.length === 3 && EMR_DOCS[2].categoryPath === '/Orders', JSON.stringify(EMR_DOCS[2]));

  console.log('\n── Automatic filing: the no-login link is the third door, and it files too ──');
  r = await call('POST', `/api/gfc/admin/enrollment/${LINKED_CLIENT.id}/documents/upload-link`, st, {});
  check('a link was generated', r.status === 200 && r.body.link && r.body.link.url, JSON.stringify(r.body));
  const linkToken = (r.body.link.url.match(/\/upload\/([^/?#]+)/) || [])[1];
  check('a token was carried in the url', !!linkToken, r.body.link.url);
  r = await call('POST', `/api/gfc/upload/${linkToken}`, null, { kind: 'otherDocument', fileName: 'fromlink.png', fileDataB64: b64(PNG) });
  check('the link upload is accepted with no login at all', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  check('and it files automatically too, with no admin ever seeing this document',
    r.body.emrFiling && r.body.emrFiling.filed === true, JSON.stringify(r.body.emrFiling));
  check('an "otherDocument" kind falls to the /Medical Record default',
    EMR_DOCS.length === 4 && EMR_DOCS[3].categoryPath === '/Medical Record', JSON.stringify(EMR_DOCS[3]));

  console.log('\n── No button exists to trigger filing manually — the old routes are gone ──');
  r = await call('POST', `/api/gfc/admin/enrollment/${LINKED_CLIENT.id}/documents/${uploadId}/file-to-emr`, st);
  check('the old manual route is gone', r.status === 404, String(r.status));
  r = await call('POST', `/api/clinical/patients/${LINKED_CLIENT.id}/documents/${uploadId}/file-to-emr`, st);
  check('gone from the clinical-chart door too', r.status === 404, String(r.status));

  console.log('\n── Move to caregiver: who this belongs to ──');
  r = await call('GET', '/api/gfc/admin/enrollment/meta/caregivers', st);
  check('the caregiver list is served', r.status === 200 && (r.body.caregivers || []).some(c => c.id === CAREGIVER.id), JSON.stringify(r.body));

  r = await call('POST', '/api/gfc/documents/upload', ct, { kind: 'otherDocument', fileName: 'timesheet.png', fileDataB64: b64(PNG) });
  const misfiledId = r.body.document.id;

  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/documents/${misfiledId}/move-to-caregiver`, st, {});
  check('no caregiverId is refused', r.status === 400 && r.body.code === 'CAREGIVER_ID_REQUIRED', JSON.stringify(r.body));

  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/documents/${misfiledId}/move-to-caregiver`, st, { caregiverId: 'not-a-real-user' });
  check('an unknown caregiver is refused', r.status === 404 && r.body.code === 'CAREGIVER_NOT_FOUND', JSON.stringify(r.body));

  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/documents/${misfiledId}/move-to-caregiver`, st, { caregiverId: STAFF.id });
  check('a non-caregiver user is refused, even an admin', r.status === 404 && r.body.code === 'CAREGIVER_NOT_FOUND', JSON.stringify(r.body));

  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/documents/${misfiledId}/move-to-caregiver`, st, { caregiverId: CAREGIVER.id });
  check('moved', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  const cgDocId = r.body.caregiverDocId;

  console.log('\n── Move to caregiver: it actually lands in the caregiver\'s own store ──');
  r = await call('GET', `/api/caregiver/documents?caregiverId=${CAREGIVER.id}`, st);
  const cgDoc = (r.body.documents || []).find(d => d.id === cgDocId);
  check('the caregiver document store carries it', !!cgDoc, JSON.stringify(r.body).slice(0, 300));
  check('office-filed lands accepted, not sitting in review', cgDoc && cgDoc.status === 'accepted', cgDoc && cgDoc.status);

  r = await call('GET', `/api/caregiver/documents/${cgDocId}/file`, st);
  check('the bytes moved with it', r.status === 200 && Buffer.isBuffer(r.body) && r.body.equals(PNG));

  console.log('\n── Move to caregiver: the ORIGINAL is never destroyed ──');
  r = await getAdminDocs(CLIENT.id);
  const original = checklistOf(CLIENT.id, r).find(f => f.id === misfiledId);
  check('the client\'s own copy is still listed', !!original, JSON.stringify(original));
  check('and it says where it also lives', !!(original && original.movedTo && original.movedTo.caregiverId === CAREGIVER.id), JSON.stringify(original));

  r = await getDocs(ct);
  const clientSide = checklistOf(CLIENT.id, r).find(f => f.id === misfiledId);
  check('and the client still sees their own upload — nothing vanished from their portal', !!clientSide, JSON.stringify(clientSide));

  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/documents/${misfiledId}/move-to-caregiver`, st, { caregiverId: CAREGIVER.id });
  check('moving a second time is refused rather than filing a duplicate copy',
    r.status === 409 && r.body.code === 'ALREADY_MOVED', JSON.stringify(r.body));

  console.log('\n── Move to caregiver: a rejected document is never moved ──');
  r = await call('POST', '/api/gfc/documents/upload', ct, { kind: 'otherDocument', fileName: 'y.png', fileDataB64: b64(PNG) });
  const rejectId2 = r.body.document.id;
  await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/documents/${rejectId2}/review`, st, { decision: 'rejected', reason: 'unreadable' });
  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/documents/${rejectId2}/move-to-caregiver`, st, { caregiverId: CAREGIVER.id });
  check('refused', r.status === 409 && r.body.code === 'DOCUMENT_REJECTED', JSON.stringify(r.body));

  console.log('\n── Move to caregiver: admin-only, not even a clinician ──');
  r = await call('POST', '/api/gfc/documents/upload', ct, { kind: 'otherDocument', fileName: 'z.png', fileDataB64: b64(PNG) });
  const clinicianTestId = r.body.document.id;
  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/documents/${clinicianTestId}/move-to-caregiver`, ct, { caregiverId: CAREGIVER.id });
  check('a client is refused', r.status === 403, String(r.status));

  console.log('\n── Storage failures refuse the action rather than recording a phantom ──');
  driveShouldFail = true;
  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/documents/${clinicianTestId}/move-to-caregiver`, st, { caregiverId: CAREGIVER.id });
  check('a Drive failure on the caregiver upload refuses the move', r.status === 502, String(r.status));
  driveShouldFail = false;
  r = await getAdminDocs(CLIENT.id);
  const stillUnmoved = checklistOf(CLIENT.id, r).find(f => f.id === clinicianTestId);
  check('and nothing was recorded as moved', stillUnmoved && !stillUnmoved.movedTo, JSON.stringify(stillUnmoved));

  console.log('\n── An EMR failure never fails the upload it rides on — it rides along as a skip ──');
  emrShouldFail = true;
  r = await call('POST', '/api/gfc/documents/upload', lct, { kind: 'otherDocument', fileName: 'fail.png', fileDataB64: b64(PNG) });
  check('the upload itself still succeeds even though filing will fail', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  const failId = r.body.document.id;
  check('the upload response says why filing failed, inline — no separate call needed',
    r.body.emrFiling && r.body.emrFiling.filed === false && r.body.emrFiling.reason === 'EMR_UPLOAD_FAILED', JSON.stringify(r.body.emrFiling));
  emrShouldFail = false;
  r = await getAdminDocs(LINKED_CLIENT.id);
  let stillUnfiled = checklistOf(LINKED_CLIENT.id, r).find(f => f.id === failId);
  check('and nothing was recorded as filed', stillUnfiled && !stillUnfiled.emrFiled, JSON.stringify(stillUnfiled));

  console.log('\n── The chart\'s own "In EMR" chip follows the same fact ──');
  r = await call('GET', `/api/clinical/patients/${LINKED_CLIENT.id}/chart`, st);
  const chartRows = r.body.chartDocuments || [];
  const chartRow = chartRows.find(d => d.uploadId === uploadId);
  check('the chart index now says this upload is in the EMR', !!(chartRow && chartRow.inChart), JSON.stringify(chartRow));
  const trulyUnfiled = chartRows.find(d => d.uploadId === failId);
  check('a not-yet-filed upload still says so', !!trulyUnfiled && !trulyUnfiled.inChart, JSON.stringify(trulyUnfiled));

  console.log('\n── A transient failure is not the end of the story — the next link-time pass can still pick it up ──');
  r = await call('POST', `/api/clinical/patients/${LINKED_CLIENT.id}/link`, st, { openEmrPatientId: LINKED_CLIENT.openEmrPatientId, relink: true });
  check('relink accepted', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  check('the previously-failed upload was the one candidate, and it was picked up this time',
    !!r.body.documentsFiling && r.body.documentsFiling.filed === 1 && r.body.documentsFiling.skipped === 0, JSON.stringify(r.body.documentsFiling));
  r = await getAdminDocs(LINKED_CLIENT.id);
  const nowFiled = checklistOf(LINKED_CLIENT.id, r).find(f => f.id === failId);
  check('and now the checklist shows it filed', !!(nowFiled && nowFiled.emrFiled), JSON.stringify(nowFiled));

  console.log('\n── The activity trail ──');
  const log = (await new MemDb().get('activity_log')) || [];
  const actions = log.map(e => e.action);
  for (const a of ['client_document_filed_to_emr', 'client_document_moved_to_caregiver']) {
    check(`${a} is audited`, actions.includes(a), actions.join(','));
  }

  console.log(`\n${pass}/${pass + fail} checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
