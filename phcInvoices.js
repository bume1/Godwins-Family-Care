'use strict';
// ============================================================================
// phcInvoices.js — Private Home Care invoices from approved hours
// (owner, 2026-11-08; spec: docs/GFC_Payroll_Billing_QuickBooks_Spec_v2.md §4)
//
// PURE. The routes in server.js gather the facts; this decides what an
// invoice says. Nothing here reads a store, a clock or the network.
//
// WHERE THE HOURS COME FROM. Either the app's own completed time logs (the
// same rows the payroll export carries) or a file in that export's format,
// for hours kept outside the app. There is no second template: the import
// reads what the app exports. Every row is checked and every bad row is
// named; one bad row stops the whole import, because an invoice made from
// half a file is worse than none.
//
// THREE RULES THE OWNER SET, each a sentence in the spec:
//   - Hours are billed AS WORKED. No cap, nothing held, nothing moved.
//   - The client's agreed daily minimum still applies, as it always has. It is
//     its own line, so the shift lines stay exactly what was worked.
//   - Money is figured from MINUTES, never from rounded hours: 292 minutes at
//     $30 is $146.00, even though 4.87 x 30 is $146.10. The owner's sample
//     invoices are worked that way.
//
// WHO GETS ONE.
//   carrier  An LTC insurance carrier: one invoice per client per service
//            date, their current format.
//   family   The client or their family: one invoice per client for a period
//            (every two weeks).
// The Bill To is copied onto the invoice when it is made, so editing a payer
// later never changes an invoice already sent.
//
// INVOICE NUMBERS keep the carrier style the samples use: GFC-NP-261006, the
// client's initials and the service date (a family invoice uses its period's
// last day). Stripe NEVER sees this number. It sees the statement's own
// GFC-INV-XXXXXX reference and an amount (patientBilling.stripeSafe).
// ============================================================================

const SERVICE_BY_LEVEL = Object.freeze({
  sitter: { service: 'Private home care, companion and sitter services', line: 'Companion services' },
  pca: { service: 'Private home care, personal care assistance', line: 'Personal care services' },
  cna: { service: 'Private home care, personal care (CNA)', line: 'Personal care services' },
  lpn: { service: 'Private home care, skilled personal care (LPN)', line: 'Personal care services' }
});
const DEFAULT_SERVICE = { service: 'Private home care services', line: 'Home care services' };
const serviceFor = (level) => SERVICE_BY_LEVEL[String(level || '').toLowerCase()] || DEFAULT_SERVICE;

const FORMATS = Object.freeze(['carrier', 'family']);
const MAX_ROWS = 5000;

const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
// One shift, however it reached us: the app's time log and the same shift in
// an imported file name the same caregiver, client and minute.
const shiftKeyOf = (caregiverId, clientId, clockInAt) => `${caregiverId}|${clientId}|${String(new Date(clockInAt).toISOString()).slice(0, 16)}`;

// Cents from minutes, rounded once at the end.
const amountFromMinutes = (minutes, rateCents) => Math.round((Number(minutes) * Number(rateCents)) / 60);
// The hours column: minutes / 60 to two decimals.
const hoursOf = (minutes) => Math.round((Number(minutes) / 60) * 100) / 100;
// "4.87 hrs (4 hr 52 min)"
function durationLabel(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  return `${hoursOf(m).toFixed(2)} hrs (${Math.floor(m / 60)} hr ${m % 60} min)`;
}

// "Jane Smith" -> "DM". One word -> its first two letters.
function initialsOf(name) {
  const words = str(name).toUpperCase().replace(/[^A-Z\s'-]/g, ' ').split(/[\s'-]+/).filter(Boolean);
  if (!words.length) return 'XX';
  if (words.length === 1) return (words[0] + 'X').slice(0, 2);
  return words[0][0] + words[words.length - 1][0];
}

// GFC-NP-261006, then -2, -3 when taken. `taken` is every number ever issued,
// voided ones included: a number is never reused.
function displayNumber(clientName, ymd, taken) {
  const base = `GFC-${initialsOf(clientName)}-${String(ymd).slice(2, 4)}${String(ymd).slice(5, 7)}${String(ymd).slice(8, 10)}`;
  const has = (n) => taken && (taken.has ? taken.has(n) : taken.includes(n));
  if (!has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!has(`${base}-${i}`)) return `${base}-${i}`;
  throw new Error('no free invoice number');
}

