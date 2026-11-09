// ============================================================================
// GUSTO PAYROLL JOURNAL → PAST PAY STUBS AND YEAR-TO-DATE (2026-11-09)
// ============================================================================
// Pure. Reads Gusto's "Payroll Journal Report" CSV (Reports → Payroll Journal,
// "Summary by Employee", the per-pay-date sections) and turns each person's
// pay date into a PAID run the app already knows how to read:
//   - My GFC shows the pay stub,
//   - the run engine counts it toward year-to-date (Social Security wage
//     base, FUTA and Georgia unemployment caps),
//   - and the year-end figures include it.
// The file is never stored. Only people matched to an account are imported;
// everyone else is listed by name for the owner, never guessed at.
//
// Gusto's figures are taken as Gusto paid them. Nothing is recalculated:
// these are records of what already happened.
// ============================================================================

const MONEY_FIELDS = Object.freeze({
  hours: 'Regular (Hours)',
  gross: 'Gross Earnings',
  federal: 'Federal Income Tax (Employee)',
  socialSecurity: 'Social Security (Employee)',
  medicare: 'Medicare (Employee)',
  addlMedicare: 'Additional Medicare (Employee)',
  georgia: 'GA State Tax (Employee)',
  erSocialSecurity: 'Social Security (Employer)',
  erMedicare: 'Medicare (Employer)',
  futa: 'FUTA (Employer)',
  txSuta: 'TX SUTA (Employer)',
  gaAdmin: 'GA Administrative Assessment Tax (Employer)',
  gaSuta: 'GA State Unemployment Tax (Employer)',
  oneTimeReimbursement: 'One Time Reimbursement',
  net: 'Net Pay',
  reimbursements: 'Reimbursements',
  check: 'Check Amount'
});
const REQUIRED_HEADERS = Object.freeze(['Last Name', 'First Name', 'Gross Earnings', 'Net Pay']);

/** RFC 4180 CSV into rows of strings. */
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
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const toCents = (v) => {
  const t = String(v == null ? '' : v).replace(/[$,\s]/g, '');
  if (t === '') return 0;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
// "09/07/2026" → "2026-09-07"
const ymd = (v) => {
  const m = /^\s*(\d{2})\/(\d{2})\/(\d{4})\s*$/.exec(String(v || ''));
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
};
const stateOf = (address) => {
  const m = /,\s*([A-Z]{2})\s+\d{5}(?:-\d{4})?\s*$/.exec(String(address || ''));
  return m ? m[1] : null;
};

/**
 * Every employee line in every pay-date section.
 * Returns { lines: [...], warnings: [...] } or { error }.
 */
function parseJournal(text) {
  const rows = parseCsv(text);
  if (!rows.length || !/payroll journal/i.test(rows[0][0] || '')) return { error: 'This is not a Gusto Payroll Journal report. In Gusto: Reports → Payroll Journal → export CSV.', code: 'GUSTO_NOT_JOURNAL' };
  const lines = [], warnings = [];
  let section = null, period = null, payDate = null, header = null, inPerPayDate = false;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const first = (r[0] || '').trim();
    if (first === 'Employee Earnings') { inPerPayDate = true; continue; }
    if (!inPerPayDate) continue;                       // the per-employee summary above is a total, not a pay date
    if (first === 'Pay period') {
      const [a, b] = String(r[1] || '').split('-').map(x => ymd(x));
      period = a && b ? { start: a, end: b } : null;
      header = null;
      if (!period) warnings.push(`Row ${i + 1}: a pay period that could not be read.`);
      section = (rows[i - 1] && (rows[i - 1][0] || '').trim()) || section;
      continue;
    }
    if (first === 'Pay day') { payDate = ymd(r[1]); header = null; continue; }
    if (first === 'Last Name') { header = r.map(h => h.trim()); continue; }
    // A section ends at its totals row; the next line is the next section's
    // label, not an employee.
    if (/^(payroll )?totals$/i.test(first)) { header = null; continue; }
    // A blank line also ends a section (a section with no one paid has no totals row).
    if (!first && r.length <= 1) { header = null; continue; }
    if (!header || !first) continue;
    if (!period || !payDate) { warnings.push(`Row ${i + 1}: a line with no pay period or pay day.`); continue; }
    const col = (name) => { const k = header.indexOf(name); return k === -1 || r[k] === undefined ? '' : String(r[k]); };
    if (REQUIRED_HEADERS.some(h => !header.includes(h))) return { error: `Row ${i + 1}: the report is missing a column Gusto normally exports.`, code: 'GUSTO_COLUMNS' };
    if (!col('Last Name').trim() || !col('First Name').trim()) { warnings.push(`Row ${i + 1}: a line with no name; skipped.`); continue; }
    const line = { lastName: col('Last Name').trim(), firstName: col('First Name').trim(), department: col('Department').trim(),
      workState: stateOf(col('Work Address')), payDate, periodStart: period.start, periodEnd: period.end, section,
      payment: col('Payment').trim(), employeeType: col('Employee Type').trim(), row: i + 1 };
    let bad = false;
    for (const [k, name] of Object.entries(MONEY_FIELDS)) {
      const v = k === 'hours' ? Number(String(col(name) || '0').replace(/,/g, '')) : toCents(col(name));
      if (v === null || (k === 'hours' && !Number.isFinite(v))) { bad = true; break; }
      line[k] = v;
    }
    if (bad) { warnings.push(`Row ${i + 1}: an amount that could not be read; the line was skipped.`); continue; }
    lines.push(line);
  }
  if (!lines.length) return { error: 'No pay-date lines were found. Export the Payroll Journal with "Employee Earnings" by pay date.', code: 'GUSTO_EMPTY' };
  return { lines, warnings };
}

