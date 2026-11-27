'use strict';
// Invoice runs (owner, 2026-11-15): approved hours -> a draft the office can
// change -> invoices -> one PDF per client, emailed. TEST DATA only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const R = require('../invoiceRuns');
const P = require('../phcInvoices');
const ts = require('../payrollTimesheets');

// Line comments come off first, so a comment naming a rule cannot satisfy it.
const strip = (src) => src.replace(/^\s*\/\/.*$/gm, '');
const SERVER = strip(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'));
const PAYROLL = strip(fs.readFileSync(path.join(__dirname, '..', 'routes', 'payroll.js'), 'utf8'));
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'billing.html'), 'utf8');
const between = (src, a, b) => { const i = src.indexOf(a); assert.ok(i >= 0, `anchor ${a}`); const j = src.indexOf(b, i + a.length); assert.ok(j > i, `anchor ${b}`); return src.slice(i, j); };

// ── which hours are approved ───────────────────────────────────────────────────
const sheet = (userId, hours, extra) => ({ userId, periodStart: '2026-11-02', periodEnd: '2026-11-08', office: { status: 'approved', ...(hours ? { hours } : {}) }, ...extra });
const row = (id, minutes, extra) => ({ timeLogId: id, caregiverId: 'cg1', minutes, serviceDate: '2026-11-03', ...extra });

test('a shift is billable once its timesheet approved THESE minutes', () => {
  const idx = R.approvalIndex([sheet('cg1', [{ ref: 'log:a', minutes: 292 }])], []);
  assert.equal(R.approvalOf(row('a', 292), idx), 'approved');
  assert.equal(R.approvalOf(row('a', 300), idx), 'changed', 'a time log corrected after approval is not approved any more');
  assert.equal(R.approvalOf(row('b', 60), idx), 'waiting', 'a shift the approval did not cover is waiting');
  assert.ok(R.isBillable('approved') && !R.isBillable('changed') && !R.isBillable('waiting'));
});

test('a timesheet sent back, or not decided, approves nothing', () => {
  const idx = R.approvalIndex([{ userId: 'cg1', periodStart: '2026-11-02', office: { status: 'sent_back', hours: [{ ref: 'log:a', minutes: 292 }] } }, { userId: 'cg1', periodStart: '2026-11-09' }], []);
  assert.equal(R.approvalOf(row('a', 292), idx), 'waiting');
});

test('payroll having paid a shift counts as approved; a draft or void payroll does not', () => {
  const runs = [{ status: 'approved', workers: [{ refs: ['log:a'] }] }, { status: 'draft', workers: [{ refs: ['log:b'] }] }, { status: 'void', workers: [{ refs: ['log:c'] }] }];
  const idx = R.approvalIndex([], runs);
  assert.equal(R.approvalOf(row('a', 10), idx), 'paid');
  assert.equal(R.approvalOf(row('b', 10), idx), 'waiting');
  assert.equal(R.approvalOf(row('c', 10), idx), 'waiting');
});

test('an approval made before this change covers its caregiver\'s whole period', () => {
  const idx = R.approvalIndex([sheet('cg1', null)], []);
  assert.equal(R.approvalOf(row('z', 100), idx), 'approved');
  assert.equal(R.approvalOf(row('z', 100, { serviceDate: '2026-11-09' }), idx), 'waiting', 'outside the period');
  assert.equal(R.approvalOf(row('z', 100, { caregiverId: 'cg2' }), idx), 'waiting', 'another caregiver');
});

test('hours read from an uploaded file are the office\'s own and count as approved', () => {
  assert.equal(R.approvalOf({ timeLogId: null, minutes: 60 }, R.approvalIndex([], [])), 'file');
  assert.ok(R.isBillable('file'));
});

