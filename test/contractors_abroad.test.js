'use strict';
// Contractors outside the U.S. and uploaded invoices (owner, 2026-11-13):
// a W-8BEN instead of a W-9 and no 1099, Wise or an international wire as the
// Settings allow, invoices as a PDF or spreadsheet with a total, reviewed by
// managers and care coordinators, and paid only by the Super Admin.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const pp = require('../payrollProfiles');
const g = require('../govForms');

let seq = 0;
function harness(store = new Map()) {
  const db = { get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
  const users = [
    { id: 'own', role: 'admin', name: 'Owner', email: 'o@x' },
    { id: 'mgr', role: 'user', isManager: true, accountType: 'manager', name: 'Mary Manager', email: 'm@x' },
    { id: 'ana', role: 'user', accountType: 'liaison', name: 'Ana Lima', email: 'a@x', employmentType: '1099' },
    { id: 'cg1', role: 'vendor', licenseLevel: 'pca', name: 'Pat Care', email: 'p@x' }
  ];
  const files = new Map(); const notices = [];
  const app = (as) => {
    const routes = require('../routes/payroll')({
      db, env: { PAYROLL_ENCRYPTION_KEY: 'a'.repeat(64) }, payrollKey: 'k'.repeat(40), logActivity: async () => {}, getUsers: async () => users,
      authenticateToken: (req, res, next) => { req.user = users.find(u => u.id === as); next(); },
      requireAdmin: (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'no' })),
      uuidv4: () => `id${++seq}`, accountTypeOf: (u) => (u.role === 'admin' ? 'admin' : u.accountType || (u.licenseLevel ? 'caregiver' : 'coordinator')), localDate: (v) => String(v).slice(0, 10),
      resolvePayRate: () => ({ rate: 18 }), queueNotification: async (...a) => notices.push(a), hashIp: () => 'h', pdf: require('../pdf-generator'),
      drive: {
        uploadStaffDocumentFile: async (role, who, name, buf) => { const id = `f${files.size + 1}`; files.set(id, Buffer.from(buf)); return { fileId: id }; },
        downloadFileBuffer: async (id) => files.get(id)
      },
      roleFolderFor: () => 'F', personFolderName: (n) => n, getAppBaseUrl: async () => 'https://app'
    });
    const a = express(); a.use(express.json({ limit: '20mb' })); a.use(routes); return a;
  };
  const call = async (as, method, url, body) => {
    const srv = app(as).listen(0);
    try {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const type = r.headers.get('content-type') || '';
      return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
    } finally { srv.close(); }
  };
  return { store, call, files, notices };
}
const W8 = { name: 'Ana Lima', citizenship: 'Brazil', permLine: 'Rua das Flores 10', permCity: 'Sao Paulo 01000-000', permCountry: 'Brazil', dob: '1991-02-03', foreignTin: '123.456.789-00', signedName: 'Ana Lima', agree: true };

test('W-8BEN: a U.S. address or citizenship is refused, a tax ID or the "not required" tick is needed', () => {
  const ctx = { at: '2026-11-13T10:00:00Z' };
  assert.equal(pp.normalizeW8BEN({ ...W8, citizenship: 'United States' }, ctx).code, 'W8_CITIZENSHIP');
  assert.equal(pp.normalizeW8BEN({ ...W8, permCountry: 'USA' }, ctx).code, 'W8_US_ADDRESS');
  assert.equal(pp.normalizeW8BEN({ ...W8, foreignTin: '' }, ctx).code, 'W8_FTIN');
  assert.ok(!pp.normalizeW8BEN({ ...W8, foreignTin: '', ftinNotRequired: true }, ctx).error);
  const n = pp.normalizeW8BEN(W8, ctx);
  assert.equal(n.foreignTin, '123.456.789-00');
  assert.ok(!JSON.stringify(n.value).includes('123.456.789-00'), 'the tax ID is returned apart, for sealing');
  const p = { ...pp.defaultProfile({ id: 'x', role: 'user' }), workerType: '1099', taxResidence: 'foreign', payMethod: { method: 'wise' } };
  assert.deepEqual(pp.missingForPay(p, { asContractor: true }), ['W-8BEN']);
  assert.deepEqual(pp.missingForPay({ ...p, w8ben: n.value }, { asContractor: true }), []);
  assert.deepEqual(pp.missingForPay({ ...p, taxResidence: 'us' }, { asContractor: true }), ['W-9'], 'a U.S. contractor still owes a W-9');
});

