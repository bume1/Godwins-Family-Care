'use strict';
// Year end: W-2 and 1099-NEC (2026-11-09). The SSA file is checked byte by
// byte against SSA Pub 42-007 (EFW2, tax year 2025); the employee copies
// against IRS Pub 1141 section 2.3 and Pub 1179; box 12 TT and the $2,000
// 1099-NEC threshold against the 2026 IRS instructions.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const zlib = require('node:zlib');

const ye = require('../payrollYearEnd');
const cal = require('../payrollCalendar');
const T = require('../payrollTaxTables');
const pc = require('../payrollCrypto');
const pdf = require('../pdf-generator');

const ROOT = path.join(__dirname, '..');
const KEY = 'b'.repeat(64);
const ENV = { PAYROLL_ENCRYPTION_KEY: KEY };
const field = (rec, start, len) => rec.slice(start - 1, start - 1 + len);

const EMPLOYER = { ein: '12-3456789', name: 'Godwins Family Care LLC', address: { line1: '4300 Paces Ferry Rd SE', line2: 'Suite 500', city: 'Atlanta', state: 'GA', zip: '30339', zip4: '' },
  gaWithholdingId: '1234567-AB', ssaUserId: 'ABCD1234', contactName: 'Office Contact', contactPhone: '4049136705', contactEmail: 'admin@example.com' };
const EMP = { ssn: '123456789', firstName: 'Pat', middle: 'Q', lastName: "O'Sample", suffix: '', address: { line1: '1 Test St', city: 'Marietta', state: 'GA', zip: '30060', zip4: '' },
  boxes: { box1: 3520050, box2: 212000, box3: 3520050, box4: 218243, box5: 3520050, box6: 51041, box12TT: 45000, box16: 3520050, box17: 120000 } };

test('the $2,000 1099-NEC threshold is confirmed, and a staged table takes the corrected note while an approved one is never rewritten', () => {
  assert.equal(T.FED_2026.necThresholdCents, 200000);
  assert.doesNotMatch(T.SEEDS[0].source, /UNCONFIRMED/);
  const staged = { id: 's', seedKey: 'federal-2026', status: 'staged', source: 'old UNCONFIRMED note', data: T.FED_2026 };
  const active = { id: 'a', seedKey: 'federal-2026', status: 'active', source: 'old UNCONFIRMED note', data: T.FED_2026 };
  assert.deepEqual(T.refreshStagedSeeds([staged]).map(t => t.source), [T.SEEDS[0].source]);
  assert.deepEqual(T.refreshStagedSeeds([active]), []);
});

test('W-2 boxes: Social Security wages stop at the 2026 base, and box 12 TT is the overtime premium only', () => {
  const run = (payDate, gross, ot) => ({ status: 'paid', period: { payDate }, workers: [{ userId: 'u1', name: 'Pat', earnings: [{ code: 'regular', amountCents: gross - ot }, { code: 'overtime', amountCents: ot }],
    pay: { grossCents: gross, taxes: { federal: 100, socialSecurity: 200, medicare: 50, georgia: 30 } } }] });
  const y = cal.yearEnd([run('2026-06-05', 10000000, 2000), run('2026-12-18', 10000000, 3000), run('2027-01-02', 999, 0), { ...run('2026-07-01', 5, 0), status: 'draft' }], [], { year: 2026, fed: T.FED_2026 });
  const w = y.w2[0];
  assert.equal(w.box1, 20000000);
  assert.equal(w.box3, T.FED_2026.ssWageBaseCents, 'capped at $184,500');
  assert.equal(w.box5, 20000000);
  assert.equal(w.box12TT, 5000);
});

test('1099-NEC: only contractors paid $2,000 or more in the year get one', () => {
  const pay = (userId, amountCents, paidAt) => ({ userId, name: userId, amountCents, paidAt });
  const y = cal.yearEnd([], [pay('a', 150000, '2026-03-01'), pay('a', 50000, '2026-09-01'), pay('b', 199999, '2026-05-01'), pay('c', 500000, '2025-12-31')], { year: 2026, fed: T.FED_2026 });
  assert.deepEqual(y.nec.map(n => [n.userId, n.box1]), [['a', 200000]]);
  assert.equal(y.necBelowThreshold, 1);
});

