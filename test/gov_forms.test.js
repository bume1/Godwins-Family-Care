'use strict';
// The official forms, filled from Pay Setup (owner, 2026-11-13): the IRS W-4
// and W-9, Georgia's G-4 and USCIS's I-9. Each is read back as text, so the
// test checks what a person would actually see on the form.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const express = require('express');
const g = require('../govForms');
const pp = require('../payrollProfiles');

const textOf = (buf) => {
  const f = path.join(os.tmpdir(), `gov-${process.pid}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(f, buf);
  try { return execFileSync('pdftotext', ['-f', '1', '-l', '1', '-layout', f, '-'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
  finally { fs.unlinkSync(f); }
};
const person = { address: { firstName: 'Pat', middle: 'Q', lastName: 'Testcase', line1: '12 Elm St', line2: 'Apt 4', city: 'Marietta', state: 'GA', zip: '30060' }, email: 'pat@example.test' };
const sig = { signedName: 'Pat Q Testcase', signedAt: '2026-11-13T15:04:00Z' };
const employer = { name: 'Godwins Family Care LLC', address: '4300 Paces Ferry Rd SE, Suite 500, Atlanta, GA 30339', ein: '123456789', gaWithholdingNumber: '1234567-AB' };

test('the blank official forms are the agencies\' own files, present and readable', () => {
  for (const [k, def] of Object.entries(g.FORMS)) {
    const b = fs.readFileSync(path.join(__dirname, '..', 'govforms', def.file));
    assert.equal(b.slice(0, 5).toString(), '%PDF-', k);
  }
});

test('W-4: name, SSN, filing status, amounts, employer and the typed signature land on the IRS form', async () => {
  const t = textOf(await g.fillW4({ person, ssn: '123456789', w4: { filingStatus: 'mfj', multipleJobs: true, dependentsCents: 400000, extraWithholdingCents: 2500, ...sig }, employer, firstDay: '2026-11-02' }));
  assert.match(t, /Pat Q/); assert.match(t, /Testcase/); assert.match(t, /123-45-6789/);
  assert.match(t, /X\s+Married filing jointly/, 'Step 1(c) marked');
  assert.match(t, /4000/); assert.match(t, /\b25\b/);
  assert.match(t, /\/s\/ Pat Q Testcase/); assert.match(t, /11\/13\/2026/);
  assert.match(t, /12-3456789/); assert.match(t, /11\/02\/2026/);
  assert.match(t, /Signed electronically by Pat Q Testcase/);
});

test('G-4: letter, allowances and total; exempt leaves lines 4 to 7 empty', async () => {
  let t = textOf(await g.fillG4({ person, ssn: '123456789', g4: { filingStatus: 'B', dependentAllowances: 2, additionalAllowances: 1, extraWithholdingCents: 1000, ...sig }, employer }));
  assert.match(t, /Pat Q Testcase/); assert.match(t, /123-45-6789/); assert.match(t, /1234567-AB/);
  assert.match(t, /LETTER USED[^\n]*B/); assert.match(t, /TOTAL ALLOWANCES[^\n]*3/);
  assert.match(t, /\/s\/ Pat Q Testcase/);
  t = textOf(await g.fillG4({ person, ssn: '123456789', g4: { filingStatus: 'A', dependentAllowances: 2, exempt: true, ...sig }, employer }));
  assert.doesNotMatch(t, /Lines 4 and 5\)\s*_*\s*\d/, 'no total when exempt');
  assert.match(t, /liability this year\. Check here X/, 'line 8a marked');
  assert.doesNotMatch(t, /DEPENDENT ALLOWANCES\s*\[?\s*2/, 'no allowances when exempt');
});

test('W-9: an EIN fills the EIN boxes and the LLC letter, never the SSN boxes', async () => {
  const t = textOf(await g.fillW9({ w9: { name: 'Pat Q Testcase', businessName: 'PT Consulting', taxClass: 'llc_s', tinType: 'ein', address: '12 Elm St, Marietta, GA 30060', ...sig }, tin: '987654321' }));
  assert.match(t, /PT Consulting/); assert.match(t, /98/); assert.match(t, /7654321/);
  assert.match(t, /Marietta, GA 30060/); assert.match(t, /\/s\/ Pat Q Testcase/);
});

test('I-9: Section 1 and Section 2 filled; the fields stay on the form, locked', async () => {
  const buf = await g.fillI9({ person, ssn: '123456789',
    i9: { section1: { status: 'authorized', workAuthExpires: '2028-05-01', dob: '1990-04-12', ...sig },
      section2: { documents: [{ list: 'B', title: 'Driver license', issuer: 'Georgia DDS', expires: '2030-01-01' }, { list: 'C', title: 'Employment authorization', issuer: 'DHS', expires: null }], firstDay: '2026-11-02', reviewedAt: '2026-11-04T14:00:00Z', reviewedBy: 'Office Admin', reviewerTitle: 'Owner' } },
    employer, immigration: { alienNumber: '123456789' }, docNumbers: ['D1234567', 'EAD99'] });
  const { PDFDocument } = require('pdf-lib');
  const f = (await PDFDocument.load(buf)).getForm();
  assert.equal(f.getTextField('Last Name (Family Name)').getText(), 'Testcase');
  assert.equal(f.getTextField('Date of Birth mmddyyyy').getText(), '04/12/1990');
  assert.equal(f.getTextField('USCIS ANumber').getText(), '123456789');
  assert.equal(f.getTextField('List B Document Number 1').getText(), 'D1234567');
  assert.equal(f.getTextField('FirstDayEmployed mmddyyyy').getText(), '11/02/2026');
  assert.ok(f.getTextField('Signature of Employee').isReadOnly(), 'locked');
  assert.match(textOf(buf), /X\s+4\.\s+An alien authorized/, 'item 4 marked');
});

test('I-9 Section 1 asks what the official form asks, and returns the immigration numbers apart', () => {
  const ctx = { at: '2026-11-13T10:00:00Z' };
  const base = { signedName: 'Pat', agree: true };
  assert.equal(pp.normalizeI9Section1({ ...base, status: 'citizen' }, ctx).code, 'I9_DOB');
  assert.equal(pp.normalizeI9Section1({ ...base, status: 'lpr', dob: '1990-01-01' }, ctx).code, 'I9_ALIEN_NUMBER');
  assert.equal(pp.normalizeI9Section1({ ...base, status: 'authorized', dob: '1990-01-01' }, ctx).code, 'I9_AUTH_NUMBER');
  const n = pp.normalizeI9Section1({ ...base, status: 'authorized', dob: '1990-01-01', i94Number: 'AB123456789' }, ctx);
  assert.deepEqual(n.ids, { alienNumber: null, i94Number: 'AB123456789', passport: null });
  assert.ok(!JSON.stringify(n.value).includes('AB123456789'), 'the number is not on the stored section');
  assert.equal(n.value.idsOnFile, true);
  const c = pp.normalizeI9Section1({ ...base, status: 'citizen', dob: '1990-01-01' }, ctx);
  assert.equal(c.ids, null);
  const pub = pp.publicProfile({ ...pp.defaultProfile({ id: 'x', role: 'user' }), i9Ids: { enc: 'secret' }, i9DocNumbers: { enc: 'secret2' } });
  assert.ok(!('i9Ids' in pub) && !('i9DocNumbers' in pub), 'never sent to a browser');
});

// Through the real routes: Sign and Save seals the numbers, files the signed
// form to the Staff Record in Drive, and the person downloads their own.
test('routes: sign the I-9, the numbers are sealed, the form is filed and downloadable', async () => {
  const store = new Map();
  const db = { get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
  const users = [{ id: 'own', role: 'admin', name: 'Owner', email: 'o@x' }, { id: 'cg1', role: 'vendor', licenseLevel: 'pca', name: 'Pat Care', email: 'p@x' }];
  const filed = [];
  const routes = (as) => require('../routes/payroll')({
    db, env: { PAYROLL_ENCRYPTION_KEY: 'a'.repeat(64) }, payrollKey: 'k'.repeat(40), logActivity: async () => {}, getUsers: async () => users,
    authenticateToken: (req, res, next) => { req.user = users.find(u => u.id === as); next(); },
    requireAdmin: (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'no' })),
    uuidv4: () => `id${Math.random()}`, accountTypeOf: (u) => (u.role === 'admin' ? 'admin' : 'caregiver'), localDate: (v) => String(v).slice(0, 10),
    resolvePayRate: () => ({ rate: 18 }), queueNotification: async () => {}, hashIp: () => 'h', pdf: require('../pdf-generator'),
    drive: { uploadStaffDocumentFile: async (role, who, name, buf) => { filed.push({ name, bytes: buf.length }); return { fileId: 'drv1' }; } },
    roleFolderFor: () => 'F', personFolderName: (n) => n, getAppBaseUrl: async () => 'https://app'
  });
  const call = async (as, method, url, body) => {
    const app = express(); app.use(express.json()); app.use(routes(as));
    const srv = app.listen(0);
    try {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const type = r.headers.get('content-type') || '';
      return { status: r.status, type, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
    } finally { srv.close(); }
  };
  await call('cg1', 'PUT', '/api/my/pay-setup/tax-address', { firstName: 'Pat', lastName: 'Care', line1: '1 Main St', city: 'Atlanta', state: 'GA', zip: '30303' });
  let r = await call('cg1', 'PUT', '/api/my/pay-setup/i9', { status: 'lpr', dob: '1985-06-01', alienNumber: 'A123456789', signedName: 'Pat Care', agree: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!JSON.stringify(r.body).includes('123456789'), 'the number never comes back');
  const raw = JSON.stringify(store.get('payroll_profiles'));
  assert.ok(!raw.includes('123456789'), 'sealed in the store');
  for (let i = 0; i < 100 && !filed.some(f => /^Form I-9 signed/.test(f.name)); i++) await new Promise(res => setTimeout(res, 50));
  for (let i = 0; i < 100 && !(store.get('payroll_profiles').cg1.formsFiled || {}).i9; i++) await new Promise(res => setTimeout(res, 50));
  assert.ok(filed.some(f => /^Form I-9 signed/.test(f.name) && f.bytes > 1000), 'filed to Drive');
  assert.equal(store.get('payroll_profiles').cg1.formsFiled.i9.driveFileId, 'drv1');
  r = await call('cg1', 'GET', '/api/my/pay-setup/forms/i9.pdf');
  assert.equal(r.status, 200); assert.equal(r.body.slice(0, 5).toString(), '%PDF-');
  const { PDFDocument } = require('pdf-lib');
  assert.equal((await PDFDocument.load(r.body)).getForm().getTextField('3 A lawful permanent resident Enter USCIS or ANumber').getText(), '123456789');
  assert.equal((await call('cg1', 'GET', '/api/my/pay-setup/forms/w4.pdf')).body.code, 'FORM_NOT_SIGNED');
  assert.equal((await call('cg1', 'GET', '/api/payroll/admin/people/cg1/forms/i9.pdf')).status, 403, 'only the Super Admin opens someone else\'s');
  assert.equal((await call('own', 'GET', '/api/payroll/admin/people/cg1/forms/i9.pdf')).status, 200);
});

// Signing needs the legal name and address first, and the W-4 the SSN too
// (owner, 2026-11-14), so the copy filed in their folder is never missing them.
// A later correction re-files the forms already signed.
test('a form cannot be signed before its name, address and SSN; a correction re-files it', async () => {
  const store = new Map();
  const db = { get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
  const users = [{ id: 'own', role: 'admin', name: 'Owner', email: 'o@x' }, { id: 'cg1', role: 'vendor', licenseLevel: 'pca', name: 'Pat Care', email: 'p@x' }];
  const filed = [];
  const app = express(); app.use(express.json());
  app.use(require('../routes/payroll')({
    db, env: { PAYROLL_ENCRYPTION_KEY: 'a'.repeat(64) }, payrollKey: 'k'.repeat(40), logActivity: async () => {}, getUsers: async () => users,
    authenticateToken: (req, res, next) => { req.user = users[1]; next(); }, requireAdmin: (req, res) => res.status(403).end(),
    uuidv4: () => `id${Math.random()}`, accountTypeOf: () => 'caregiver', localDate: (v) => String(v).slice(0, 10),
    resolvePayRate: () => ({ rate: 18 }), queueNotification: async () => {}, hashIp: () => 'h', pdf: require('../pdf-generator'),
    drive: { uploadStaffDocumentFile: async (r, w, name) => { filed.push(name); return { fileId: `d${filed.length}` }; } },
    roleFolderFor: () => 'F', personFolderName: (n) => n, getAppBaseUrl: async () => ''
  }));
  const srv = app.listen(0);
  const put = async (form, body) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/my/pay-setup/${form}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    const w4 = { filingStatus: 'single', signedName: 'Pat Care', agree: true };
    assert.equal((await put('w4', w4)).body.code, 'FORM_NEEDS_ADDRESS');
    assert.equal((await put('i9', { status: 'citizen', dob: '1990-01-01', signedName: 'Pat Care', agree: true })).body.code, 'FORM_NEEDS_ADDRESS');
    await put('tax-address', { firstName: 'Pat', lastName: 'Care', line1: '1 Main St', city: 'Atlanta', state: 'GA', zip: '30303' });
    assert.equal((await put('w4', w4)).body.code, 'FORM_NEEDS_SSN');
    assert.equal((await put('i9', { status: 'citizen', dob: '1990-01-01', signedName: 'Pat Care', agree: true })).status, 200, 'the I-9 does not need the SSN');
    await put('ssn', { ssn: '123-45-6789' });
    assert.equal((await put('w4', w4)).status, 200);
    // Filing runs after the reply; wait for it rather than for a fixed time.
    const until = async (ok) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise(r => setTimeout(r, 50)); };
    await until(() => filed.some(n => /^Form W-4/.test(n)));
    assert.equal(filed.filter(n => /^Form W-4/.test(n)).length, 1);
    await put('tax-address', { firstName: 'Pat', lastName: 'Care', line1: '2 New St', city: 'Atlanta', state: 'GA', zip: '30303' });
    await until(() => filed.filter(n => /^Form W-4/.test(n)).length >= 2 && filed.filter(n => /^Form I-9/.test(n)).length >= 2);
    assert.equal(filed.filter(n => /^Form W-4/.test(n)).length, 2, 'the W-4 was filed again with the new address');
    assert.ok(filed.filter(n => /^Form I-9/.test(n)).length >= 2, 'and the I-9');
  } finally { srv.close(); }
});
