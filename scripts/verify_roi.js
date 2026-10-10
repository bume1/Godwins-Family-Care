#!/usr/bin/env node
/**
 * The Transfer-of-Care provider ROI, end to end (rebuilt 2026-10-10).
 *
 * Owner report: the online form produced many PDFs with broken information.
 * This drives the REAL routes and reads back what was stored and what the
 * PDFs actually contain:
 *   - the patient's identity comes from the record, not from what the page sent
 *   - the same office typed twice is one release, not two
 *   - a bad fax number is refused and NOTHING is written
 *   - ticked boxes are drawn ticks, one per ticked box, and the form is one page
 *   - a provider with a release in force is not pre-filled again
 *   - every release opens from the chart, even when the Drive upload failed
 *
 * Stubbed: the KV store and Drive. Everything between them is shipped code.
 *
 *   node scripts/verify_roi.js
 */
process.env.PORT = process.env.PORT || '4613';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'roi-verification-secret';
process.env.AUTO_CHANGELOG = 'false';
process.env.MFA_ENFORCE = 'false';

const path = require('path');
const zlib = require('zlib');
const Module = require('module');

const STORE = new Map();
class MemDb {
  async get(k) { return STORE.has(k) ? JSON.parse(JSON.stringify(STORE.get(k))) : null; }
  async set(k, v) { STORE.set(k, JSON.parse(JSON.stringify(v))); return true; }
  async delete(k) { STORE.delete(k); return true; }
  async list(prefix) { return [...STORE.keys()].filter(k => !prefix || k.startsWith(prefix)); }
  async empty() { STORE.clear(); return true; }
}
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@replit/database') return '__memdb__';
  return realResolve.call(this, request, ...rest);
};
require.cache['__memdb__'] = { id: '__memdb__', filename: '__memdb__', loaded: true, exports: MemDb };

const DRIVE = [];
let driveShouldFail = false;
const gdrive = require(path.join(__dirname, '..', 'googledrive.js'));
gdrive.uploadProviderROIFile = async (folder, fileName, buf) => {
  if (driveShouldFail) throw new Error('simulated Drive outage');
  DRIVE.push({ fileName, buf });
  return { webViewLink: `https://drive.test/${DRIVE.length}` };
};

const jwt = require('jsonwebtoken');
const config = require(path.join(__dirname, '..', 'config.js'));
const { PDFDocument } = require('pdf-lib');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tok = (u) => {
  const sid = `sess_${u.id}`;
  const at = new Date().toISOString();
  STORE.set(`auth_session:${sid}`, {
    id: sid, userId: u.id, role: u.role, createdAt: at, lastSeenAt: at,
    absoluteExpiresAt: null, revokedAt: null, revokedReason: null,
    ipHash: null, userAgent: null, mfaVerified: true, surface: null
  });
  return jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, sid }, process.env.JWT_SECRET, { expiresIn: '1h' });
};
const call = async (method, url, token, body) => {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: Object.assign({ 'Authorization': `Bearer ${token || ''}` }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const ct = res.headers.get('content-type') || '';
  const payload = ct.includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, body: payload, contentType: ct };
};

// Every content stream of a PDF, inflated, so drawing operators can be counted.
const pdfContent = (buf) => {
  const s = buf.toString('latin1');
  let out = '';
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    try { out += zlib.inflateSync(Buffer.from(s.slice(start, end), 'latin1')).toString('latin1') + '\n'; } catch (e) { /* not a flate stream */ }
  }
  return out;
};
// A tick is the only thing the form strokes at 1.6pt.
const tickCount = (buf) => (pdfContent(buf).match(/\b1\.6 w\b/g) || []).length;
const pageCount = async (buf) => (await PDFDocument.load(buf)).getPageCount();

// A signature the validator accepts (a real drawing encodes well past 100
// characters). The padding may make the image unreadable to pdfkit, which then
// leaves the line blank rather than failing the form; that path is tested too.
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' + 'A'.repeat(120);

const CLIENT = {
  id: 'client_roi_1', role: config.ROLES.CLIENT, email: 'roipatient@example.test',
  name: 'Juanita Guess', slug: 'juanita-guess', serviceLine: 'BOTH',
  enrollmentStatus: 'enrolled', consents: { consentToTreat: 'signed' }, consentMeta: {},
  intake: {
    firstName: 'Juanita', lastName: 'Guess', dob: '1940-01-02', phone: '404-555-1212',
    address: { line1: '12 Main St', city: 'Atlanta', state: 'GA', zip: '30301' }
  },
  // Two spellings of one office, saved by the old merge.
  priorProviders: [
    { name: 'Dr. Smith', dept: 'Cardiology', fax: '', addedFrom: 'intake_prefill' },
    { name: 'dr smith', dept: '', fax: '404-555-0001', addedFrom: 'roi_form' },
    { name: 'Emory Hospital', addedFrom: 'intake_prefill' }
  ]
};