// ---- Bill To -----------------------------------------------------------------
// The office's payers list holds carriers. A client's own billTo either points
// at one (with that client's insured name, policy # and claim #) or names a
// family payer directly.
function normalizePayer(body) {
  const b = body || {};
  const name = str(b.name).slice(0, 160);
  if (!name) return { error: 'Give the payer\'s name.', code: 'PAYER_NAME_REQUIRED' };
  const email = str(b.claimsEmail).slice(0, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'That claims email does not look right.', code: 'PAYER_EMAIL_INVALID' };
  return {
    value: {
      name,
      attn: str(b.attn).slice(0, 160),
      addressLines: (Array.isArray(b.addressLines) ? b.addressLines : String(b.addressLines || '').split(/\r?\n/))
        .map(str).filter(Boolean).slice(0, 4).map(l => l.slice(0, 160)),
      claimsEmail: email,
      phone: str(b.phone).slice(0, 40)
    }
  };
}

function normalizeBillTo(body, payers) {
  const b = body || {};
  if (b.type === 'carrier') {
    const payer = (payers || []).find(p => p && p.id === b.payerId && !p.retired);
    if (!payer) return { error: 'Pick the carrier from the payers list.', code: 'BILL_TO_PAYER_UNKNOWN' };
    const insuredName = str(b.insuredName).slice(0, 160);
    const policyNumber = str(b.policyNumber).slice(0, 60);
    if (!insuredName) return { error: 'Give the insured\'s name.', code: 'BILL_TO_INSURED_REQUIRED' };
    if (!policyNumber) return { error: 'Give the policy number.', code: 'BILL_TO_POLICY_REQUIRED' };
    return { value: { type: 'carrier', payerId: payer.id, insuredName, policyNumber, claimNumber: str(b.claimNumber).slice(0, 60) } };
  }
  if (b.type === 'family') {
    const p = normalizePayer(b);
    if (p.error) return { error: p.error.replace('payer', 'person billed'), code: p.code };
    return { value: { type: 'family', name: p.value.name, attn: p.value.attn, addressLines: p.value.addressLines, email: p.value.claimsEmail } };
  }
  return { error: 'Say who is billed: a carrier or the family.', code: 'BILL_TO_TYPE_REQUIRED' };
}

// What prints under BILL TO, frozen onto the invoice.
function billToSnapshot(billTo, payers) {
  if (!billTo) return null;
  if (billTo.type === 'carrier') {
    const p = (payers || []).find(x => x && x.id === billTo.payerId);
    if (!p) return null;
    return {
      type: 'carrier', name: p.name, attn: p.attn || '', addressLines: p.addressLines || [], email: p.claimsEmail || '',
      insuredName: billTo.insuredName, policyNumber: billTo.policyNumber, claimNumber: billTo.claimNumber || ''
    };
  }
  if (billTo.type === 'family') {
    return { type: 'family', name: billTo.name, attn: billTo.attn || '', addressLines: billTo.addressLines || [], email: billTo.email || '' };
  }
  return null;
}

// ---- Hours from the app ------------------------------------------------------
// A completed time log is one hour row. Unfinished shifts are not billable.
function rowsFromTimeLogs(timeLogs, { from, to, localDate }) {
  const out = [];
  for (const l of timeLogs || []) {
    if (!l || !l.clock_in_at || !l.clock_out_at || !(Number(l.total_minutes) > 0)) continue;
    const d = localDate(l.clock_in_at);
    if (!d || d < from || d > to) continue;
    out.push({
      sourceKey: `log:${l.id}`,
      shiftKey: shiftKeyOf(l.caregiver_id, l.client_id, l.clock_in_at),
      timeLogId: l.id,
      caregiverId: l.caregiver_id, caregiverName: l.caregiver_name || '',
      licenseLevel: l.license_level || '',
      clientId: l.client_id, clientName: l.client_name || '',
      clockInAt: l.clock_in_at, clockOutAt: l.clock_out_at,
      minutes: Number(l.total_minutes), serviceDate: d
    });
  }
  return out;
}

// ---- Hours from a file -------------------------------------------------------
// RFC 4180, the shape toPayrollCsv writes: quoted fields, doubled quotes, CRLF.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(v => v !== '')) rows.push(row);
  return rows;
}
// toPayrollCsv puts ' before a leading = + - @ so a spreadsheet does not run
// it as a formula. Read back, that guard comes off.
const unguard = (v) => (/^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);

