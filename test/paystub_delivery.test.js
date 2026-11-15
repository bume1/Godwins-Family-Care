'use strict';
// Pay stub delivery, end to end (audit, owner, 2026-11-14): approving payroll
// writes a stub for each person into the store My GFC lists, emails a
// link-only notice, and the employee downloads a branded PDF that says how
// this run actually paid them. A stub whose Drive copy failed is drawn again
// from its run rather than leaving the employee a notice they cannot open.
// Every check goes through the routes payroll and My GFC really use.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const pp = require('../payrollProfiles');
const T = require('../payrollTaxTables');

const users = [
  { id: 'own', role: 'admin', name: 'Owner', email: 'o@x' },
  { id: 'cg1', role: 'vendor', licenseLevel: 'pca', accountType: 'caregiver', name: 'Pat Care', email: 'p@x', payRate: 18 },
  { id: 'cg2', role: 'vendor', licenseLevel: 'pca', accountType: 'caregiver', name: 'Sam Aide', email: 's@x', payRate: 20 }
];
const log = (id, uid, d, mins) => ({ id, caregiver_id: uid, client_id: 'c1', shift_id: null, clock_in_at: `${d}T14:00:00Z`, clock_out_at: `${d}T22:00:00Z`, total_minutes: mins });
const prof = (u) => ({ ...pp.defaultProfile(u), payMethod: { method: 'direct_deposit', bankName: 'PNC', accountLast4: '4321' }, ssn: { last4: '1111' }, w4: { filingStatus: 'single' }, g4: { filingStatus: 'A' }, i9: { section1: {}, section2: {} } });
const text = (buf) => {
  const f = path.join(os.tmpdir(), `stub-${process.pid}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(f, buf);
  try { return execFileSync('pdftotext', ['-layout', f, '-']).toString(); } finally { fs.unlinkSync(f); }
};

function world() {
  const store = new Map();
  const db = { get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
  const filed = {}; const emails = []; const folders = [];
  const drive = {
    uploadStaffDocumentFile: async () => { throw new Error('a pay stub is never filed in a role documents folder'); },
    // The finance folder (owner, 2026-11-14). Sam's filing fails, as Drive sometimes does.
    uploadPayStubFile: async (base, payDate, name, buf) => { folders.push({ base, payDate, name }); if (/Sam Aide/.test(name)) throw new Error('Drive down'); const id = `drv-${name}`; filed[id] = buf; return { fileId: id }; },
    downloadFileBuffer: async (id) => { if (!filed[id]) throw new Error('File not found'); return filed[id]; }
  };
  let me = users[0];
  const auth = (req, res, next) => { req.user = me; next(); };
  const payroll = require('../routes/payroll')({
    db, env: { PAYROLL_ENCRYPTION_KEY: 'a'.repeat(64) }, payrollKey: 'k'.repeat(40), logActivity: async () => {}, getUsers: async () => users,
    authenticateToken: auth, requireAdmin: (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({})),
    uuidv4: (() => { let n = 0; return () => `id${++n}`; })(), accountTypeOf: (u) => (u.role === 'admin' ? 'admin' : 'caregiver'), localDate: (v) => String(v).slice(0, 10),
    resolvePayRate: (u) => ({ rate: u && u.payRate, source: 'base' }), queueNotification: async (...a) => emails.push(a), hashIp: () => 'h',
    pdf: require('../pdf-generator'), drive, roleFolderFor: () => 'F', personFolderName: (n) => n, getAppBaseUrl: async () => 'https://app.example'
  });
  const portal = require('../routes/staffPortal')({ db, logActivity: async () => {}, getUsers: async () => users, authenticateToken: auth, uuidv4: () => 'u',
    drive, regeneratePayStub: (row) => payroll.stubPdfForRow(row) });
  const app = express(); app.use(express.json()); app.use(portal); app.use(payroll);
  store.set('time_logs', [log('a', 'cg1', '2026-11-02', 480), log('b', 'cg1', '2026-11-03', 480), log('c', 'cg2', '2026-11-04', 420)]);
  store.set('payroll_settings', { gaSutaRatePct: 2.7, employerEin: '12-3456789', schedules: { caregivers: { frequency: 'weekly', anchor: '2026-11-02', payDateOffsetDays: 5 } } });
  store.set('payroll_tax_tables', T.seedRows([], { uuid: () => Math.random().toString(36), at: 'x' }).map(t => ({ ...t, status: 'active', approvedAt: 'x' })));
  store.set('payroll_profiles', { cg1: prof(users[1]), cg2: prof(users[2]) });
  const call = async (as, method, url, body) => {
    me = users.find(u => u.id === as);
    const srv = app.listen(0);
    try {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const buf = Buffer.from(await r.arrayBuffer());
      return { status: r.status, buf, body: (() => { try { return JSON.parse(buf.toString()); } catch (e) { return {}; } })() };
    } finally { srv.close(); }
  };
  return { store, emails, call, payroll, folders };
}

test('a stub goes out when its payment is marked paid, with the receipt, filed in the finance folder, and opens branded', async () => {
  const w = world();
  let r = await w.call('own', 'POST', '/api/payroll/admin/runs', { periodStart: '2026-11-02', schedule: 'caregivers' });
  const runId = r.body.run.id;
  // Sam is sent by Cash App this run, though a bank is on file.
  r = await w.call('own', 'PUT', `/api/payroll/admin/runs/${runId}/channel`, { default: 'direct_deposit', byUser: { cg2: 'p2p' } });
  assert.equal(r.status, 200);
  r = await w.call('own', 'POST', `/api/payroll/admin/runs/${runId}/approve`, { timesheetReason: 'test' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.stubs.written, 0, 'approval issues no stub');
  assert.equal(w.emails.length, 0, 'and emails nobody');
  assert.equal((await w.call('cg1', 'GET', '/api/my/paystubs')).body.paystubs.length, 0, 'nothing to see before the money is sent');
  r = await w.call('own', 'POST', `/api/payroll/admin/runs/${runId}/payments/cg1`, { confirmation: 'PNC-778812' });
  assert.equal(r.body.stub.written, 1);
  assert.equal((await w.call('cg2', 'GET', '/api/my/paystubs')).body.paystubs.length, 0, 'Sam is not paid yet');
  r = await w.call('own', 'POST', `/api/payroll/admin/runs/${runId}/payments/cg2`, { confirmation: 'CASH-4F7Q2' });
  assert.equal(r.body.stub.pdfFailed, 1);
  assert.deepEqual(w.folders.map(f => [f.base, f.payDate]), [[null, '2026-11-13'], [null, '2026-11-13']], 'filed in the finance folder by payday');
  assert.match(w.folders[0].name, /^Pay stub 2026-11-13 - Pat Care\.pdf$/);

  // The notice: one per person as their pay is sent, no amount, links to their own pay page.
  assert.equal(w.emails.length, 2);
  for (const [type, , email, , data] of w.emails) {
    assert.equal(type, 'paystub_ready');
    assert.match(data.body, /payday November 13, 2026 has been sent, and your pay stub is ready/);
    assert.doesNotMatch(JSON.stringify(data), /\$|\d+\.\d\d/, 'the email never carries an amount');
    assert.equal(data.ctaUrl, 'https://app.example/caregiver#hours', `${email} is sent to their pay page`);
  }

  // Pat: listed, opens, branded, paid by direct deposit.
  r = await w.call('cg1', 'GET', '/api/my/paystubs');
  assert.equal(r.body.paystubs.length, 1, 'a person sees only their own stub');
  const pat = r.body.paystubs[0];
  assert.equal(pat.hasPdf, true); assert.equal(pat.payDate, '2026-11-13');
  r = await w.call('cg1', 'GET', `/api/my/paystubs/${pat.id}/file`);
  assert.equal(r.status, 200); assert.equal(r.buf.slice(0, 5).toString(), '%PDF-');
  const t1 = text(r.buf);
  assert.match(t1, /PAY STUB/); assert.match(t1, /Godwins Family Care LLC/); assert.match(t1, /EIN 12-3456789/);
  assert.match(t1, /Pat Care/); assert.match(t1, /Pay date 11\/13\/2026/);
  assert.match(t1, /Direct deposit to account ending 4321 · Receipt PNC-778812 · sent /);
  assert.doesNotMatch(t1, /Sam Aide/);

  // Sam: Drive failed, so the stub is drawn from the run, and it says Cash App.
  r = await w.call('cg2', 'GET', '/api/my/paystubs');
  const sam = r.body.paystubs[0];
  assert.equal(sam.hasPdf, true, 'a Drive failure never leaves a stub without a PDF');
  assert.equal(w.store.get('staff_paystubs').find(x => x.userId === 'cg2').driveFileId, null);
  r = await w.call('cg2', 'GET', `/api/my/paystubs/${sam.id}/file`);
  assert.equal(r.status, 200);
  const t2 = text(r.buf);
  assert.match(t2, /Sam Aide/);
  assert.match(t2, /P2P by Cash App from \$GodwinsFamilyCare · Receipt CASH-4F7Q2/, 'how this run paid them, and the receipt');
  assert.doesNotMatch(t2, /account ending 4321/);

  // Nobody opens someone else's stub.
  r = await w.call('cg1', 'GET', `/api/my/paystubs/${sam.id}/file`);
  assert.equal(r.status, 404);
});

test('a stub reads as issued: its own year to date, and the bank and SSN as they were that payday', async () => {
  const w = world();
  let r = await w.call('own', 'POST', '/api/payroll/admin/runs', { periodStart: '2026-11-02', schedule: 'caregivers' });
  await w.call('own', 'POST', `/api/payroll/admin/runs/${r.body.run.id}/approve`, { timesheetReason: 'test' });
  await w.call('own', 'POST', `/api/payroll/admin/runs/${r.body.run.id}/payments/cg1`, { confirmation: 'PNC-1' });
  const row = w.store.get('staff_paystubs').find(x => x.userId === 'cg1');
  const before = text(await w.payroll.stubPdfForRow(row));
  // A later week is paid, and they change bank and SSN afterwards.
  w.store.set('time_logs', [...w.store.get('time_logs'), log('d', 'cg1', '2026-11-10', 480)]);
  r = await w.call('own', 'POST', '/api/payroll/admin/runs', { periodStart: '2026-11-09', schedule: 'caregivers' });
  await w.call('own', 'POST', `/api/payroll/admin/runs/${r.body.run.id}/approve`, { timesheetReason: 'test' });
  const prof = w.store.get('payroll_profiles');
  prof.cg1 = { ...prof.cg1, payMethod: { ...prof.cg1.payMethod, accountLast4: '9999' }, ssn: { ...prof.cg1.ssn, last4: '2222' } };
  w.store.set('payroll_profiles', prof);
  const after = text(await w.payroll.stubPdfForRow(row));
  assert.equal(after, before, 'the Nov 13 stub reads the same after a later payday and new details');
  assert.match(after, /4321/); assert.doesNotMatch(after, /9999/);
  assert.equal(await w.payroll.stubPdfForRow({ userId: 'cg1' }), null, 'a stub not from an app run is not drawn');
});

test('My GFC reads a payday still ahead as Payday, not Paid', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'my-gfc.js'), 'utf8');
  assert.match(src, /p\.payDate > todayYmd\(\) \? 'Payday' : 'Paid'/);
  assert.match(src, /timeZone: 'America\/New_York'/);
});

// Lines added by hand (owner, 2026-11-14): a bonus shows as its own line on
// the draft, in the register CSV and on the stub, not only as a bigger gross.
test('a bonus is its own line in the register CSV and on the stub, and can be removed from a draft', async () => {
  const w = world();
  let r = await w.call('own', 'POST', '/api/payroll/admin/runs', { periodStart: '2026-11-02', schedule: 'caregivers' });
  const runId = r.body.run.id;
  r = await w.call('own', 'POST', `/api/payroll/admin/runs/${runId}/adjustments`, { userId: 'cg1', type: 'bonus', amount: '50', note: 'Emergency Tuesday hours' });
  assert.equal(r.status, 200);
  r = await w.call('own', 'POST', `/api/payroll/admin/runs/${runId}/adjustments`, { userId: 'cg1', type: 'bonus', amount: '10', note: 'Entered twice by mistake' });
  const extra = r.body.run.adjustments.find(a => a.amountCents === 1000);
  r = await w.call('own', 'DELETE', `/api/payroll/admin/runs/${runId}/adjustments/${extra.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.run.adjustments.map(a => a.amountCents), [5000], 'the mistaken line is gone');
  const pat = r.body.run.workers.find(x => x.userId === 'cg1');
  assert.ok(pat.earnings.some(e => e.code === 'bonus' && e.amountCents === 5000));
  // Register CSV: a Bonus column and the line named with its note.
  r = await w.call('own', 'GET', `/api/payroll/admin/runs/${runId}/register.csv`);
  const csv = r.buf.toString().trim().split('\r\n');
  const head = csv[0].split('","').map(x => x.replace(/"/g, ''));
  const row = csv.find(l => l.startsWith('"Pat Care"'));
  const cells = row.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(c => c.replace(/,$/, '').replace(/^"|"$/g, ''));
  assert.equal(cells[head.indexOf('Bonus')], '50.00');
  assert.equal(cells[head.indexOf('Regular Pay')], '288.00', '16 hours at $18');
  assert.match(cells[head.indexOf('Added Lines')], /Bonus \$50\.00: Emergency Tuesday hours/);
  assert.equal(Number(cells[head.indexOf('Gross')]), 338, 'gross is regular pay plus the bonus');
  // Approved: the stub lists the bonus with its note.
  r = await w.call('own', 'POST', `/api/payroll/admin/runs/${runId}/approve`, { timesheetReason: 'test' });
  await w.call('own', 'POST', `/api/payroll/admin/runs/${runId}/payments/cg1`, { confirmation: 'PNC-9' });
  const stub = w.store.get('staff_paystubs').find(x => x.userId === 'cg1');
  const t = text(await w.payroll.stubPdfForRow(stub));
  assert.match(t, /Bonus · Emergency Tuesday hours\s+\$50\.00/);
  // An approved run's lines cannot be removed.
  r = await w.call('own', 'DELETE', `/api/payroll/admin/runs/${runId}/adjustments/${pat.earnings ? r.body.run.adjustments[0].id : ''}`);
  assert.equal(r.body.code, 'RUN_LOCKED');
});

test('taxes entered by hand warn when a later line changes gross', async () => {
  const w = world();
  let r = await w.call('own', 'POST', '/api/payroll/admin/runs', { periodStart: '2026-11-02', schedule: 'caregivers' });
  const runId = r.body.run.id;
  r = await w.call('own', 'PUT', `/api/payroll/admin/runs/${runId}/manual-taxes/cg1`, { federal: '0', socialSecurity: '17.86', medicare: '4.18', stateTax: '0', reason: 'W-4 pending' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let pat = r.body.run.workers.find(x => x.userId === 'cg1');
  assert.equal(pat.manualTaxes.grossChanged, false);
  assert.equal(pat.manualTaxes.grossCents, 28800);
  r = await w.call('own', 'POST', `/api/payroll/admin/runs/${runId}/adjustments`, { userId: 'cg1', type: 'bonus', amount: '50', note: 'Holiday' });
  pat = r.body.run.workers.find(x => x.userId === 'cg1');
  assert.equal(pat.manualTaxes.grossChanged, true, 'gross moved after the taxes were entered');
  assert.equal(pat.pay.taxes.socialSecurity, 1786, 'hand-entered taxes are not changed by the app');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'payroll.html'), 'utf8');
  assert.match(page, /manualTaxes\.grossChanged && <div/);
});

// The runs list says how a run was sent and how far it is paid (owner,
// 2026-11-14: a run sent by Cash App read only "approved").
test('the runs list shows P2P and how many payments are marked paid; Paid once all are', async () => {
  const w = world();
  let r = await w.call('own', 'POST', '/api/payroll/admin/runs', { periodStart: '2026-11-02', schedule: 'caregivers' });
  const runId = r.body.run.id;
  await w.call('own', 'PUT', `/api/payroll/admin/runs/${runId}/channel`, { default: 'p2p' });
  await w.call('own', 'POST', `/api/payroll/admin/runs/${runId}/approve`, { timesheetReason: 'test' });
  const row = async () => (await w.call('own', 'GET', '/api/payroll/admin/overview')).body.runs.find(x => x.id === runId);
  let x = await row();
  assert.equal(x.status, 'approved'); assert.equal(x.p2p, 2); assert.equal(x.people, 2); assert.equal(x.markedPaid, 0);
  r = await w.call('own', 'POST', `/api/payroll/admin/runs/${runId}/payments/cg1`, {});
  assert.match(r.body.error, /Cash App/, 'the prompt names Cash App');
  await w.call('own', 'POST', `/api/payroll/admin/runs/${runId}/payments/cg1`, { confirmation: 'CA-1' });
  x = await row();
  assert.equal(x.status, 'approved'); assert.equal(x.markedPaid, 1);
  await w.call('own', 'POST', `/api/payroll/admin/runs/${runId}/payments/cg2`, { confirmation: 'CA-2' });
  x = await row();
  assert.equal(x.status, 'paid'); assert.equal(x.markedPaid, 2);
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'payroll.html'), 'utf8');
  assert.match(page, /r\.p2p === r\.people \? 'P2P'/);
  assert.match(page, /marked paid\. Open it and mark each payment on the Payment Sheet/);
});