test('the SSA EFW2 file: every record is 512 bytes plus CR/LF, money is in cents, totals add up', () => {
  const file = ye.efw2File({ year: 2025, employer: EMPLOYER, employees: [EMP, { ...EMP, ssn: '987654321', firstName: 'Lee' }] });
  const recs = file.split('\r\n').slice(0, -1);
  assert.equal(file.endsWith('\r\n'), true);
  assert.deepEqual(recs.map(r => r.slice(0, 2)), ['RA', 'RE', 'RW', 'RW', 'RT', 'RF']);
  for (const r of recs) assert.equal(r.length, 512, `${r.slice(0, 2)} is ${r.length}`);
  const [ra, re, rw, , rt, rf] = recs;
  assert.equal(field(ra, 3, 9), '123456789', 'EIN digits only');
  assert.equal(field(ra, 12, 8), 'ABCD1234');
  assert.equal(field(ra, 29, 1), '0'); assert.equal(field(ra, 36, 2), '98'); assert.equal(field(ra, 500, 1), 'L');
  assert.equal(field(re, 3, 4), '2025'); assert.equal(field(re, 174, 1), 'N'); assert.equal(field(re, 219, 1), 'R'); assert.equal(field(re, 220, 1), ' ');
  assert.equal(field(rw, 3, 9), '123456789');
  assert.equal(field(rw, 42, 20).trim(), "O'SAMPLE", 'upper case, apostrophe kept');
  assert.equal(field(rw, 188, 11), '00003520050');
  assert.equal(field(rw, 221, 11), '00000218243');
  assert.equal(field(rw, 254, 11), '00000000000', 'an unused money field is zeros, never blanks');
  assert.equal(field(rt, 3, 7), '0000002');
  assert.equal(field(rt, 10, 15), '000000007040100');
  assert.equal(field(rf, 8, 9), '000000002');
});

test('no guessed layout: the SSA file and the IRIS CSV refuse a tax year whose layout is not built in', () => {
  assert.throws(() => ye.efw2File({ year: 2026, employer: EMPLOYER, employees: [EMP] }), e => e.code === 'EFW2_LAYOUT_UNKNOWN');
  assert.throws(() => ye.irisNecCsv({ year: 2026, payer: EMPLOYER, recipients: [] }), e => e.code === 'IRIS_LAYOUT_UNKNOWN');
});

test('the IRIS 1099-NEC CSV follows the template column order and formats', () => {
  const csv = ye.irisNecCsv({ year: 2025, payer: { ...EMPLOYER, phone: '404-913-6705' }, recipients: [{ tin: '111223333', tinType: 'ssn', firstName: 'Dee', lastName: 'Examiner', address: { line1: '2 Test Ave', city: 'Atlanta', state: 'GA', zip: '30303' }, box1Cents: 450000 }] });
  const [head, row] = csv.trim().split('\r\n');
  assert.equal(head.split(',').length >= 54, true);
  const cells = row.split(',');
  assert.equal(cells[0], '1099-NEC');
  assert.equal(cells[3], '12-3456789');
  assert.equal(cells[20], '111-22-3333');
  assert.equal(cells[37], '4500.00');
});