test('approving a timesheet stores the hour items it covers, with their minutes', () => {
  const items = [{ ref: 'log:a', kind: 'hours', minutes: 292 }, { ref: 'visit:v', kind: 'visit', count: 1 }, { ref: 'log:b', kind: 'hours', minutes: 60 }];
  assert.deepEqual(ts.approvedHours(items), [{ ref: 'log:a', minutes: 292 }, { ref: 'log:b', minutes: 60 }]);
  const decide = between(PAYROLL, "'/api/payroll/admin/timesheets/decide'", 'res.json(');
  assert.match(decide, /status === 'approved' \? \{ \.\.\.n\.value, hours: ts\.approvedHours\(items\) \}/, 'the decide route stores them on approval');
});

// ── office changes ─────────────────────────────────────────────────────────────
test('an hours change or a shift left off needs a reason; hours read three ways', () => {
  const keys = new Set(['log:a']);
  assert.equal(R.normalizeEdit({ sourceKey: 'log:a', hours: '5' }, keys).code, 'RUN_REASON_REQUIRED');
  assert.equal(R.normalizeEdit({ sourceKey: 'log:x', hours: '5', reason: 'r' }, keys).code, 'RUN_SHIFT_UNKNOWN');
  assert.equal(R.normalizeEdit({ sourceKey: 'log:a', remove: true }, keys).code, 'RUN_REASON_REQUIRED');
  assert.equal(R.normalizeEdit({ sourceKey: 'log:a', hours: '25', reason: 'r' }, keys).code, 'RUN_HOURS_INVALID');
  assert.equal(R.normalizeEdit({ sourceKey: 'log:a', hours: '4.5', reason: 'r' }, keys).value.minutes, 270);
  assert.equal(R.normalizeEdit({ sourceKey: 'log:a', hours: '4:30', reason: 'r' }, keys).value.minutes, 270);
  assert.equal(R.normalizeEdit({ sourceKey: 'log:a', hours: '4h 30m', reason: 'r' }, keys).value.minutes, 270);
  assert.deepEqual(R.normalizeEdit({ sourceKey: 'log:a', clear: true }, keys).value, { sourceKey: 'log:a', clear: true });
});

test('edits apply: billed minutes change, the clocked minutes are kept, a left-off shift is gone', () => {
  const rows = [{ sourceKey: 'a', minutes: 292 }, { sourceKey: 'b', minutes: 60 }, { sourceKey: 'c', minutes: 30 }];
  const out = R.applyEdits(rows, [{ sourceKey: 'a', minutes: 300 }, { sourceKey: 'b', remove: true }]);
  assert.deepEqual(out, [{ sourceKey: 'a', minutes: 300, editedFrom: 292 }, { sourceKey: 'c', minutes: 30 }]);
  // One entry per shift: the latest wins, and Undo clears it.
  let e = R.withEdit([], { sourceKey: 'a', minutes: 300, reason: 'r' }, { by: 'x' });
  e = R.withEdit(e, { sourceKey: 'a', minutes: 310, reason: 'r2' }, { by: 'x' });
  assert.equal(e.length, 1); assert.equal(e[0].minutes, 310);
  assert.deepEqual(R.withEdit(e, { sourceKey: 'a', clear: true }), []);
});

test('an added line: hours at the client\'s rate or a fixed amount, dated inside the run, with a reason', () => {
  const ctx = { clientIds: new Set(['c1']), from: '2026-11-02', to: '2026-11-15' };
  const base = { clientId: 'c1', date: '2026-11-04', description: 'Personal care services', reason: 'Missed clock-in' };
  assert.equal(R.normalizeAdjustment({ ...base, kind: 'hours', hours: '2:30' }, ctx).value.minutes, 150);
  assert.equal(R.normalizeAdjustment({ ...base, kind: 'amount', amount: '-$20' }, ctx).value.amountCents, -2000, 'a credit');
  assert.equal(R.normalizeAdjustment({ ...base, kind: 'amount', amount: '0' }, ctx).code, 'RUN_AMOUNT_INVALID');
  assert.equal(R.normalizeAdjustment({ ...base, date: '2026-11-20', kind: 'hours', hours: '1' }, ctx).code, 'RUN_DATE_OUTSIDE');
  assert.equal(R.normalizeAdjustment({ ...base, clientId: 'c9', kind: 'hours', hours: '1' }, ctx).code, 'RUN_CLIENT_REQUIRED');
  assert.equal(R.normalizeAdjustment({ ...base, reason: '', kind: 'hours', hours: '1' }, ctx).code, 'RUN_REASON_REQUIRED');
  assert.equal(R.normalizeAdjustment({ ...base, description: '', kind: 'hours', hours: '1' }, ctx).code, 'RUN_DESCRIPTION_REQUIRED');
  assert.equal(R.normalizeAdjustment({ ...base }, ctx).code, 'RUN_LINE_KIND');
});

