'use strict';
// Payroll in more than one state (2026-11-09): Georgia first, unchanged;
// Texas ships second; any other state is added by approving its table.
const test = require('node:test');
const assert = require('node:assert');

const tax = require('../payrollTax');
const engine = require('../payrollEngine');
const cal = require('../payrollCalendar');
const T = require('../payrollTaxTables');
const pp = require('../payrollProfiles');
const qb = require('../quickbooks');
const ye = require('../payrollYearEnd');

const TABLES = { federal: T.FED_2026, GA: T.GA_2026, states: { TX: T.TX_2026 } };
const period = { start: '2026-11-02', end: '2026-11-15', payDate: '2026-11-20' };
const W4 = { filingStatus: 'single' };
const base = (id, extra) => ({ ...pp.defaultProfile({ id, name: id }), payMethod: { method: 'check' }, ssn: { last4: '1' }, w4: W4, i9: { section1: {}, section2: {} }, hourlyRateCents: 2000, ...extra });
const items = (uid, minutes) => ({ byUser: new Map([[uid, [{ ref: `log:${uid}`, kind: 'hours', date: '2026-11-03', minutes, rateCents: 2000 }]]]), skipped: [] });
const run = (profile, settings, tables = TABLES, minutes = 600) => engine.buildRun({ period, settings: { frequency: 'biweekly', gaSutaRatePct: 2.7, ...settings }, people: [{ user: { id: profile.userId, name: profile.userId }, profile }], gathered: items(profile.userId, minutes), ytdByUser: new Map(), tables });

test('Georgia is unchanged: G-4 required, Georgia tax and Georgia unemployment', () => {
  const r = run(base('g1', { g4: { filingStatus: 'A' } }), {}, TABLES, 60 * 80);
  const w = r.workers[0];
  assert.ok(w.pay.taxes.georgia > 0);
  assert.equal(w.pay.taxes.state, undefined);
  assert.equal(w.pay.employer.gaSuta, Math.round(w.pay.grossCents * 2.7 / 100));
  assert.equal(w.pay.workState, 'GA');
  assert.deepEqual(pp.missingForPay({ ...base('g2'), g4: null }).includes('G-4'), true);
});

test('Texas: no state income tax, no G-4, Texas unemployment on the first $9,000 at GFC\'s Texas rate', () => {
  const p = base('t1', { workState: 'TX' });
  assert.equal(pp.missingForPay(p).includes('G-4'), false, 'Georgia\'s form is not asked of a Texas worker');
  const r = run(p, { states: { TX: { sutaRatePct: 2.7 } } }, TABLES, 60 * 80);
  const w = r.workers[0];
  assert.deepEqual(r.blocked, []);
  assert.ok(w.pay.grossCents > 150000, 'enough pay that Georgia tax would show if it were applied');
  assert.equal(w.pay.taxes.georgia, 0);
  assert.equal(w.pay.taxes.state, 0);
  assert.equal(w.pay.employer.gaSuta, 0, 'no Georgia unemployment for a Texas worker');
  assert.equal(w.pay.employer.stateSuta, Math.round(w.pay.grossCents * 2.7 / 100));
  assert.equal(r.totals.byState.TX.sutaCents, w.pay.employer.stateSuta);
  assert.equal(r.totals.cashNeededCents, r.totals.netCents + r.totals.federalCents + r.totals.socialSecurityCents + r.totals.medicareCents + r.totals.employerSocialSecurityCents + r.totals.employerMedicareCents + r.totals.futaCents + w.pay.employer.stateSuta);
  // The wage base: wages already over $9,000 this year owe nothing more.
  const capped = tax.paycheck({ earnings: [{ amountCents: 100000 }], ytd: { grossCents: 880000 }, w4: W4, tables: TABLES, perYear: 26, sutaRatePct: 2.7, workState: 'TX' });
  assert.equal(capped.employer.stateSuta, Math.round(20000 * 2.7 / 100));
});

