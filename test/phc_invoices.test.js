'use strict';
// Private Home Care invoices from approved hours (owner, 2026-11-08).
// Spec: docs/GFC_Payroll_Billing_QuickBooks_Spec_v2.md §4. The owner's two
// sample invoices are the pattern: 292 minutes at $30/hr bills $146.00 and
// reads "4.87 hrs (4 hr 52 min)". The samples themselves are not in the repo
// (it is public and they carry a client's policy numbers), so the numbers are
// restated here with made-up names.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');

const P = require('../phcInvoices');
const billing = require('../patientBilling');
const sched = require('../schedulingRepository');
const cg = require('../caregiverRepository');
const t = require('../public/gfc-time');
const pdf = require('../pdf-generator');
const packetImport = require('../welcomePacketImport');
const { ORG } = require('../public/consent-text');

const ROOT = path.join(__dirname, '..');
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '');
const SERVER = strip(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'));
const PAGE = strip(fs.readFileSync(path.join(ROOT, 'public', 'billing.html'), 'utf8'));

const localDate = (v) => (t.zonedParts(v) || {}).isoDate;
const fmtDate = (v) => t.fmtDate(/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? `${v}T12:00:00Z` : v);
const opts = (extra) => ({
  payers: [{ id: 'p1', name: 'Sample LTC Co', attn: 'Claims Department', addressLines: ['P.O. Box 1', 'Columbus, OH 43215'], claimsEmail: 'claims@example.com' }],
  invoiced: new Set(), taken: new Set(), period: { from: '2026-08-31', to: '2026-09-13' },
  levelLabel: (l) => cg.LICENSE_LABELS[l] || '', fmtDate, fmtTime: t.fmtTime, ...extra
});
const carrierClient = { id: 'c1', name: 'Nora Patel', rateAgreement: { hourlyRate: 30, dailyMinimumHours: 4 },
  billing: { billTo: { type: 'carrier', payerId: 'p1', insuredName: 'Nora Patel', policyNumber: 'POL-1', claimNumber: 'CLM-1' } } };
const familyClient = { id: 'c2', name: 'Ray Ochoa', rateAgreement: { hourlyRate: '32.50', dailyMinimumHours: 4 },
  billing: { billTo: { type: 'family', name: 'Lena Ochoa', addressLines: ['1 Main St', 'Atlanta, GA 30301'], email: '' } } };
const shift = (clientId, ymd, start, end, extra) => {
  const inAt = t.instantFromZoned(ymd, start), outAt = t.instantFromZoned(ymd, end);
  return { sourceKey: `log:${clientId}-${ymd}-${start}`, shiftKey: P.shiftKeyOf('g1', clientId, inAt), caregiverId: 'g1', caregiverName: 'Tara Gibbs',
    licenseLevel: 'pca', clientId, clientName: '', clockInAt: inAt, clockOutAt: outAt,
    minutes: Math.round((Date.parse(outAt) - Date.parse(inAt)) / 60000), serviceDate: ymd, ...extra };
};

// ── money from minutes ────────────────────────────────────────────────────────
test('money is figured from minutes, never from the rounded hours (the owner\'s samples)', () => {
  assert.equal(P.amountFromMinutes(292, 3000), 14600, '292 min at $30 is $146.00, not 4.87 x 30 = $146.10');
  assert.equal(P.amountFromMinutes(256, 3000), 12800);
  assert.equal(P.hoursOf(256), 4.27);
  assert.equal(P.durationLabel(292), '4.87 hrs (4 hr 52 min)');
  assert.equal(P.durationLabel(256), '4.27 hrs (4 hr 16 min)');
});

test('the older home care statement is figured from minutes too', () => {
  const logs = [{ client_id: 'c', clock_in_at: '2026-10-06T13:00:00Z', clock_out_at: 'x', total_minutes: 292 }];
  const r = billing.homeCareLines(logs, { clientId: 'c', from: '2026-10-01', to: '2026-10-31', hourlyRate: 30, dailyMinimumHours: 0, localDate });
  assert.equal(r.lines[0].amountCents, 14600);
  assert.equal(r.lines[0].hours, 4.87);
});

// ── invoice numbers ─────────────────────────────────────────────────────────
test('invoice numbers keep the carrier style, and a number is never reused', () => {
  assert.equal(P.displayNumber('Jane Smith', '2026-10-06', new Set()), 'GFC-JS-261006');
  assert.equal(P.displayNumber('Mary Ann de la Cruz', '2026-10-06', new Set()), 'GFC-MC-261006');
  assert.equal(P.displayNumber('Cher', '2026-10-06', new Set()), 'GFC-CH-261006');
  assert.equal(P.displayNumber('Nora Patel', '2026-10-06', new Set(['GFC-NP-261006'])), 'GFC-NP-261006-2');
  assert.equal(P.displayNumber('Nora Patel', '2026-10-06', new Set(['GFC-NP-261006', 'GFC-NP-261006-2'])), 'GFC-NP-261006-3');
});

test('the server counts voided invoices as taken numbers, and Stripe never sees the display number', () => {
  assert.match(SERVER, /const taken = new Set\(invoices\.map\(i => i\.displayNumber\)\.filter\(Boolean\)\);/, 'every invoice, voids included');
  assert.match(SERVER, /number: await newInvoiceNumber\(\), clientId: i\.clientId, kind: 'home_care'/, 'each invoice still gets its own GFC-INV reference');
  // stripeSafe only accepts the GFC-INV reference as the product name.
  const inv = { id: '0f7a2b1c-1111-2222-3333-444455556666', number: 'GFC-INV-AAAAAA', displayNumber: 'GFC-NP-261006', totalCents: 14600 };
  const form = billing.checkoutForm(inv, { successUrl: 'https://app.example.com/portal?billing=paid', cancelUrl: 'https://app.example.com/portal?billing=cancelled' });
  assert.ok(!JSON.stringify(form).includes('GFC-NP'), 'initials never reach Stripe');
  assert.ok(billing.stripeSafe(form));
});

// ── grouping ─────────────────────────────────────────────────────────────────
test('an LTC carrier gets one invoice per client per date of service, laid out like the sample', () => {
  const rows = [shift('c1', '2026-10-06', '09:00', '13:52'), shift('c1', '2026-10-08', '09:00', '13:16')];
  const d = P.draftInvoices(rows, opts({ clients: [carrierClient] }));
  assert.equal(d.invoices.length, 2);
  const [a, b] = d.invoices;
  assert.equal(a.format, 'carrier');
  assert.equal(a.displayNumber, 'GFC-NP-261006');
  assert.equal(a.serviceDate, '2026-10-06');
  assert.equal(a.totalCents, 14600);
  assert.equal(a.lines[0].description, 'Personal care services · Tara Gibbs (PCA) · 10/6/2026');
  assert.deepEqual([a.shifts[0].start, a.shifts[0].end, a.shifts[0].duration, a.shifts[0].service],
    ['9:00 AM', '1:52 PM', '4.87 hrs (4 hr 52 min)', 'Private home care, personal care assistance']);
  assert.deepEqual([a.billTo.name, a.billTo.insuredName, a.billTo.policyNumber, a.billTo.claimNumber], ['Sample LTC Co', 'Nora Patel', 'POL-1', 'CLM-1']);
  assert.equal(b.displayNumber, 'GFC-NP-261008');
  assert.equal(b.totalCents, 12800);
});

test('two shifts on one date are one carrier invoice with a line and a details block each', () => {
  const rows = [shift('c1', '2026-10-06', '08:00', '10:30'), shift('c1', '2026-10-06', '14:00', '16:00', { caregiverId: 'g2', caregiverName: 'Ann Lee', licenseLevel: 'cna' })];
  const d = P.draftInvoices(rows, opts({ clients: [carrierClient] }));
  assert.equal(d.invoices.length, 1);
  assert.equal(d.invoices[0].lines.length, 2);
  assert.equal(d.invoices[0].shifts.length, 2);
  assert.equal(d.invoices[0].totalCents, 7500 + 6000, '4.5 hrs worked that day meets the 4-hr minimum: no minimum line');
  assert.ok(!d.invoices[0].lines.some(l => l.kind === 'minimum'));
});

test('a family is billed once for the period, numbered by its last day', () => {
  const rows = [shift('c2', '2026-09-01', '09:00', '14:00'), shift('c2', '2026-09-08', '09:00', '14:00')];
  const d = P.draftInvoices(rows, opts({ clients: [familyClient] }));
  assert.equal(d.invoices.length, 1);
  const i = d.invoices[0];
  assert.equal(i.format, 'family');
  assert.equal(i.displayNumber, 'GFC-RO-260913');
  assert.deepEqual(i.period, { from: '2026-08-31', to: '2026-09-13' });
  assert.equal(i.totalCents, 2 * 5 * 3250);
});

test('the daily minimum is its own line, so each shift line stays what was worked', () => {
  const rows = [shift('c1', '2026-10-06', '09:00', '11:30')];   // 150 min against a 4-hr minimum
  const i = P.draftInvoices(rows, opts({ clients: [carrierClient] })).invoices[0];
  assert.equal(i.lines.length, 2);
  assert.equal(i.lines[0].minutes, 150);
  assert.equal(i.lines[1].kind, 'minimum');
  assert.equal(i.lines[1].minutes, 90);
  assert.match(i.lines[1].description, /^Daily minimum, 4 hrs agreed · 10\/6\/2026$/);
  assert.equal(i.totalCents, 12000);
  // Worked hours above the minimum: billed as worked, nothing held, no cap.
  const long = P.draftInvoices([shift('c1', '2026-09-03', '07:00', '19:00')], opts({ clients: [carrierClient] })).invoices[0];
  assert.equal(long.lines.length, 1);
  assert.equal(long.totalCents, 12 * 3000);
});

test('a shift already on a live invoice is never billed twice, whether it came from the app or a file', () => {
  const s = shift('c1', '2026-10-06', '09:00', '13:52');
  const keys = P.invoicedKeys([{ status: 'open', lines: [{ sourceKey: 'imp:other', shiftKey: s.shiftKey }] }]);
  const d = P.draftInvoices([s], opts({ clients: [carrierClient], invoiced: keys }));
  assert.equal(d.invoices.length, 0);
  assert.equal(d.alreadyInvoiced, 1);
  // A voided invoice frees its shifts.
  const freed = P.invoicedKeys([{ status: 'void', lines: [{ sourceKey: s.sourceKey, shiftKey: s.shiftKey }] }]);
  assert.equal(P.draftInvoices([s], opts({ clients: [carrierClient], invoiced: freed })).invoices.length, 1);
  // A statement from the older route covers its client and dates.
  assert.ok(P.coveredByOldStatement(s, [{ status: 'open', kind: 'home_care', clientId: 'c1', period: { from: '2026-10-01', to: '2026-10-14' } }]));
  assert.ok(!P.coveredByOldStatement(s, [{ status: 'open', kind: 'home_care', format: 'family', clientId: 'c1', period: { from: '2026-10-01', to: '2026-10-14' } }]));
});

test('a client with no rate or no Bill To is named, not invoiced', () => {
  const noRate = { ...carrierClient, id: 'c3', name: 'No Rate', rateAgreement: {} };
  const noBill = { ...familyClient, id: 'c4', name: 'No Bill', billing: {} };
  const d = P.draftInvoices([shift('c3', '2026-10-06', '09:00', '13:00'), shift('c4', '2026-10-06', '09:00', '13:00')], opts({ clients: [noRate, noBill] }));
  assert.equal(d.invoices.length, 0);
  assert.deepEqual(d.skipped.map(s => s.reason), ['No agreed hourly rate. Set it on their Rate card.', 'No Bill To. Say who is billed for this client.']);
});

// ── the hours file ─────────────────────────────────────────────────────────────
const people = {
  caregivers: [{ id: 'g1', name: 'Tara Gibbs', licenseLevel: 'pca' }, { id: 'g2', name: 'Ann Lee', licenseLevel: 'cna' }],
  clients: [{ id: 'c1', name: 'Nora Patel' }, { id: 'c2', name: 'Ray Ochoa' }],
  instantFromZoned: t.instantFromZoned, localDate
};
// A file exactly as the app's payroll export writes it.
const exportRow = (cgName, client, inAt, outAt) => ({
  caregiverName: cgName, licenseLevel: 'PCA', clientName: client,
  shiftDate: sched.csvDate(inAt), clockInAt: sched.csvTime(inAt, sched.csvLocalDate(inAt)), clockOutAt: sched.csvTime(outAt, sched.csvLocalDate(inAt)),
  hours: sched.minutesToHours(Math.round((Date.parse(outAt) - Date.parse(inAt)) / 60000))
});

test('the app\'s own payroll export reads back in, overnight shifts included', () => {
  const a = exportRow('Tara Gibbs', 'Nora Patel', t.instantFromZoned('2026-10-06', '09:00'), t.instantFromZoned('2026-10-06', '13:52'));
  const b = exportRow('Ann Lee', 'Ray Ochoa', t.instantFromZoned('2026-10-07', '22:00'), t.instantFromZoned('2026-10-08', '06:00'));
  assert.equal(b.clockOutAt, '10/8 6:00 AM', 'the export date-stamps a shift that crosses midnight');
  const r = P.rowsFromImport(sched.toPayrollCsv([a, b]), people);
  assert.ok(!r.errors, JSON.stringify(r.errors));
  assert.deepEqual(r.rows.map(x => [x.caregiverId, x.clientId, x.minutes, x.serviceDate]), [['g1', 'c1', 292, '2026-10-06'], ['g2', 'c2', 480, '2026-10-07']]);
  // The same shift from the app and from the file is one shift.
  assert.equal(r.rows[0].shiftKey, P.shiftKeyOf('g1', 'c1', '2026-10-06T13:00:37.000Z'));
});

test('the billing export\'s column names are read too', () => {
  const csv = 'Client,Service Date,Caregiver,Actual In,Actual Out,Billable Hours\r\nNora Patel,10/6/2026,Tara Gibbs,9:00 AM,1:52 PM,4.87\r\n';
  const r = P.rowsFromImport(csv, people);
  assert.equal(r.rows[0].minutes, 292);
});

test('one bad row stops the whole import, and every bad row is named', () => {
  const head = 'Caregiver,License Level,Client,Shift Date,Clock In,Clock Out,Hours\r\n';
  const csv = head + [
    'Tara Gibbs,PCA,Nora Patel,10/6/2026,9:00 AM,1:52 PM,4.87',
    'Nobody Here,PCA,Nora Patel,10/6/2026,9:00 AM,1:52 PM,4.87',
    'Tara Gibbs,PCA,Nora Patel,9/3/2026,9:00 AM,1:52 PM,5.00',
    'Tara Gibbs,PCA,Nora Patel,13/3/2026,9:00 AM,1:52 PM,4.87',
    'Tara Gibbs,PCA,Nora Patel,10/6/2026,9:00 AM,1:52 PM,4.87'
  ].join('\r\n');
  const r = P.rowsFromImport(csv, people);
  assert.ok(!r.rows);
  assert.deepEqual(r.errors.map(e => e.line), [3, 4, 5, 6]);
  assert.match(r.errors[0].message, /No caregiver called "Nobody Here"/);
  assert.match(r.errors[1].message, /Hours says 5\.00 but Clock In to Clock Out is 4\.87/);
  assert.match(r.errors[2].message, /is not a date/);
  assert.match(r.errors[3].message, /in the file twice/);
});

test('a shared name is refused, never guessed', () => {
  const twins = { ...people, caregivers: [...people.caregivers, { id: 'g9', name: 'Tara Gibbs' }] };
  const r = P.rowsFromImport('Caregiver,Client,Shift Date,Clock In,Clock Out,Hours\nTara Gibbs,Nora Patel,10/6/2026,9:00 AM,1:52 PM,4.87\n', twins);
  assert.match(r.errors[0].message, /Two caregivers are called "Tara Gibbs"/);
});

test('a file that is not the export says which columns are missing', () => {
  const r = P.rowsFromImport('Name,Date,Hours\nx,10/6/2026,4\n', people);
  assert.match(r.errors[0].message, /Missing columns: Caregiver, Client, Shift Date, Clock In, Clock Out\./);
});

test('the export\'s spreadsheet-formula guard comes off on the way back in', () => {
  const r = P.rowsFromImport(sched.toPayrollCsv([exportRow('Tara Gibbs', 'Nora Patel', t.instantFromZoned('2026-10-06', '09:00'), t.instantFromZoned('2026-10-06', '13:52'))])
    .replace('Tara Gibbs', "'-Tara Gibbs"), { ...people, caregivers: [{ id: 'g1', name: '-Tara Gibbs' }] });
  assert.equal(r.rows[0].caregiverId, 'g1');
});

// ── Bill To ────────────────────────────────────────────────────────────────────
test('Bill To: a carrier needs a payer from the list, the insured and the policy number', () => {
  const payers = [{ id: 'p1', name: 'X' }];
  assert.equal(P.normalizeBillTo({ type: 'carrier', payerId: 'nope', insuredName: 'a', policyNumber: '1' }, payers).code, 'BILL_TO_PAYER_UNKNOWN');
  assert.equal(P.normalizeBillTo({ type: 'carrier', payerId: 'p1', policyNumber: '1' }, payers).code, 'BILL_TO_INSURED_REQUIRED');
  assert.equal(P.normalizeBillTo({ type: 'carrier', payerId: 'p1', insuredName: 'a' }, payers).code, 'BILL_TO_POLICY_REQUIRED');
  assert.equal(P.normalizeBillTo({ type: 'family', name: '' }).code, 'PAYER_NAME_REQUIRED');
  assert.deepEqual(P.normalizeBillTo({ type: 'family', name: 'Lena', addressLines: '1 Main\n\nAtlanta' }).value.addressLines, ['1 Main', 'Atlanta']);
});

test('the Bill To is copied onto the invoice, so editing a payer later changes no invoice', () => {
  const o = opts({ clients: [carrierClient] });
  const inv = P.draftInvoices([shift('c1', '2026-10-06', '09:00', '13:52')], o).invoices[0];
  o.payers[0].name = 'Renamed Co';
  assert.equal(inv.billTo.name, 'Sample LTC Co');
});

// ── the patient never sees a carrier's invoice ──────────────────────────────────
test('a carrier invoice is the carrier\'s: never on the portal, never paid online, never announced to the patient', () => {
  assert.equal(billing.patientPays({ format: 'carrier' }), false);
  assert.equal(billing.patientPays({ format: 'family' }), true);
  assert.equal(billing.patientPays({ kind: 'copay' }), true);
  assert.match(SERVER, /r\.clientId === client\.id && r\.status !== 'draft' && billing\.patientPays\(r\)\)/, 'portal list');
  assert.match(SERVER, /r\.id === req\.params\.id && r\.clientId === client\.id && billing\.patientPays\(r\)\);/, 'online pay');
  assert.match(SERVER, /if \(to === 'open' && billing\.patientPays\(t\.inv\)\) notifyStatement\(t\.inv\.clientId\);/, 'the statement email');
});