const base = (over) => Object.assign({
  // Deliberately wrong: the server must print the record, not this.
  patientName: 'Somebody Else', patientDOB: '1999-09-09', patientAddress: '[object Object]', patientPhone: '',
  providers: [{ name: 'Dr. Smith', fax: '(404) 555-0001' }],
  categories: { hp: true, lab: true, diag: false, other: false, otherText: '' },
  includesProtected: false,
  purposeTreatment: true, purposeOther: false, purposeOtherText: 'left over text',
  expDate: '', expEvent: '',
  signatureImageB64: SIG, printedName: 'Juanita Guess', relationship: ''
}, over || {});

(async () => {
  const ADMIN = { id: 'admin_roi_1', role: config.ROLES.ADMIN, email: 'roiadmin@example.test', name: 'Roi Admin' };
  STORE.set('users', [CLIENT, ADMIN]);
  require(path.join(__dirname, '..', 'server.js'));
  await new Promise(r => setTimeout(r, 2500));
  const ct = tok(CLIENT), at = tok(ADMIN);
  const count = (k) => (STORE.get(k) || []).length;

  console.log('\n── The prefill ──');
  let r = await call('GET', '/api/gfc/transfer-roi', ct);
  check('the prefill loads', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  check('the address prints as a line, never [object Object]', r.body.patient && r.body.patient.patientAddress === '12 Main St, Atlanta, GA 30301', JSON.stringify(r.body.patient));
  check('the record\'s identity is marked as from the record', r.body.patientFromRecord && r.body.patientFromRecord.patientDOB === true);
  const names = (r.body.priorProviders || []).map(p => p.name);
  check('two spellings of one office are listed once', names.length === 2 && names[0] === 'Dr. Smith', JSON.stringify(names));
  check('…and the listed one keeps the fax the other copy had', r.body.priorProviders[0].fax === '404-555-0001');
  check('nothing is marked as already authorized yet', r.body.priorProviders.every(p => !p.activeAuthorization));

  console.log('\n── Refusals write nothing ──');
  r = await call('POST', '/api/gfc/transfer-roi/submit', ct, base({ providers: [{ name: 'Emory Hospital', fax: '123' }] }));
  check('a fax that is not 10 digits is refused', r.status === 400 && /10-digit/.test(JSON.stringify(r.body)), JSON.stringify(r.body));
  check('…and nothing was written', count('consent_events') === 0 && count('consent_provider_authorizations') === 0);
  r = await call('POST', '/api/gfc/transfer-roi/submit', ct, base({ expDate: '2020-01-01' }));
  check('an expiration date in the past is refused', r.status === 400 && r.body.fieldErrors && r.body.fieldErrors.expiration_date, JSON.stringify(r.body));
  r = await call('POST', '/api/gfc/transfer-roi/submit', ct, base({ categories: { other: true, otherText: '' } }));
  check('"Other" records with no description is refused', r.status === 400 && r.body.fieldErrors && r.body.fieldErrors.otherText, JSON.stringify(r.body));
  r = await call('POST', '/api/gfc/transfer-roi/submit', ct, base({ providers: Array.from({ length: 11 }, (_, i) => ({ name: `Clinic ${i}` })) }));
  check('more than 10 providers in one form is refused', r.status === 400, JSON.stringify(r.body));
  check('…and still nothing was written', count('consent_events') === 0);

  console.log('\n── One submission ──');
  r = await call('POST', '/api/gfc/transfer-roi/submit', ct, base({
    providers: [
      { name: 'Dr. Smith', fax: '(404) 555-0001' },
      { name: 'DR SMITH', address: '1 Peachtree St' },
      { name: 'Emory Hospital' }
    ],
    expDate: '2099-01-01'
  }));
  check('the form submits', r.status === 200, JSON.stringify(r.body));
  check('the same office typed twice is ONE release (2, not 3)', r.body.providerCount === 2, String(r.body.providerCount));
  check('a provider with no fax is named back', Array.isArray(r.body.missingFax) && r.body.missingFax.includes('Emory Hospital'), JSON.stringify(r.body.missingFax));
  const events = STORE.get('consent_events') || [];
  const ev = events[0] || {};
  const oneYear = new Date(Date.UTC(new Date().getUTCFullYear() + 1, new Date().getUTCMonth(), new Date().getUTCDate())).toISOString().slice(0, 10);
  check('an expiration beyond a year is held to one year', ev.expiration_date && ev.expiration_date <= oneYear, ev.expiration_date);
  check('the stored identity is the record\'s, not what the page sent', ev.patient_snapshot && ev.patient_snapshot.patientName === 'Juanita Guess' && ev.patient_snapshot.patientDOB === '1940-01-02', JSON.stringify(ev.patient_snapshot));
  check('an unticked "Other purpose" is not stored', ev.purpose_other_text === null, String(ev.purpose_other_text));
  check('specially protected information is not authorized', ev.includes_protected_info === false);
  const auths = STORE.get('consent_provider_authorizations') || [];
  const smith = auths.find(a => a.provider_name === 'Dr. Smith');
  check('the duplicate filled in the address the first copy lacked', smith && smith.address === '1 Peachtree St', JSON.stringify(smith));
  check('the fax is stored in one format', smith && smith.fax === '404-555-0001', smith && smith.fax);
  check('one PDF per release reached Drive', DRIVE.length === 2, String(DRIVE.length));

  const pdf = DRIVE[0] && DRIVE[0].buf;
  check('the release is ONE page', pdf && await pageCount(pdf) === 1);
  // Ticked: H&P, lab, treatment purpose = 3. The protected line is NOT ticked.
  check('exactly the ticked boxes are drawn ticked (3)', pdf && tickCount(pdf) === 3, String(pdf && tickCount(pdf)));
  check('no "&" stands in for a checkbox any more', pdf && !/\(&\)|<26>/.test(pdfContent(pdf)));

  const prior = (STORE.get('users') || []).find(u => u.id === CLIENT.id).priorProviders;
  check('the saved provider list has no duplicate offices', prior.length === 2, JSON.stringify(prior.map(p => p.name)));

  console.log('\n── The next time the form opens ──');
  r = await call('GET', '/api/gfc/transfer-roi', ct);
  const again = r.body.priorProviders || [];
  check('both providers now show a release in force', again.length === 2 && again.every(p => p.activeAuthorization && p.activeAuthorization.expiresOn), JSON.stringify(again.map(p => [p.name, p.activeAuthorization])));

  console.log('\n── Protected information, opted in ──');
  r = await call('POST', '/api/gfc/transfer-roi/submit', ct, base({ providers: [{ name: 'Grady Behavioral Health' }], includesProtected: true}));
  check('it submits', r.status === 200, JSON.stringify(r.body));
  const pdf2 = DRIVE[DRIVE.length - 1].buf;
  check('the opt-in is a fourth drawn tick', tickCount(pdf2) === 4, String(tickCount(pdf2)));

  console.log('\n── Opening a release from the record ──');
  driveShouldFail = true;
  r = await call('POST', '/api/gfc/transfer-roi/submit', ct, base({ providers: [{ name: 'Northside Hospital', fax: '770-555-0100' }] }));
  check('a Drive outage does not lose the release', r.status === 200 && Array.isArray(r.body.storageFailed) && r.body.storageFailed.includes('Northside Hospital'), JSON.stringify(r.body));
  driveShouldFail = false;
  const north = (STORE.get('consent_provider_authorizations') || []).find(a => a.provider_name === 'Northside Hospital');
  r = await call('GET', '/api/gfc/transfer-roi', ct);
  const listed = (r.body.authorizations || []).find(x => x.id === north.id);
  check('the patient sees the release in their list of signed authorizations', !!listed && listed.providerName === 'Northside Hospital', JSON.stringify(r.body.authorizations));
  r = await call('GET', `/api/gfc/transfer-roi/authorizations/${north.id}.pdf`, ct);
  check('the patient downloads their copy as a PDF', r.status === 200 && /application\/pdf/.test(r.contentType) && Buffer.isBuffer(r.body) && r.body.slice(0, 5).toString() === '%PDF-', `${r.status} ${r.contentType}`);
  check('the copy is one page', Buffer.isBuffer(r.body) && await pageCount(r.body) === 1);
  r = await call('GET', `/api/gfc/transfer-roi/authorizations/nope.pdf`, ct);
  check('an unknown release is a 404', r.status === 404, String(r.status));
  r = await call('GET', `/api/clinical/patients/${CLIENT.id}/documents/${encodeURIComponent('roi:' + north.id)}/file`, at);
  check('staff open it from the chart as a PDF, not a Drive link', r.status === 200 && /application\/pdf/.test(r.contentType) && Buffer.isBuffer(r.body), `${r.status} ${r.contentType} ${Buffer.isBuffer(r.body) ? '' : JSON.stringify(r.body).slice(0, 200)}`);
  r = await call('GET', `/api/clinical/patients/${CLIENT.id}`, at);
  const chartRow = ((r.body && (r.body.documents || r.body.chartDocuments)) || []).find(d => d.id === `roi:${north.id}`);
  check('the chart lists it as openable', !chartRow || chartRow.openable === true, JSON.stringify(chartRow));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
