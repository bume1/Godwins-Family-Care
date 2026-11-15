'use strict';
// ============================================================================
// invoiceRuns.js — the invoice run, the billing side of a payroll run
// (owner, 2026-11-15)
//
// An invoice run takes one period's hours and makes that period's invoices,
// the way a payroll run takes the hours and makes pay. It is a DRAFT until it
// is approved: the office can change a shift's billed hours (with a reason),
// leave a shift off, and add lines by hand, then approve. Approving makes the
// invoices; sending emails them.
//
// WHICH HOURS. A shift is billed once its caregiver's timesheet for that pay
// period is approved (payrollTimesheets.js), or once payroll has paid it.
// Approval is tied to the minutes as they were: a time log corrected after
// approval is "not approved" again until someone approves it again. Shifts
// still waiting are listed in the run, never billed quietly; the office can
// include them anyway, with a reason. Hours read from a file the office
// uploads are the office's own figures and count as approved.
//
// PURE. The routes in server.js gather the facts and store the run.
// ============================================================================

const NOTE_MAX = 300;
const DESC_MAX = 160;
const MAX_LINE_CENTS = 10000000;   // $100,000: a typo guard, not a policy

const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// ---- Which hours are approved ----------------------------------------------
/**
 * sheets: payroll_timesheets rows. payrollRuns: payroll_runs rows.
 * A sheet approved since 2026-11-15 carries the hour items it approved
 * (office.hours: [{ ref: 'log:<id>', minutes }]). One approved before then
 * carries only its fingerprint, so its whole period counts for that person.
 */
function approvalIndex(sheets, payrollRuns) {
  const logs = new Map();
  const legacy = [];
  for (const s of sheets || []) {
    const o = s && s.office;
    if (!o || o.status !== 'approved') continue;
    if (Array.isArray(o.hours)) {
      for (const h of o.hours) {
        const m = /^log:(.+)$/.exec(String(h && h.ref));
        if (m) logs.set(m[1], Number(h.minutes) || 0);
      }
    } else if (s.userId && isYmd(s.periodStart)) {
      legacy.push({ userId: String(s.userId), from: s.periodStart, to: isYmd(s.periodEnd) ? s.periodEnd : s.periodStart });
    }
  }
  const paid = new Set();
  for (const r of payrollRuns || []) {
    if (!r || r.status === 'draft' || r.status === 'void') continue;
    for (const w of r.workers || []) for (const ref of w.refs || []) {
      const m = /^log:(.+)$/.exec(String(ref));
      if (m) paid.add(m[1]);
    }
  }
  return { logs, legacy, paid };
}

/**
 * 'paid'      payroll paid this shift
 * 'approved'  its timesheet approved these exact minutes
 * 'approved'  (an older approval) its caregiver's period was approved
 * 'changed'   approved, but the minutes changed since
 * 'waiting'   not approved yet
 * 'file'      read from an uploaded hours file
 */
function approvalOf(row, index) {
  if (!row.timeLogId) return 'file';
  const id = String(row.timeLogId);
  if (index.paid.has(id)) return 'paid';
  if (index.logs.has(id)) return index.logs.get(id) === Number(row.minutes) ? 'approved' : 'changed';
  if (index.legacy.some(l => l.userId === String(row.caregiverId) && row.serviceDate >= l.from && row.serviceDate <= l.to)) return 'approved';
  return 'waiting';
}
const isBillable = (state) => state === 'paid' || state === 'approved' || state === 'file';

// ---- Office changes inside a run --------------------------------------------
// "4.5", "4:30" or "4h 30m" -> minutes. Null when it is not a length.
function minutesFrom(v) {
  const s = str(v).toLowerCase();
  if (!s) return null;
  let m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) return Number(m[2]) > 59 ? null : Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d{1,2})\s*h(?:rs?|ours?)?\s*(?:(\d{1,2})\s*m(?:in)?)?$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2] || 0);
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 60);
  return null;
}

/** A shift's billed hours changed, or the shift left off. Always with a reason. */
function normalizeEdit(body, rowKeys) {
  const b = body || {};
  const sourceKey = str(b.sourceKey);
  if (!sourceKey || (rowKeys && !rowKeys.has(sourceKey))) return { error: 'That shift is not in this run.', code: 'RUN_SHIFT_UNKNOWN' };
  if (b.clear === true) return { value: { sourceKey, clear: true } };
  const reason = str(b.reason).slice(0, NOTE_MAX);
  if (!reason) return { error: 'Say why, so the change can be explained later.', code: 'RUN_REASON_REQUIRED' };
  if (b.remove === true) return { value: { sourceKey, remove: true, reason } };
  const minutes = minutesFrom(b.hours);
  if (!(minutes > 0)) return { error: 'Give the hours to bill, like 4.5 or 4:30.', code: 'RUN_HOURS_INVALID' };
  if (minutes > 24 * 60) return { error: 'A shift cannot bill more than 24 hours.', code: 'RUN_HOURS_INVALID' };
  return { value: { sourceKey, minutes, reason } };
}

