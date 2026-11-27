'use strict';
// The send-by date skips bank holidays (owner, 2026-11-27: the Payment Sheet
// said "Send by Nov 26", Thanksgiving), with a switch in Payroll Settings.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const tax = require('../payrollTax');
const pp = require('../payrollProfiles');
const T = require('../payrollTaxTables');

test('the Federal Reserve holidays, with Sunday moved to Monday and Saturday not observed', () => {
  assert.deepStrictEqual(tax.bankHolidays(2026).map(h => h.date), ['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25'],
    'July 4, 2026 is a Saturday, so it is not observed');
  assert.strictEqual(tax.bankHolidayOn('2022-12-26'), 'Christmas Day', 'Christmas on a Sunday is observed Monday');
  assert.strictEqual(tax.bankHolidayOn('2027-12-24'), null, 'Christmas on a Saturday: the Friday before is a business day');
  assert.strictEqual(tax.bankHolidayOn('2026-11-27'), null);
  assert.strictEqual(tax.bankHolidayOn('2027-11-25'), 'Thanksgiving Day');
});

test('send by skips weekends always and bank holidays when switched on', () => {
  assert.strictEqual(tax.sendByDate('2026-11-27', { skipBankHolidays: true }), '2026-11-25', 'Thanksgiving skipped');
  assert.strictEqual(tax.sendByDate('2026-11-27', { skipBankHolidays: false }), '2026-11-26');
  assert.strictEqual(tax.sendByDate('2026-11-27'), '2026-11-26', 'a caller with no settings keeps weekends only');
  assert.strictEqual(tax.sendByDate('2026-01-20', { skipBankHolidays: true }), '2026-01-16', 'MLK Monday and the weekend before it');
  assert.strictEqual(tax.sendByDate('2026-11-30', { skipBankHolidays: true }), '2026-11-27', 'a Monday payday sends the Friday before');
  assert.deepStrictEqual(tax.sendByDate('2026-11-27', { skipBankHolidays: true, detail: true }), { date: '2026-11-25', skipped: [{ date: '2026-11-26', name: 'Thanksgiving Day' }] });
});

test('the setting is on by default and takes only on or off', () => {
  assert.strictEqual(tax.DEFAULT_SETTINGS.skipBankHolidays, true);
  assert.strictEqual(tax.normalizeSettings({ skipBankHolidays: false }, {}).value.skipBankHolidays, false);
  assert.strictEqual(tax.normalizeSettings({ skipBankHolidays: 'yes' }, {}).code, 'SKIP_BANK_HOLIDAYS');
});

test('the Payment Sheet shows the send-by date that skips Thanksgiving, and the switch turns it off', async () => {
  const users = [{ id: 'own', role: 'admin', name: 'Owner', email: 'o@x' }, { id: 'cg1', role: 'vendor', licenseLevel: 'pca', accountType: 'caregiver', name: 'Pat Care', email: 'p@x', payRate: 18 }];
  const store = new Map();
  const db = { get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
  store.set('time_logs', [{ id: 'a', caregiver_id: 'cg1', client_id: 'c1', clock_in_at: '2026-11-17T14:00:00Z', clock_out_at: '2026-11-17T22:00:00Z', total_minutes: 480 }]);
  store.set('payroll_settings', { gaSutaRatePct: 2.7, employerEin: '12-3456789', schedules: { caregivers: { frequency: 'weekly', anchor: '2026-11-02', payDateOffsetDays: 5 } } });
  store.set('payroll_tax_tables', T.seedRows([], { uuid: () => Math.random().toString(36), at: 'x' }).map(t => ({ ...t, status: 'active', approvedAt: 'x' })));
  store.set('payroll_profiles', { cg1: { ...pp.defaultProfile(users[1]), payMethod: { method: 'direct_deposit', accountLast4: '4321' }, ssn: { last4: '1111' }, w4: { filingStatus: 'single' }, g4: { filingStatus: 'A' }, i9: { section1: {}, section2: {} } } });
  const app = express(); app.use(express.json());
  app.use(require('../routes/payroll')({
    db, env: { PAYROLL_ENCRYPTION_KEY: 'a'.repeat(64) }, payrollKey: 'k'.repeat(40), logActivity: async () => {}, getUsers: async () => users,
    authenticateToken: (req, res, next) => { req.user = users[0]; next(); }, requireAdmin: (q, s, n) => n(), uuidv4: (() => { let n = 0; return () => `id${++n}`; })(),
    accountTypeOf: (u) => (u.role === 'admin' ? 'admin' : 'caregiver'), localDate: (v) => String(v).slice(0, 10), resolvePayRate: (u) => ({ rate: u && u.payRate, source: 'base' }),
    queueNotification: async () => {}, hashIp: () => 'h', pdf: require('../pdf-generator'), drive: {}, roleFolderFor: () => 'F', personFolderName: (n) => n, getAppBaseUrl: async () => 'https://app.example'
  }));
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const call = async (method, url, body) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    let r = await call('POST', '/api/payroll/admin/runs', { periodStart: '2026-11-16', schedule: 'caregivers' });
    const id = r.body.run.id; assert.strictEqual(r.body.run.period.payDate, '2026-11-27');
    r = await call('POST', `/api/payroll/admin/runs/${id}/approve`, { timesheetReason: 'test' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await call('GET', `/api/payroll/admin/runs/${id}/payment-sheet`);
    assert.strictEqual(r.body.sendBy, '2026-11-25');
    assert.deepStrictEqual(r.body.sendBySkipped, [{ date: '2026-11-26', name: 'Thanksgiving Day' }]);
    r = await call('PUT', '/api/payroll/admin/settings', { skipBankHolidays: false });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await call('GET', `/api/payroll/admin/runs/${id}/payment-sheet`);
    assert.strictEqual(r.body.sendBy, '2026-11-26', 'switched off: weekends only');
    assert.deepStrictEqual(r.body.sendBySkipped, []);
  } finally { srv.close(); }
});

test('the page offers the switch and names the skipped holiday', () => {
  const page = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'payroll.html'), 'utf8');
  assert.match(page, /data-skip-bank-holidays/);
  assert.match(page, /skipBankHolidays: s\.skipBankHolidays !== false/);
  assert.match(page, /sheet\.sendBySkipped/);
});