test('employee copies never carry a full SSN or TIN, and say the required things', async () => {
  await assert.rejects(pdf.generateW2EmployeePDF({ year: 2026, employer: EMPLOYER, employee: { ssnTruncated: '123-45-6789' }, boxes: EMP.boxes }));
  await assert.rejects(pdf.generate1099NecPDF({ year: 2026, payer: EMPLOYER, recipient: { tinTruncated: '123456789' }, boxes: { box1a: 1 } }));
  assert.equal(ye.truncateTin('123456789', 'ssn'), 'XXX-XX-6789');
  const src = fs.readFileSync(path.join(ROOT, 'pdf-generator.js'), 'utf8');
  const w2 = src.slice(src.indexOf('const W2_COPIES'), src.indexOf('async function generate1099NecPDF'));
  for (const s of ["Copy B, To Be Filed With Employee's FEDERAL Tax Return.", "Copy C, For EMPLOYEE'S RECORDS.", "Copy 2, To Be Filed With Employee's State, City, or Local Income Tax Return.",
    'This information is being furnished to the Internal Revenue Service.', 'Department of the Treasury', 'OMB No. 1545-0029', 'Earned income tax credit', 'Box 12, code TT', 'Wage and Tax Statement']) {
    assert.ok(w2.includes(s), `W-2 copy is missing: ${s}`);
  }
  assert.doesNotMatch(w2, /doc\.image\(/, 'no logo on a W-2 employee copy (Pub 1141)');
  const nec = src.slice(src.indexOf('async function generate1099NecPDF'), src.indexOf('\nmodule.exports'));
  for (const s of ['OMB No. 1545-0116', 'Copy B  For Recipient', 'This is important tax information and is being furnished to the IRS.', "4  Federal income tax withheld", '1a  Nonemployee compensation', '1d  Overtime compensation']) {
    assert.ok(nec.includes(s), `1099-NEC copy is missing: ${s}`);
  }
  assert.match(nec, /font\('Helvetica-Bold'\)\.fontSize\(7\)\.text\('4  Federal income tax withheld'/, 'box 4 caption in bold (Pub 1179)');
});

// ---- the routes --------------------------------------------------------------------
function harness(userId, store = new Map(), { today = '2027-01-10T15:00:00Z' } = {}) {
  const db = { get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
  const acts = [], mail = [];
  const users = [{ id: 'own', role: 'admin', name: 'Owner', email: 'o@x' },
    { id: 'e1', role: 'user', name: 'Pat Sample', email: 'p@x' }, { id: 'e2', role: 'user', name: 'Lee Paper', email: 'l@x' },
    { id: 'c1', role: 'user', name: 'Dee Examiner', email: 'd@x', employmentType: '1099' }];
  const RealDate = Date;
  global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [today])); } static now() { return new RealDate(today).getTime(); } };
  const routes = require('../routes/payroll')({
    db, env: ENV, payrollKey: 'k'.repeat(40), logActivity: async (...a) => acts.push(a), getUsers: async () => users,
    authenticateToken: (req, res, next) => { req.user = users.find(u => u.id === userId); next(); },
    requireAdmin: (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'no' })),
    uuidv4: (() => { let n = 0; return () => `id${++n}`; })(), accountTypeOf: (u) => (u.role === 'admin' ? 'admin' : 'provider'), localDate: (iso) => String(iso).slice(0, 10),
    resolvePayRate: () => ({ rate: null }), queueNotification: async (...a) => mail.push(a), hashIp: () => 'h',
    pdf, drive: {}, roleFolderFor: () => 'F', personFolderName: (n) => n, getAppBaseUrl: async () => 'https://app'
  });
  global.Date = RealDate;
  const app = express(); app.use(express.json()); app.use(routes);
  return { app, store, acts, mail, users, RealDate };
}
const req = async (app, method, url, body, today = '2027-01-10T15:00:00Z') => {
  const RealDate = Date;
  global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [today])); } static now() { return new RealDate(today).getTime(); } };
  const srv = app.listen(0); const port = srv.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, type, body: type.includes('json') ? await r.json() : await r.text() };
  } finally { srv.close(); global.Date = RealDate; }
};
const seed = (store) => {
  const addr = { firstName: 'Pat', middle: '', lastName: 'Sample', suffix: '', line1: '1 Test St', line2: '', city: 'Marietta', state: 'GA', zip: '30060', zip4: '' };
  store.set('payroll_tax_tables', T.seedRows([], { uuid: () => Math.random().toString(36).slice(2), at: 'x' }).map(t => ({ ...t, year: 2026, status: 'active' })));
  store.set('payroll_settings', { employerEin: '12-3456789', yearEnd: { gaWithholdingId: '1234567-AB' } });
  store.set('payroll_profiles', {
    e1: { userId: 'e1', workerType: 'W2', ssn: { enc: pc.seal('123456789', ENV), last4: '6789' }, taxAddress: addr, eDelivery: { consented: true } },
    e2: { userId: 'e2', workerType: 'W2', ssn: { enc: pc.seal('987654321', ENV), last4: '4321' }, taxAddress: { ...addr, firstName: 'Lee', lastName: 'Paper' } },
    c1: { userId: 'c1', workerType: '1099', tin: { enc: pc.seal('111223333', ENV), last4: '3333', type: 'ssn' }, w9: { name: 'Dee Examiner' }, taxAddress: { ...addr, firstName: 'Dee', lastName: 'Examiner' }, eDelivery: { consented: true } }
  });
  const w = (userId, gross, ot) => ({ userId, name: userId, earnings: [{ code: 'regular', amountCents: gross - ot }, { code: 'overtime', amountCents: ot }], pay: { grossCents: gross, taxes: { federal: 1000, socialSecurity: 2000, medicare: 500, georgia: 300 } } });
  store.set('payroll_runs', [{ id: 'r1', status: 'paid', period: { start: '2026-12-01', end: '2026-12-14', payDate: '2026-12-19' }, workers: [w('e1', 300000, 4500), w('e2', 100000, 0)] }]);
  store.set('contractor_invoices', [{ id: 'i1', userId: 'c1', name: 'Dee Examiner', status: 'paid', paidAt: '2026-06-01T00:00:00Z', totalCents: 450000 }]);
};