// ── per day or per period ──────────────────────────────────────────────────────
const fmtDate = (v) => String(v).slice(0, 10);
const fmtTime = (v) => String(v).slice(11, 16);
const carrier = (mode) => ({ id: 'p1', name: 'RiverSource Life', claimsEmail: 'claims@example.test', addressLines: ['PO Box 1'], invoiceMode: mode });
const client = { id: 'c1', name: 'Test Client', rateAgreement: { hourlyRate: 30, dailyMinimumHours: 4 }, billing: { billTo: { type: 'carrier', payerId: 'p1', insuredName: 'Test Client', policyNumber: 'P-1' } } };
const shiftRow = (day, minutes, k) => ({ sourceKey: `log:${k}`, shiftKey: `s${k}`, timeLogId: k, caregiverId: 'cg1', caregiverName: 'Pat Caregiver', licenseLevel: 'pca', clientId: 'c1', clientName: 'Test Client', clockInAt: `${day}T14:00:00Z`, clockOutAt: `${day}T18:52:00Z`, minutes, serviceDate: day });
const draft = (mode, rows, extras) => P.draftInvoices(rows, { clients: [client], payers: [carrier(mode)], invoiced: new Set(), taken: new Set(), period: { from: '2026-11-02', to: '2026-11-15' }, extras, levelLabel: () => 'PCA', fmtDate, fmtTime });

test('a carrier with a daily maximum gets one invoice per date of service', () => {
  const d = draft('daily', [shiftRow('2026-11-03', 292, 'a'), shiftRow('2026-11-04', 292, 'b')]);
  assert.equal(d.invoices.length, 2);
  assert.deepEqual(d.invoices.map(i => i.serviceDate), ['2026-11-03', '2026-11-04']);
  assert.ok(d.invoices.every(i => i.billTo.invoiceMode === 'daily'));
});

test('a carrier set to "one invoice for the period" gets one, numbered for the period\'s last day', () => {
  const d = draft('period', [shiftRow('2026-11-03', 292, 'a'), shiftRow('2026-11-04', 292, 'b')]);
  assert.equal(d.invoices.length, 1);
  assert.equal(d.invoices[0].serviceDate, null);
  assert.deepEqual(d.invoices[0].period, { from: '2026-11-02', to: '2026-11-15' });
  assert.equal(d.invoices[0].displayNumber, 'GFC-TC-261115');
  assert.equal(d.invoices[0].format, 'carrier', 'still the carrier layout');
});

test('a carrier with no setting is billed per day, as before', () => {
  assert.equal(P.billToSnapshot(client.billing.billTo, [{ ...carrier(undefined) }]).invoiceMode, 'daily');
  assert.equal(P.normalizePayer({ name: 'X' }).value.invoiceMode, 'daily');
  assert.equal(P.normalizePayer({ name: 'X', invoiceMode: 'period' }).value.invoiceMode, 'period');
});

test('added lines land on the right invoice; on a day with no shift a daily carrier gets an invoice for it', () => {
  const d = draft('daily', [shiftRow('2026-11-03', 292, 'a')], [
    { id: 'x1', clientId: 'c1', date: '2026-11-03', description: 'Credit', amountCents: -2000 },
    { id: 'x2', clientId: 'c1', date: '2026-11-05', description: 'Personal care services', minutes: 240 }
  ]);
  assert.equal(d.invoices.length, 2);
  const day3 = d.invoices.find(i => i.serviceDate === '2026-11-03');
  assert.deepEqual(day3.lines.map(l => l.kind), ['shift', 'adjustment']);
  assert.equal(day3.totalCents, 14600 - 2000);
  const day5 = d.invoices.find(i => i.serviceDate === '2026-11-05');
  assert.equal(day5.lines[0].amountCents, 12000, '4 hours at $30');
  assert.equal(day5.lines[0].hours, 4);
});

