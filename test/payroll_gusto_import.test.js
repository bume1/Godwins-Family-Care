'use strict';
// Importing past pay from Gusto's Payroll Journal (2026-11-09). The fixture
// below is SYNTHETIC: made-up names and amounts in Gusto's exact layout. A
// real export carries real names, addresses and wages and never belongs in
// this public repo.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const g = require('../payrollGustoImport');
const engine = require('../payrollEngine');
const cal = require('../payrollCalendar');
const T = require('../payrollTaxTables');
const pp = require('../payrollProfiles');

const HEAD = '"Last Name","First Name","Department","Work Address","Regular (Hours)","Regular (Amount)","Regular (Rate)","Gross Earnings","Employee Taxes","Federal Income Tax (Employee)","Social Security (Employee)","Medicare (Employee)","Additional Medicare (Employee)","GA State Tax (Employee)","Employer Taxes","Social Security (Employer)","Medicare (Employer)","FUTA (Employer)","TX SUTA (Employer)","GA Administrative Assessment Tax (Employer)","GA State Unemployment Tax (Employer)","One Time Reimbursement","Net Pay","Reimbursements","Donations","Check Amount","Employer Cost","Employee Type","Payment"';
const row = (last, first, addr, hours, gross, fed, ss, med, ga, ers, erm, futa, tx, gaAdm, gaSuta, net, pay) =>
  `"${last}","${first}","Care","${addr}","${hours}","${gross}","20.00","${gross}","0","${fed}","${ss}","${med}","0.00","${ga}","0","${ers}","${erm}","${futa}","${tx}","${gaAdm}","${gaSuta}","0.0","${net}","0.00","0.00","${net}","0","Paid by the hour","${pay}"`;
const GA = '1 Office Rd, Ste 1, Atlanta, GA 30339';
const TX = '9 Elm St, Dallas, TX 75001';
const section = (label, period, payDay, rows) => [`"${label}"`, `"Pay period"," ${period}"`, `"Pay day"," ${payDay}"`, HEAD, ...rows, '"Payroll Totals","",""', '', '""'].join('\n');
const FILE = ['"Payroll Journal Report"', '', '"Godwins Family Care"', '', '"Payroll Journal Summary by Employee"', HEAD,
  // The year's summary per person: a total, not a pay date.
  row('Rivers', 'Ana', GA, '28.58', '931.60', '0', '0', '0', '0', '0', '0', '0', '', '', '', '851.00', ''),
  row('Totals', '', '', '0', '9999.00', '0', '0', '0', '0', '0', '0', '0', '', '', '', '9999.00', ''), '',
  '"Employee Earnings"',
  section('Non-Gusto', '09/07/2026 - 09/12/2026', '09/18/2026', [row('Rivers', 'Ana', GA, '0.00', '360.00', '0.00', '22.32', '5.22', '0.00', '22.32', '5.22', '2.16', '', '0.22', '9.50', '332.46', 'Historical')]),
  // A Gusto correction: a reversal and the same line again, netting to nothing.
  section('Non-Gusto', '09/14/2026 - 09/20/2026', '09/25/2026', [row('Rivers', 'Ana', GA, '0.00', '-327.59', '0.00', '-20.31', '-4.75', '0.00', '-20.31', '-4.75', '-1.97', '', '-0.20', '-8.65', '-302.53', 'Historical')]),
  section('Non-Gusto', '09/14/2026 - 09/20/2026', '09/25/2026', [row('Rivers', 'Ana', GA, '0.00', '327.59', '0.00', '20.31', '4.75', '0.00', '20.31', '4.75', '1.97', '', '0.20', '8.65', '302.53', 'Historical')]),
  section('Regular (Weekly (Caregiver))', '09/28/2026 - 10/04/2026', '10/09/2026', [row('Rivers', 'Ana', GA, '28.58', '571.60', '0.00', '35.44', '8.29', '9.33', '35.44', '8.29', '3.43', '', '0.34', '15.09', '518.54', 'Direct Deposit')]),
  section('Regular (BI-Weekly (Standard))', '09/28/2026 - 10/11/2026', '10/23/2026', [
    row('Lake', 'Bo', TX, '6.00', '108.00', '0.00', '6.70', '1.57', '', '6.70', '1.57', '0.65', '2.92', '', '', '99.73', 'Check'),
    row('Nobody', 'Cy', GA, '1.00', '20.00', '0.00', '1.24', '0.29', '0.00', '1.24', '0.29', '0.12', '', '0.01', '0.53', '18.47', 'Check')
  ])
].join('\n');
const USERS = [{ id: 'own', role: 'admin', name: 'Owner', email: 'o@x' }, { id: 'a1', role: 'vendor', licenseLevel: 'pca', name: 'Ana Rivers', email: 'a@x' }, { id: 'b1', role: 'user', name: 'Bo Lake', email: 'b@x' }];