test('release freezes the forms, emails only people who agreed (a link, never the form), and lists the rest for paper', async () => {
  const { app, store, mail } = harness('own'); seed(store);
  let r = await req(app, 'POST', '/api/payroll/admin/year-end/2026/release', null, '2026-12-20T15:00:00Z');
  assert.equal(r.body.code, 'YE_YEAR_NOT_OVER');
  r = await req(app, 'POST', '/api/payroll/admin/year-end/2026/release');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.emailed, 2);
  assert.deepEqual(r.body.paper.map(p => p.userId), ['e2']);
  const row = store.get('payroll_year_end')[0];
  assert.equal(row.w2.find(x => x.userId === 'e1').boxes.box12TT, 4500);
  assert.ok(!JSON.stringify(row).includes('123456789') && !JSON.stringify(row).includes('111223333'), 'the frozen row keeps only the last four');
  for (const m of mail) assert.doesNotMatch(JSON.stringify(m[4]), /\$|\d{3},\d{3}|3000\.00|4500/, 'a link, never figures');
  r = await req(app, 'POST', '/api/payroll/admin/year-end/2026/release');
  assert.equal(r.body.code, 'YE_ALREADY_RELEASED');
});

test('release refuses open runs and missing paperwork, by name', async () => {
  const { app, store } = harness('own'); seed(store);
  store.set('payroll_runs', [...store.get('payroll_runs'), { id: 'r2', status: 'approved', period: { payDate: '2026-12-31' }, workers: [] }]);
  assert.equal((await req(app, 'POST', '/api/payroll/admin/year-end/2026/release')).body.code, 'YE_RUNS_OPEN');
  seed(store);
  const p = store.get('payroll_profiles'); delete p.e2.taxAddress; store.set('payroll_profiles', p);
  const r = await req(app, 'POST', '/api/payroll/admin/year-end/2026/release');
  assert.equal(r.body.code, 'YE_PEOPLE_MISSING');
  assert.match(r.body.error, /Lee Paper|e2/);
});