test('a fixed-amount line has no hours or rate, and prints that way', async () => {
  const d = draft('period', [shiftRow('2026-11-03', 292, 'a')], [{ id: 'x1', clientId: 'c1', date: '2026-11-03', description: 'Mileage', amountCents: 1500 }]);
  const line = d.invoices[0].lines.find(l => l.kind === 'adjustment');
  assert.equal(line.hours, null); assert.equal(line.rateCents, null);
  const pdf = require('../pdf-generator');
  const buf = await pdf.generatePhcInvoicePDF({ ...d.invoices[0], invoiceDate: '11/15/2026', periodLabel: '11/2/2026 to 11/15/2026', billedDuration: 'x' });
  assert.equal(buf.slice(0, 5).toString(), '%PDF-');
});

test('an edited shift bills its edited minutes and carries where it came from', () => {
  const d = draft('daily', R.applyEdits([shiftRow('2026-11-03', 292, 'a')], [{ sourceKey: 'log:a', minutes: 300 }]));
  assert.equal(d.invoices[0].lines[0].minutes, 300);
  assert.equal(d.invoices[0].lines[0].editedFrom, 292);
  assert.equal(d.invoices[0].totalCents, 15000);
});

test('credits print as -$20.00', () => {
  assert.equal(require('../patientBilling').fmtUsd(-2000), '-$20.00');
  assert.equal(require('../patientBilling').fmtUsd(123456), '$1,234.56');
});

// ── a spreadsheet ────────────────────────────────────────────────────────────────
test('an Excel sheet read raw (day numbers, day fractions) and hand-kept headers import', () => {
  const people = {
    caregivers: [{ id: 'cg1', name: 'Pat Caregiver', licenseLevel: 'pca' }], clients: [{ id: 'c1', name: 'Test Client' }],
    instantFromZoned: (ymd, hm) => `${ymd}T${String(Number(hm.slice(0, 2)) + 5).padStart(2, '0')}:${hm.slice(3)}:00.000Z`,
    localDate: (iso) => String(iso).slice(0, 10)
  };
  const r = P.rowsFromImport('Caregiver,Client,Date,Start,End,Hours\r\nPat Caregiver,Test Client,46332,0.375,0.5,3\r\nPat Caregiver,Test Client,11/7/26,1:00 PM,17:30,4.5\r\n', people);
  assert.ok(!r.errors, JSON.stringify(r.errors));
  assert.equal(r.rows[0].serviceDate, '2026-11-06');
  assert.equal(r.rows[0].minutes, 180);
  assert.equal(r.rows[1].serviceDate, '2026-11-07');
  assert.equal(r.rows[1].minutes, 270);
  const bad = P.rowsFromImport('Caregiver,Client,Date,Start,End,Hours\r\nPat Caregiver,Test Client,46332,0.375,0.5,4\r\n', people);
  assert.match(bad.errors[0].message, /Hours says 4\.00 but Clock In to Clock Out is 3\.00/, 'the hours still have to agree with the times');
});