// The payroll export's headers, plus the billing export's names for the same
// columns, so either file the app exports can come back in.
const HEADER_ALIASES = Object.freeze({
  caregiver: ['caregiver'],
  level: ['license level'],
  client: ['client'],
  date: ['shift date', 'service date'],
  clockIn: ['clock in', 'actual in'],
  clockOut: ['clock out', 'actual out'],
  hours: ['hours', 'billable hours']
});
const REQUIRED_COLUMNS = ['caregiver', 'client', 'date', 'clockIn', 'clockOut', 'hours'];

// "10/3/2026" -> "2026-10-03"
function ymdFromUsDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(str(s));
  if (!m) return isYmd(str(s)) ? str(s) : null;
  const mo = Number(m[1]), d = Number(m[2]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
// "9:00 AM" on the row's date, or "10/4 6:00 AM" when it crossed midnight
// (csvTime writes it that way). Returns [ymd, "HH:MM"] or null.
function wallClock(s, rowYmd) {
  const m = /^(?:(\d{1,2})\/(\d{1,2})\s+)?(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/.exec(str(s));
  if (!m) return null;
  let h = Number(m[3]);
  const min = Number(m[4]);
  if (h < 1 || h > 12 || min > 59) return null;
  const pm = /p/i.test(m[5]);
  if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
  let ymd = rowYmd;
  if (m[1]) {
    let year = Number(rowYmd.slice(0, 4));
    const mo = Number(m[1]), d = Number(m[2]);
    if (mo < Number(rowYmd.slice(5, 7))) year += 1;   // Dec 31 into Jan 1
    ymd = `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return [ymd, `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`];
}

/**
 * Read an hours file. People are matched BY NAME, because that is what the
 * export carries: an unknown or ambiguous name is an error, never a guess.
 * `instantFromZoned(ymd, 'HH:MM')` turns Georgia's wall clock into an instant
 * (gfc-time). Returns { rows } or { errors: [{ line, message }] }.
 */
function rowsFromImport(text, { caregivers, clients, instantFromZoned, localDate }) {
  const table = parseCsv(text);
  if (!table.length) return { errors: [{ line: 1, message: 'The file is empty.' }] };
  if (table.length - 1 > MAX_ROWS) return { errors: [{ line: 1, message: `The file has more than ${MAX_ROWS} rows. Split it by date.` }] };
  const head = table[0].map(h => str(h).toLowerCase());
  const col = {};
  for (const [key, names] of Object.entries(HEADER_ALIASES)) {
    const i = head.findIndex(h => names.includes(h));
    if (i !== -1) col[key] = i;
  }
  const missing = REQUIRED_COLUMNS.filter(k => col[k] === undefined);
  if (missing.length) {
    return { errors: [{ line: 1, message: `This is not the app's payroll export. Missing column${missing.length > 1 ? 's' : ''}: ${missing.map(k => HEADER_ALIASES[k][0].replace(/\b\w/g, c => c.toUpperCase())).join(', ')}.` }] };
  }
  const byName = (list) => {
    const m = new Map();
    for (const u of list || []) {
      const k = str(u && u.name).toLowerCase();
      if (!k) continue;
      m.set(k, m.has(k) ? null : u);   // null = two people share this name
    }
    return m;
  };
  const cgByName = byName(caregivers), clByName = byName(clients);
  const errors = [], rows = [], seen = new Set();
  table.slice(1).forEach((r, i) => {
    const line = i + 2;
    const cell = (k) => unguard(str(r[col[k]]));
    const say = (message) => errors.push({ line, message });
    const cgName = cell('caregiver'), clName = cell('client');
    const cg = cgByName.get(cgName.toLowerCase()), cl = clByName.get(clName.toLowerCase());
    if (!cgName) return say('No caregiver named.');
    if (cg === undefined) return say(`No caregiver called "${cgName}" in the app.`);
    if (cg === null) return say(`Two caregivers are called "${cgName}". Fix one name in the app first.`);
    if (!clName) return say('No client named.');
    if (cl === undefined) return say(`No client called "${clName}" in the app.`);
    if (cl === null) return say(`Two clients are called "${clName}". Fix one name in the app first.`);
    const ymd = ymdFromUsDate(cell('date'));
    if (!ymd) return say(`"${cell('date')}" is not a date.`);
    const a = wallClock(cell('clockIn'), ymd), b = wallClock(cell('clockOut'), ymd);
    if (!a) return say(`Clock In "${cell('clockIn')}" is not a time like 9:00 AM.`);
    if (!b) return say(`Clock Out "${cell('clockOut')}" is not a time like 1:52 PM.`);
    const inAt = instantFromZoned(a[0], a[1]);
    let outAt = instantFromZoned(b[0], b[1]);
    if (!inAt || !outAt) return say('The clock times could not be read.');
    // An overnight shift written without the date ("10:00 PM" to "6:00 AM").
    if (Date.parse(outAt) <= Date.parse(inAt) && b[0] === ymd) {
      const next = new Date(Date.parse(`${ymd}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
      outAt = instantFromZoned(next, b[1]);
    }
    const minutes = Math.round((Date.parse(outAt) - Date.parse(inAt)) / 60000);
    if (!(minutes > 0)) return say('Clock Out is not after Clock In.');
    if (minutes > 24 * 60) return say('That shift is longer than 24 hours.');
    // The Hours column must agree with the clock times: the invoice prints
    // both, and they cannot say two different things.
    const hrs = Number(cell('hours').replace(/[^\d.]/g, ''));
    if (!(hrs > 0)) return say(`Hours "${cell('hours')}" is not a number.`);
    if (Math.abs(hrs - hoursOf(minutes)) > 0.011) {
      return say(`Hours says ${hrs.toFixed(2)} but Clock In to Clock Out is ${hoursOf(minutes).toFixed(2)}. Correct one of them.`);
    }
    const key = `imp:${cg.id}|${cl.id}|${inAt}`;
    if (seen.has(key)) return say('This shift is in the file twice.');
    seen.add(key);
    rows.push({
      sourceKey: key, shiftKey: shiftKeyOf(cg.id, cl.id, inAt), timeLogId: null,
      caregiverId: cg.id, caregiverName: cg.name,
      licenseLevel: cg.licenseLevel || cell('level').toLowerCase() || '',
      clientId: cl.id, clientName: cl.name,
      clockInAt: inAt, clockOutAt: outAt, minutes,
      serviceDate: localDate(inAt) || ymd,
      line
    });
  });
  return errors.length ? { errors } : { rows };
}

// ---- Rows -> invoices --------------------------------------------------------
/**
 * Draft invoices from hour rows.
 *   clients:   client records (rateAgreement, billing.billTo, name)
 *   payers:    the office's payers list
 *   invoiced:  Set of sourceKeys already on a live (non-void) invoice
 *   taken:     Set of every invoice number ever issued
 *   period:    { from, to } — the family invoice's period
 *   levelLabel(level): "PCA"
 *   fmtDate(iso | ymd), fmtTime(iso): Georgia's clock
 * Returns { invoices, skipped: [{ clientName, reason, ... }], alreadyInvoiced }.
 */
function draftInvoices(rows, { clients, payers, invoiced, taken, period, levelLabel, fmtDate, fmtTime }) {
  const used = new Set(taken || []);
  const skipped = [];
  let alreadyInvoiced = 0;
  const byClient = new Map();
  for (const r of rows || []) {
    if (invoiced && (invoiced.has(r.sourceKey) || invoiced.has(r.shiftKey))) { alreadyInvoiced++; continue; }
    if (!byClient.has(r.clientId)) byClient.set(r.clientId, []);
    byClient.get(r.clientId).push(r);
  }
  const invoices = [];
  const clientById = new Map((clients || []).map(c => [c.id, c]));
  for (const [clientId, list] of byClient) {
    const client = clientById.get(clientId);
    const clientName = (client && client.name) || list[0].clientName;
    if (!client) { skipped.push({ clientId, clientName, reason: 'Not a client in the app.', shifts: list.length }); continue; }
    const ra = client.rateAgreement || {};
    const rateCents = Math.round(Number(String(ra.hourlyRate || '').replace(/[$,\s]/g, '')) * 100);
    if (!(rateCents > 0)) { skipped.push({ clientId, clientName, reason: 'No agreed hourly rate. Set it on their Rate card.', shifts: list.length }); continue; }
    const billTo = billToSnapshot(client.billing && client.billing.billTo, payers);
    if (!billTo) { skipped.push({ clientId, clientName, reason: 'No Bill To. Say who is billed for this client.', shifts: list.length }); continue; }
    const minMinutes = Number(ra.dailyMinimumHours) > 0 ? Math.round(Number(ra.dailyMinimumHours) * 60) : 0;
    const format = billTo.type === 'carrier' ? 'carrier' : 'family';
    const sorted = list.slice().sort((a, b) => String(a.clockInAt).localeCompare(String(b.clockInAt)));
    const groups = format === 'carrier'
      ? [...sorted.reduce((m, r) => m.set(r.serviceDate, [...(m.get(r.serviceDate) || []), r]), new Map()).entries()]
      : [[null, sorted]];
    for (const [serviceDate, shifts] of groups) {
      const lines = [];
      const byDay = new Map();
      for (const s of shifts) {
        const lbl = levelLabel(s.licenseLevel) || '';
        const svc = serviceFor(s.licenseLevel);
        lines.push({
          kind: 'shift', date: s.serviceDate,
          description: `${svc.line} · ${s.caregiverName}${lbl ? ` (${lbl})` : ''} · ${fmtDate(s.serviceDate)}`,
          minutes: s.minutes, hours: hoursOf(s.minutes), rateCents,
          amountCents: amountFromMinutes(s.minutes, rateCents),
          sourceKey: s.sourceKey, shiftKey: s.shiftKey, timeLogId: s.timeLogId || null
        });
        byDay.set(s.serviceDate, (byDay.get(s.serviceDate) || 0) + s.minutes);
      }
      // The agreed daily minimum, as its own line, so each shift line stays
      // what was actually worked.
      if (minMinutes) {
        for (const [day, worked] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          if (worked >= minMinutes) continue;
          const extra = minMinutes - worked;
          lines.push({
            kind: 'minimum', date: day, minimumApplied: true,
            description: `Daily minimum, ${hoursOf(minMinutes)} hrs agreed · ${fmtDate(day)}`,
            minutes: extra, hours: hoursOf(extra), rateCents, amountCents: amountFromMinutes(extra, rateCents)
          });
        }
        lines.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'minimum') - (b.kind === 'minimum'));
      }
      const numberDate = serviceDate || (period && period.to) || shifts[shifts.length - 1].serviceDate;
      const number = displayNumber(clientName, numberDate, used);
      used.add(number);
      const billedMinutes = lines.reduce((a, l) => a + l.minutes, 0);
      invoices.push({
        clientId, clientName, format, displayNumber: number,
        serviceDate: serviceDate || null,
        period: format === 'family' ? { from: period && period.from, to: period && period.to } : null,
        billTo,
        shifts: shifts.map(s => {
          const lbl = levelLabel(s.licenseLevel) || '';
          return {
            caregiverName: s.caregiverName, levelLabel: lbl, service: serviceFor(s.licenseLevel).service,
            date: fmtDate(s.serviceDate), start: fmtTime(s.clockInAt), end: fmtTime(s.clockOutAt),
            minutes: s.minutes, duration: durationLabel(s.minutes)
          };
        }),
        lines,
        billedMinutes,
        totalCents: lines.reduce((a, l) => a + l.amountCents, 0)
      });
    }
  }
  invoices.sort((a, b) => String(a.clientName).localeCompare(String(b.clientName)) || String(a.displayNumber).localeCompare(String(b.displayNumber)));
  return { invoices, skipped, alreadyInvoiced };
}

// Every shift already on a live invoice, so the same hours are never billed twice.
function invoicedKeys(invoices) {
  const s = new Set();
  for (const inv of invoices || []) {
    if (!inv || inv.status === 'void') continue;
    for (const l of inv.lines || []) { if (l.sourceKey) s.add(l.sourceKey); if (l.shiftKey) s.add(l.shiftKey); }
    // Statements made by the older home-care route carry neither key. They are
    // matched by client and date instead (coveredByOldStatement).
  }
  return s;
}
// The older home-care statements (before 2026-11-08) cover a client for a
// date range. A shift inside one is already billed.
function coveredByOldStatement(row, invoices) {
  return (invoices || []).some(inv => inv && inv.status !== 'void' && inv.kind === 'home_care' && !inv.format &&
    inv.clientId === row.clientId && inv.period && row.serviceDate >= inv.period.from && row.serviceDate <= inv.period.to);
}

module.exports = {
  FORMATS, SERVICE_BY_LEVEL, serviceFor, shiftKeyOf,
  amountFromMinutes, hoursOf, durationLabel, initialsOf, displayNumber,
  normalizePayer, normalizeBillTo, billToSnapshot,
  rowsFromTimeLogs, parseCsv, rowsFromImport, ymdFromUsDate, wallClock,
  draftInvoices, invoicedKeys, coveredByOldStatement
};
