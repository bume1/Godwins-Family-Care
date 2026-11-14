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
  const filed = {}; const emails = [];
  const drive = {
    // Sam's Drive copy fails, as Drive sometimes does.
    uploadStaffDocumentFile: async (role, person, name, buf) => { if (person === 'Sam Aide') throw new Error('Drive down'); filed[`drv-${person}`] = buf; return { fileId: `drv-${person}` }; },
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
  return { store, emails, call, payroll };
}

test('approving payroll: each person gets a stub row, a link-only email, and a branded PDF they can open', async () => {
  const w = world();
  let r = await w.call('own', 'POST', '/api/payroll/admin/runs', { periodStart: '2026-11-02', schedule: 'caregivers' });
  const runId = r.body.run.id;
  // Sam is sent by Cash App this run, though a bank is on file.
  r = await w.call('own', 'PUT', `/api/payroll/admin/runs/${runId}/channel`, { default: 'direct_deposit', byUser: { cg2: 'p2p' } });
  assert.equal(r.status, 200);
  r = await w.call('own', 'POST', `/api/payroll/admin/runs/${runId}/approve`, { timesheetReason: 'test' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.stubs, { written: 2, pdfFailed: 1 });

  // The notice: one per person, no amount, links to their own pay page.
  assert.equal(w.emails.length, 2);
  for (const [type, , email, , data] of w.emails) {
    assert.equal(type, 'paystub_ready');
    assert.match(data.body, /payday November 13, 2026 is ready/);
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
  assert.match(t1, /Direct deposit to account ending 4321/);
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
  assert.match(t2, /P2P by Cash App from \$GodwinsFamilyCare/, 'the stub says how this run paid them');
  assert.doesNotMatch(t2, /account ending 4321/);

  // Nobody opens someone else's stub.
  r = await w.call('cg1', 'GET', `/api/my/paystubs/${sam.id}/file`);
  assert.equal(r.status, 404);
});

test('a stub drawn again later keeps its own year to date, not a later run\'s', async () => {
  const w = world();
  let r = await w.call('own', 'POST', '/api/payroll/admin/runs', { periodStart: '2026-11-02', schedule: 'caregivers' });
  await w.call('own', 'POST', `/api/payroll/admin/runs/${r.body.run.id}/approve`, { timesheetReason: 'test' });
  const row = w.store.get('staff_paystubs').find(x => x.userId === 'cg1');
  const before = text(await w.payroll.stubPdfForRow(row));
  // A later week is paid.
  w.store.set('time_logs', [...w.store.get('time_logs'), log('d', 'cg1', '2026-11-10', 480)]);
  r = await w.call('own', 'POST', '/api/payroll/admin/runs', { periodStart: '2026-11-09', schedule: 'caregivers' });
  await w.call('own', 'POST', `/api/payroll/admin/runs/${r.body.run.id}/approve`, { timesheetReason: 'test' });
  const after = text(await w.payroll.stubPdfForRow(row));
  assert.equal(after, before, 'the Nov 13 stub reads the same after a later payday');
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