// ── sending ──────────────────────────────────────────────────────────────────────
test('the send plan: one entry per client, a carrier with no claims email is blocked by name', () => {
  const m = new Map([
    ['c1', [{ id: 'i1', clientName: 'A', format: 'carrier', status: 'draft', billTo: { name: 'RiverSource', email: 'claims@example.test' } }]],
    ['c2', [{ id: 'i2', clientName: 'B', format: 'carrier', status: 'draft', billTo: { name: 'No Email LTC' } }]],
    ['c3', [{ id: 'i3', clientName: 'C', format: 'family', status: 'open', billTo: { name: 'Fam' } }]],
    ['c4', [{ id: 'i4', clientName: 'D', format: 'family', status: 'void', billTo: { name: 'Fam' } }]]
  ]);
  const plan = R.sendPlan(m);
  assert.equal(plan.length, 3, 'a client with only void invoices has nothing to send');
  assert.equal(plan[0].toEmail, 'claims@example.test');
  assert.match(plan[1].blocked, /No Email LTC has no claims email/);
  assert.equal(plan[2].sent, true);
  assert.equal(R.combinedFileName("Ada O'Neil", '2026-11-02', '2026-11-15'), 'GFC_Invoices-Ada_O_Neil_2026-11-02_to_2026-11-15.pdf');
});

