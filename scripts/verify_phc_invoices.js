#!/usr/bin/env node
/**
 * Private Home Care invoices from approved hours, through the REAL server and
 * routes (owner, 2026-11-08). Payers, Bill To, Generate Invoices from the
 * app's hours and from an imported payroll export, the invoice PDF, and the
 * carrier invoice kept off the patient's portal. Stored values are read back.
 *   node scripts/verify_phc_invoices.js
 */
process.env.PORT = process.env.PORT || '4621';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'phc-invoice-verification-secret';
process.env.AUTO_CHANGELOG = 'false';
process.env.MFA_ENFORCE = 'false';
const path = require('path'); const Module = require('module');
const STORE = new Map();
class MemDb {
  async get(k) { return STORE.has(k) ? JSON.parse(JSON.stringify(STORE.get(k))) : null; }
  async set(k, v) { STORE.set(k, JSON.parse(JSON.stringify(v))); return true; }
  async delete(k) { STORE.delete(k); return true; }
  async list(prefix) { return [...STORE.keys()].filter(k => !prefix || k.startsWith(prefix)); }
  async empty() { STORE.clear(); return true; }
}
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) { if (request === '@replit/database') return '__memdb__'; return realResolve.call(this, request, ...rest); };
require.cache['__memdb__'] = { id: '__memdb__', filename: '__memdb__', loaded: true, exports: MemDb };
const SENT = [];
const email = require(path.join(__dirname, '..', 'email.js'));
email.sendEmail = async (to, subject) => { SENT.push({ to, subject }); return { success: true }; };
const jwt = require('jsonwebtoken');
const { PDFDocument } = require('pdf-lib');
const packetImport = require(path.join(__dirname, '..', 'welcomePacketImport.js'));
const sched = require(path.join(__dirname, '..', 'schedulingRepository.js'));
const t = require(path.join(__dirname, '..', 'public', 'gfc-time.js'));
const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); } };
const tok = (u) => { const sid = `sess_${u.id}`; const at = new Date().toISOString();
  STORE.set(`auth_session:${sid}`, { id: sid, userId: u.id, role: u.role, createdAt: at, lastSeenAt: at, absoluteExpiresAt: null, revokedAt: null, revokedReason: null, ipHash: null, userAgent: null, mfaVerified: true, surface: null });
  return jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, sid }, process.env.JWT_SECRET, { expiresIn: '1h' }); };
