#!/usr/bin/env node
/**
 * Two-way document exchange — HTTP round trip.
 *
 * Runs the REAL server and the REAL routes. The only things stubbed are the two
 * pieces of infrastructure that are not reachable from a build sandbox: the KV
 * store (@replit/database) and HIPAA Drive. Everything between them — auth,
 * gating, the checklist derivation, the request/remind/review lifecycle — is the
 * shipped code path.
 *
 * Every assertion reads STORED STATE back through a route. Nothing is proven by
 * a status code alone: this codebase has now been bitten five times by a 200
 * that wrote nothing.
 *
 *   node scripts/verify_document_exchange.js
 */
// Set before ANY local require: config.js reads PORT at load time, and it is
// pulled in transitively by the first module required here.
process.env.PORT = process.env.PORT || '4599';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'document-exchange-verification-secret';
process.env.AUTO_CHANGELOG = 'false';

const path = require('path');
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

// Load the real googledrive module, then swap only the two calls that touch
// Google. Everything else in it stays as shipped.
const gdrivePath = require.resolve(path.join(__dirname, '..', 'googledrive.js'));
const gdrive = require(gdrivePath);
gdrive.uploadClientDocumentFile = async (clientName, fileName, buf, mime) => {
  if (driveShouldFail) throw new Error('simulated Drive outage');
  const id = `drv_${DRIVE.size + 1}`;
  DRIVE.set(id, { buf, mime, fileName });
  return { fileId: id, webViewLink: `https://drive.test/${id}`, webContentLink: null };
};
gdrive.downloadFileBuffer = async (id) => {
  const f = DRIVE.get(id);
  if (!f) throw new Error('not found');
  return f.buf;
};

const jwt = require('jsonwebtoken');
const config = require(path.join(__dirname, '..', 'config.js'));

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tok = (u) => jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' });