test('SAFETY: the run is draft-only for changes, approving makes drafts, sending refuses to mark a failed email sent', () => {
  for (const route of ['/edits', '/lines', '/include-waiting']) {
    const body = between(SERVER, `'/api/gfc/admin/billing-runs/:id${route}'`, 'app.');
    assert.match(body, /draftOnly\(res, run\)/, `${route} only changes a draft`);
  }
  const approve = between(SERVER, "'/api/gfc/admin/billing-runs/:id/approve'", "'/api/gfc/admin/billing-runs/:id/clients");
  assert.match(approve, /status: 'draft'/, 'approved invoices are drafts until sent');
  assert.match(approve, /runId: run\.id/);
  assert.match(approve, /RUN_INVOICE_EMPTY/, 'never an invoice for $0 or less');
  const send = between(SERVER, "'/api/gfc/admin/billing-runs/:id/send'", "'/api/gfc/admin/billing/invoices/:id/pdf'");
  assert.match(send, /phi: true/, 'the invoice email carries PHI and goes only on the covered transport');
  assert.match(send, /if \(!r \|\| !r\.success\) \{ results\.push\(.*Nothing was marked sent.*continue; \}/, 'a failed email is reported and nothing is marked sent');
  assert.match(send, /config\.ROI_ADMIN_EMAIL/, 'the office is copied');
  assert.ok(send.indexOf("billing.transition(") > send.indexOf('if (!r || !r.success)'), 'invoices move to sent only after the email went');
  assert.match(send, /notifyStatement\(p\.clientId, \{ skipEmails: emailedTo \}\)/, 'a family\'s client and POA are told, never twice');
  assert.match(SERVER, /RUN_DRAFT_OVERLAPS/, 'two drafts never cover the same days');
  // Unapproved hours are listed, never billed quietly.
  assert.match(SERVER, /invoiceRuns\.isBillable\(r\.approval\) \|\| run\.includeWaiting/);
});

test('the Billing page reads a spreadsheet raw and never decides a number itself', () => {
  assert.match(PAGE, /sheet_to_json\(ws, \{ header: 1, raw: true, defval: '' \}\)/);
  assert.match(PAGE, /cdn\.sheetjs\.com\/xlsx-0\.20\.1/);
  assert.match(PAGE, /<InvoiceRuns data=\{data\} reload=\{load\} \/>/);
  for (const label of ['Start Draft', 'Edit Hours', 'Leave Off', 'Add Line', 'Rebuild From Hours', 'Delete Draft', 'Approve', 'View PDF', 'Send All', 'Mark Sent', 'Bill Them Anyway']) {
    assert.ok(PAGE.includes(`>${label}<`), label);
  }
});

// ---- Voiding a run (owner, 2026-11-27: "anything can be null until approved AND sent") ----
test('voidPlan: an approved run is voidable until anything in it is sent', () => {
  const run = { id: 'r', status: 'approved', invoiceIds: ['a', 'b', 'c'] };
  const inv = (id, clientId, status) => ({ id, clientId, status, displayNumber: `GFC-${id}` });
  const unsent = [inv('a', 'c1', 'draft'), inv('b', 'c1', 'draft'), inv('c', 'c2', 'draft'), inv('z', 'c9', 'draft')];
  assert.deepEqual(R.voidPlan(run, unsent, { reason: 'wrong rate' }).ids, ['a', 'b', 'c'], 'only this run\'s invoices');
  assert.equal(R.voidPlan(run, unsent, {}).code, 'RUN_VOID_REASON_REQUIRED');
  assert.equal(R.voidPlan(run, unsent, { reason: '   ' }).code, 'RUN_VOID_REASON_REQUIRED');
  assert.equal(R.voidPlan({ ...run, status: 'draft' }, unsent, { reason: 'x' }).code, 'RUN_IS_DRAFT');
  assert.equal(R.voidPlan({ ...run, status: 'void' }, unsent, { reason: 'x' }).code, 'RUN_ALREADY_VOID');
  assert.equal(R.voidPlan(null, unsent, { reason: 'x' }).code, 'RUN_NOT_FOUND');

  const partSent = [inv('a', 'c1', 'open'), inv('b', 'c1', 'open'), inv('c', 'c2', 'draft')];
  const blocked = R.voidPlan(run, partSent, { reason: 'x' });
  assert.equal(blocked.code, 'RUN_ALREADY_SENT', 'once sent, the run stands');
  assert.match(blocked.error, /GFC-a, GFC-b/);
  assert.deepEqual(R.voidPlan(run, partSent, { reason: 'x', clientId: 'c2' }).ids, ['c'], 'a client not sent yet can still be voided');
  assert.equal(R.voidPlan(run, partSent, { reason: 'x', clientId: 'c1' }).code, 'RUN_ALREADY_SENT');
  assert.equal(R.voidPlan(run, [inv('a', 'c1', 'paid'), inv('b', 'c1', 'void'), inv('c', 'c2', 'void')], { reason: 'x' }).code, 'RUN_ALREADY_SENT', 'paid counts as sent');
  assert.equal(R.voidPlan(run, [inv('a', 'c1', 'void'), inv('b', 'c1', 'void'), inv('c', 'c2', 'void')], { reason: 'x' }).code, 'RUN_NOTHING_TO_VOID');
  assert.deepEqual(R.voidPlan(run, [inv('a', 'c1', 'void'), inv('b', 'c1', 'draft'), inv('c', 'c2', 'draft')], { reason: 'x' }).ids, ['b', 'c'], 'already-void invoices are skipped');
});

test('allVoid: a run is void only when every one of its invoices is', () => {
  const run = { invoiceIds: ['a', 'b'] };
  assert.equal(R.allVoid(run, [{ id: 'a', status: 'void' }, { id: 'b', status: 'draft' }]), false);
  assert.equal(R.allVoid(run, [{ id: 'a', status: 'void' }, { id: 'b', status: 'void' }, { id: 'x', status: 'draft' }]), true);
  assert.equal(R.allVoid({ invoiceIds: [] }, []), false);
});

test('a voided run frees its shifts for a new run', () => {
  const lines = [{ sourceKey: 'log:1', shiftKey: 's1' }];
  assert.ok(P.invoicedKeys([{ status: 'draft', lines }]).has('log:1'));
  assert.ok(!P.invoicedKeys([{ status: 'void', lines }]).has('log:1'));
});

test('SAFETY: the void route checks voidPlan, needs a reason, and settles the run', () => {
  const body = between(SERVER, "'/api/gfc/admin/billing-runs/:id/void'", '\napp.');
  assert.match(body, /invoiceRuns\.voidPlan\(run, all, \{ clientId, reason \}\)/);
  assert.match(body, /if \(plan\.error\) return/);
  assert.match(body, /billing\.transition\(all\.find\(i => i\.id === id\), 'void'/, 'each invoice voids through the one status mover');
  assert.match(body, /settleRunAfterVoid\(run/);
  assert.match(body, /requireBilling/);
  const statements = between(SERVER, "'/api/gfc/admin/billing/invoices/:id/:action'", '\napp.');
  assert.match(statements, /to === 'void' && t\.inv\.runId[\s\S]*settleRunAfterVoid/, 'a single void under Statements keeps the run true');
});