test('a person opens only their own form, the open is recorded, and the PDF shows the last four only', async () => {
  const store = new Map();
  const own = harness('own', store); seed(store);
  await req(own.app, 'POST', '/api/payroll/admin/year-end/2026/release');
  const me = harness('e1', store);
  let r = await req(me.app, 'GET', '/api/my/tax-forms');
  assert.deepEqual(r.body.forms.map(f => f.label), ['W-2']);
  r = await req(me.app, 'GET', '/api/my/tax-forms/2026/1099-nec.pdf');
  assert.equal(r.status, 404, 'not mine');
  r = await req(me.app, 'GET', '/api/my/tax-forms/2026/w2.pdf');
  assert.equal(r.status, 200);
  assert.ok(store.get('payroll_year_end')[0].w2.find(x => x.userId === 'e1').openedAt);
});

test('the filing sheet carries full numbers only for the owner, logs the download with counts, and is never stored', async () => {
  const store = new Map();
  const own = harness('own', store); seed(store);
  let r = await req(own.app, 'GET', '/api/payroll/admin/year-end/2026/filing-sheet.csv');
  assert.equal(r.body.code, 'YE_NOT_RELEASED');
  await req(own.app, 'POST', '/api/payroll/admin/year-end/2026/release');
  r = await req(own.app, 'GET', '/api/payroll/admin/year-end/2026/filing-sheet.csv');
  assert.equal(r.status, 200);
  assert.match(r.body, /123-45-6789/); assert.match(r.body, /111-22-3333/); assert.match(r.body, /45\.00/, 'box 12 TT');
  const log = own.acts.find(a => a[2] === 'tax_filing_filing_sheet_downloaded');
  assert.deepEqual(log[5], { w2: 2, nec: 1 });
  assert.ok(!JSON.stringify([...store.values()]).includes('123-45-6789'));
  r = await req(own.app, 'GET', '/api/payroll/admin/year-end/2026/ssa-w2.txt');
  assert.equal(r.status, 409, 'no SSA file for 2026 without its layout');
  const emp = harness('e1', store);
  assert.equal((await req(emp.app, 'GET', '/api/payroll/admin/year-end/2026/filing-sheet.csv')).status, 403);
});

test('electronic consent needs the current terms, and a withdrawal is confirmed in writing', async () => {
  const store = new Map();
  const me = harness('e1', store);
  let r = await req(me.app, 'GET', '/api/my/pay-setup');
  assert.ok(r.body.options.eDelivery.disclosure.some(t => /paper/.test(t)));
  r = await req(me.app, 'PUT', '/api/my/pay-setup/e-delivery', { consented: true, disclosureVersion: 'old' });
  assert.equal(r.body.code, 'E_DELIVERY_TERMS_CHANGED');
  r = await req(me.app, 'PUT', '/api/my/pay-setup/e-delivery', { consented: true, disclosureVersion: ye.E_DELIVERY_VERSION });
  assert.equal(r.status, 200);
  r = await req(me.app, 'PUT', '/api/my/pay-setup/e-delivery', { consented: false });
  assert.equal(r.status, 200);
  assert.equal(me.mail.filter(m => m[0] === 'tax_form_consent_withdrawn').length, 1);
});

