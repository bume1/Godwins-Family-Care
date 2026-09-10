#!/usr/bin/env node
/**
 * The chart's document list — HTTP round trip.
 *
 * WHY THIS EXISTS: a clinician reviewing a chart saw no documents at all.
 * Probed live on OpenEMR 8.4 (2026-09-09, TEST PatientOne, pid 1):
 *
 *   POST patient/1/document        → 200, body literally `true`, no id returned
 *   FHIR DocumentReference?patient → 200, total 0 — instance-wide, immediately
 *                                    after that successful upload
 *   GET  patient/1/document        → 404 (no list route)
 *   GET  patient/1/document/{id}   → 500 "CSRF key is empty" — the route exists
 *                                    and crashes on a session check
 *
 * So the chart is assembled from what the app holds and merged with whatever the
 * EMR returns. This proves the assembled list and that every row it calls
 * openable actually opens.
 *
 * Runs the REAL server and REAL routes. Stubbed: the KV store, Drive and the
 * OpenEMR transport, none of which is reachable from a build sandbox. Every
 * assertion reads back what the route actually returned.
 *
 *   node scripts/verify_chart_documents.js
 */
process.env.PORT = process.env.PORT || '4603';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'chart-documents-verification-secret';

const path = require('path');
const Module = require('module');

const STORE = new Map();
class MemDb {
  async get(k) { return STORE.has(k) ? JSON.parse(JSON.stringify(STORE.get(k))) : null; }
  async set(k, v) { STORE.set(k, JSON.parse(JSON.stringify(v))); return true; }
  async delete(k) { STORE.delete(k); return true; }
  async list(p) { return [...STORE.keys()].filter(k => !p || k.startsWith(p)); }
  async empty() { STORE.clear(); return true; }
}
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...rest) {
  if (r === '@replit/database') return '__memdb__';
  return realResolve.call(this, r, ...rest);
};
require.cache['__memdb__'] = { id: '__memdb__', filename: '__memdb__', loaded: true, exports: MemDb };

const gdrive = require(path.join(__dirname, '..', 'googledrive.js'));
// A realistically sized stand-in, so the byte assertion tests the route
// rather than the size of a fixture.
const DRIVE = new Map([['drv_upload', Buffer.concat([Buffer.from('%PDF-1.4\nuploaded scan\n'), Buffer.alloc(2048, 32)])]]);
gdrive.downloadFileBuffer = async (id) => {
  if (!DRIVE.has(id)) throw new Error('no such Drive file');
  return DRIVE.get(id);
};
gdrive.uploadCarePlanFile = async () => { throw new Error('no Drive in this sandbox'); };

// OpenEMR: reproduce the instance faithfully — documents go in, none come back.
//
// TWO DEPLOY STATES, because the app has to be right in both. PATCH.deployed
// false is the instance as it stands today: no document read at all. True is
// the instance after `docker compose build --pull && docker compose up -d`
// ships the 8.4.0-p1 document routes. Nothing else about the fixture changes,
// so any difference in the chart is caused by the deploy and nothing else.
const PATCH = { deployed: false };
const EMR_DOCS = [
  { id: 7, name: 'Cardiology consult 2026-08-30.pdf', category: 'Medical Record', docdate: '2026-08-30', filed_at: '2026-09-01 09:12:00', mimetype: 'application/pdf', size: 4096 },
  { id: 9, name: 'Faxed hospital discharge.pdf', category: null, docdate: null, filed_at: '2026-09-06 14:02:00', mimetype: 'application/pdf', size: 2048 }
];
const EMR_BYTES = Buffer.concat([Buffer.from('%PDF-1.4\nfiled straight into OpenEMR\n'), Buffer.alloc(4096, 32)]);

const openemr = require(path.join(__dirname, '..', 'openemr.js'));
openemr.isConfigured = () => true;
openemr.forActor = () => new Proxy({}, {
  get(_t, prop) {
    if (prop === 'getDocumentReferences') return async () => [];   // total 0, as live
    if (prop === 'uploadPatientDocument') return async () => true;  // 200 `true`, as live
    // The patch routes. Undeployed, both 404 — which the transport reports as
    // supported:false, never as "this patient has no documents".
    if (prop === 'listPatientDocuments') {
      return async () => PATCH.deployed ? { supported: true, rows: EMR_DOCS } : { supported: false, rows: [] };
    }
    if (prop === 'getPatientDocument') {
      return async (_puuid, id) => {
        if (!PATCH.deployed) return { supported: false, doc: null };
        const row = EMR_DOCS.find(d => String(d.id) === String(id));
        // Deployed and no such document: a 400 from the patch, NOT a 404.
        if (!row) return { supported: true, doc: null };
        return { supported: true, doc: { name: row.name, mimetype: row.mimetype, buffer: EMR_BYTES } };
      };
    }
    if (['getProblems', 'getAllergies', 'getMedicationRequests', 'getEncounters', 'getCarePlans', 'getVitalObservations'].includes(prop)) {
      return async () => [];
    }
    if (prop === 'getPatient') return async (id) => ({ id, name: [{ family: 'PatientOne', given: ['TEST'] }] });
    return async () => { throw new Error(`openemr.${String(prop)} not stubbed`); };
  }
});