test('W-8BEN fills the IRS form', async () => {
  const n = pp.normalizeW8BEN(W8, { at: '2026-11-13T10:00:00Z' });
  const { PDFDocument } = require('pdf-lib');
  const f = (await PDFDocument.load(await g.fillW8BEN({ w8: n.value, tins: { foreignTin: n.foreignTin } }))).getForm();
  assert.equal(f.getFields().length, 0, 'flattened');
  const fs = require('fs'), os = require('os'), path = require('path');
  const file = path.join(os.tmpdir(), `w8-${process.pid}.pdf`);
  fs.writeFileSync(file, await g.fillW8BEN({ w8: n.value, tins: { foreignTin: n.foreignTin } }));
  const t = require('child_process').execFileSync('pdftotext', ['-layout', file, '-'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  fs.unlinkSync(file);
  assert.match(t, /Ana Lima/); assert.match(t, /Brazil/); assert.match(t, /123\.456\.789-00/); assert.match(t, /02-03-1991/); assert.match(t, /\/s\/ Ana Lima/);
});

test('abroad is off until Settings turn it on; then W-8BEN, a wire, and no 1099', async () => {
  const h = harness();
  h.store.set('payroll_profiles', { ana: { ...pp.defaultProfile({ id: 'ana', role: 'user' }), workerType: '1099' } });
  let r = await h.call('ana', 'PUT', '/api/my/pay-setup/tax-residence', { residence: 'foreign' });
  assert.equal(r.body.code, 'OVERSEAS_OFF');
  assert.equal((await h.call('own', 'PUT', '/api/payroll/admin/settings', { overseas: { enabled: true, payMethods: [] } })).body.code, 'OVERSEAS_METHODS');
  r = await h.call('own', 'PUT', '/api/payroll/admin/settings', { overseas: { enabled: true, payMethods: ['wise', 'intl_wire'] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await h.call('ana', 'PUT', '/api/my/pay-setup/tax-residence', { residence: 'foreign' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.profile.checklist.some(c => c.key === 'w8ben'), 'a W-8BEN row');
  assert.ok(!r.body.profile.checklist.some(c => c.key === 'w9'), 'no W-9 row');
  r = await h.call('ana', 'PUT', '/api/my/pay-setup/w8ben', W8);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await h.call('ana', 'PUT', '/api/my/pay-setup/pay-method', { method: 'intl_wire', bankName: 'Banco X', bankCountry: 'Brazil', swift: 'BRASBRRJ', iban: 'BR1500000000000010932840814P2' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.profile.payMethod.accountLast4, '8142', 'the last four digits');
  const raw = JSON.stringify(h.store.get('payroll_profiles'));
  for (const secret of ['BR1500000000000010932840814P2', '123.456.789-00']) assert.ok(!raw.includes(secret), `${secret} sealed`);
  assert.ok(!JSON.stringify(r.body).includes('123.456.789-00'));
  // A U.S. contractor cannot pick the wire.
  h.store.set('payroll_profiles', { ...h.store.get('payroll_profiles'), cg1: { ...pp.defaultProfile({ id: 'cg1', role: 'user' }), workerType: '1099', taxResidence: 'us' } });
  assert.equal((await h.call('cg1', 'PUT', '/api/my/pay-setup/pay-method', { method: 'intl_wire', bankName: 'B', bankCountry: 'C', swift: 'BRASBRRJ', iban: 'ABC123456' })).body.code, 'WIRE_NOT_OFFERED');
  r = await h.call('ana', 'GET', '/api/my/pay-setup/forms/w8ben.pdf');
  assert.equal(r.status, 200); assert.equal(r.body.slice(0, 5).toString(), '%PDF-');
});

test('invoices: upload a PDF with its total; managers review, only the Super Admin pays; wrong files refused', async () => {
  const h = harness();
  h.store.set('payroll_profiles', { ana: { ...pp.defaultProfile({ id: 'ana', role: 'user' }), workerType: '1099', taxResidence: 'us', w9: { name: 'Ana' }, payMethod: { method: 'check' } } });
  const pdf = Buffer.from('%PDF-1.4\n% test invoice\n').toString('base64');
  const base = { invoiceNo: 'INV-7', periodStart: '2026-11-01', periodEnd: '2026-11-07' };
  assert.equal((await h.call('ana', 'POST', '/api/my/contractor-invoices', { ...base, lines: [] })).body.code, 'CI_NO_LINES');
  assert.equal((await h.call('ana', 'POST', '/api/my/contractor-invoices', { ...base, attachment: { name: 'a.exe', dataBase64: Buffer.from('MZ').toString('base64') }, total: '10' })).body.code, 'CI_FILE_TYPE');
  assert.equal((await h.call('ana', 'POST', '/api/my/contractor-invoices', { ...base, attachment: { name: 'inv.pdf', dataBase64: pdf } })).body.code, 'CI_TOTAL');
  assert.equal((await h.call('ana', 'POST', '/api/my/contractor-invoices', { ...base, lines: [{ serviceDate: '2026-11-02', description: 'Visit', unit: 'visit', qty: 1, rate: '50' }], total: '60' })).body.code, 'CI_TOTAL_MISMATCH');
  let r = await h.call('ana', 'POST', '/api/my/contractor-invoices', { ...base, attachment: { name: 'inv.pdf', dataBase64: pdf }, total: '450.00' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.invoice.id;
  assert.equal(r.body.invoice.totalCents, 45000); assert.equal(r.body.invoice.attachment.type, 'application/pdf');
  const csv = await h.call('ana', 'POST', '/api/my/contractor-invoices', { ...base, invoiceNo: 'INV-8', attachment: { name: 'inv.csv', dataBase64: Buffer.from('date,hours\n2026-11-02,3\n').toString('base64') }, total: '90' });
  assert.equal(csv.body.invoice.attachment.type, 'text/csv');
  // The manager sees it, opens the file, and approves; cannot pay.
  r = await h.call('mgr', 'GET', '/api/payroll/admin/contractor-invoices');
  assert.equal(r.status, 200); assert.equal(r.body.canReview, true); assert.equal(r.body.canPay, false);
  assert.equal(r.body.invoices.find(x => x.id === id).payTo, null, 'pay details are for the Super Admin');
  r = await h.call('mgr', 'GET', `/api/payroll/contractor-invoices/${id}/file`);
  assert.equal(r.status, 200); assert.equal(r.body.slice(0, 5).toString(), '%PDF-');
  assert.equal((await h.call('cg1', 'GET', `/api/payroll/contractor-invoices/${id}/file`)).status, 404, 'someone else\'s invoice file is not found');
  r = await h.call('mgr', 'POST', `/api/payroll/admin/contractor-invoices/${csv.body.invoice.id}/reject`, { note: 'Add the client name' });
  assert.equal(r.status, 200); assert.ok(h.notices.some(n => n[0] === 'contractor_invoice_sent_back' && !JSON.stringify(n).includes('client name')), 'told where to look, not the note');
  r = await h.call('mgr', 'POST', `/api/payroll/admin/contractor-invoices/${id}/approve`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await h.call('mgr', 'POST', `/api/payroll/admin/contractor-invoices/${id}/pay`, { confirmation: 'X' })).status, 403);
  assert.equal((await h.call('cg1', 'POST', `/api/payroll/admin/contractor-invoices/${id}/approve`)).status, 403);
  r = await h.call('own', 'POST', `/api/payroll/admin/contractor-invoices/${id}/pay`, { confirmation: 'PNC123' });
  assert.equal(r.status, 200); assert.equal(r.body.invoice.status, 'paid');
});

test('a contractor abroad with a W-8BEN is left off the 1099s and listed apart', async () => {
  const cal = require('../payrollCalendar');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'payroll.js'), 'utf8');
  assert.match(src, /const paid = allPaid\.filter\(x => !abroad\(x\.userId\)\);/);
  assert.match(src, /foreignContractors: figures\.foreignContractors \|\| \[\]/);
  const fed = { ssWageBaseCents: 18000000, necThresholdCents: 200000 };
  const out = cal.yearEnd([], [{ userId: 'u', name: 'U', amountCents: 500000, paidAt: '2026-05-01' }], { year: 2026, fed });
  assert.equal(out.nec.length, 1, 'the builder itself is unchanged; the route filters');
});