const call = async (method, url, token, body) => {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: Object.assign(
      { 'Authorization': `Bearer ${token}` },
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
  id: 'client_verify_1', role: config.ROLES.CLIENT, email: 'testpatient@example.test',
  name: 'TEST PatientOne', slug: 'test-patientone', serviceLine: 'PHC',
  enrollmentStatus: 'enrolled', consents: { consentToTreat: 'signed' }, consentMeta: {},
  intake: { firstName: 'TEST', lastName: 'PatientOne' }
};
const STAFF = { id: 'staff_verify_1', role: config.ROLES.ADMIN, email: 'staff@example.test', name: 'Verification Staff' };
// A second client, so the scoping check exercises the real ownership filter
// rather than a user the cache has not seen yet.
const OTHER = {
  id: 'client_verify_2', role: config.ROLES.CLIENT, email: 'other@example.test',
  name: 'Other Client', slug: 'other-client', serviceLine: 'PHC',
  enrollmentStatus: 'enrolled', consents: { consentToTreat: 'signed' }, consentMeta: {}, intake: {}
};

(async () => {
  STORE.set('users', [CLIENT, STAFF, OTHER]);
  require(path.join(__dirname, '..', 'server.js'));
  await new Promise(r => setTimeout(r, 2500));

  const ct = tok(CLIENT), st = tok(STAFF);
  console.log('\n── Client checklist derives from the service line ──');
  let r = await call('GET', '/api/gfc/documents', ct);
  check('client documents payload returns', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  let kinds = (r.body.checklist || []).map(x => x.kind);
  check('a PHC client is asked for ID and insurance', kinds.includes('photoId') && kinds.includes('insuranceCard'), kinds.join(','));
  check('a PHC client is NOT asked for medical-only documents',
    !kinds.includes('dnrPolst') && !kinds.includes('priorRecords'), kinds.join(','));
  check('no representative on file means no POA document is chased', !kinds.includes('poaGuardianship'), kinds.join(','));
  check('everything starts missing', (r.body.checklist || []).every(x => x.status === 'missing'));
  check('outstanding counts only what is required or asked for', r.body.outstanding === 2, String(r.body.outstanding));

  console.log('\n── Widening the service line widens the checklist ──');
  await call('PUT', `/api/gfc/admin/enrollment/${CLIENT.id}/service-line`, st, { serviceLine: 'BOTH' });
  r = await call('GET', '/api/gfc/documents', ct);
  kinds = (r.body.checklist || []).map(x => x.kind);
  check('the medical documents appear once medical care is added',
    kinds.includes('dnrPolst') && kinds.includes('priorRecords'), kinds.join(','));

  console.log('\n── Upload, and read the file back ──');
  r = await call('POST', '/api/gfc/documents/upload', ct, { kind: 'photoId', fileName: 'licence.png', fileDataB64: b64(PNG) });
  check('upload accepted', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  const uploadId = r.body.document && r.body.document.id;

  r = await call('GET', '/api/gfc/documents', ct);
  const photo = (r.body.checklist || []).find(x => x.kind === 'photoId');
  check('the checklist now reports it received', photo && photo.status === 'received', photo && photo.status);
  check('the file is listed by name', photo && photo.files[0] && photo.files[0].fileName === 'licence.png');
  check('outstanding dropped by one', r.body.outstanding === 1, String(r.body.outstanding));

  r = await call('GET', `/api/gfc/documents/uploads/${uploadId}/file`, ct);
  check('the client reads their own file back', r.status === 200 && Buffer.isBuffer(r.body) && r.body.equals(PNG));
  check('served with the sniffed type, not the declared one', r.contentType.includes('image/png'), r.contentType);

  console.log('\n── What the exchange refuses ──');
  r = await call('POST', '/api/gfc/documents/upload', ct, { kind: 'photoId', fileName: 'x.txt', fileDataB64: Buffer.from('not an image').toString('base64') });
  check('a file that is not PDF/JPG/PNG is refused', r.status === 400, String(r.status));
  r = await call('POST', '/api/gfc/documents/upload', ct, { kind: 'made_up_kind', fileName: 'a.png', fileDataB64: b64(PNG) });
  check('an unknown document type is refused', r.status === 400 && r.body.code === 'DOCUMENT_KIND_UNKNOWN', JSON.stringify(r.body));

  driveShouldFail = true;
  r = await call('POST', '/api/gfc/documents/upload', ct, { kind: 'insuranceCard', fileName: 'card.png', fileDataB64: b64(PNG) });
  check('a storage failure fails the upload rather than recording a phantom',
    r.status === 502 && r.body.code === 'DOCUMENT_STORAGE_UNAVAILABLE', JSON.stringify(r.body));
  driveShouldFail = false;
  r = await call('GET', '/api/gfc/documents', ct);
  const card = (r.body.checklist || []).find(x => x.kind === 'insuranceCard');
  check('and nothing was recorded for it', card && card.status === 'missing' && card.files.length === 0);

  r = await call('GET', `/api/gfc/documents/uploads/${uploadId}/file`, tok(OTHER));
  check('another client cannot read this file', r.status === 404, String(r.status));
  check('and gets no bytes', !Buffer.isBuffer(r.body) || !r.body.equals(PNG));

  console.log('\n── Staff request, reminder, and the trail they leave ──');
  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/documents/request`, st, {
    items: [{ kind: 'priorRecords', note: 'Discharge summary from March please' }, { label: 'Guardianship order' }],
    dueAt: '2026-10-01'
  });
  check('request created', r.status === 200 && r.body.created.length === 2, JSON.stringify(r.body).slice(0, 200));

  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/documents/request`, st, { items: [{ kind: 'priorRecords' }] });
  check('asking twice for the same thing does not create a second row', (r.body.created || []).length === 0, JSON.stringify(r.body));

  r = await call('GET', '/api/gfc/documents', ct);
  const asked = (r.body.checklist || []).find(x => x.kind === 'priorRecords');
  check('the ask reaches the client checklist', asked && asked.requested === true);
  check('with the staff note as the instruction', asked && asked.hint === 'Discharge summary from March please', asked && asked.hint);
  check('and a due date', !!(asked && asked.dueAt));
  const custom = (r.body.checklist || []).find(x => x.kind.startsWith('custom:'));
  check('a one-off ask lands in the same checklist', !!custom && custom.label === 'Guardianship order');

  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/documents/remind`, st, {});
  check('reminder sent', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  r = await call('GET', `/api/gfc/admin/enrollment/${CLIENT.id}/documents`, st);
  const reminded = (r.body.checklist || []).find(x => x.kind === 'priorRecords');
  check('the reminder is stamped on the record, not just sent', !!(reminded && reminded.remindedAt), JSON.stringify(reminded));

  console.log('\n── Review: accept, and reject with a reason ──');
  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/documents/${uploadId}/review`, st, { decision: 'rejected' });
  check('a rejection with no reason is refused', r.status === 400 && r.body.code === 'REASON_REQUIRED', JSON.stringify(r.body));

  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/documents/${uploadId}/review`, st, { decision: 'rejected', reason: 'The photo is too blurry to read the number.' });
  check('rejection recorded', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  r = await call('GET', '/api/gfc/documents', ct);
  const rejected = (r.body.checklist || []).find(x => x.kind === 'photoId');
  check('a rejected document goes back to missing', rejected && rejected.status === 'missing', rejected && rejected.status);
  check('and the client is told why', rejected && rejected.files.some(f => f.rejectionReason && f.rejectionReason.includes('blurry')));

  r = await call('POST', '/api/gfc/documents/upload', ct, { kind: 'photoId', fileName: 'licence2.png', fileDataB64: b64(PNG) });
  const secondId = r.body.document.id;
  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/documents/${secondId}/review`, st, { decision: 'accepted' });
  check('the replacement is accepted', r.status === 200);
  r = await call('GET', '/api/gfc/documents', ct);
  const done = (r.body.checklist || []).find(x => x.kind === 'photoId');
  check('and the checklist says it is on file', done && done.status === 'accepted', done && done.status);
  check('the rejected copy is still visible alongside it', done && done.files.length === 2, String(done && done.files.length));

  console.log('\n── Only staff work the staff side ──');
  r = await call('GET', `/api/gfc/admin/enrollment/${CLIENT.id}/documents`, ct);
  check('a client cannot open the staff document view', r.status === 403, String(r.status));
  r = await call('POST', `/api/gfc/admin/enrollment/${CLIENT.id}/documents/request`, ct, { items: [{ kind: 'photoId' }] });
  check('a client cannot request documents of themselves', r.status === 403, String(r.status));

  console.log('\n── The activity trail ──');
  const log = (await new MemDb().get('activity_log')) || [];
  const actions = log.map(e => e.action);
  for (const a of ['client_document_uploaded', 'client_document_read', 'client_documents_requested', 'client_documents_reminded', 'client_document_reviewed']) {
    check(`${a} is audited`, actions.includes(a), actions.join(','));
  }

  console.log(`\n${pass}/${pass + fail} checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