// A run already paid before stubs carried the receipt (Tasha's, 2026-11-14):
// its stub opens with the receipt at once, and Redo Pay Stubs files it again
// in the finance folder without emailing anyone. The folder is a setting.
test('an earlier stub shows its receipt, Redo Pay Stubs files it again quietly, and the finance folder is set by link', async () => {
  const w = world();
  let r = await w.call('own', 'POST', '/api/payroll/admin/runs', { periodStart: '2026-11-02', schedule: 'caregivers' });
  const runId = r.body.run.id;
  await w.call('own', 'POST', `/api/payroll/admin/runs/${runId}/approve`, { timesheetReason: 'test' });
  r = await w.call('own', 'POST', `/api/payroll/admin/runs/${runId}/stubs`);
  assert.equal(r.body.code, 'STUBS_NONE_PAID', 'nothing to issue before anyone is paid');
  await w.call('own', 'POST', `/api/payroll/admin/runs/${runId}/payments/cg1`, { confirmation: 'CASH-77' });
  // Make it look like a stub issued the old way: at approval, no receipt.
  const rows = w.store.get('staff_paystubs');
  rows[0] = { ...rows[0], final: undefined, snap: undefined, driveFileId: 'old' };
  w.store.set('staff_paystubs', rows);
  r = await w.call('cg1', 'GET', `/api/my/paystubs/${rows[0].id}/file`);
  assert.equal(r.status, 200);
  assert.match(text(r.buf), /Receipt CASH-77/, 'the earlier stub opens with its receipt');
  // Settings: a folder link is kept as its id; anything else is refused.
  r = await w.call('own', 'PUT', '/api/payroll/admin/settings', { payStubFolder: 'not a folder' });
  assert.equal(r.body.code, 'PAY_STUB_FOLDER');
  r = await w.call('own', 'PUT', '/api/payroll/admin/settings', { payStubFolder: 'https://drive.google.com/drive/folders/1J5uvQyKt6FWVcbTESTabc?usp=sharing' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const emailsBefore = w.emails.length;
  r = await w.call('own', 'POST', `/api/payroll/admin/runs/${runId}/stubs`);
  assert.equal(r.status, 200); assert.equal(r.body.written, 1);
  assert.equal(w.emails.length, emailsBefore, 'nobody is emailed again');
  assert.equal(w.folders[w.folders.length - 1].base, '1J5uvQyKt6FWVcbTESTabc', 'filed in the folder set');
  assert.equal(w.store.get('staff_paystubs').length, 1, 'the same stub, replaced, not a second one');
  assert.equal(w.store.get('staff_paystubs')[0].final, true);
});

// Past Gusto pay dates recorded as a check but sent by Zelle or Cash App
// (owner, 2026-11-14): corrected in the records and on the stubs, openly,
// for Gusto history only. Amounts never change and nobody is emailed.
test('a Gusto check pay date sent by Zelle or Cash App is corrected openly on the stub and in the register, Gusto history only', async () => {
  const w = world();
  const gustoRun = (payDate, start, end) => ({ id: `gusto:${payDate}:${start}:${end}`, status: 'paid', source: 'gusto', period: { start, end, payDate }, payments: {},
    workers: [{ userId: 'cg1', name: 'Pat Care', workerType: 'W2', payMethod: 'check', refs: [], missing: [], imported: { from: 'Gusto', workState: 'GA' },
      earnings: [{ code: 'regular', label: 'Regular', minutes: 600, rateCents: 1800, amountCents: 18000 }],
      pay: { grossCents: 18000, taxes: { federal: 0, socialSecurity: 1116, medicare: 261, georgia: 500 }, taxCents: 1877, reimbursementsCents: 0, netCents: 16123, workState: 'GA', employer: { socialSecurity: 1116, medicare: 261, futa: 108, gaSuta: 486 } } }] });
  const A = gustoRun('2026-10-30', '2026-10-19', '2026-10-25'), B = gustoRun('2026-10-23', '2026-10-12', '2026-10-18');
  w.store.set('payroll_runs', [A, B]);
  // The run shows the person's other Gusto paydays to tick.
  let r = await w.call('own', 'GET', `/api/payroll/admin/runs/${encodeURIComponent(A.id)}`);
  assert.deepEqual(r.body.run.correctionOptions.cg1.map(o => [o.payDate, o.recordedAs]), [['2026-10-23', 'check']]);
  // A reason and a real method are required; only the Super Admin corrects.
  r = await w.call('own', 'POST', `/api/payroll/admin/runs/${encodeURIComponent(A.id)}/payment-correction`, { userId: 'cg1', method: 'zelle' });
  assert.equal(r.body.code, 'PAYMENT_CORRECTION_REASON');
  r = await w.call('own', 'POST', `/api/payroll/admin/runs/${encodeURIComponent(A.id)}/payment-correction`, { userId: 'cg1', method: 'venmo', reason: 'x' });
  assert.equal(r.body.code, 'PAYMENT_CORRECTION_METHOD');
  r = await w.call('cg1', 'POST', `/api/payroll/admin/runs/${encodeURIComponent(A.id)}/payment-correction`, { userId: 'cg1', method: 'zelle', reason: 'x' });
  assert.equal(r.status, 403);
  const emailsBefore = w.emails.length;
  r = await w.call('own', 'POST', `/api/payroll/admin/runs/${encodeURIComponent(A.id)}/payment-correction`, { userId: 'cg1', method: 'zelle', receipt: 'ZL-889', sentOn: '2026-10-30', reason: 'Gusto check run; paid by Zelle while direct deposit was set up', alsoRunIds: [B.id] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.corrected, ['2026-10-30', '2026-10-23']);
  assert.equal(w.emails.length, emailsBefore, 'nobody is emailed');
  const stubs = w.store.get('staff_paystubs');
  assert.equal(stubs.length, 2); assert.ok(stubs.every(x => x.final && /^drv-Pay stub/.test(x.driveFileId)), 'filed again in the finance folder');
  const tA = text(await w.payroll.stubPdfForRow(stubs.find(x => x.payDate === '2026-10-30')));
  assert.match(tA, /Payment: Zelle \(P2P\) · Receipt ZL-889 · sent Oct 30, 2026\. Payroll run in Gusto, which recorded it as a paper check; corrected by the\s+office on /);
  assert.match(tA, /\$161\.23/, 'the amount is unchanged');
  const tB = text(await w.payroll.stubPdfForRow(stubs.find(x => x.payDate === '2026-10-23')));
  assert.match(tB, /Payment: Zelle \(P2P\)\. Payroll run in Gusto, which recorded it as a paper check/);
  // Cash App reads apart from Zelle, and a later correction adds to the history.
  await w.call('own', 'POST', `/api/payroll/admin/runs/${encodeURIComponent(B.id)}/payment-correction`, { userId: 'cg1', method: 'cashapp', receipt: 'CA-5', reason: 'It was Cash App that week' });
  assert.match(text(await w.payroll.stubPdfForRow(w.store.get('staff_paystubs').find(x => x.payDate === '2026-10-23'))), /Payment: Cash App \(P2P\) · Receipt CA-5/);
  const hist = w.store.get('payroll_payment_corrections');
  assert.equal(hist.length, 3, 'nothing is erased');
  assert.ok(hist[2].replaces === hist[1].id && hist.every(c => c.recordedAs === 'check'));
  // The register says both: how it was sent and what Gusto recorded.
  r = await w.call('own', 'GET', `/api/payroll/admin/runs/${encodeURIComponent(A.id)}/register.csv`);
  const [head, row] = r.buf.toString().trim().split('\r\n');
  const col = (name) => row.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(c => c.replace(/,$/, '').replace(/^"|"$/g, ''))[head.split('","').map(x => x.replace(/"/g, '')).indexOf(name)];
  assert.equal(col('Pay Method'), 'Zelle'); assert.equal(col('Payment Confirmation'), 'ZL-889');
  assert.equal(col('Recorded In Gusto As'), 'check'); assert.match(col('Payment Correction'), /paid by Zelle/);
  // Importing the Gusto file again (fresh runs) keeps the correction.
  w.store.set('payroll_runs', [gustoRun('2026-10-30', '2026-10-19', '2026-10-25'), gustoRun('2026-10-23', '2026-10-12', '2026-10-18')]);
  assert.match(text(await w.payroll.stubPdfForRow(w.store.get('staff_paystubs').find(x => x.payDate === '2026-10-30'))), /Zelle \(P2P\) · Receipt ZL-889/);
  // A pay date run in the app is never corrected this way.
  r = await w.call('own', 'POST', '/api/payroll/admin/runs', { periodStart: '2026-11-02', schedule: 'caregivers' });
  r = await w.call('own', 'POST', `/api/payroll/admin/runs/${r.body.run.id}/payment-correction`, { userId: 'cg1', method: 'zelle', reason: 'x' });
  assert.equal(r.body.code, 'PAYMENT_CORRECTION_GUSTO_ONLY');
});