test('the journal parses by pay date, a correction nets to nothing, and totals match the file to the cent', () => {
  const p = g.parseJournal(FILE);
  assert.ifError(p.error);
  assert.equal(p.lines.length, 6, 'the summary at the top is not a pay date');
  const e = g.netEntries(p.lines);
  assert.deepEqual(e.map(x => `${x.firstName}:${x.payDate}:${x.gross}`).sort(), ['Ana:2026-09-18:36000', 'Ana:2026-10-09:57160', 'Bo:2026-10-23:10800', 'Cy:2026-10-23:2000']);
  const b = g.buildImport({ entries: e, users: USERS, profiles: {}, at: 'x', by: 'o' });
  assert.deepEqual(b.unmatched, [{ name: 'Cy Nobody', reason: 'No account with this name.' }]);
  const ana = b.matched.find(m => m.userId === 'a1');
  assert.equal(ana.grossCents, 93160);
  const w = b.runs.find(r => r.period.payDate === '2026-10-09').workers[0];
  assert.equal(w.pay.netCents, w.pay.grossCents - w.pay.taxCents);
  assert.equal(w.pay.employer.gaSuta, 1509 + 34, 'Georgia unemployment plus the administrative assessment');
  assert.equal(b.runs.find(r => r.period.payDate === '2026-10-09').frequency, 'weekly');
  assert.equal(b.matched.find(m => m.userId === 'b1').workStates[0], 'TX');
});

test('not a Gusto journal is refused by name', () => {
  assert.equal(g.parseJournal('a,b\n1,2').code, 'GUSTO_NOT_JOURNAL');
});

test('a person who works outside Georgia is blocked from app runs, never taxed as Georgian', () => {
  const user = { id: 'b1', name: 'Bo Lake' };
  const profile = { ...pp.defaultProfile(user), workState: 'TX', payMethod: { method: 'check' }, ssn: { last4: '1' }, w4: { filingStatus: 'single' }, g4: { filingStatus: 'A' }, i9: { section1: {}, section2: {} }, hourlyRateCents: 1800 };
  const gathered = { byUser: new Map([['b1', [{ ref: 'log:1', kind: 'hours', date: '2026-11-02', minutes: 60, rateCents: 1800 }]]]), skipped: [] };
  const run = engine.buildRun({ period: { start: '2026-11-02', end: '2026-11-15', payDate: '2026-11-20' }, settings: { frequency: 'biweekly', gaSutaRatePct: 2.7 }, people: [{ user, profile }], gathered, ytdByUser: new Map(), tables: { federal: T.FED_2026, GA: T.GA_2026 } });
  assert.match(run.blocked[0].missing.join(' '), /Works in Texas: approve a Texas tax table/);
});

test('Gusto made the deposits for its pay dates, so they never appear as taxes the app owes', () => {
  const b = g.buildImport({ entries: g.netEntries(g.parseJournal(FILE).lines), users: USERS, profiles: {}, at: 'x', by: 'o' });
  assert.equal(cal.calendar(b.runs, [], { frequency: 'biweekly', federalDepositSchedule: 'monthly', gaWithholdingFrequency: 'monthly' }).length, 0);
  // ...but they DO count toward year-to-date (the wage-base caps) and the year's figures.
  assert.equal(engine.ytdFrom(b.runs, { year: 2026 }).get('a1').grossCents, 93160);
});

