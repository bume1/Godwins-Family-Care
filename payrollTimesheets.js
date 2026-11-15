'use strict';
// ============================================================================
// payrollTimesheets.js — approving hours before payroll (owner, 2026-11-13)
//
// For each pay period, each employee's hours are a TIMESHEET:
//   - the employee may confirm them ("Looks right") or flag them ("Something
//     is wrong", with a note). Optional: the office can approve without it.
//   - the Super Admin approves them, or sends them back with a note saying
//     what to correct. Only the Super Admin decides (owner answer).
//
// An approval is tied to the hours AS THEY WERE (a fingerprint of every hour
// item and its length). If a time log is corrected afterwards, the approval no
// longer matches and the timesheet reads "changed since approved", so nobody
// approves one set of hours and pays another.
//
// Unapproved hours never hold pay back: hours actually worked are paid on the
// regular payday (FLSA). Approving a payroll with unapproved timesheets asks
// the Super Admin for a reason, which is kept on the run (owner answer:
// "warn; you decide").
//
// PURE. The routes gather the rows and store the results.
// ============================================================================
const crypto = require('crypto');

const EMPLOYEE_STATUSES = Object.freeze(['confirmed', 'flagged']);
const OFFICE_DECISIONS = Object.freeze(['approved', 'sent_back']);
const NOTE_MAX = 600;

const sheetId = (schedule, periodStart, userId) => `${schedule}:${periodStart}:${userId}`;

// What payroll would pay for this person's period, by item. Order-independent.
function fingerprint(items) {
  const parts = (items || []).map(it => `${it.ref}|${it.minutes || 0}|${it.count || 0}`).sort();
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 24);
}

function totals(items) {
  let minutes = 0, visits = 0, exams = 0;
  for (const it of items || []) {
    if (it.kind === 'hours') minutes += Number(it.minutes) || 0;
    if (it.kind === 'visit') visits += Number(it.count) || 0;
    if (it.kind === 'exam') exams += Number(it.count) || 0;
  }
  return { minutes, visits, exams };
}

// The person-facing rows: one per item, by day.
function lines(items) {
  return (items || []).map(it => ({ ref: it.ref, date: it.date, source: it.source, kind: it.kind, minutes: it.minutes || null, count: it.count || null }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.ref).localeCompare(String(b.ref)));
}

// Where a timesheet stands, given the hours as they are now.
//   office: 'approved' | 'changed' (approved, but the hours moved since) |
//           'sent_back' | 'waiting'
//   employee: 'confirmed' | 'flagged' | 'changed' (confirmed other hours) | 'not_yet'
function statusOf(sheet, currentPrint) {
  const o = sheet && sheet.office, e = sheet && sheet.employee;
  let office = 'waiting';
  if (o && o.status === 'approved') office = o.fingerprint === currentPrint ? 'approved' : 'changed';
  else if (o && o.status === 'sent_back') office = 'sent_back';
  let employee = 'not_yet';
  if (e && e.status === 'flagged') employee = 'flagged';
  else if (e && e.status === 'confirmed') employee = e.fingerprint === currentPrint ? 'confirmed' : 'changed';
  return { office, employee, approved: office === 'approved' };
}

function normalizeEmployee(b) {
  b = b || {};
  if (!EMPLOYEE_STATUSES.includes(b.status)) return { error: 'Choose Looks Right or Something Is Wrong.', code: 'TIMESHEET_STATUS' };
  const note = String(b.note || '').trim().slice(0, NOTE_MAX);
  if (b.status === 'flagged' && !note) return { error: 'Say what is wrong, so the office can fix it.', code: 'TIMESHEET_NOTE_REQUIRED' };
  return { value: { status: b.status, note: note || null } };
}

function normalizeOffice(b) {
  b = b || {};
  const decision = b.decision === 'approve' ? 'approved' : b.decision === 'send_back' ? 'sent_back' : null;
  if (!decision) return { error: 'Approve or send back.', code: 'TIMESHEET_DECISION' };
  const note = String(b.note || '').trim().slice(0, NOTE_MAX);
  if (decision === 'sent_back' && !note) return { error: 'Say what needs correcting, so they know what to fix.', code: 'TIMESHEET_NOTE_REQUIRED' };
  return { value: { status: decision, note: note || null } };
}

// Apply a change to a stored sheet (or a new one), keeping the history.
function record(sheet, base, part, value, { at, by, byId, print }) {
  const s = sheet ? { ...sheet } : { ...base, history: [] };
  s[part] = { ...value, fingerprint: print, at, by, byId };
  s.history = [...(s.history || []), { part, ...value, fingerprint: print, at, by, byId }];
  // A new employee answer after a send-back re-opens the office decision.
  if (part === 'employee' && s.office && s.office.status === 'sent_back') s.office = { ...s.office, answeredAt: at };
  return s;
}

// The people in a run whose timesheet is not approved for the hours being paid.
function unapproved(workers, sheets, printsByUser) {
  const byUser = new Map((sheets || []).map(s => [String(s.userId), s]));
  return (workers || []).filter(w => !statusOf(byUser.get(String(w.userId)), printsByUser.get(String(w.userId))).approved)
    .map(w => ({ userId: w.userId, name: w.name, status: statusOf(byUser.get(String(w.userId)), printsByUser.get(String(w.userId))) }));
}

module.exports = { EMPLOYEE_STATUSES, OFFICE_DECISIONS, sheetId, fingerprint, totals, lines, statusOf, normalizeEmployee, normalizeOffice, record, unapproved };