test('clinical-only clients are never invoiced here', () => {
  assert.match(SERVER, /const clinicalOnly = new Set\(clients\.filter\(c => String\(c\.serviceLine \|\| ''\)\.toUpperCase\(\) === 'IHPC'\)\.map\(c => c\.id\)\);/);
  assert.match(SERVER, /rows = rows\.filter\(r => !clinicalOnly\.has\(r\.clientId\)/);
});

test('every invoice route is billing\'s, and the PDF is opened with the token in the header', () => {
  for (const r of ["app.post('/api/gfc/admin/billing-payers'", "app.put('/api/gfc/admin/billing-payers/:id'", "app.put('/api/gfc/admin/billing/:clientId/bill-to'",
    "app.post('/api/gfc/admin/billing-invoices/preview'", "app.post('/api/gfc/admin/billing-invoices'", "app.get('/api/gfc/admin/billing/invoices/:id/pdf'"]) {
    assert.ok(SERVER.includes(`${r}, authenticateToken, requireBilling,`), r);
  }
  assert.match(PAGE, /headers: \{ Authorization: `Bearer \$\{getToken\(\)\}` \}/);
  assert.doesNotMatch(PAGE, /\/pdf\?token=/);
});

// ── the PDF ─────────────────────────────────────────────────────────────────────
test('the PDF reads like the owner\'s sample invoice', async () => {
  const inv = P.draftInvoices([shift('c1', '2026-10-06', '09:00', '13:52')], opts({ clients: [carrierClient] })).invoices[0];
  const buf = await pdf.generatePhcInvoicePDF({ ...inv, invoiceDate: '10/8/2026', serviceDateLabel: '10/6/2026' });
  const doc = await PDFDocument.load(buf);
  assert.equal(doc.getPageCount(), 1);
  const text = (await packetImport.extractRuns(doc)).map(r => r.text).join(' ').replace(/\s+/g, ' ');
  for (const s of ['INVOICE', 'Invoice # GFC-NP-261006', 'Invoice date 10/8/2026', 'Service date 10/6/2026',
    'FROM', 'Godwins Family Care LLC', '4300 Paces Ferry Rd SE, Suite 500', 'Atlanta, GA 30339', `Tel ${ORG.phone}`, `Fax ${ORG.fax}`, ORG.email,
    'BILL TO', 'Sample LTC Co', 'Attn: Claims Department', 'claims@example.com', 'Insured: Nora Patel', 'Policy #: POL-1', 'Claim #: CLM-1',
    'SERVICE DETAILS', 'Tara Gibbs, PCA', 'Private home care, personal care assistance', 'Shift start (ET)', '9:00 AM', '1:52 PM', '4.87 hrs (4 hr 52 min)',
    'DESCRIPTION', 'HOURS', 'RATE', 'AMOUNT', 'Personal care services · Tara Gibbs (PCA) · 10/6/2026', '4.87', '$30.00/hr', '$146.00',
    'Subtotal', 'Sales tax (0%)', '$0.00', 'TOTAL DUE', 'PAYMENT', 'Payable to: Godwins Family Care LLC', 'Terms: Due Upon Receipt', 'Care That Sees You.']) {
    assert.ok(text.includes(s), `missing "${s}"`);
  }
  assert.ok(!text.includes('$146.10'));
});

test('a long family invoice runs to a second page with the table header repeated', async () => {
  const rows = [];
  for (let d = 1; d <= 13; d++) for (const [a, b] of [['08:00', '12:00'], ['13:00', '17:00']]) rows.push(shift('c2', `2026-09-${String(d).padStart(2, '0')}`, a, b));
  const inv = P.draftInvoices(rows, opts({ clients: [familyClient] })).invoices[0];
  const buf = await pdf.generatePhcInvoicePDF({ ...inv, invoiceDate: '9/14/2026', periodLabel: '8/31/2026 to 9/13/2026', billedDuration: P.durationLabel(inv.billedMinutes) });
  const doc = await PDFDocument.load(buf);
  assert.ok(doc.getPageCount() >= 2);
  const text = (await packetImport.extractRuns(doc)).map(r => r.text).join(' ');
  assert.equal(text.split('DESCRIPTION').length - 1, doc.getPageCount(), 'the table header repeats on each page');
  assert.ok(text.includes('Page 2 of'));
  assert.ok(text.includes('$3,380.00'), '26 shifts x 4 hrs x $32.50');
});

test('an overnight shift typed without its end date runs into the next morning', () => {
  const r = P.rowsFromImport('Caregiver,Client,Shift Date,Clock In,Clock Out,Hours\nTara Gibbs,Nora Patel,9/3/2026,10:00 PM,6:00 AM,8.00\n', people);
  assert.ok(!r.errors, JSON.stringify(r.errors));
  assert.equal(r.rows[0].minutes, 480);
  assert.equal(r.rows[0].serviceDate, '2026-09-03');
});
