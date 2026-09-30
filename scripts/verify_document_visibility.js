#!/usr/bin/env node
/**
 * Who sees a client document, and removing one (owner, 2026-09-29).
 *
 *   - The patient sees what they sent, plus anything the office filed that a
 *     staff member deliberately shared. Nothing else.
 *   - Admin or manager can remove an uploaded file, with a reason. It leaves
 *     every screen; who, when and why stay on the row. An OpenEMR copy stays in
 *     OpenEMR (its API cannot delete one) and the reply says so.
 *
 * Runs the REAL server and routes. Stubbed: the KV store, Drive and the OpenEMR
 * transport. Assertions read stored state back through the routes.
 *
 *   node scripts/verify_document_visibility.js
 */
process.env.PORT = process.env.PORT || '4611';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'document-visibility-verification-secret';
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

const CLIENT = {
  id: 'client_vis_1', role: config.ROLES.CLIENT, email: 'vispatient@example.test',
  name: 'Vis PatientOne', slug: 'vis-patientone', serviceLine: 'BOTH',
  enrollmentStatus: 'enrolled', consents: { consentToTreat: 'signed' }, consentMeta: {},
  intake: { firstName: 'Vis', lastName: 'PatientOne' }, openEmrPatientId: 'emr-vis-1'
};
const ADMIN = { id: 'admin_vis_1', role: config.ROLES.ADMIN, email: 'visadmin@example.test', name: 'Vis Admin' };
const MANAGER = { id: 'mgr_vis_1', role: 'user', isManager: true, email: 'vismgr@example.test', name: 'Vis Manager' };
const CLINICIAN = {
  id: 'rn_vis_1', role: 'user', hasClinicalAccess: true, clinicalRole: 'rn', clinicalRoleConfirmed: true,
  email: 'visrn@example.test', name: 'Vis Nurse'
};
const CASE_MANAGER = { id: 'cm_vis_1', role: 'caseManager', email: 'viscm@example.test', name: 'Vis Case Manager' };