/**
 * One entry per person per pay date and period. Gusto writes a correction as
 * a reversal plus a new line; they are summed, and a pay date that nets to
 * nothing is dropped.
 */
function netEntries(lines) {
  const by = new Map();
  for (const l of lines) {
    const key = [l.lastName.toLowerCase(), l.firstName.toLowerCase(), l.payDate, l.periodStart, l.periodEnd].join('|');
    const e = by.get(key) || { ...l, sections: [], payments: [] };
    if (by.has(key)) for (const k of Object.keys(MONEY_FIELDS)) e[k] += l[k];
    e.sections.push(l.section);
    if (l.payment && l.gross > 0) e.payments.push(l.payment);
    by.set(key, e);
  }
  const out = [];
  for (const e of by.values()) {
    if (Object.keys(MONEY_FIELDS).every(k => Math.abs(e[k]) < 0.005)) continue;
    e.hours = Math.round(e.hours * 100) / 100;
    e.payment = e.payments[e.payments.length - 1] || e.payment;
    out.push(e);
  }
  return out;
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
/** The one account a Gusto name belongs to, or why there is none. */
function matchUser(entry, users, profiles) {
  const want = norm(`${entry.firstName}${entry.lastName}`);
  const hits = (users || []).filter(u => {
    if (!u || u.accountStatus === 'inactive') return false;
    const p = (profiles || {})[String(u.id)];
    const legal = p && p.taxAddress ? norm(`${p.taxAddress.firstName}${p.taxAddress.lastName}`) : null;
    const parts = String(u.name || '').trim().split(/\s+/);
    const firstLast = parts.length > 1 ? norm(`${parts[0]}${parts[parts.length - 1]}`) : null;
    return [legal, norm(u.name), firstLast].includes(want);
  });
  if (hits.length === 1) return { user: hits[0] };
  return { reason: hits.length ? 'More than one account has this name.' : 'No account with this name.' };
}

const PAYMENT_METHOD = Object.freeze({ 'direct deposit': 'direct_deposit', check: 'check' });
const frequencyOf = (start, end) => {
  const days = Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86400000) + 1;
  return days === 7 ? { frequency: 'weekly', perYear: 52 } : days === 14 ? { frequency: 'biweekly', perYear: 26 } : { frequency: 'other', perYear: null };
};

