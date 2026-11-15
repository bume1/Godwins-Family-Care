#!/usr/bin/env node
// Live probe for invoice runs (owner, 2026-11-15; invoiceRuns.js).
// Run against a server started with MFA_ENFORCE=false, e.g.
//   PORT=3199 DATA_STORE=memory MFA_ENFORCE=false node server.js
// TEST DATA only. Every assertion reads a stored value or a real route's
// answer back. Email is not configured on a probe server, so Send is checked
// for refusing to mark anything sent when the email does not go.

const BASE = process.env.PROBE_BASE || 'http://localhost:3199';
const ADMIN_EMAIL = process.env.PROBE_ADMIN_EMAIL || 'admin@godwinsfamilycarellc.com';
const ADMIN_PASSWORD = process.env.PROBE_ADMIN_PASSWORD || 'gfcforever2026';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? `\n         ${JSON.stringify(detail).slice(0, 900)}` : ''}`); }
};
const call = async (method, path, token, body) => {
  const r = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const type = r.headers.get('content-type') || '';
  if (type.includes('application/pdf')) return { status: r.status, pdf: Buffer.from(await r.arrayBuffer()), disposition: r.headers.get('content-disposition') };
  if (type.includes('text/csv')) return { status: r.status, text: await r.text() };
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
};
const STAMP = Date.now();
// Georgia 9:00 AM is 14:00Z in November.
const at = (ymd, hh, mm = 0) => new Date(Date.parse(`${ymd}T${String(hh + 5).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`)).toISOString();

(async () => {
  const admin = ((await call('POST', '/api/auth/login', null, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).body || {}).token;
  if (!admin) { console.log('LOGIN FAILED — is the app running with MFA_ENFORCE=false?'); process.exit(1); }

  console.log('\n--- 1. a carrier, two clients and a caregiver (TEST DATA) ---');
  const daily = (await call('POST', '/api/gfc/admin/billing-payers', admin, { name: `Probe Daily LTC ${STAMP}`, attn: 'Claims', addressLines: 'PO Box 1\nAtlanta, GA 30301', claimsEmail: 'claims@example.test', invoiceMode: 'daily' })).body.payer;
  const perPeriod = (await call('POST', '/api/gfc/admin/billing-payers', admin, { name: `Probe Period LTC ${STAMP}`, addressLines: 'PO Box 2', invoiceMode: 'period' })).body.payer;
  ok('a carrier keeps how it is billed', daily.invoiceMode === 'daily' && perPeriod.invoiceMode === 'period', [daily, perPeriod]);
  const mk = async (name, extra) => {
    const email = `probe.ir.${name.split(' ')[1].toLowerCase()}.${STAMP}@example.test`;
    const r = await call('POST', '/api/users', admin, { email, password: 'Probe12345!', name, sendWelcomeEmail: false, ...extra });
    return { id: r.body && r.body.id, name, status: r.status, body: r.body };
  };
  const cg = await mk(`Probe Carla ${STAMP}`, { accountType: 'caregiver', licenseLevel: 'pca', payRate: 18 });
  const c1 = await mk(`Probe Ada ${STAMP}`, { role: 'client', accountType: 'client', practiceName: 'Probe practice' });
  const c2 = await mk(`Probe Ben ${STAMP}`, { role: 'client', accountType: 'client', practiceName: 'Probe practice' });
  ok('the people exist', cg.id && c1.id && c2.id, [cg.status, cg.body, c1.status, c1.body]);
  for (const c of [c1, c2]) {
    const r = await call('PUT', `/api/gfc/admin/enrollment/${c.id}/rate`, admin, { hourlyRate: 30, dailyMinimumHours: 5 });
    ok(`rate set for ${c.name}`, r.status === 200, r.body);
  }
  ok('Bill To: Ada to the daily carrier', (await call('PUT', `/api/gfc/admin/billing/${c1.id}/bill-to`, admin, { type: 'carrier', payerId: daily.id, insuredName: 'Probe Ada', policyNumber: 'P-1' })).status === 200);
  ok('Bill To: Ben to the period carrier', (await call('PUT', `/api/gfc/admin/billing/${c2.id}/bill-to`, admin, { type: 'carrier', payerId: perPeriod.id, insuredName: 'Probe Ben', policyNumber: 'P-2' })).status === 200);

  console.log('\n--- 2. completed shifts, one timesheet approved ---');
  const days = ['2026-11-03', '2026-11-04'];
  for (const c of [c1, c2]) for (const d of days) {
    const r = await call('POST', '/api/scheduling/time-logs', admin, { caregiverId: cg.id, clientId: c.id, clockInAt: at(d, 9), clockOutAt: at(d, 13, 52), reason: 'Probe hours (TEST DATA)' });
    ok(`time log ${c.name} ${d}`, r.status === 200 || r.status === 201, r.body);
  }
  const sheet = await call('GET', `/api/payroll/admin/timesheets?schedule=caregivers&date=${days[0]}`, admin);
  const period = sheet.body && sheet.body.period;
  ok('the caregiver pay period is found', period && period.start <= days[0] && period.end >= days[1], sheet.body);

  console.log('\n--- 3. a draft run bills only approved hours ---');
  let r = await call('POST', '/api/gfc/admin/billing-runs', admin, { source: 'app', from: days[0], to: days[1] });
  ok('a draft starts', r.status === 200 && r.body.run.status === 'draft', r.body);
  const runId = r.body.run.id;
  const mine = (v) => (v.shifts || []).filter(s => s.clientName.includes(String(STAMP)));
  ok('all four shifts are listed, waiting on the timesheet', mine(r.body).length === 4 && mine(r.body).every(s => s.waiting && s.approval === 'waiting'), mine(r.body));
  ok('nothing is invoiced while they wait', !(r.body.invoices || []).some(i => String(i.clientName).includes(String(STAMP))), r.body.invoices);
  const clash = await call('POST', '/api/gfc/admin/billing-runs', admin, { source: 'app', from: days[1], to: days[1] });
  ok('a second draft over the same days is refused', clash.status === 409 && clash.body.code === 'RUN_DRAFT_OVERLAPS', clash.body);

  const dec = await call('POST', '/api/payroll/admin/timesheets/decide', admin, { schedule: 'caregivers', periodStart: period.start, periodEnd: period.end, userId: cg.id, decision: 'approve' });
  ok('the timesheet is approved', dec.status === 200, dec.body);
  r = await call('GET', `/api/gfc/admin/billing-runs/${runId}`, admin);
  ok('after approval the shifts are billable', mine(r.body).every(s => s.approval === 'approved' && !s.waiting), mine(r.body));
  const invs = (r.body.invoices || []).filter(i => String(i.clientName).includes(String(STAMP)));
  const ada = invs.filter(i => i.clientName.startsWith('Probe Ada')), ben = invs.filter(i => i.clientName.startsWith('Probe Ben'));
  ok('the daily carrier gets one invoice per date of service', ada.length === 2 && ada.every(i => i.serviceDate), ada);
  ok('the period carrier gets one invoice for the period', ben.length === 1 && !ben[0].serviceDate, ben);
  ok('292 minutes at $30 is $146.00, plus 8 minutes up to the 5-hour daily minimum', ada[0].lines[0].amount === '$146.00' && ada[0].lines.some(l => l.kind === 'minimum' && l.amount === '$4.00'), ada[0].lines);

  console.log('\n--- 4. office changes inside the draft ---');
  const shift = mine(r.body).find(s => s.clientName.startsWith('Probe Ada') && s.date === days[0]);
  let e = await call('POST', `/api/gfc/admin/billing-runs/${runId}/edits`, admin, { sourceKey: shift.sourceKey, hours: '5' });
  ok('an hours change needs a reason', e.status === 400 && e.body.code === 'RUN_REASON_REQUIRED', e.body);
  e = await call('POST', `/api/gfc/admin/billing-runs/${runId}/edits`, admin, { sourceKey: shift.sourceKey, hours: '5:00', reason: 'Family confirmed she stayed until 2 PM' });
  const edited = mine(e.body).find(s => s.sourceKey === shift.sourceKey);
  ok('the billed hours change and the clocked hours stay', edited.billedMinutes === 300 && edited.clockedMinutes === 292, edited);
  const adaDay1 = e.body.invoices.find(i => i.clientName.startsWith('Probe Ada') && i.serviceDate === days[0]);
  ok('the invoice bills 5.00 hours ($150.00) and drops the minimum line', adaDay1.lines[0].amount === '$150.00' && !adaDay1.lines.some(l => l.kind === 'minimum'), adaDay1.lines);
  const benShift = mine(e.body).find(s => s.clientName.startsWith('Probe Ben') && s.date === days[1]);
  e = await call('POST', `/api/gfc/admin/billing-runs/${runId}/edits`, admin, { sourceKey: benShift.sourceKey, remove: true, reason: 'Billed separately' });
  ok('a shift left off is off the invoice', e.body.invoices.find(i => i.clientName.startsWith('Probe Ben')).lines.filter(l => l.kind === 'shift').length === 1, e.body.invoices);
  e = await call('POST', `/api/gfc/admin/billing-runs/${runId}/lines`, admin, { clientId: c2.id, date: days[1], kind: 'amount', amount: '-20', description: 'Credit, late arrival', reason: 'Owner credit' });
  ok('a credit line is added', e.status === 200 && e.body.run.adjustments.length === 1, e.body);
  const out = await call('POST', `/api/gfc/admin/billing-runs/${runId}/lines`, admin, { clientId: c2.id, date: '2026-12-01', kind: 'hours', hours: '2', description: 'x', reason: 'x' });
  ok('a line dated outside the run is refused', out.status === 400 && out.body.code === 'RUN_DATE_OUTSIDE', out.body);

  console.log('\n--- 5. approve, then the combined PDF ---');
  const ap = await call('POST', `/api/gfc/admin/billing-runs/${runId}/approve`, admin);
  ok('approving makes the invoices', ap.status === 200 && ap.body.run.status === 'approved' && ap.body.invoices.length >= 3, ap.body);
  const again = await call('POST', `/api/gfc/admin/billing-runs/${runId}/edits`, admin, { sourceKey: shift.sourceKey, hours: '6', reason: 'x' });
  ok('an approved run cannot be changed', again.status === 409 && again.body.code === 'RUN_NOT_DRAFT', again.body);
  const stmts = (await call('GET', '/api/gfc/admin/billing-statements', admin)).body.invoices.filter(i => i.runId === runId);
  ok('the invoices are drafts on Statements, tied to the run', stmts.length === ap.body.invoices.length && stmts.every(i => i.status === 'draft'), stmts.map(i => i.status));
  ok('the edited hours were billed as edited', stmts.some(i => (i.lines || []).some(l => l.editedFrom === 292 && l.minutes === 300)), stmts.map(i => i.lines));
  const pdf = await call('GET', `/api/gfc/admin/billing-runs/${runId}/clients/${c1.id}/pdf`, admin);
  ok('one PDF holds the client\'s invoices', pdf.status === 200 && pdf.pdf && pdf.pdf.slice(0, 5).toString() === '%PDF-', pdf.status);
  ok('  named for the client and period', /GFC_Invoices-Probe_Ada_\d+_2026-11-03_to_2026-11-04\.pdf/.test(pdf.disposition || ''), pdf.disposition);
  const pages = (await require('pdf-lib').PDFDocument.load(pdf.pdf)).getPageCount();
  ok('  one page per invoice at least (two dates)', pages >= 2, pages);

  console.log('\n--- 6. sending ---');
  const plan = ap.body.send || [];
  ok('a carrier with no claims email cannot be emailed', (plan.find(p => p.clientId === c2.id) || {}).blocked, plan);
  const send = await call('POST', `/api/gfc/admin/billing-runs/${runId}/send`, admin, { clientId: c1.id });
  const res1 = (send.body.results || [])[0] || {};
  ok('when the email does not go, nothing is marked sent', send.status === 200 && res1.sent === false && /did not go|not configured/i.test(res1.reason || ''), send.body);
  const still = (await call('GET', '/api/gfc/admin/billing-statements', admin)).body.invoices.filter(i => i.runId === runId && i.clientId === c1.id);
  ok('  the invoices are still drafts', still.every(i => i.status === 'draft'), still.map(i => i.status));
  const manual = await call('POST', `/api/gfc/admin/billing-runs/${runId}/send`, admin, { clientId: c2.id, manual: true });
  ok('Mark Sent works without email', (manual.body.results || [])[0] && manual.body.results[0].sent === true && manual.body.results[0].channel === 'manual', manual.body);
  const benInv = (await call('GET', '/api/gfc/admin/billing-statements', admin)).body.invoices.filter(i => i.runId === runId && i.clientId === c2.id);
  ok('  and the invoice is now sent (open)', benInv.length === 1 && benInv[0].status === 'open', benInv.map(i => i.status));

  console.log('\n--- 7. the billing export carries rate, amount, approval and invoice ---');
  const csv = await call('GET', `/api/scheduling/billing.csv?from=${days[0]}&to=${days[1]}`, admin);
  const [head, ...rows] = csv.text.trim().split(/\r?\n/);
  const heads = head.split(',');
  ok('the new columns are last', heads.slice(-4).join('|') === 'Client Rate|Billed Amount|Timesheet|Invoice', heads.slice(-4));
  const line = rows.find(x => x.includes(`Probe Ada ${STAMP}`));
  const cells = line.split(',');
  ok('  rate 30.00, amount 146.00, approved, invoice number', cells.slice(-4)[0] === '30.00' && cells.slice(-4)[1] === '146.00' && cells.slice(-4)[2] === 'Approved' && /^GFC-PA-/.test(cells.slice(-4)[3]), cells.slice(-4));

  console.log('\n--- 8. a spreadsheet run (Excel cells as day numbers) ---');
  const xl = `Caregiver,Client,Date,Start,End,Hours\r\nProbe Carla ${STAMP},Probe Ada ${STAMP},46332,0.375,0.5,3\r\n`;
  const imp = await call('POST', '/api/gfc/admin/billing-runs', admin, { source: 'import', from: '2026-11-06', to: '2026-11-08', csv: xl, fileName: 'hours.xlsx' });
  ok('the spreadsheet run starts and reads 9:00 AM to 12:00 PM on 11/6/2026', imp.status === 200 && (imp.body.shifts || []).some(s => s.date === '2026-11-06' && s.start === '9:00 AM' && s.approval === 'file'), imp.body);
  ok('Delete Draft', (await call('DELETE', `/api/gfc/admin/billing-runs/${imp.body.run.id}`, admin)).status === 200);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