(async () => {
  STORE.set('users', [CLIENT, ADMIN, MANAGER, CLINICIAN, CASE_MANAGER]);
  require(path.join(__dirname, '..', 'server.js'));
  await new Promise(r => setTimeout(r, 2500));

  const at = tok(ADMIN), mt = tok(MANAGER), rt = tok(CLINICIAN), cmt = tok(CASE_MANAGER), ct = tok(CLIENT);
  const P = `/api/gfc/admin/enrollment/${CLIENT.id}/documents`;
  const staffFiles = async () => ((await call('GET', P, at)).body.checklist || []).flatMap(c => c.files || []);
  const patientFiles = async () => ((await call('GET', '/api/gfc/documents', ct)).body.checklist || []).flatMap(c => c.files || []);
  const patientChart = async () => (await call('GET', '/api/gfc/clinical/documents', ct)).body.documents || [];

  console.log('\n── One document the client sent, one the office filed ──');
  let r = await call('POST', '/api/gfc/documents/upload', ct, { kind: 'photoId', fileName: 'my-licence.png', fileDataB64: b64(PNG) });
  check('the client uploads their own', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  const ownId = r.body.document && r.body.document.id;
  r = await call('POST', `${P}/upload`, at, { kind: 'priorRecords', fileName: 'medical-summary.png', fileDataB64: b64(PNG) });
  check('the office files one', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  const staffId = r.body.document && r.body.document.id;

  console.log('\n── What the patient sees ──');
  let pf = await patientFiles();
  check('the patient\'s checklist lists their own upload', pf.some(f => f.id === ownId));
  check('the patient\'s checklist does NOT list the office-filed one', !pf.some(f => f.id === staffId), JSON.stringify(pf.map(f => f.fileName)));
  const cl = (await call('GET', '/api/gfc/documents', ct)).body.checklist || [];
  const rec = cl.find(c => c.kind === 'priorRecords');
  check('the item still reads as on file, so the patient is not chased for it', rec && rec.status === 'accepted', JSON.stringify(rec));
  let pc = await patientChart();
  check('the patient\'s record lists their own upload as "You sent this"',
    pc.some(d => d.uploadId === ownId && d.category === 'You sent this'), JSON.stringify(pc.map(d => [d.title, d.category])));
  check('the patient\'s record does not list the office-filed one', !pc.some(d => d.uploadId === staffId));
  r = await call('GET', `/api/gfc/documents/uploads/${staffId}/file`, ct);
  check('the patient cannot open the office-filed one directly (404, not 403)', r.status === 404, String(r.status));
  r = await call('GET', `/api/gfc/clinical/documents/${encodeURIComponent('upload:' + staffId)}/file`, ct);
  check('nor through the record route', r.status === 404, String(r.status));
  r = await call('GET', `/api/gfc/documents/uploads/${ownId}/file`, ct);
  check('the patient still opens their own', r.status === 200, String(r.status));

  console.log('\n── What staff see ──');
  let sf = await staffFiles();
  const staffRow = sf.find(f => f.id === staffId);
  check('staff see who filed it and that it is hidden', staffRow && staffRow.source === 'staff' && staffRow.sharedWithPatient === false, JSON.stringify(staffRow));
  const ownRow = sf.find(f => f.id === ownId);
  check('staff see the client\'s own as sent by the client and visible to them', ownRow && ownRow.source === 'client' && ownRow.sharedWithPatient === true, JSON.stringify(ownRow));
  r = await call('GET', P, at);
  check('an admin is told they may remove and share', r.body.access && r.body.access.canRemove === true && r.body.access.canShare === true, JSON.stringify(r.body.access));
  r = await call('GET', P, cmt);
  check('a case manager may do neither', r.body.access && r.body.access.canRemove === false && r.body.access.canShare === false, JSON.stringify(r.body.access));

  console.log('\n── Sharing ──');
  r = await call('PUT', `${P}/${staffId}/share`, cmt, { shared: true });
  check('a case manager cannot share', r.status === 403, String(r.status));
  r = await call('PUT', `${P}/${staffId}/share`, rt, { shared: 'yes' });
  check('the flag must be true or false', r.status === 400 && r.body.code === 'SHARE_FLAG_REQUIRED', JSON.stringify(r.body));
  r = await call('PUT', `${P}/${ownId}/share`, rt, { shared: false });
  check('the client\'s own upload cannot be hidden from them', r.status === 409 && r.body.code === 'CLIENT_OWN_DOCUMENT', JSON.stringify(r.body));
  r = await call('PUT', `${P}/${staffId}/share`, rt, { shared: true });
  check('a clinician shares the office-filed one', r.status === 200 && r.body.sharedWithPatient === true, JSON.stringify(r.body));
  pc = await patientChart();
  check('the patient now sees it, as "From your care team"',
    pc.some(d => d.uploadId === staffId && d.category === 'From your care team'), JSON.stringify(pc.map(d => [d.title, d.category])));
  r = await call('GET', `/api/gfc/documents/uploads/${staffId}/file`, ct);
  check('and can open it', r.status === 200, String(r.status));
  r = await call('PUT', `${P}/${staffId}/share`, mt, { shared: false });
  check('a manager hides it again', r.status === 200 && r.body.sharedWithPatient === false, JSON.stringify(r.body));
  pf = await patientFiles();
  check('and it is gone from the patient\'s view', !pf.some(f => f.id === staffId));

  console.log('\n── Removing ──');
  r = await call('POST', `${P}/${ownId}/remove`, rt, { reason: 'duplicate' });
  check('a clinician cannot remove', r.status === 403 && r.body.code === 'DOCUMENT_REMOVE_ADMIN_OR_MANAGER', JSON.stringify(r.body));
  r = await call('POST', `${P}/${ownId}/remove`, cmt, { reason: 'duplicate' });
  check('a case manager cannot remove', r.status === 403, String(r.status));
  r = await call('POST', `${P}/${ownId}/remove`, mt, { reason: '' });
  check('a reason is required', r.status === 400 && r.body.code === 'REMOVE_REASON_REQUIRED', JSON.stringify(r.body));
  sf = await staffFiles();
  check('a refused removal removes nothing', sf.some(f => f.id === ownId));
  r = await call('POST', `${P}/${ownId}/remove`, mt, { reason: 'Uploaded twice by mistake' });
  check('a manager removes it, with a reason', r.status === 200 && r.body.removed && r.body.removed.byName === 'Vis Manager', JSON.stringify(r.body).slice(0, 300));
  check('the reply says a copy is still in OpenEMR', r.body.emrCopy && r.body.emrCopy.stillInOpenEmr === true, JSON.stringify(r.body.emrCopy));
  const stored = (STORE.get('client_document_uploads') || []).find(u => u.id === ownId);
  check('the row stays in the store, carrying who, when and why',
    stored && stored.removed && stored.removed.reason === 'Uploaded twice by mistake' && stored.removed.byId === MANAGER.id && !!stored.removed.at, JSON.stringify(stored && stored.removed));
  check('the Drive file is kept', stored && DRIVE.has(stored.driveFileId));
  sf = await staffFiles();
  check('it is gone from the staff checklist', !sf.some(f => f.id === ownId));
  const photo = ((await call('GET', P, at)).body.checklist || []).find(c => c.kind === 'photoId');
  check('removing the only photo ID puts it back on the list', photo && photo.status === 'missing', JSON.stringify(photo));
  pf = await patientFiles();
  check('it is gone from the patient\'s checklist', !pf.some(f => f.id === ownId));
  pc = await patientChart();
  check('and from the patient\'s record', !pc.some(d => d.uploadId === ownId));
  r = await call('GET', `/api/gfc/documents/uploads/${ownId}/file`, ct);
  check('the patient cannot open it', r.status === 404, String(r.status));
  r = await call('GET', `${P}/${ownId}/file`, at);
  check('staff cannot open it from the app either', r.status === 404, String(r.status));
  r = await call('POST', `${P}/${ownId}/review`, at, { decision: 'accepted' });
  check('it cannot be reviewed', r.status === 404, String(r.status));
  r = await call('POST', `${P}/${ownId}/remove`, at, { reason: 'again' });
  check('removing it twice is refused', r.status === 409 && r.body.code === 'DOCUMENT_ALREADY_REMOVED', JSON.stringify(r.body));
  r = await call('POST', `${P}/${staffId}/remove`, at, { reason: 'Wrong patient' });
  check('an admin removes one too', r.status === 200, String(r.status));

  console.log('\n── The chart ──');
  r = await call('GET', `/api/clinical/patients/${CLIENT.id}/chart`, at);
  const chartRows = r.body.chartDocuments || [];
  check('removed uploads are gone from the clinician\'s chart', !chartRows.some(d => d.uploadId === ownId || d.uploadId === staffId), JSON.stringify(chartRows.map(d => d.title)));

  console.log('\n── The activity trail ──');
  const log = (await new MemDb().get('activity_log')) || [];
  const actions = log.map(e => e.action);
  for (const a of ['client_document_removed', 'client_document_shared', 'client_document_unshared']) {
    check(`${a} is audited`, actions.includes(a), actions.join(','));
  }
  const removedEntry = log.find(e => e.action === 'client_document_removed');
  check('the log records the removal, never the reason text', removedEntry && !JSON.stringify(removedEntry).includes('Uploaded twice by mistake'), JSON.stringify(removedEntry));

  console.log(`\n${pass}/${pass + fail} checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
