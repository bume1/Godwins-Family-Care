'use strict';
// Payroll inside the app (spec v2, 2026-11-08). The withholding math is
// checked against the official 2026 figures: IRS Pub 15-T's biweekly
// wage-bracket table and the Georgia DOR guide's own worked examples.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const pc = require('../payrollCrypto');
const pp = require('../payrollProfiles');
const tax = require('../payrollTax');
const engine = require('../payrollEngine');
const cal = require('../payrollCalendar');
const T = require('../payrollTaxTables');
const qb = require('../quickbooks');
const ime = require('../imeBilling');

const ROOT = path.join(__dirname, '..');
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '');
const read = (f) => strip(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const KEY = 'a'.repeat(64);
const ENV = { PAYROLL_ENCRYPTION_KEY: KEY };
const TABLES = { federal: T.FED_2026, GA: T.GA_2026 };

// ── the math, against the official figures ──────────────────────────────────
test('federal withholding matches Pub 15-T 2026 (biweekly wage-bracket row $1,985–$2,005)', () => {
  // The IRS wage-bracket values for that row; the percentage method at the
  // row's midpoint ($1,995) rounds to each.
  for (const [status, box, irs] of [['single', 0, 156], ['mfj', 0, 76], ['hoh', 0, 114], ['single', 1, 269], ['mfj', 1, 156], ['hoh', 1, 200]]) {
    const c = tax.federalWithholding(199500, { filingStatus: status, multipleJobs: !!box }, T.FED_2026, 26);
    assert.equal(Math.round(c / 100), irs, `${status} ${box ? 'Step 2 checked' : 'standard'}`);
  }
  assert.equal(tax.federalWithholding(199500, { filingStatus: 'single' }, T.FED_2026, 26), 15555, 'to the cent: 4,044.40 / 26');
});

test('W-4 Steps 3 and 4 and the exempt box', () => {
  const base = { filingStatus: 'single' };
  assert.equal(tax.federalWithholding(199500, { ...base, dependentsCents: 200000 }, T.FED_2026, 26), 7863, '$2,000 a year of credits is $76.92 a period');
  assert.equal(tax.federalWithholding(199500, { ...base, extraWithholdingCents: 2500 }, T.FED_2026, 26), 18055);
  assert.equal(tax.federalWithholding(199500, { ...base, exempt: true }, T.FED_2026, 26), 0);
  assert.equal(tax.federalWithholding(199500, null, T.FED_2026, 26), 0);
});

test('Georgia matches the 2026 guide\'s own worked examples', () => {
  // Example 1: semimonthly $2,000, married one spouse working, 1 dependent → $27.03
  assert.equal(tax.georgiaWithholding(200000, { filingStatus: 'C', dependentAllowances: 1 }, T.GA_2026, 24), 2703);
  // Example 2: biweekly $935, head of household, 2 dependents → $0
  assert.equal(tax.georgiaWithholding(93500, { filingStatus: 'D', dependentAllowances: 2 }, T.GA_2026, 26), 0);
  assert.equal(T.GA_2026.ratePct, 4.99);
  assert.deepEqual(Object.keys(pp.G4_FILING), ['A', 'B', 'C', 'D'], 'the G-4 rev. 06/03/26 letters');
});

test('Social Security stops at the wage base; Additional Medicare starts over $200,000', () => {
  assert.equal(tax.socialSecurity(500000, 18300000, T.FED_2026), Math.round(150000 * 0.062), 'only the $1,500 left under $184,500');
  assert.equal(tax.socialSecurity(500000, 18450000, T.FED_2026), 0);
  assert.equal(tax.medicare(1000000, 19500000, T.FED_2026), Math.round(1000000 * 0.0145 + 500000 * 0.009));
  const er = tax.employerTaxes(500000, 650000, T.FED_2026, 2.7, T.GA_2026);
  assert.equal(er.futa, Math.round(50000 * 0.006), 'FUTA on the $500 left under $7,000');
  assert.equal(er.gaSuta, Math.round(300000 * 0.027), 'SUTA on the $3,000 left under $9,500');
  assert.equal(tax.employerTaxes(500000, 0, T.FED_2026, null, T.GA_2026).gaSuta, null, 'no rate set is no figure, never a guess');
});

test('overtime: over 40 hours in a Monday-to-Sunday week, at 1.5x the weighted regular rate', () => {
  const day = (d, h, r) => ({ date: d, minutes: h * 60, rateCents: r });
  const h = tax.hourlyEarnings([day('2026-11-02', 10, 2000), day('2026-11-03', 10, 2000), day('2026-11-04', 10, 2000), day('2026-11-05', 15, 2000)]);
  assert.equal(h.straightTimeCents, 90000); assert.equal(h.overtimePremiumCents, 5000); assert.equal(h.overtimeMinutes, 300);
  // Two rates in one week: regular rate is the weighted average (29 CFR 778.115).
  const w = tax.hourlyEarnings([day('2026-11-02', 30, 2000), day('2026-11-03', 20, 3000)]);
  assert.equal(w.straightTimeCents, 120000); assert.equal(w.overtimePremiumCents, Math.round(10 * 2400 * 0.5));
  // 45 hours split across two workweeks is no overtime.
  assert.equal(tax.hourlyEarnings([day('2026-11-08', 25, 2000), day('2026-11-09', 20, 2000)]).overtimeMinutes, 0, 'Sunday 11/8 and Monday 11/9 are different weeks');
});

test('pay periods: weekly Monday–Sunday, biweekly Monday through the second Sunday', () => {
  assert.deepEqual(tax.periodFor('2026-11-11', { frequency: 'weekly', anchor: '2026-01-05' }).start, '2026-11-09');
  assert.deepEqual(tax.periodFor('2026-11-11', { frequency: 'weekly', anchor: '2026-01-05' }).end, '2026-11-15');
  const b = tax.periodFor('2026-11-11', { frequency: 'biweekly', anchor: '2026-01-05' });
  assert.equal(new Date(`${b.start}T12:00:00Z`).getUTCDay(), 1); assert.equal(new Date(`${b.end}T12:00:00Z`).getUTCDay(), 0);
  assert.equal(b.perYear, 26);
  assert.equal(tax.workweekStart('2026-11-15'), '2026-11-09', 'a Sunday belongs to the week that began Monday');
  assert.equal(tax.sendByDate('2026-11-16'), '2026-11-13', 'a Monday payday sends by the Friday before');
  assert.equal(tax.normalizeSettings({ anchor: '2026-11-10' }).code, 'PAY_ANCHOR', 'a period must start on a Monday');
});

// ── the paperwork ────────────────────────────────────────────────────────────
test('identifiers the SSA and the Fed never issue are refused', () => {
  for (const bad of ['000123456', '666123456', '912345678', '123004567', '123450000', '12345']) assert.ok(pp.checkSsn(bad), bad);
  assert.equal(pp.checkSsn('123-45-6789'), null);
  assert.equal(pp.checkRouting('021000021'), null);
  assert.ok(pp.checkRouting('021000022'), 'the ABA checksum fails');
});

test('a form is a signature: typed name and agreement, or nothing saves', () => {
  const ctx = { at: '2026-11-08T12:00:00Z' };
  assert.equal(pp.normalizeW4({ filingStatus: 'single', agree: true }, ctx).code, 'SIGNATURE_REQUIRED');
  assert.equal(pp.normalizeW4({ filingStatus: 'single', signedName: 'A B' }, ctx).code, 'AGREEMENT_REQUIRED');
  assert.equal(pp.normalizeW4({ filingStatus: 'single', signedName: 'A B', agree: true, dependentsAmount: 'lots' }, ctx).code, 'W4_AMOUNT');
  assert.equal(pp.normalizeW4({ filingStatus: 'single', signedName: 'A B', agree: true, dependentsAmount: '2000' }, ctx).value.dependentsCents, 200000);
  assert.equal(pp.normalizeI9Section2({ documents: [{ list: 'B', title: 'License' }], firstDay: '2026-11-09' }, { at: 'x', by: 'y' }).code, 'I9_DOCUMENTS', 'List B alone is not enough');
});

test('who is missing what: a run refuses anyone without W-4, G-4, SSN, I-9 or pay method', () => {
  const p = pp.defaultProfile({ id: 'u', role: 'user' });
  assert.deepEqual(pp.missingForPay(p).slice(0, 5), ['How they are paid (bank details, check or Wise)', 'SSN', 'W-4', 'G-4', 'I-9']);
  const ready = { ...p, payMethod: { method: 'check' }, ssn: { last4: '6789' }, w4: {}, g4: {}, i9: { section1: {}, section2: {} }, hourlyRateCents: 3000 };
  assert.deepEqual(pp.missingForPay(ready), []);
  assert.deepEqual(pp.missingForPay({ ...ready, i9: { section1: {} } }), ['I-9 Section 2 (the office)']);
  assert.ok(pp.defaultProfile({ id: 'c', role: 'vendor', licenseLevel: 'pca' }).isCaregiver);
  assert.equal(pp.defaultProfile({ id: 'c', role: 'vendor', licenseLevel: 'pca' }).wageAccount, 'home_care');
});

// ── secrets ──────────────────────────────────────────────────────────────────
test('SSNs and bank numbers are sealed; no key, nothing stored', () => {
  const sealed = pc.seal('123456789', ENV);
  assert.ok(!sealed.includes('123456789'));
  assert.equal(pc.open(sealed, ENV), '123456789');
  assert.notEqual(pc.seal('123456789', ENV), sealed, 'a fresh IV each time');
  assert.throws(() => pc.seal('x', {}), e => e.code === 'PAYROLL_KEY_MISSING');
  const pub = pp.publicProfile({ ...pp.defaultProfile({ id: 'u' }), ssn: { enc: sealed, last4: '6789' }, payMethod: { method: 'direct_deposit', routingEnc: 'R', accountEnc: 'A', accountLast4: '4321', routingLast4: '0021' } });
  assert.ok(!JSON.stringify(pub).includes(sealed) && !/"(routingEnc|accountEnc|enc)"/.test(JSON.stringify(pub)), 'no ciphertext reaches a screen either');
  assert.equal(pub.ssnLast4, '6789');
});

// ── the run ───────────────────────────────────────────────────────────────────
const ld = (v) => String(v).slice(0, 10);
const cgUser = { id: 'cg1', name: 'Pat Care', role: 'vendor', licenseLevel: 'pca', payRate: 18 };
const cgProfile = { ...pp.defaultProfile(cgUser), payMethod: { method: 'check' }, ssn: { last4: '1111' }, w4: { filingStatus: 'single' }, g4: { filingStatus: 'A' }, i9: { section1: {}, section2: {} } };
const period = { start: '2026-11-02', end: '2026-11-15', payDate: '2026-11-20' };
const log = (id, d, mins) => ({ id, caregiver_id: 'cg1', client_id: 'c1', shift_id: null, clock_in_at: `${d}T14:00:00Z`, clock_out_at: `${d}T22:00:00Z`, total_minutes: mins });

test('a run pays completed caregiver shifts at their rate, with overtime, and taxes each line', () => {
  const g = engine.gatherItems({ period, users: [cgUser], profilesById: new Map([['cg1', cgProfile]]), timeLogs: [log('a', '2026-11-02', 480), log('b', '2026-11-03', 480), log('c', '2026-11-04', 480), log('d', '2026-11-05', 480), log('e', '2026-11-06', 600)],
    shifts: [], visitTimings: [], imeCases: [], paidRefs: new Set(), localDate: ld, resolvePayRate: (u) => ({ rate: u.payRate, source: 'base' }) });
  const run = engine.buildRun({ period, settings: { frequency: 'biweekly', gaSutaRatePct: 2.7 }, people: [{ user: cgUser, profile: cgProfile }], gathered: g, ytdByUser: new Map(), tables: TABLES });
  const w = run.workers[0];
  assert.equal(w.earnings.find(e => e.code === 'regular').amountCents, 42 * 1800);
  assert.equal(w.earnings.find(e => e.code === 'overtime').amountCents, 2 * 900);
  assert.equal(w.pay.grossCents, 77400);
  assert.equal(w.pay.netCents, w.pay.grossCents - Object.values(w.pay.taxes).reduce((a, v) => a + v, 0));
  assert.equal(run.blocked.length, 0);
  assert.equal(run.totals.cashNeededCents, run.totals.netCents + run.totals.federalCents + run.totals.socialSecurityCents + run.totals.medicareCents + run.totals.georgiaCents + run.totals.employerSocialSecurityCents + run.totals.employerMedicareCents + run.totals.futaCents + run.totals.gaSutaCents);
});

test('hours already paid are never paid twice, and a shift with no rate is named, not paid at zero', () => {
  const g = engine.gatherItems({ period, users: [cgUser], profilesById: new Map(), timeLogs: [log('a', '2026-11-02', 480), log('b', '2026-11-03', 480)], shifts: [], visitTimings: [], imeCases: [],
    paidRefs: new Set(['log:a']), localDate: ld, resolvePayRate: () => ({ rate: null, source: 'unset' }) });
  assert.equal((g.byUser.get('cg1') || []).length, 0);
  assert.equal(g.skipped.length, 1);
  assert.equal(g.skipped[0].ref, 'log:b');
  const runs = [{ status: 'approved', workers: [{ refs: ['log:x'] }] }, { status: 'draft', workers: [{ refs: ['log:y'] }] }];
  assert.deepEqual([...engine.paidRefsFrom(runs)], ['log:x'], 'a draft locks nothing');
});

test('someone missing paperwork is shown and blocked, never quietly paid', () => {
  const p = { ...cgProfile, w4: null };
  const g = { byUser: new Map([['cg1', [{ ref: 'log:a', kind: 'hours', date: '2026-11-02', minutes: 480, rateCents: 1800 }]]]), skipped: [] };
  const run = engine.buildRun({ period, settings: { frequency: 'biweekly', gaSutaRatePct: 2.7 }, people: [{ user: cgUser, profile: p }], gathered: g, ytdByUser: new Map(), tables: TABLES });
  assert.equal(run.workers[0].pay, undefined);
  assert.deepEqual(run.blocked[0].missing, ['W-4']);
  assert.equal(run.totals.grossCents, 0);
});

// ── taxes owed ────────────────────────────────────────────────────────────────
test('deposit due dates follow the IRS rules and skip the weekend', () => {
  assert.equal(cal.fifteenthAfter('2026-11-20'), '2026-12-15');
  assert.equal(cal.semiweeklyDue('2026-11-20'), '2026-11-25', 'a Friday payday deposits by Wednesday');
  assert.equal(cal.semiweeklyDue('2026-11-16'), '2026-11-20', 'a Monday payday deposits by Friday');
  assert.equal(cal.quarterDue('2026-11-20'), '2027-01-31');
  assert.equal(cal.nextBusinessDay('2027-01-31'), '2027-02-01');
  const run = { id: 'r', status: 'approved', period, totals: { federalCents: 100, socialSecurityCents: 62, medicareCents: 15, employerSocialSecurityCents: 62, employerMedicareCents: 15, georgiaCents: 40, futaCents: 6, gaSutaCents: 27 } };
  const l = cal.liabilitiesForRun(run, { federalDepositSchedule: 'monthly', gaWithholdingFrequency: 'monthly' });
  assert.equal(l.find(x => x.type === 'federal_deposit').amountCents, 254);
  assert.equal(l.find(x => x.type === 'federal_deposit').dueDate, '2026-12-15');
  // FUTA under $500 for the year carries to the next quarter.
  const c = cal.calendar([run], [], { federalDepositSchedule: 'monthly', gaWithholdingFrequency: 'monthly' });
  assert.equal(c.find(g => g.type === 'futa').amountCents, 6, 'Q4 always deposits');
});

test('the 941 figures tie to the runs, with Social Security capped at the wage base', () => {
  const w = (uid, gross) => ({ userId: uid, name: uid, pay: { grossCents: gross, taxes: { federal: 1000, socialSecurity: 0, medicare: 0, georgia: 500 }, employer: { socialSecurity: 0, medicare: 0 } } });
  const runs = [{ id: 'q3', status: 'paid', period: { payDate: '2026-09-15' }, workers: [w('a', 18000000)] }, { id: 'q4', status: 'paid', period: { payDate: '2026-10-15' }, workers: [w('a', 1000000)] }];
  const q = cal.quarterSummary(runs, { year: 2026, quarter: 4, fed: T.FED_2026, sutaWageBaseCents: 950000 });
  assert.equal(q.form941.line2_wagesCents, 1000000);
  assert.equal(q.form941.line5a_ssWagesCents, 450000, 'only $4,500 was under the $184,500 base');
  assert.equal(q.formDOL4N.taxableWagesCents, 0, 'already over the $9,500 SUTA base');
  assert.equal(q.formG7.totalWithheldCents, 500);
});

// ── QuickBooks: PHC only ────────────────────────────────────────────────────────
test('QuickBooks takes only private home care, and every journal balances', () => {
  assert.ok(qb.assertPhc({ kind: 'copay' }, { serviceLine: 'PHC' }), 'a copay is clinical');
  assert.ok(qb.assertPhc({ kind: 'home_care' }, { serviceLine: 'IHPC' }));
  assert.equal(qb.assertPhc({ kind: 'home_care' }, { serviceLine: 'BOTH' }), null);
  const ids = Object.fromEntries(Object.keys(qb.ACCOUNTS).map(k => [k, k]));
  const run = { period, workers: [{ wageAccount: 'home_care', pay: { grossCents: 100000, reimbursementsCents: 500 } }],
    totals: { netCents: 81000, federalCents: 9000, socialSecurityCents: 6200, medicareCents: 1450, georgiaCents: 2850, employerSocialSecurityCents: 6200, employerMedicareCents: 1450, futaCents: 600, gaSutaCents: 2700 } };
  const je = qb.journalForRun(run, ids);
  const sum = (t) => je.Line.filter(l => l.JournalEntryLineDetail.PostingType === t).reduce((a, l) => a + Math.round(l.Amount * 100), 0);
  assert.equal(sum('Debit'), sum('Credit'));
  assert.throws(() => qb.journalForRun({ ...run, totals: { ...run.totals, netCents: 80000 } }, ids), /does not balance/, 'an unbalanced journal is never posted');
  assert.equal(qb.requestIdFor('run:1'), qb.requestIdFor('run:1'), 'a retry is the same request to QuickBooks');
  const split = qb.taxSplit({ key: 'federal_deposit:2026-12-15', amountCents: 25401 }, [run]);
  assert.equal(split.reduce((a, s) => a + s.amountCents, 0), 25401, 'the split adds up to the cent');
  assert.equal(qb.accountNumberFor('1a2b-3c4d-5e6f'), 'GFC-1A2B3C4D');
});

test('the server sends QuickBooks invoices only through the PHC door, and never a copay', () => {
  const server = read('server.js');
  assert.match(server, /if \(to === 'open'\) qbo\.invoiceSent\(t\.inv\)/);
  assert.match(read('quickbooks.js'), /const refused = assertPhc\(inv, client\);\n\s+if \(refused\) return \{ skipped: refused \};/);
  assert.doesNotMatch(read('quickbooks.js'), /createCopayInvoice|encounter|diagnos/i);
});

// ── IME ─────────────────────────────────────────────────────────────────────────
test('IME: an entity with no rates bills nothing; an exam bills once; voiding frees it', () => {
  const cases = [{ id: 'k1', status: 'report_submitted', contractingEntity: 'ves', referenceId: 'C-1', examDate: '2026-11-02' }, { id: 'k2', status: 'open', contractingEntity: 'ves' }];
  assert.equal(ime.buildInvoice({ entity: 'ves', picks: [{ caseId: 'k1', code: 'x' }], cases, invoices: [], schedules: {} }).code, 'IME_NO_SCHEDULE');
  const schedules = { ves: ime.normalizeSchedule('ves', { rates: [{ label: 'General medical', rate: '350' }] }).value };
  assert.equal(schedules.ves.rates[0].rateCents, 35000);
  const r = ime.buildInvoice({ entity: 'ves', picks: [{ caseId: 'k1', code: 'general_medical' }], cases, invoices: [], schedules });
  assert.equal(r.value.totalCents, 35000);
  const live = [{ status: 'sent', lines: [{ caseId: 'k1' }] }];
  assert.equal(ime.buildInvoice({ entity: 'ves', picks: [{ caseId: 'k1', code: 'general_medical' }], cases, invoices: live, schedules }).code, 'IME_NOT_BILLABLE');
  assert.equal(ime.unbilled(cases, [{ status: 'void', lines: [{ caseId: 'k1' }] }], schedules).length, 1);
  assert.equal(ime.buildInvoice({ entity: 'lsgs', picks: [{ caseId: 'k1', code: 'general_medical' }], cases, invoices: [], schedules: { ...schedules, lsgs: schedules.ves } }).code, 'IME_WRONG_ENTITY');
  assert.equal(ime.transition({ status: 'sent' }, 'paid', { at: 'x', by: 'y' }).code, 'IME_PAYMENT_REFERENCE');
});

// ── wiring into My GFC, not beside it ────────────────────────────────────────────
test('pay setup lives in My GFC\'s Hours & Pay, and stubs land in the store My GFC already lists', () => {
  const g = read('public/my-gfc.js');
  assert.match(g, /window\.MyPay && <Section id="mg-pay" title="Pay Setup"/);
  assert.match(g, /<window\.MyPay\.ContractorInvoices Section=\{Section\} \/>/);
  for (const page of ['public/my.html', 'public/caregiver.html']) {
    const h = fs.readFileSync(path.join(ROOT, page), 'utf8');
    assert.ok(h.indexOf('src="/my-pay.js"') > 0 && h.indexOf('src="/my-pay.js"') < h.indexOf('src="/my-gfc.js"'), `${page} loads my-pay.js before my-gfc.js`);
  }
  const r = read('routes/payroll.js');
  assert.match(r, /const PAYSTUBS = 'staff_paystubs';/, 'one stub store, shared with routes/staffPortal.js');
  assert.match(r, /req\.get\('X-GFC-Payroll-Key'\)/, 'the Apps Script\'s header');
  assert.match(r, /env\.PAYROLL_INGEST_KEY/, 'and its key: one secret');
  const notice = r.slice(r.indexOf("queueNotification('paystub_ready'"), r.indexOf("relatedEntityType: 'paystub'"));
  assert.ok(notice.length > 50, 'the stub notice was found');
  assert.doesNotMatch(notice, /usd\(|Cents|gross|\.net/, 'the stub email carries no amount');
});

// ── the routes, through a real router ──────────────────────────────────────────
function harness(user, store = new Map()) {
  const db = { get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
  const acts = [];
  const users = [{ id: 'own', role: 'admin', name: 'Owner', email: 'o@x' }, { id: 'cg1', role: 'vendor', licenseLevel: 'pca', name: 'Pat Care', email: 'p@x', payRate: 18 },
    { id: 'cg2', role: 'vendor', licenseLevel: 'pca', name: 'Sam Aide', email: 's@x', payRate: 20 },
    { id: 'st1', role: 'user', name: 'Dee Examiner', email: 'd@x', employmentType: '1099' }];
  const routes = require('../routes/payroll')({
    db, env: ENV, payrollKey: 'k'.repeat(40), logActivity: async (...a) => acts.push(a), getUsers: async () => users,
    authenticateToken: (req, res, next) => { req.user = users.find(u => u.id === user); next(); },
    requireAdmin: (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'no' })),
    uuidv4: (() => { let n = 0; return () => `id${++n}`; })(), accountTypeOf: (u) => (u.role === 'admin' ? 'admin' : 'caregiver'), localDate: ld,
    resolvePayRate: (u) => ({ rate: u && u.payRate, source: 'base' }), queueNotification: async () => {}, hashIp: () => 'h',
    pdf: require('../pdf-generator'), drive: { uploadStaffDocumentFile: async () => ({ fileId: 'drv1' }) }, roleFolderFor: () => 'F', personFolderName: (n) => n, getAppBaseUrl: async () => 'https://app'
  });
  const app = express(); app.use(express.json()); app.use(routes);
  return { app, store, acts };
}
const req = async (app, method, url, body, headers) => {
  const srv = app.listen(0); const port = srv.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  } finally { srv.close(); }
};