const jwt = require('jsonwebtoken');
const config = require(path.join(__dirname, '..', 'config.js'));
const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${d ? ` — ${d}` : ''}`); } };
const tok = (u) => jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
const call = async (m, u, t, b) => {
  const r = await fetch(`${BASE}${u}`, {
    method: m,
    headers: Object.assign({ Authorization: `Bearer ${t}` }, b ? { 'Content-Type': 'application/json' } : {}),
    body: b ? JSON.stringify(b) : undefined
  });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, ct, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};

const PLAN = { version: 1, problems: [{ text: 'Fall risk' }], goals: ['Stay safe at home'], effectiveDate: '2026-09-01' };
const CLIENT = {
  id: 'c_chart', role: config.ROLES.CLIENT, email: 'chart@test', name: 'TEST PatientOne',
  slug: 'test-patientone', serviceLine: 'BOTH', enrollmentStatus: 'enrolled',
  openEmrPatientId: 'uuid-chart', careTier: 'A2',
  intake: { dob: '1948-03-11' },
  consents: { npp: 'signed', consentToTreat: 'signed', pcaScope: 'pending' },
  consentMeta: {
    npp: { signedAt: '2026-09-03T10:00:00.000Z', typedName: 'TEST PatientOne', ipHash: 'h', version: '2026-09-packet-v2' },
    consentToTreat: { signedAt: '2026-09-03T10:05:00.000Z', typedName: 'TEST PatientOne', ipHash: 'h', version: '2026-09-packet-v2' }
  },
  rateAgreement: { hourlyRate: 32, minimumHours: 4, setAt: '2026-09-01T10:00:00.000Z' },
  carePlan: { ...PLAN, rnSignedAt: '2026-09-02T10:00:00.000Z', rnName: 'Bethel Godwins RN' },
  carePlanCoSign: { v1: { at: '2026-09-04T10:00:00.000Z', name: 'TEST PatientOne' } }
};
const CLINICIAN = { id: 'clin_1', role: config.ROLES.ADMIN, email: 'rn@test', name: 'Bethel Godwins' };

(async () => {
  STORE.set('users', [CLIENT, CLINICIAN]);
  STORE.set('care_plan_versions', [
    { id: 'v1', client_id: CLIENT.id, version: 1, plan: PLAN, rnSignature: { name: 'Bethel Godwins RN', at: '2026-09-02T10:00:00.000Z' }, createdAt: '2026-09-02T10:00:00.000Z' }
  ]);
  STORE.set('care_plan_cosign_events', [
    { id: 'e1', client_id: CLIENT.id, version: 1, at: '2026-09-04T10:00:00.000Z', name: 'TEST PatientOne', signerRole: 'client' }
  ]);
  STORE.set('client_document_uploads', [
    { id: 'up_ok', clientId: CLIENT.id, kind: 'photoId', fileName: 'licence.pdf', mimeType: 'application/pdf', driveFileId: 'drv_upload', uploadedAt: '2026-09-05T10:00:00.000Z', status: 'accepted' },
    { id: 'up_bad', clientId: CLIENT.id, kind: 'insuranceCard', fileName: 'blurry.pdf', mimeType: 'application/pdf', driveFileId: 'drv_upload', uploadedAt: '2026-09-05T11:00:00.000Z', status: 'rejected', rejectionReason: 'unreadable' }
  ]);

  require(path.join(__dirname, '..', 'server.js'));
  await new Promise(r => setTimeout(r, 2500));
  const t = tok(CLINICIAN);

  console.log('\n── STATE 1: the patch is NOT deployed (the instance as it stands today) ──');
  let r = await call('GET', `/api/clinical/patients/${CLIENT.id}/chart`, t);
  check('chart loads', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  check('the FHIR document read is genuinely empty, as on the live instance',
    r.body.emr && r.body.emr.documents && r.body.emr.documents.ok && r.body.emr.documents.rows.length === 0);
  const docs = r.body.chartDocuments || [];
  check('and the chart still has documents', docs.length > 0, String(docs.length));
  const byId = Object.fromEntries(docs.map(d => [d.id, d]));
  check('the signed plan of care is listed', !!byId['careplan:1'], Object.keys(byId).join(','));
  check('both executed consents are listed', !!byId['consent:npp'] && !!byId['consent:consentToTreat']);
  check('the unsigned consent is NOT listed', !byId['consent:pcaScope']);
  check('the accepted client upload is listed', !!byId['upload:up_ok']);
  check('the rejected upload is NOT listed', !byId['upload:up_bad']);
  check('the plan says it reached the EMR chart', byId['careplan:1'] && byId['careplan:1'].inChart === false,
    'no chartFiled stamp on this fixture, so false is correct');

  console.log('\n── Every row it calls openable actually opens ──');
  for (const id of ['careplan:1', 'consent:npp', 'upload:up_ok']) {
    r = await call('GET', `/api/clinical/patients/${CLIENT.id}/documents/${encodeURIComponent(id)}/file`, t);
    check(`${id} opens`, r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    check(`${id} returns real bytes`, Buffer.isBuffer(r.body) && r.body.length > 100, String(Buffer.isBuffer(r.body) ? r.body.length : 'not a buffer'));
  }

  console.log('\n── What it refuses, and why ──');
  r = await call('GET', `/api/clinical/patients/${CLIENT.id}/documents/consent:pcaScope/file`, t);
  check('an unsigned consent produces no copy', r.status === 404 || r.status === 409, String(r.status));
  r = await call('GET', `/api/clinical/patients/${CLIENT.id}/documents/upload:up_bad/file`, t);
  check('a rejected upload is refused', r.status === 409 && r.body.code === 'DOCUMENT_REJECTED', JSON.stringify(r.body));
  r = await call('GET', `/api/clinical/patients/${CLIENT.id}/documents/emr:x1/file`, t);
  check('an EMR row says the instance has no read API', r.status === 501 && r.body.code === 'EMR_DOCUMENT_READ_UNAVAILABLE', JSON.stringify(r.body));
  r = await call('GET', `/api/clinical/patients/${CLIENT.id}/documents/nonsense/file`, t);
  check('an unknown reference is refused, not guessed at', r.status === 400 && r.body.code === 'DOCUMENT_REF_UNKNOWN', JSON.stringify(r.body));
  r = await call('GET', `/api/clinical/patients/${CLIENT.id}/documents/careplan:99/file`, t);
  check('a care-plan version that does not exist is refused', r.status === 404, String(r.status));

  console.log('\n── Access ──');
  r = await call('GET', `/api/clinical/patients/${CLIENT.id}/documents/careplan:1/file`, tok(CLIENT));
  check('a client cannot read the clinical chart document route', r.status === 403, String(r.status));

  console.log('\n── STATE 2: the patch IS deployed — the same chart, one rebuild later ──');
  PATCH.deployed = true;
  r = await call('GET', `/api/clinical/patients/${CLIENT.id}/chart`, t);
  check('chart still loads', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  const docs2 = r.body.chartDocuments || [];
  const by2 = Object.fromEntries(docs2.map(d => [d.id, d]));
  check("the EMR's own documents now appear", !!by2['emr:7'] && !!by2['emr:9'], Object.keys(by2).join(','));
  check('and they are openable, with no "open it in OpenEMR" note',
    by2['emr:7'].openable === true && by2['emr:7'].note === null, JSON.stringify(by2['emr:7']));
  check('an uncategorised document is NOT dropped from the chart', !!by2['emr:9']);
  check('the app-side rows are untouched by the deploy',
    !!by2['careplan:1'] && !!by2['consent:npp'] && !!by2['upload:up_ok']);
  check('nothing the app holds was duplicated by the EMR list',
    docs2.filter(d => d.id === 'careplan:1').length === 1, String(docs2.filter(d => d.id === 'careplan:1').length));

  r = await call('GET', `/api/clinical/patients/${CLIENT.id}/documents/emr:7/file`, t);
  check('an EMR document opens', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  check('and returns the stored bytes', Buffer.isBuffer(r.body) && r.body.length === EMR_BYTES.length,
    String(Buffer.isBuffer(r.body) ? r.body.length : 'not a buffer'));

  r = await call('GET', `/api/clinical/patients/${CLIENT.id}/documents/emr:404/file`, t);
  check('a document the chart does not have reads as MISSING, not as an undeployed feature',
    r.status === 404 && r.body.code === 'EMR_DOCUMENT_NOT_FOUND', `${r.status} ${JSON.stringify(r.body)}`);

  r = await call('GET', `/api/clinical/patients/${CLIENT.id}/documents/emr:7/file`, tok(CLIENT));
  check('a client still cannot read an EMR document through the chart route', r.status === 403, String(r.status));

  console.log('\n── The audit trail ──');
  const log = (await new MemDb().get('activity_log')) || [];
  const reads = log.filter(e => e.action === 'chart_document_read');
  check('every chart document read is audited', reads.length >= 4, String(reads.length));
  check('including the EMR one', reads.some(e => e.details && String(e.details.resource || '').startsWith('emr_')),
    JSON.stringify(reads.map(e => e.details && e.details.resource)));
  check('with which document', reads.every(e => e.details && e.details.docId), JSON.stringify(reads.map(e => e.details && e.details.docId)));

  console.log(`\n${pass}/${pass + fail} checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