test('a Texas worker is blocked until the Texas table is approved, and the run flags a missing Texas rate', () => {
  const p = base('t1', { workState: 'TX' });
  const noTable = run(p, {}, { federal: T.FED_2026, GA: T.GA_2026, states: {} });
  assert.match(noTable.blocked[0].missing.join(' '), /approve a Texas tax table/);
  assert.equal(noTable.workers[0].pay, undefined);
  const noRate = run(p, { gaSutaRatePct: null });
  assert.deepEqual(noRate.stateRatesMissing, ['TX']);
  assert.equal(noRate.sutaRateMissing, false, 'no Georgia rate is needed for a Texas-only run');
});

test('a state that taxes wages needs its own certificate, and its table does the math', () => {
  const FLAT = { incomeTax: true, method: 'flat', ratePct: 5, exemptionCents: 100000, sutaWageBaseCents: 1000000 };
  assert.equal(T.validateTable({ year: 2026, jurisdiction: 'NC', data: FLAT }).error, undefined);
  const tables = { ...TABLES, states: { NC: FLAT } };
  const p = base('n1', { workState: 'NC' });
  assert.match(run(p, {}, tables).blocked[0].missing.join(' '), /North Carolina withholding certificate/);
  const withCert = run({ ...p, stateCert: { state: 'NC', filingStatus: 'single', allowances: 1 } }, { states: { NC: { sutaRatePct: 1 } } }, tables);
  // $200 biweekly = $5,200 a year, less $1,000 = $4,200 × 5% = $210 / 26 = $8.08
  assert.equal(withCert.workers[0].pay.taxes.state, 808);
  const BR = { incomeTax: true, method: 'brackets', sutaWageBaseCents: 0, allowanceCents: 0, standardDeductionCents: { single: 0, married: 0 }, brackets: { single: [[0, 1000000, 0, 2], [1000000, null, 20000, 4]], married: [[0, null, 0, 1]] } };
  assert.equal(T.validateTable({ year: 2026, jurisdiction: 'SC', data: BR }).error, undefined);
  // $520/yr... take $30,000 a year: 2% of $10,000 + 4% of $20,000 = $1,000 a year
  assert.equal(tax.stateWithholding(115385, BR, { filingStatus: 'single' }, 26), Math.round(100000 / 26));
  assert.ok(T.validateTable({ year: 2026, jurisdiction: 'ZZ', data: FLAT }).error);
  assert.ok(T.validateTable({ year: 2026, jurisdiction: 'TX', data: { incomeTax: false, method: 'flat', sutaWageBaseCents: 1 } }).error);
});

test('the calendar: Texas unemployment goes to the TWC quarterly, never to Georgia DOL', () => {
  const r = run(base('t1', { workState: 'TX' }), { states: { TX: { sutaRatePct: 2.7 } } });
  const l = cal.liabilitiesForRun({ ...r, id: 'r1', status: 'approved' }, { federalDepositSchedule: 'monthly', gaWithholdingFrequency: 'monthly' });
  assert.ok(!l.some(x => x.type === 'ga_suta'));
  const tx = l.find(x => x.type === 'tx_suta');
  assert.equal(tx.agency, 'TX_TWC');
  assert.equal(tx.dueDate, '2027-02-01', 'Q4: January 31 falls on a Sunday in 2027');
  const g = cal.calendar([{ ...r, id: 'r1', status: 'approved' }], [], { federalDepositSchedule: 'monthly', gaWithholdingFrequency: 'monthly' });
  assert.match(g.find(x => x.type === 'tx_suta').agencyLabel, /Texas Workforce Commission/);
});