test('the reminder job is quiet outside January 20 to February 15 and never reveals a figure', async () => {
  const store = new Map();
  const own = harness('own', store); seed(store);
  await req(own.app, 'POST', '/api/payroll/admin/year-end/2026/release');
  const hdr = { 'X-GFC-Payroll-Key': 'k'.repeat(40) };
  const job = async (today) => {
    const RealDate = Date;
    global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [today])); } static now() { return new RealDate(today).getTime(); } };
    const srv = own.app.listen(0);
    try { const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/payroll/automation/tax-form-reminders`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...hdr }, body: '{}' }); return r.json(); }
    finally { srv.close(); global.Date = RealDate; }
  };
  assert.equal((await job('2027-01-12T15:00:00Z')).summary, 'not in season');
  const before = own.mail.length;
  const out = await job('2027-01-21T15:00:00Z');
  assert.match(out.summary, /2 reminded, 1 unmailed/);
  for (const m of own.mail.slice(before)) assert.doesNotMatch(JSON.stringify(m[4]), /\d+\.\d{2}/);
});

test('the Apps Script and the app agree: every job the script calls exists, and so does the tax-sources read', async () => {
  const gs = fs.readFileSync(path.join(ROOT, 'scripts/payroll_automations.gs'), 'utf8');
  const called = [...gs.matchAll(/callPayrollJob_\('([a-z-]+)'/g)].map(m => m[1]);
  assert.ok(called.length >= 8);
  const { app } = harness('own');
  const hdr = { 'X-GFC-Payroll-Key': 'k'.repeat(40), 'Content-Type': 'application/json' };
  const srv = app.listen(0);
  try {
    for (const job of new Set(called)) {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/payroll/automation/${job}`, { method: 'POST', headers: hdr, body: JSON.stringify({ taxYear: 2026 }) });
      assert.notEqual(r.status, 404, `the script calls ${job}, which the app does not have`);
    }
    assert.match(gs, /appRequest_\('get', '\/api\/payroll\/automation\/tax-sources'\)/);
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/payroll/automation/tax-sources`, { headers: hdr });
    const b = await r.json();
    assert.equal(r.status, 200);
    assert.ok(b.sources.some(x => x.jurisdiction === 'federal') && b.sources.some(x => x.jurisdiction === 'GA'));
    const noKey = await fetch(`http://127.0.0.1:${srv.address().port}/api/payroll/automation/tax-sources`);
    assert.equal(noKey.status, 401);
  } finally { srv.close(); }
  assert.match(gs, /'payrollTaxFormReminders'\]/, 'rev 1\'s trigger is cleaned up on reinstall');
});

test('every state is watched from its official pages; one with none would be reported, never silently skipped', () => {
  const out = T.sourcesFor(['GA', 'TX', 'ZZ']);
  assert.deepEqual(out.unwatched, ['ZZ']);
  assert.ok(out.sources.some(s => s.jurisdiction === 'TX' && /twc\.texas\.gov/.test(s.url)));
  assert.equal(Object.keys(T.STATE_SOURCES).length, 51, 'every state and DC');
  for (const [k, v] of Object.entries(T.STATE_SOURCES)) for (const p of v.pages) assert.match(p.url, /^https:\/\//, k);
});

test('the Jan 2 build tells the owner what is ready and what blocks release, and releases nothing', async () => {
  const { app, store, mail } = harness('own'); seed(store);
  const p = store.get('payroll_profiles'); delete p.e2.taxAddress; store.set('payroll_profiles', p);
  const srv = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/payroll/automation/year-end-build`, { method: 'POST', headers: { 'X-GFC-Payroll-Key': 'k'.repeat(40), 'Content-Type': 'application/json' }, body: JSON.stringify({ taxYear: 2026 }) });
    const b = await r.json();
    assert.match(b.summary, /2 W-2, 1 1099-NEC, 1 blocker/);
  } finally { srv.close(); }
  assert.equal((store.get('payroll_year_end') || []).filter(x => x.released).length, 0, 'nothing is released');
  const note = mail.find(m => m[0] === 'tax_forms_ready_for_review');
  assert.ok(note && /Lee Paper|e2/.test(note[4].body));
  assert.doesNotMatch(note[4].body, /\d+\.\d{2}/, 'no figures in the email');
});

test('once the forms are released, the Jan 2 build stays quiet', async () => {
  const { app, store, mail } = harness('own'); seed(store);
  await req(app, 'POST', '/api/payroll/admin/year-end/2026/release');
  const before = mail.length;
  const srv = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/payroll/automation/year-end-build`, { method: 'POST', headers: { 'X-GFC-Payroll-Key': 'k'.repeat(40), 'Content-Type': 'application/json' }, body: JSON.stringify({ taxYear: 2026 }) });
    assert.equal((await r.json()).summary, 'already released');
  } finally { srv.close(); }
  assert.equal(mail.length, before);
});