// ---- the route ---------------------------------------------------------------------
function harness(store = new Map()) {
  const db = { get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
  const acts = [], mail = [];
  const routes = require('../routes/payroll')({
    db, env: { PAYROLL_ENCRYPTION_KEY: 'c'.repeat(64) }, logActivity: async (...a) => acts.push(a), getUsers: async () => USERS,
    authenticateToken: (req, res, next) => { req.user = USERS[0]; next(); }, requireAdmin: (req, res, next) => next(),
    uuidv4: (() => { let n = 0; return () => `id${++n}`; })(), accountTypeOf: (u) => (u.role === 'admin' ? 'admin' : u.role === 'vendor' ? 'caregiver' : 'provider'), localDate: (iso) => String(iso).slice(0, 10),
    resolvePayRate: () => ({ rate: null }), queueNotification: async (...a) => mail.push(a), hashIp: () => 'h',
    pdf: require('../pdf-generator'), drive: { uploadStaffDocumentFile: async () => ({ fileId: 'drv' }) }, roleFolderFor: () => 'F', personFolderName: (n) => n, getAppBaseUrl: async () => 'https://app'
  });
  const app = express(); app.use(express.json({ limit: '5mb' })); app.use(routes);
  return { app, store, acts, mail };
}
const post = async (app, body) => {
  const srv = app.listen(0);
  try { const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/payroll/admin/import/gusto`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; }
  finally { srv.close(); }
};

test('preview writes nothing; import writes paid runs and stubs without emailing anyone, locks the app\'s hours in those periods, and re-importing replaces', async () => {
  const { app, store, mail, acts } = harness();
  store.set('time_logs', [{ id: 'L1', caregiver_id: 'a1', clock_in_at: '2026-09-30T13:00:00Z', clock_out_at: '2026-09-30T17:00:00Z', total_minutes: 240 }, { id: 'L2', caregiver_id: 'a1', clock_in_at: '2026-11-03T13:00:00Z', clock_out_at: '2026-11-03T17:00:00Z', total_minutes: 240 }]);
  let r = await post(app, { csv: FILE });
  assert.equal(r.body.preview, true);
  assert.equal(r.body.stubs, 3);
  assert.deepEqual(r.body.nonGeorgia.map(n => n.userId), ['b1']);
  assert.equal(store.has('payroll_runs'), false, 'a preview writes nothing');
  r = await post(app, { csv: FILE, commit: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.stubsWritten, 3);
  assert.equal(mail.length, 0, 'no emails for past pay dates');
  const runs = store.get('payroll_runs');
  assert.ok(runs.every(x => x.status === 'paid' && x.source === 'gusto'));
  assert.equal(store.get('staff_paystubs').filter(s => s.source === 'gusto').length, 3);
  const logs = store.get('time_logs');
  assert.ok(logs.find(l => l.id === 'L1').payroll_run_id, 'hours inside an imported period are locked');
  assert.equal(logs.find(l => l.id === 'L2').payroll_run_id, undefined, 'hours outside it are not');
  assert.ok(engine.paidRefsFrom(runs).has('log:L1'), 'a later app run will not pay them again');
  assert.equal(store.get('payroll_profiles').b1.workState, 'TX');
  assert.doesNotMatch(JSON.stringify(acts.find(a => a[2] === 'payroll_gusto_imported')), /Rivers|571|36000/, 'the log carries counts only');
  r = await post(app, { csv: FILE, commit: true });
  assert.equal(store.get('payroll_runs').length, runs.length, 're-importing replaces, never doubles');
  assert.equal(store.get('staff_paystubs').length, 3);
});

test('a pay date the app already paid is not imported a second time', async () => {
  const { app, store } = harness();
  store.set('payroll_runs', [{ id: 'app1', status: 'paid', period: { start: '2026-09-28', end: '2026-10-04', payDate: '2026-10-09' }, workers: [{ userId: 'a1', pay: { grossCents: 1 } }] }]);
  const r = await post(app, { csv: FILE });
  assert.equal(r.body.stubs, 2);
  assert.ok(r.body.warnings.some(w => /already paid by a payroll run in the app/.test(w)));
});

test('a section with no one paid, and the next section\'s label, are never read as employees', () => {
  const empty = ['"Regular (BI-Weekly (Standard))"', '"Pay period"," 09/14/2026 - 09/27/2026"', '"Pay day"," 10/05/2026"', HEAD, '', '""'].join('\n');
  const file = FILE.replace('"Employee Earnings"', `"Employee Earnings"\n${empty}`);
  const p = g.parseJournal(file);
  assert.deepEqual(p.warnings, []);
  assert.ok(p.lines.every(l => l.firstName && l.lastName));
  assert.equal(p.lines.length, 6);
});

test('the per-employee summary above the pay dates is a total and is never imported or warned about', () => {
  const p = g.parseJournal(FILE);
  assert.deepEqual(p.warnings, []);
});

test('two accounts with the same name are not guessed between', () => {
  const twins = [...USERS, { id: 'a2', role: 'vendor', licenseLevel: 'pca', name: 'Ana Rivers', email: 'a2@x' }];
  const b = g.buildImport({ entries: g.netEntries(g.parseJournal(FILE).lines), users: twins, profiles: {}, at: 'x', by: 'o' });
  assert.ok(b.unmatched.some(u => u.name === 'Ana Rivers' && /More than one/.test(u.reason)));
  assert.ok(!b.matched.some(m => m.userId === 'a1' || m.userId === 'a2'));
});

test('Additional Medicare is part of box 6 (Medicare withheld), and a section can end straight into the next label', () => {
  const r = `"Rivers","Ana","Care","${GA}","40.00","3000.00","75.00","3000.00","0","100.00","186.00","43.50","9.00","120.00","0","186.00","43.50","0.00","","0.00","0.00","0.0","2541.50","0.00","0.00","2541.50","0","Paid by the hour","Check"`;
  const file = ['"Payroll Journal Report"', '"Employee Earnings"', '"Regular (Weekly (Caregiver))"', '"Pay period"," 11/02/2026 - 11/08/2026"', '"Pay day"," 11/13/2026"', HEAD, r,
    '"Payroll Totals","",""', '"Regular (Weekly (Caregiver))"', '"Pay period"," 11/09/2026 - 11/15/2026"', '"Pay day"," 11/20/2026"', HEAD, '', '""'].join('\n');
  const p = g.parseJournal(file);
  assert.deepEqual(p.warnings, []);
  assert.equal(p.lines.length, 1);
  const b = g.buildImport({ entries: g.netEntries(p.lines), users: USERS, profiles: {}, at: 'x', by: 'o' });
  const w = b.runs[0].workers[0];
  assert.equal(w.pay.taxes.medicare, 4350 + 900);
  assert.equal(w.pay.netCents, w.pay.grossCents - w.pay.taxCents);
});

// Every earning Gusto lists is its own stub line with its hours and rate
// (owner, 2026-11-13: "every single paystub as is in Gusto"). Wages Gusto
// recorded as history, without hours, say so.
test('Gusto earnings: Regular and Overtime keep their hours and rates; historical wages are named', () => {
  const g = require('../payrollGustoImport');
  const head = 'Last Name,First Name,Department,Work Address,Regular (Hours),Regular (Amount),Regular (Rate),Overtime (Hours),Overtime (Amount),Overtime (Rate),Gross Earnings,Federal Income Tax (Employee),Social Security (Employee),Medicare (Employee),GA State Tax (Employee),Net Pay,Employee Type,Payment';
  const csv = ['"Payroll journal"', '', 'Employee Earnings', 'Regular (Weekly (Caregiver))', 'Pay period, 10/05/2026 - 10/11/2026', 'Pay day, 10/16/2026', head,
    'Rivers,Ann,PHC,"1 Main St, Atlanta, GA 30339",40.00,800.00,20.00,2.00,60.00,30.00,860.00,10.00,53.32,12.47,20.00,764.21,Paid by the hour,Direct Deposit', 'Payroll Totals,,,,,,,,,,,,,,,,,', '',
    'Non-Gusto', 'Pay period, 09/14/2026 - 09/20/2026', 'Pay day, 09/25/2026', head,
    'Rivers,Ann,PHC,"1 Main St, Atlanta, GA 30339",0.00,300.00,0,,,,300.00,0,18.60,4.35,0,277.05,Paid by the hour,Historical'].join('\n');
  const p = g.parseJournal(csv); assert.ok(!p.error, JSON.stringify(p));
  const b = g.buildImport({ entries: g.netEntries(p.lines), users: [{ id: 'u1', name: 'Ann Rivers' }], profiles: {}, refsFor: () => [], at: 'x', by: 'y' });
  assert.deepEqual(b.warnings, []);
  const oct = b.runs.find(r => r.period.payDate === '2026-10-16').workers[0].earnings;
  assert.deepEqual(oct.map(e => [e.code, e.label, e.minutes, e.rateCents, e.amountCents]), [['regular', 'Hours worked', 2400, 2000, 80000], ['overtime', 'Overtime', 120, 3000, 6000]]);
  const sep = b.runs.find(r => r.period.payDate === '2026-09-25').workers[0].earnings;
  assert.deepEqual(sep.map(e => [e.label, e.minutes, e.amountCents]), [['Wages (recorded in Gusto without hours)', 0, 30000]]);
  // Lines that do not add up to gross: one line carries the gross, and it is named.
  const w = []; const one = g.earningsFor({ gross: 1000, hours: 1, payment: 'Check', payDate: 'd', earnings: [{ label: 'Regular', amountCents: 900, hours: 1, rateCents: 900 }] }, 'Ann', w);
  assert.equal(one.length, 1); assert.equal(one[0].amountCents, 1000); assert.equal(w.length, 1);
});