test('quarterly forms: Georgia\'s DOL-4N counts Georgia workers only; Texas gets its own report', () => {
  const ga = run(base('g1', { g4: { filingStatus: 'A' } }), {});
  const tx = run(base('t1', { workState: 'TX' }), { states: { TX: { sutaRatePct: 2.7 } } }, TABLES, 60 * 500);
  const runs = [{ ...ga, id: 'a', status: 'paid' }, { ...tx, id: 'b', status: 'paid' }];
  const q = cal.quarterSummary(runs, { year: 2026, quarter: 4, fed: T.FED_2026, sutaWageBaseCents: 950000, stateWageBases: { TX: 900000 } });
  assert.equal(q.formDOL4N.totalWagesCents, ga.workers[0].pay.grossCents);
  assert.equal(q.formDOL4N.employees.length, 1);
  assert.equal(q.form941.line2_wagesCents, ga.workers[0].pay.grossCents + tx.workers[0].pay.grossCents, 'the 941 counts everyone');
  const o = q.otherStates.find(x => x.state === 'TX');
  assert.equal(o.taxableWagesCents, 900000, 'capped at the Texas wage base');
  assert.equal(o.excessWagesCents, tx.workers[0].pay.grossCents - 900000);
});

test('the W-2: a Texas worker has no state wages in boxes 15-17, and Georgia\'s G-1003 leaves them out', () => {
  const ga = run(base('g1', { g4: { filingStatus: 'A' } }), {});
  const tx = run(base('t1', { workState: 'TX' }), { states: { TX: { sutaRatePct: 2.7 } } });
  const y = cal.yearEnd([{ ...ga, status: 'paid' }, { ...tx, status: 'paid' }], [], { year: 2026, fed: T.FED_2026 });
  const t = y.w2.find(w => w.userId === 't1'), g = y.w2.find(w => w.userId === 'g1');
  assert.deepEqual([t.stateCode, t.box16, t.box17], ['TX', 0, 0]);
  assert.equal(g.box16, g.box1);
  const g1003 = ye.g1003Totals(y.w2.map(w => ({ boxes: w })));
  assert.equal(g1003.w2Count, 1);
  assert.equal(g1003.gaWagesCents, g.box16);
});

test('QuickBooks: Texas posts to the other-state accounts and the journal still balances', () => {
  const r = run(base('t1', { workState: 'TX' }), { states: { TX: { sutaRatePct: 2.7 } } });
  const ids = Object.fromEntries(Object.keys(qb.ACCOUNTS).map(k => [k, k]));
  const j = qb.journalForRun({ ...r, id: 'r1' }, ids);
  const tx = j.Line.find(l => l.Description === 'TX unemployment');
  assert.equal(tx.JournalEntryLineDetail.AccountRef.value, 'stateSuta');
  assert.ok(!j.Line.some(l => l.Description === 'Georgia unemployment'));
  assert.deepEqual(qb.taxSplit({ key: 'tx_suta:2027-02-01', amountCents: 540 }, []), [{ account: 'stateSuta', amountCents: 540 }]);
});

test('the shipped tables: federal, then Georgia, then Texas, all staged; the watch list puts Georgia first', () => {
  assert.deepEqual(T.SEEDS.map(s => s.jurisdiction), ['federal', 'GA', 'TX']);
  assert.deepEqual(T.TX_2026, { incomeTax: false, method: 'none', sutaWageBaseCents: 900000, newEmployerSutaRatePct: 2.7 });
  const order = [...new Set(T.sourcesFor(['TX', 'GA', 'AL']).sources.map(s => s.jurisdiction).concat(T.sourcesFor(['TX', 'GA', 'AL']).unwatched))];
  assert.deepEqual(order.slice(0, 2), ['federal', 'GA']);
});

test('a work state is any state, Georgia by default', () => {
  assert.equal(pp.normalizePaySetup({ workState: 'tx' }).value.workState, 'TX');
  assert.equal(pp.normalizePaySetup({ workState: 'ZZ' }).code, 'WORK_STATE');
  assert.equal(pp.defaultProfile({ id: 'x' }).workState, 'GA');
});