/**
 * The paid runs for the matched people, plus what was not imported.
 *   refsFor(userId, period) → the app's own hour items in that period
 *   (time logs, visits) so a later app run never pays them a second time.
 */
function buildImport({ entries, users, profiles, refsFor, at, by }) {
  const matched = new Map(), unmatched = new Map(), runs = new Map(), warnings = [];
  for (const e of entries) {
    const m = matchUser(e, users, profiles);
    const name = `${e.firstName} ${e.lastName}`;
    if (!m.user) { unmatched.set(name, m.reason); continue; }
    const uid = String(m.user.id);
    // Gross less what was withheld, plus reimbursements, is what was paid.
    const taxes = { federal: e.federal, socialSecurity: e.socialSecurity, medicare: e.medicare + e.addlMedicare, georgia: e.georgia };
    const taxCents = Object.values(taxes).reduce((a, v) => a + v, 0);
    const reimbursementsCents = e.reimbursements + e.oneTimeReimbursement;
    if (e.gross - taxCents + reimbursementsCents !== e.net) warnings.push(`${name}, pay date ${e.payDate}: Gusto's net pay does not equal gross less taxes plus reimbursements. Imported as Gusto shows it.`);
    if (e.gross < 0 || e.net < 0) { warnings.push(`${name}, pay date ${e.payDate}: a negative pay date after corrections; not imported. Check it in Gusto.`); continue; }
    const id = `gusto:${e.payDate}:${e.periodStart}:${e.periodEnd}`;
    const fq = frequencyOf(e.periodStart, e.periodEnd);
    const run = runs.get(id) || { id, status: 'paid', source: 'gusto', period: { start: e.periodStart, end: e.periodEnd, payDate: e.payDate },
      frequency: fq.frequency, perYear: fq.perYear, workers: [], importedAt: at, importedBy: by, paidAt: at, payments: {} };
    run.workers.push({
      userId: uid, name: m.user.name || name, workerType: 'W2',
      payMethod: PAYMENT_METHOD[String(e.payment || '').toLowerCase()] || null,
      refs: refsFor ? refsFor(uid, { start: e.periodStart, end: e.periodEnd }) : [],
      earnings: [{ code: 'regular', label: 'Hours worked', minutes: Math.round(e.hours * 60), amountCents: e.gross }],
      missing: [],
      pay: {
        grossCents: e.gross, taxes, taxCents, reimbursementsCents, netCents: e.net,
        employer: { socialSecurity: e.erSocialSecurity, medicare: e.erMedicare, futa: e.futa, gaSuta: e.gaSuta + e.gaAdmin, gaAdmin: e.gaAdmin, txSuta: e.txSuta }
      },
      imported: { from: 'Gusto', department: e.department, workState: e.workState, payment: e.payment, historical: /historical/i.test(e.payment || '') }
    });
    run.payments[uid] = { confirmation: `Gusto ${e.payment || ''}`.trim(), at };
    runs.set(id, run);
    const mm = matched.get(uid) || { userId: uid, name: m.user.name || name, payDates: 0, grossCents: 0, workStates: new Set() };
    mm.payDates++; mm.grossCents += e.gross; if (e.workState) mm.workStates.add(e.workState);
    matched.set(uid, mm);
  }
  for (const r of runs.values()) r.workers.sort((a, b) => a.name.localeCompare(b.name));
  return {
    runs: [...runs.values()].sort((a, b) => a.period.payDate.localeCompare(b.period.payDate)),
    matched: [...matched.values()].map(m => ({ ...m, workStates: [...m.workStates] })).sort((a, b) => a.name.localeCompare(b.name)),
    unmatched: [...unmatched.entries()].map(([name, reason]) => ({ name, reason })).sort((a, b) => a.name.localeCompare(b.name)),
    warnings
  };
}

module.exports = { MONEY_FIELDS, parseCsv, parseJournal, netEntries, matchUser, buildImport, frequencyOf };