test('a person\'s SSN and bank numbers are sealed in the store and never come back', async () => {
  const { app, store } = harness('cg1');
  let r = await req(app, 'PUT', '/api/my/pay-setup/ssn', { ssn: '123-45-6789' });
  assert.equal(r.status, 200); assert.equal(r.body.profile.ssnLast4, '6789');
  r = await req(app, 'PUT', '/api/my/pay-setup/pay-method', { method: 'direct_deposit', routing: '021000021', account: '987654321', accountType: 'checking', bankName: 'PNC' });
  assert.equal(r.status, 200);
  const raw = JSON.stringify(store.get('payroll_profiles'));
  for (const s of ['123456789', '021000021', '987654321']) { assert.ok(!raw.includes(s), `${s} stored in the clear`); assert.ok(!JSON.stringify(r.body).includes(s)); }
  r = await req(app, 'PUT', '/api/my/pay-setup/pay-method', { method: 'direct_deposit', routing: '021000022', account: '1', accountType: 'checking' });
  assert.equal(r.body.code, 'BANK_ROUTING');
});

test('only the owner reveals a number, and every reveal is logged without the value', async () => {
  const { app, store, acts } = harness('cg1');
  await req(app, 'PUT', '/api/my/pay-setup/ssn', { ssn: '123456789' });
  assert.equal((await req(app, 'POST', '/api/payroll/admin/people/cg1/reveal', { field: 'ssn' })).status, 403);
  const own = harness('own', store);
  const r = await req(own.app, 'POST', '/api/payroll/admin/people/cg1/reveal', { field: 'ssn' });
  assert.equal(r.body.value, '123456789');
  const logged = JSON.stringify(own.acts.filter(a => a[2] === 'payroll_secret_revealed'));
  assert.ok(logged.includes('"field":"ssn"') && !logged.includes('123456789'));
  assert.ok(!JSON.stringify(acts).includes('123456789'));
});

