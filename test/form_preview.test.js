'use strict';
// The official form beside its questions (owner, 2026-11-14): while someone
// fills in a W-4, G-4, I-9, W-9 or W-8BEN, the real form is drawn with their
// answers so far, marked PREVIEW, with no signature and secret numbers as
// their last four. A preview writes nothing.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const pp = require('../payrollProfiles');
const gov = require('../govForms');

const users = [{ id: 'cg1', role: 'vendor', licenseLevel: 'pca', accountType: 'caregiver', name: 'Pat Care', email: 'p@x', payRate: 18 }];
const text = (buf) => {
  const f = path.join(os.tmpdir(), `prev-${process.pid}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(f, buf);
  try { return execFileSync('pdftotext', ['-layout', f, '-']).toString(); } finally { fs.unlinkSync(f); }
};
function world() {
  const store = new Map(); const acts = [];
  const db = { get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
  const app = express(); app.use(express.json());
  app.use(require('../routes/payroll')({
    db, env: { PAYROLL_ENCRYPTION_KEY: 'a'.repeat(64) }, payrollKey: 'k'.repeat(40), logActivity: async (...a) => acts.push(a), getUsers: async () => users,
    authenticateToken: (req, res, next) => { req.user = users[0]; next(); }, requireAdmin: (req, res) => res.status(403).json({}),
    uuidv4: (() => { let n = 0; return () => `id${++n}`; })(), accountTypeOf: () => 'caregiver', localDate: (v) => String(v).slice(0, 10),
    resolvePayRate: (u) => ({ rate: u && u.payRate, source: 'base' }), queueNotification: async () => {}, hashIp: () => 'h',
    pdf: require('../pdf-generator'), drive: { uploadStaffDocumentFile: async () => ({ fileId: 'drv' }) }, roleFolderFor: () => 'F', personFolderName: (n) => n, getAppBaseUrl: async () => 'https://app'
  }));
  const call = async (method, url, body) => {
    const srv = app.listen(0);
    try {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const buf = Buffer.from(await r.arrayBuffer());
      let json = {}; try { json = JSON.parse(buf.toString()); } catch (e) { /* a pdf */ }
      return { status: r.status, buf, body: json, type: r.headers.get('content-type'), cache: r.headers.get('cache-control') };
    } finally { srv.close(); }
  };
  return { store, acts, call };
}
const ADDRESS = { firstName: 'Pat', lastName: 'Care', line1: '12 Oak St', city: 'Atlanta', state: 'GA', zip: '30339' };

test('a W-4 preview draws the answers so far on the real form, marked PREVIEW, unsigned, SSN masked, and writes nothing', async () => {
  const w = world();
  let r = await w.call('POST', '/api/my/pay-setup/preview/w4', { filingStatus: 'single' });
  assert.equal(r.body.code, 'FORM_NEEDS_ADDRESS', 'the form is filled from the legal address, so that comes first');
  assert.equal((await w.call('PUT', '/api/my/pay-setup/tax-address', ADDRESS)).status, 200);
  assert.equal((await w.call('PUT', '/api/my/pay-setup/ssn', { ssn: '123-45-6789' })).status, 200);
  const before = JSON.stringify(w.store.get('payroll_profiles'));
  const actsBefore = w.acts.length;
  r = await w.call('POST', '/api/my/pay-setup/preview/w4', { filingStatus: 'single', dependentsAmount: '2000', extraWithholding: '15', signedName: 'Pat Care', agree: true });
  assert.equal(r.status, 200, r.buf.toString().slice(0, 200));
  assert.equal(r.type, 'application/pdf'); assert.equal(r.cache, 'no-store');
  const t = text(r.buf);
  assert.match(t, /PREVIEW/);
  assert.match(t, /2000/); assert.match(t, /\b15\b/);
  assert.match(t, /XXX-XX-6789/); assert.doesNotMatch(t, /123-45-6789/);
  assert.doesNotMatch(t, /\/s\//, 'a preview is never signed, even with a name typed');
  assert.doesNotMatch(t, /Signed electronically/);
  assert.equal(JSON.stringify(w.store.get('payroll_profiles')), before, 'the profile is unchanged');
  assert.equal(w.acts.length, actsBefore, 'no activity row, so the answers are never logged');
  // Half filled, or nothing yet: it still draws.
  r = await w.call('POST', '/api/my/pay-setup/preview/w4', {});
  assert.equal(r.status, 200);
  r = await w.call('POST', '/api/my/pay-setup/preview/w4', { filingStatus: 'nonsense', dependentsAmount: 'abc' });
  assert.equal(r.status, 200, 'a value that would be refused on save is left blank in the preview');
});

test('I-9, G-4, W-9 and W-8BEN previews mask what is secret and show what was typed', async () => {
  const w = world();
  await w.call('PUT', '/api/my/pay-setup/tax-address', ADDRESS);
  let r = await w.call('POST', '/api/my/pay-setup/preview/i9', { status: 'lpr', dob: '1990-04-05', alienNumber: 'A123456789', otherLastNames: 'Smith' });
  assert.equal(r.status, 200);
  assert.ok(r.buf.slice(0, 5).toString() === '%PDF-');
  r = await w.call('POST', '/api/my/pay-setup/preview/g4', { filingStatus: 'B', dependentAllowances: '2' });
  let t = text(r.buf);
  assert.match(t, /PREVIEW/);
  r = await w.call('POST', '/api/my/pay-setup/preview/w9', { name: 'Pat Care LLC', taxClass: 'llc_single', tin: '987654321', address: '12 Oak St, Atlanta, GA 30339' });
  t = text(r.buf);
  assert.match(t, /Pat Care LLC/); assert.match(t, /PREVIEW/);
  assert.doesNotMatch(t, /987/, 'the taxpayer ID shows only its last four');
  r = await w.call('POST', '/api/my/pay-setup/preview/w8ben', { name: 'Ana Lima', citizenship: 'Brazil', permLine: 'Rua A 1', permCity: 'Recife', permCountry: 'Brazil', foreignTin: '11122233344', signedName: 'Ana Lima', agree: true });
  t = text(r.buf);
  assert.match(t, /Ana Lima/); assert.match(t, /Recife/);
  assert.doesNotMatch(t, /11122233344/);
  r = await w.call('POST', '/api/my/pay-setup/preview/state-cert', { filingStatus: 'married', allowances: '1' });
  assert.equal(r.status, 200);
  assert.match(text(r.buf), /PREVIEW/);
  assert.equal((await w.call('POST', '/api/my/pay-setup/preview/ssn', {})).status, 404, 'only the official forms preview');
});

test('every box the workspace outlines is a real field on the official form', async () => {
  for (const [key, map] of Object.entries(gov.FIELD_MAP)) {
    const b = await gov.fieldBoxes(key);
    assert.ok(b.pages.length > 0, key);
    for (const appKey of Object.keys(map)) {
      assert.ok(b.fields[appKey] && b.fields[appKey].length, `${key}.${appKey} has no box on the form`);
      for (const m of b.fields[appKey]) assert.ok(m.page < b.pages.length && m.w > 0 && m.h > 0, `${key}.${appKey}`);
    }
  }
  // Every mapped key is an answer the app asks for (a name="" on its input).
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'my-pay.js'), 'utf8');
  for (const map of Object.values(gov.FIELD_MAP)) for (const appKey of Object.keys(map)) assert.match(ui, new RegExp(`name="${appKey}"`), appKey);
  const w = world();
  const r = await w.call('GET', '/api/my/pay-setup/preview/w4/fields');
  assert.ok(r.body.fields.dependentsAmount && r.body.fields.signedName);
});

test('the preview shape matches what is saved, so one fill serves both', () => {
  const ctx = { at: '2026-11-14T15:00:00Z', ipHash: null };
  const sig = { signedName: 'Pat Care', agree: true };
  const strip = (v) => { const o = { ...v }; delete o.signedName; delete o.signedAt; delete o.ipHash; return o; };
  const cases = [
    ['w4', pp.normalizeW4, { filingStatus: 'mfj', multipleJobs: true, dependentsAmount: '2000', otherIncome: '100', deductions: '0', extraWithholding: '20', exempt: false }],
    ['g4', pp.normalizeG4, { filingStatus: 'B', dependentAllowances: '2', additionalAllowances: '1', extraWithholding: '5' }],
    ['i9', pp.normalizeI9Section1, { status: 'citizen', dob: '1990-04-05', otherLastNames: 'Smith', phone: '4045550100' }],
    ['w9', pp.normalizeW9, { name: 'Pat Care', businessName: '', taxClass: 'individual', tinType: 'ssn', tin: '123456789', address: '12 Oak St, Atlanta' }]
  ];
  for (const [key, strict, body] of cases) {
    const want = strip(strict({ ...body, ...sig }, ctx).value);
    const got = pp.previewValue(key, body, ctx).value;
    if (key === 'i9') delete want.idsOnFile;
    assert.deepEqual(got, want, key);
  }
});