const call = async (method, url, token, body) => {
  const res = await fetch(`${BASE}${url}`, { method, headers: Object.assign({}, token ? { Authorization: `Bearer ${token}` } : {}, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json().catch(() => ({})) : Buffer.from(await res.arrayBuffer()) };
};
const at = (ymd, hm) => t.instantFromZoned(ymd, hm);

const CARRIER = { id: 'cl_nora', role: 'client', email: 'nora@example.test', name: 'Nora Patel', serviceLine: 'PHC', enrollmentStatus: 'enrolled', consents: {},
  rateAgreement: { hourlyRate: 30, dailyMinimumHours: 4 }, intake: { ltc: { carrier: 'Genworth', policyNum: 'G-77' } } };
const FAMILY = { id: 'cl_ray', role: 'client', email: 'ray@example.test', name: 'Ray Ochoa', serviceLine: 'PHC', enrollmentStatus: 'enrolled', consents: {},
  rateAgreement: { hourlyRate: 32.5, dailyMinimumHours: 4 } };
const CLINICAL = { id: 'cl_ihpc', role: 'client', email: 'ivy@example.test', name: 'Ivy Clinic', serviceLine: 'IHPC', enrollmentStatus: 'enrolled', consents: {},
  rateAgreement: { hourlyRate: 30, dailyMinimumHours: 4 }, billing: { billTo: { type: 'family', name: 'Ivy Clinic', addressLines: [] } } };
const CG = { id: 'cg_tasha', role: 'vendor', email: 'tasha@example.test', name: 'Tara Gibbs', licenseLevel: 'pca' };
const ADMIN = { id: 'admin_inv', role: 'admin', email: 'invadmin@example.test', name: 'Inv Admin' };
const CM = { id: 'cm_inv', role: 'caseManager', email: 'cm@example.test', name: 'Cass CM' };
const log = (id, client, ymd, a, b) => ({ id, caregiver_id: CG.id, caregiver_name: CG.name, license_level: 'pca', client_id: client.id, client_name: client.name,
  clock_in_at: at(ymd, a), clock_out_at: at(ymd, b), total_minutes: Math.round((Date.parse(at(ymd, b)) - Date.parse(at(ymd, a))) / 60000) });

(async () => {
  STORE.set('users', [CARRIER, FAMILY, CLINICAL, CG, ADMIN, CM]);
  STORE.set('time_logs', [
    log('t1', CARRIER, '2026-10-06', '09:00', '13:52'),
    log('t2', CARRIER, '2026-10-08', '09:00', '13:16'),
    log('t3', FAMILY, '2026-09-29', '09:00', '11:00'),
    log('t4', FAMILY, '2026-10-07', '09:00', '14:00'),
    log('t5', CLINICAL, '2026-10-07', '09:00', '13:00'),
    { id: 't6', caregiver_id: CG.id, client_id: FAMILY.id, clock_in_at: at('2026-10-09', '09:00'), clock_out_at: null, total_minutes: null }
  ]);
  require(path.join(__dirname, '..', 'server.js'));
  await new Promise(r => setTimeout(r, 2500));
  const a = tok(ADMIN), cm = tok(CM), ct = tok(CARRIER);
  const period = { from: '2026-09-28', to: '2026-10-11' };

  console.log('\n── Who may ──');
  let r = await call('POST', '/api/gfc/admin/billing-invoices/preview', cm, { source: 'app', ...period });
  check('a case manager cannot generate invoices', r.status === 403);

  console.log('\n── Payers and Bill To ──');
  r = await call('POST', '/api/gfc/admin/billing-payers', a, { name: 'Sample LTC Co', attn: 'Claims Department', addressLines: 'P.O. Box 1\nColumbus, OH 43215', claimsEmail: 'claims@example.com' });
  const payer = r.body.payer;
  check('a carrier is added to the payers list', r.status === 200 && STORE.get('billing_payers').length === 1 && payer.addressLines.length === 2);
  r = await call('POST', '/api/gfc/admin/billing-payers', a, { name: 'sample ltc co' });
  check('the same carrier is not added twice', r.status === 409);
  r = await call('GET', `/api/gfc/admin/billing/${CARRIER.id}`, a);
  check('the client\'s enrollment LTC policy is offered, not filled in', r.body.ltcOnFile && r.body.ltcOnFile.policyNumber === 'G-77' && r.body.billTo === null);
  r = await call('POST', '/api/gfc/admin/billing-invoices/preview', a, { source: 'app', ...period });
  check('with no Bill To, each client is named and not invoiced', r.status === 200 && r.body.invoices.length === 0 && r.body.skipped.map(s => s.clientName).sort().join() === 'Nora Patel,Ray Ochoa');
  r = await call('PUT', `/api/gfc/admin/billing/${CARRIER.id}/bill-to`, a, { type: 'carrier', payerId: payer.id, insuredName: 'Nora Patel', policyNumber: 'G-77', claimNumber: 'A1' });
  check('a carrier Bill To is saved', r.status === 200 && STORE.get('users').find(u => u.id === CARRIER.id).billing.billTo.payerId === payer.id);
  r = await call('PUT', `/api/gfc/admin/billing/${FAMILY.id}/bill-to`, a, { type: 'family', name: 'Lena Ochoa', addressLines: '1 Main St\nAtlanta, GA 30301' });
  check('a family Bill To is saved', r.status === 200);

  console.log('\n── Generate from the app\'s hours ──');
  r = await call('POST', '/api/gfc/admin/billing-invoices/preview', a, { source: 'app', ...period });
  const pv = r.body;
  check('three invoices: two carrier (one per date), one family; the clinical client and the open shift left out',
    pv.invoices.map(i => i.displayNumber).join() === 'GFC-NP-261006,GFC-NP-261008,GFC-RO-261011', JSON.stringify(pv.invoices.map(i => i.displayNumber)));
  check('billed as worked from minutes: $146.00 and $128.00', pv.invoices[0].total === '$146.00' && pv.invoices[1].total === '$128.00');
  check('the family\'s 2-hour day gets its daily minimum as its own line', pv.invoices[2].lines.some(l => l.minimum) && pv.invoices[2].total === '$292.50');
  r = await call('POST', '/api/gfc/admin/billing-invoices', a, { source: 'app', ...period });
  check('drafts are made', r.status === 200 && r.body.created.length === 3);
  const stored = STORE.get('patient_invoices');
  const carrierInv = stored.find(i => i.displayNumber === 'GFC-NP-261006');
  check('a stored carrier invoice keeps its own Stripe reference and a frozen Bill To',
    /^GFC-INV-/.test(carrierInv.number) && carrierInv.billTo.policyNumber === 'G-77' && carrierInv.status === 'draft' && carrierInv.lines[0].sourceKey === 'log:t1');
  r = await call('POST', '/api/gfc/admin/billing-invoices/preview', a, { source: 'app', ...period });
  check('running it again bills nothing twice', r.body.invoices.length === 0 && r.body.alreadyInvoiced === 4);

  console.log('\n── The PDF ──');
  r = await call('GET', `/api/gfc/admin/billing/invoices/${carrierInv.id}/pdf`, a);
  const doc = await PDFDocument.load(r.body);
  const text = (await packetImport.extractRuns(doc)).map(x => x.text).join(' ').replace(/\s+/g, ' ');
  check('the PDF is one page, numbered GFC-NP-261006, with the policy number and $146.00',
    r.status === 200 && doc.getPageCount() === 1 && text.includes('Invoice # GFC-NP-261006') && text.includes('Policy #: G-77') && text.includes('$146.00') && text.includes('4.87 hrs (4 hr 52 min)'));
  check('it is served with its number as the file name', /GFC-NP-261006\.pdf/.test(r.headers.get('content-disposition') || ''));

  console.log('\n── The patient never sees the carrier\'s invoice ──');
  r = await call('POST', `/api/gfc/admin/billing/invoices/${carrierInv.id}/send`, a);
  check('Mark Sent works and emails the patient nothing', r.status === 200 && SENT.length === 0);
  r = await call('GET', '/api/gfc/billing', ct);
  check('the carrier invoice is not on the client\'s portal', r.status === 200 && !r.body.invoices.some(i => i.id === carrierInv.id) && r.body.balanceCents === 0);
  r = await call('POST', `/api/gfc/billing/invoices/${carrierInv.id}/pay`, ct);
  check('and cannot be paid online', r.status === 404);
  const famInv = STORE.get('patient_invoices').find(i => i.format === 'family');
  r = await call('POST', `/api/gfc/admin/billing/invoices/${famInv.id}/send`, a);
  check('a family invoice sent is announced to the client', r.status === 200 && SENT.some(m => m.to === FAMILY.email));

  console.log('\n── Import an hours file ──');
  // Void the 9/4 carrier invoice, then bring the same shift back in from the export.
  const sep4 = STORE.get('patient_invoices').find(i => i.displayNumber === 'GFC-NP-261008');
  await call('POST', `/api/gfc/admin/billing/invoices/${sep4.id}/void`, a, { reason: 'Re-run from the corrected file' });
  const row = (cl, ymd, a1, b1) => ({ caregiverName: CG.name, licenseLevel: 'PCA', clientName: cl.name, shiftDate: sched.csvDate(at(ymd, a1)),
    clockInAt: sched.csvTime(at(ymd, a1), ymd), clockOutAt: sched.csvTime(at(ymd, b1), ymd), hours: sched.minutesToHours(Math.round((Date.parse(at(ymd, b1)) - Date.parse(at(ymd, a1))) / 60000)) });
  const bad = sched.toPayrollCsv([row(CARRIER, '2026-10-08', '09:00', '13:16'), { ...row(CARRIER, '2026-10-09', '09:00', '13:00'), caregiverName: 'Nobody' }]);
  r = await call('POST', '/api/gfc/admin/billing-invoices/preview', a, { source: 'import', csv: bad, ...period });
  check('a file with a bad row imports nothing and names the row', r.status === 400 && r.body.code === 'IMPORT_ROWS_INVALID' && r.body.rowErrors[0].line === 3);
  const good = sched.toPayrollCsv([row(CARRIER, '2026-10-06', '09:00', '13:52'), row(CARRIER, '2026-10-08', '09:00', '13:16')]);
  r = await call('POST', '/api/gfc/admin/billing-invoices', a, { source: 'import', csv: good, fileName: 'payroll.csv', ...period });
  const reissued = STORE.get('patient_invoices').filter(i => i.source === 'import');
  check('only the voided date is invoiced again; the 9/2 shift already on a live invoice is left off',
    r.status === 200 && r.body.created.length === 1 && r.body.alreadyInvoiced === 1 && reissued.length === 1);
  check('the re-issued invoice takes the next number, never the voided one', reissued[0].displayNumber === 'GFC-NP-261008-2');
  const imp = STORE.get('invoice_hour_imports');
  check('the approved file is kept with the invoice made from it', imp.length === 1 && imp[0].invoiceIds[0] === reissued[0].id && imp[0].fileName === 'payroll.csv');

  const acts = JSON.stringify((STORE.get('activity_log') || []).filter(x => /invoice|payer|bill_to/.test(x.action || x.type || '')));
  check('the activity log carries counts and ids, never the client\'s policy number', !/G-77/.test(acts));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