test('a draft needs approved tables; approval refuses missing paperwork, then locks hours and writes the stub into My GFC\'s store', async () => {
  const store = new Map();
  const { app } = harness('own', store);
  store.set('time_logs', [log('a', '2026-11-02', 480), { ...log('z', '2026-11-03', 240), caregiver_id: 'cg2' }]);
  store.set('payroll_settings', { frequency: 'biweekly', anchor: '2026-01-05', payDateOffsetDays: 5, gaSutaRatePct: 2.7 });
  let r = await req(app, 'POST', '/api/payroll/admin/runs', { periodStart: '2026-11-02', schedule: 'caregivers' });
  assert.equal(r.body.code, 'PAYROLL_NO_TABLES', 'staged tables pay nothing');
  store.set('payroll_tax_tables', T.seedRows([], { uuid: () => Math.random().toString(36), at: 'x' }).map(t => ({ ...t, status: 'active', approvedAt: 'x' })));
  r = await req(app, 'POST', '/api/payroll/admin/runs', { periodStart: '2026-11-02', schedule: 'caregivers' });
  assert.equal(r.status, 200);
  const runId = r.body.run.id;
  assert.ok(r.body.run.blocked.find(b => b.userId === 'cg1'));
  r = await req(app, 'POST', `/api/payroll/admin/runs/${runId}/approve`);
  assert.equal(r.body.code, 'RUN_BLOCKED');
  store.set('payroll_profiles', { cg1: cgProfile, cg2: { ...cgProfile, userId: 'cg2' } });
  r = await req(app, 'POST', `/api/payroll/admin/runs/${runId}/approve`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(store.get('time_logs')[0].payroll_run_id, runId, 'the paid hours lock');
  const stub = store.get('staff_paystubs')[0];
  assert.deepEqual([stub.userId, stub.reference, stub.driveFileId, stub.source], ['cg1', `run:${runId}`, 'drv1', 'app']);
  r = await req(app, 'POST', `/api/payroll/admin/runs/${runId}/adjustments`, { userId: 'cg1', type: 'bonus', amount: '50', note: 'x' });
  assert.equal(r.body.code, 'RUN_LOCKED');
  // Paid only when every worker has a confirmation.
  r = await req(app, 'POST', `/api/payroll/admin/runs/${runId}/payments/cg1`, {});
  assert.equal(r.body.code, 'PAYMENT_CONFIRMATION');
  r = await req(app, 'POST', `/api/payroll/admin/runs/${runId}/payments/cg1`, { confirmation: 'PNC-1' });
  assert.equal(r.body.run.status, 'approved', 'one of two confirmed is not paid');
  r = await req(app, 'POST', `/api/payroll/admin/runs/${runId}/payments/cg2`, { confirmation: 'PNC-2' });
  assert.equal(r.body.run.status, 'paid');
});

test('the automations take the Apps Script\'s key and only draft', async () => {
  const { app } = harness('own');
  assert.equal((await req(app, 'POST', '/api/payroll/automation/missing-time', {})).status, 401);
  assert.equal((await req(app, 'POST', '/api/payroll/automation/missing-time', {}, { 'X-GFC-Payroll-Key': 'k'.repeat(40) })).status, 200);
  assert.equal((await req(app, 'POST', '/api/payroll/automation/approve-run', {}, { 'X-GFC-Payroll-Key': 'k'.repeat(40) })).status, 404, 'there is no approve job');
  const src = read('routes/payroll.js');
  const jobs = src.slice(src.indexOf('const automationJobs = {'), src.indexOf('return router;'));
  assert.doesNotMatch(jobs, /status: 'approved'|status = 'active'|'paid'/, 'no job approves, activates or pays');
});

test('a contractor invoice number is never reused, and a non-contractor cannot invoice', async () => {
  const store = new Map();
  const { app } = harness('cg1', store);
  const st = harness('st1', store);
  const body = { invoiceNo: 'A-1', periodStart: '2026-11-01', periodEnd: '2026-11-14', lines: [{ serviceDate: '2026-11-02', description: 'Exam', unit: 'exam', qty: 1, rate: '300' }] };
  assert.equal((await req(app, 'POST', '/api/my/contractor-invoices', body)).body.code, 'CI_NOT_CONTRACTOR');
  // A caregiver stays W-2 even if a stored profile says 1099.
  store.set('payroll_profiles', { cg1: { ...cgProfile, workerType: '1099' } });
  assert.equal((await req(app, 'POST', '/api/my/contractor-invoices', body)).body.code, 'CI_NOT_CONTRACTOR');
  // 1099 comes from the user record (User Management), with no payroll profile saved.
  assert.equal((await req(st.app, 'POST', '/api/my/contractor-invoices', body)).body.invoice.totalCents, 30000);
  assert.equal((await req(st.app, 'POST', '/api/my/contractor-invoices', body)).body.code, 'CI_NUMBER_USED');
});

test('a paid time log is locked against edits', () => {
  assert.match(read('routes/scheduling.js'), /if \(log\.payroll_run_id\) \{\n\s+return \{ error: \{ status: 409,[^\n]*code: 'TIME_LOG_PAYROLL_LOCKED' \} \};/);
});

test('W-2 staff time on the shared clock is paid at their payroll rate; a salaried person\'s is not paid twice', () => {
  const staffLog = (id, uid) => ({ id, caregiver_id: uid, client_id: null, shift_id: null, kind: 'staff', clock_in_at: '2026-11-03T13:00:00Z', clock_out_at: '2026-11-03T21:00:00Z', total_minutes: 480 });
  const profilesById = new Map([['rn1', { userId: 'rn1', workerType: 'W2', payType: 'hourly', hourlyRateCents: 4000 }], ['ad1', { userId: 'ad1', workerType: 'W2', payType: 'salary', salaryAnnualCents: 5200000 }]]);
  const g = engine.gatherItems({ period, users: [{ id: 'rn1' }, { id: 'ad1' }], profilesById, timeLogs: [staffLog('s1', 'rn1'), staffLog('s2', 'ad1')], shifts: [], visitTimings: [], imeCases: [],
    paidRefs: new Set(), localDate: ld, resolvePayRate: () => { throw new Error('a staff row never uses the caregiver rate'); } });
  assert.deepEqual(g.byUser.get('rn1').map(i => [i.ref, i.minutes, i.rateCents, i.source]), [['log:s1', 480, 4000, 'Staff time']]);
  assert.equal(g.byUser.get('ad1'), undefined);
});

test('W-2 or 1099 has one home: the user record wins over the payroll profile, and the payroll page cannot contradict it', async () => {
  assert.equal(pp.withEmploymentType({ workerType: 'W2' }, { employmentType: 'HYBRID' }).workerType, 'HYBRID');
  assert.equal(pp.withEmploymentType({ workerType: '1099' }, {}).workerType, '1099', 'unset on the user: the profile is the fallback');
  assert.equal(pp.withEmploymentType({ workerType: '1099', isCaregiver: true }, { employmentType: '1099' }).workerType, 'W2');
  const { app } = harness('own');
  let r = await req(app, 'PUT', '/api/payroll/admin/people/st1', { workerType: 'W2' });
  assert.equal(r.body.code, 'EMPLOYMENT_TYPE_ON_USER');
  r = await req(app, 'PUT', '/api/payroll/admin/people/st1', { hourlyRate: '50' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.profile.workerType, '1099');
});

test('there is one staff clock (main\'s): payroll adds no clock of its own', () => {
  const src = read('routes/payroll.js') + read('public/my-pay.js') + read('payrollEngine.js');
  assert.doesNotMatch(src, /staff_time_entries|\/api\/my\/clock|staffEntries/);
});

// ---------------------------------------------------------------------------
// TWO PAY SCHEDULES (owner, 2026-11-09): caregivers weekly, everyone else
// every two weeks, each with its own runs.
// ---------------------------------------------------------------------------
test('two pay schedules: caregivers weekly, everyone else every two weeks, and old settings read as the staff schedule', () => {
  const legacy = { frequency: 'biweekly', anchor: '2026-01-05', payDateOffsetDays: 5 };
  assert.deepEqual(tax.scheduleSettings(legacy, 'staff'), { frequency: 'biweekly', anchor: '2026-01-05', payDateOffsetDays: 5 });
  assert.equal(tax.scheduleSettings(legacy, 'caregivers').frequency, 'weekly');
  const cgP = tax.periodFor('2026-11-04', legacy, 'caregivers');
  assert.deepEqual([cgP.start, cgP.end, cgP.perYear, cgP.schedule], ['2026-11-02', '2026-11-08', 52, 'caregivers']);
  const stP = tax.periodFor('2026-11-04', legacy, 'staff');
  assert.deepEqual([stP.start, stP.end, stP.perYear, stP.schedule], ['2026-10-26', '2026-11-08', 26, 'staff']);
  // Each schedule is validated on its own and says which one is wrong.
  const bad = tax.normalizeSettings({ schedules: { caregivers: { anchor: '2026-11-04' } } }, legacy);
  assert.equal(bad.code, 'PAY_ANCHOR'); assert.match(bad.error, /^Caregivers/);
  assert.equal(tax.normalizeSettings({ schedules: { nurses: {} } }, legacy).code, 'PAY_SCHEDULE');
  const ok = tax.normalizeSettings({ schedules: { caregivers: { payDateOffsetDays: 3 } } }, legacy).value;
  assert.equal(ok.schedules.caregivers.payDateOffsetDays, 3);
  assert.equal(ok.schedules.staff.frequency, 'biweekly', 'the untouched schedule keeps its values');
  assert.equal(tax.periodFor('2026-11-04', ok, 'caregivers').payDate, '2026-11-11', 'a saved schedule is the one used');
  // Who is on which: a caregiver weekly, anyone else biweekly, the owner can move a person.
  assert.equal(pp.scheduleFor(pp.defaultProfile(cgUser)), 'caregivers');
  assert.equal(pp.scheduleFor(pp.defaultProfile({ id: 'n1', role: 'user' })), 'staff');
  assert.equal(pp.scheduleFor({ ...pp.defaultProfile(cgUser), paySchedule: 'staff' }), 'staff');
  assert.equal(pp.normalizePaySetup({ paySchedule: 'monthly' }).code, 'PAY_SCHEDULE');
  assert.equal(pp.normalizePaySetup({ paySchedule: '' }).value.paySchedule, null);
});

test('a run pays only the people on its schedule, and the weekly run divides by 52', async () => {
  const store = new Map();
  const { app } = harness('own', store);
  const staffLog = { id: 'sx', caregiver_id: 'nx', client_id: null, shift_id: null, kind: 'staff', clock_in_at: '2026-11-03T13:00:00Z', clock_out_at: '2026-11-03T21:00:00Z', total_minutes: 480 };
  store.set('time_logs', [log('a', '2026-11-02', 480), staffLog]);
  store.set('payroll_settings', { frequency: 'biweekly', anchor: '2026-01-05', payDateOffsetDays: 5, gaSutaRatePct: 2.7 });
  store.set('payroll_tax_tables', T.seedRows([], { uuid: () => Math.random().toString(36), at: 'x' }).map(t => ({ ...t, status: 'active', approvedAt: 'x' })));
  store.set('payroll_profiles', { cg1: cgProfile });
  assert.equal((await req(app, 'POST', '/api/payroll/admin/runs', { periodStart: '2026-11-02' })).body.code, 'RUN_SCHEDULE', 'a run names its schedule');
  let r = await req(app, 'POST', '/api/payroll/admin/runs', { periodStart: '2026-11-02', schedule: 'caregivers' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.run.schedule, r.body.run.perYear, r.body.run.period.end], ['caregivers', 52, '2026-11-08']);
  assert.deepEqual(r.body.run.workers.map(w => w.userId), ['cg1']);
  const cgRunId = r.body.run.id;
  // The staff run for the overlapping period is its own run, not the caregiver one rebuilt.
  r = await req(app, 'POST', '/api/payroll/admin/runs', { periodStart: '2026-11-02', schedule: 'staff' });
  assert.notEqual(r.body.run.id, cgRunId);
  assert.ok(!r.body.run.workers.some(w => w.userId === 'cg1'), 'a caregiver is never in the staff run');
  // Moving the caregiver to the staff schedule moves them.
  store.set('payroll_profiles', { cg1: { ...cgProfile, paySchedule: 'staff' } });
  r = await req(app, 'POST', '/api/payroll/admin/runs', { periodStart: '2026-11-02', schedule: 'staff' });
  assert.deepEqual([r.body.run.workers.map(w => w.userId), r.body.run.perYear], [['cg1'], 26]);
  // Both schedules can start a period on the same Monday; they are still two runs.
  const a = await req(app, 'POST', '/api/payroll/admin/runs', { periodStart: '2026-10-26', schedule: 'caregivers' });
  const b = await req(app, 'POST', '/api/payroll/admin/runs', { periodStart: '2026-10-26', schedule: 'staff' });
  assert.equal(a.body.run.period.start, b.body.run.period.start);
  assert.notEqual(a.body.run.id, b.body.run.id, 'same start date, different schedules, different runs');
  const ov = (await req(app, 'GET', '/api/payroll/admin/overview')).body;
  assert.deepEqual(ov.schedules.map(s => [s.key, s.frequency]), [['caregivers', 'weekly'], ['staff', 'biweekly']]);
});

test('period close drafts each schedule on its own and skips one with nobody to pay', async () => {
  const src = read('routes/payroll.js');
  const job = src.slice(src.indexOf("'period-close': async"), src.indexOf("'missing-time': async"));
  assert.match(job, /for \(const schedule of Object\.keys\(tax\.PAY_SCHEDULES\)\)/);
  assert.match(job, /close:\$\{schedule\}:\$\{period\.start\}/, 'one owner notice per schedule and period');
  assert.match(job, /!existing && !d\.run\.workers\.length/);
});

test('Pay Setup lists pay and tax paperwork only, grouped, and hiring paperwork is not repeated there', async () => {
  const rows = pp.checklist({ ...pp.defaultProfile(cgUser) });
  assert.deepEqual(rows.map(r => r.key), ['w4', 'g4', 'i9', 'ssn', 'pay', 'taxaddress', 'edelivery']);
  assert.ok(rows.every(r => r.group === 'tax' || r.group === 'paid'));
  assert.ok(!rows.some(r => /offer|handbook/i.test(r.key + r.label)), 'the offer letter and handbook belong to onboarding');
  const { app } = harness('cg1');
  assert.equal((await req(app, 'PUT', '/api/my/pay-setup/offer', { signatureName: 'Pat Care', agree: true })).status >= 400, true, 'and the form is gone from Pay Setup');
  const page = read('public/my-pay.js');
  assert.ok(!/offer: 'offer'|handbook: 'handbook'/.test(page));
  assert.match(page, /'Tax forms' : 'Getting paid'/);
});

test('the run register CSV is the run: each line from the run, and its TOTAL row equals the run\'s totals', async () => {
  const store = new Map();
  const { app } = harness('own', store);
  store.set('time_logs', [log('a', '2026-11-02', 480), { ...log('z', '2026-11-03', 600), caregiver_id: 'cg2' }]);
  store.set('payroll_settings', { frequency: 'biweekly', anchor: '2026-01-05', payDateOffsetDays: 5, gaSutaRatePct: 2.7 });
  store.set('payroll_tax_tables', T.seedRows([], { uuid: () => Math.random().toString(36), at: 'x' }).map(t => ({ ...t, status: 'active', approvedAt: 'x' })));
  store.set('payroll_profiles', { cg1: cgProfile, cg2: { ...cgProfile, userId: 'cg2' } });
  const runId = (await req(app, 'POST', '/api/payroll/admin/runs', { periodStart: '2026-11-02', schedule: 'caregivers' })).body.run.id;
  await req(app, 'POST', `/api/payroll/admin/runs/${runId}/approve`);
  const run = store.get('payroll_runs').find(r => r.id === runId);
  const srv = app.listen(0);
  let text;
  try { text = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/payroll/admin/runs/${runId}/register.csv`)).text(); } finally { srv.close(); }
  const rowsOut = text.trim().split('\r\n').map(l => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(c => c.replace(/,$/, '').replace(/^"|"$/g, '')));
  const head = rowsOut[0], body = rowsOut.slice(1, -1), total = rowsOut[rowsOut.length - 1];
  const col = (name) => head.indexOf(name);
  assert.equal(body.length, run.workers.length);
  for (const name of ['Gross', 'Net Pay', 'Federal Income Tax', 'Social Security', 'Medicare', 'State Income Tax']) {
    const sum = body.reduce((t, r) => t + Math.round(Number(r[col(name)]) * 100), 0);
    assert.equal(Math.round(Number(total[col(name)]) * 100), sum, `${name}: the lines add up to the total`);
  }
  assert.equal(total[col('Gross')], (run.totals.grossCents / 100).toFixed(2));
  assert.equal(total[col('Net Pay')], (run.totals.netCents / 100).toFixed(2));
  const pat = body.find(r => r[0] === 'Pat Care');
  assert.equal(pat[col('Regular Hours')], '8.00');
  assert.ok(!/\b\d{9}\b/.test(text), 'no SSN or account number');
});

test('the owner sets each schedule\'s first Monday on Settings, and a non-Monday is refused', async () => {
  const store = new Map();
  const { app } = harness('own', store);
  store.set('payroll_settings', { frequency: 'biweekly', anchor: '2026-01-05', payDateOffsetDays: 5 });
  let r = await req(app, 'PUT', '/api/payroll/admin/settings', { schedules: { staff: { anchor: '2026-01-14' } } });
  assert.equal(r.body.code, 'PAY_ANCHOR');
  r = await req(app, 'PUT', '/api/payroll/admin/settings', { schedules: { staff: { frequency: 'biweekly', anchor: '2026-01-12' } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(tax.periodFor('2026-11-04', r.body.settings, 'staff').start, '2026-11-02', 'the biweekly weeks moved by one');
  assert.equal(tax.scheduleSettings(r.body.settings, 'caregivers').anchor, '2026-01-05', 'the other schedule is untouched');
  const page = read('public/payroll.html');
  assert.match(page, /First Monday of a pay period<input type="date"/);
  assert.match(page, /v\.anchor && v\.anchor !== was\.anchor \? \{ anchor: v\.anchor \}/, 'an unchanged date is not sent, so a frequency change still starts at the next period');
});

// An I-9 already on file from Gusto or paper (owner, 2026-11-13): the
// employee does not fill it in again, and the copy must be on their record.
test('an I-9 on file from before counts as complete; the copy must be filed first', () => {
  const pp = require('../payrollProfiles');
  const base = { ...pp.defaultProfile({ id: 'x', role: 'user' }), w4: {}, g4: {}, ssn: { last4: '1' }, payMethod: { method: 'check' } };
  assert.ok(pp.missingForPay(base).includes('I-9'));
  assert.equal(pp.normalizeI9OnFile({ firstDay: '2025-03-03' }, { at: 'now', by: 'A' }).code, 'I9_COPY_NOT_FILED');
  assert.equal(pp.normalizeI9OnFile({ copyFiled: true }, { at: 'now', by: 'A' }).code, 'I9_FIRST_DAY');
  const n = pp.normalizeI9OnFile({ firstDay: '2025-03-03', copyFiled: true, source: 'gusto' }, { at: 'now', by: 'A' });
  const p = { ...base, i9: { onFile: n.value } };
  assert.ok(!pp.missingForPay(p).some(m => /I-9/.test(m)), 'no I-9 left to do');
  const row = pp.checklist(p).find(r => r.key === 'i9');
  assert.equal(row.done, true); assert.equal(row.locked, true);
  assert.match(row.note, /Already on file/);
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'payroll.js'), 'utf8');
  assert.match(src, /router\.put\('\/api\/payroll\/admin\/people\/:userId\/i9-on-file', authenticateToken, requireAdmin,/);
});