/**
 * A line added by hand: hours at the client's agreed rate, or a fixed amount.
 * A fixed amount may be negative (a credit). Its date sits inside the run.
 */
function normalizeAdjustment(body, { clientIds, from, to }) {
  const b = body || {};
  const clientId = str(b.clientId);
  if (!clientId || (clientIds && !clientIds.has(clientId))) return { error: 'Choose the client.', code: 'RUN_CLIENT_REQUIRED' };
  const date = str(b.date);
  if (!isYmd(date)) return { error: 'Give the date of service.', code: 'RUN_DATE_REQUIRED' };
  if (date < from || date > to) return { error: `The date must fall in this run, ${from} to ${to}.`, code: 'RUN_DATE_OUTSIDE' };
  const description = str(b.description).slice(0, DESC_MAX);
  if (!description) return { error: 'Say what the line is for. The carrier or family reads it.', code: 'RUN_DESCRIPTION_REQUIRED' };
  const reason = str(b.reason).slice(0, NOTE_MAX);
  if (!reason) return { error: 'Say why it is added, for the office record.', code: 'RUN_REASON_REQUIRED' };
  if (b.kind === 'amount') {
    const cents = Math.round(Number(str(b.amount).replace(/[$,\s]/g, '')) * 100);
    if (!Number.isFinite(cents) || cents === 0 || Math.abs(cents) > MAX_LINE_CENTS) return { error: 'Give the amount, like 120.00 (or -40.00 for a credit).', code: 'RUN_AMOUNT_INVALID' };
    return { value: { clientId, date, description, amountCents: cents, reason } };
  }
  if (b.kind === 'hours') {
    const minutes = minutesFrom(b.hours);
    if (!(minutes > 0) || minutes > 24 * 60) return { error: 'Give the hours, like 2 or 1:30.', code: 'RUN_HOURS_INVALID' };
    return { value: { clientId, date, description, minutes, reason } };
  }
  return { error: 'Choose hours at the client\'s rate, or a fixed amount.', code: 'RUN_LINE_KIND' };
}

/** The hour rows as billed: edits applied, removed shifts left out. */
function applyEdits(rows, edits) {
  const byKey = new Map((edits || []).map(e => [e.sourceKey, e]));
  const out = [];
  for (const r of rows || []) {
    const e = byKey.get(r.sourceKey);
    if (e && e.remove) continue;
    if (e && e.minutes) out.push({ ...r, minutes: e.minutes, editedFrom: r.minutes });
    else out.push(r);
  }
  return out;
}

// The edit list after one change: one entry per shift, the latest wins.
function withEdit(edits, value, meta) {
  const rest = (edits || []).filter(e => e.sourceKey !== value.sourceKey);
  return value.clear ? rest : [...rest, { ...value, ...meta }];
}

// ---- Sending -----------------------------------------------------------------
// Who an approved run's invoices go to, one entry per client. A carrier gets
// its invoices by email at its claims address; a family gets the PDF at the
// Bill To email, and the client and their POA get the usual "new statement"
// notice (no amount). A carrier with no claims email cannot be emailed.
function sendPlan(invoicesByClient) {
  const plan = [];
  for (const [clientId, invs] of invoicesByClient) {
    const live = invs.filter(i => i && i.status !== 'void');
    if (!live.length) continue;
    const bt = live[0].billTo || {};
    const draft = live.filter(i => i.status === 'draft');
    const entry = { clientId, clientName: live[0].clientName || '', format: live[0].format, billTo: bt.name || '',
      invoiceIds: live.map(i => i.id), draftIds: draft.map(i => i.id), toEmail: bt.email || '', sent: !draft.length };
    if (!entry.sent && live[0].format === 'carrier' && !bt.email) entry.blocked = `${bt.name || 'The carrier'} has no claims email. Add it under Settings, or download the PDF, send it yourself and use Mark Sent.`;
    plan.push(entry);
  }
  return plan.sort((a, b) => a.clientName.localeCompare(b.clientName));
}

// "GFC_Invoices-Jane_Smith_2026-11-02_to_2026-11-15.pdf"
function combinedFileName(clientName, from, to) {
  const n = str(clientName).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Client';
  return `GFC_Invoices-${n}_${from}_to_${to}.pdf`;
}

module.exports = {
  NOTE_MAX, approvalIndex, approvalOf, isBillable, minutesFrom,
  normalizeEdit, normalizeAdjustment, applyEdits, withEdit, sendPlan, combinedFileName
};
