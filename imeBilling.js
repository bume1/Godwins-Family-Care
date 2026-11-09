'use strict';
// ============================================================================
// imeBilling.js — billing the IME / C&P contracting entities (spec v2 §5).
//
// A FEE SCHEDULE PER ENTITY (LSGS, Leidos QTC, VES). Each is a list of exam
// types with a rate. VES's sheet is coming from the owner and LSGS is a
// placeholder until its rates are uploaded, so a schedule with no rates is a
// PLACEHOLDER: an exam for that entity waits, unbilled, rather than billing
// at a guessed price.
//
// AN EXAM BILLS ONCE. A case at `report_submitted` becomes one billable line
// at its entity's rate for the exam type the office picks. The line records
// the invoice it went on, and a case already on a live invoice is never
// offered again. Voiding an invoice frees its exams.
//
// EXAMINERS: a W-2 examiner is paid through payroll (payrollEngine, per exam).
// A 1099 examiner, or one set up as both (employee for clinical care,
// contractor for exams), is paid as a contractor: the office builds a payout
// invoice from their completed exams.
//
// PURE.
// ============================================================================
const ENTITIES = Object.freeze({ lsgs: 'LSGS', leidos_qtc: 'Leidos QTC', ves: 'VES' });
const STATUSES = Object.freeze(['draft', 'sent', 'paid', 'void']);

const str = (v, n = 200) => (v === null || v === undefined ? '' : String(v)).trim().slice(0, n);
const toCents = (v) => { const n = Number(String(v === undefined || v === null ? '' : v).replace(/[$,\s]/g, '')); return Number.isFinite(n) && n > 0 && n < 1000000 ? Math.round(n * 100) : null; };

function normalizeSchedule(entity, b) {
  if (!ENTITIES[entity]) return { error: 'Unknown contracting entity.', code: 'IME_ENTITY' };
  const rates = [];
  const seen = new Set();
  for (const [i, r] of (Array.isArray(b && b.rates) ? b.rates : []).entries()) {
    const label = str(r && r.label, 160);
    const code = str(r && r.code, 40) || label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
    const cents = toCents(r && r.rate);
    if (!label) return { error: `Rate ${i + 1}: name the exam type.`, code: 'IME_RATE_LABEL' };
    if (cents === null) return { error: `Rate ${i + 1}: give a dollar amount.`, code: 'IME_RATE_AMOUNT' };
    if (seen.has(code)) return { error: `Rate ${i + 1}: "${label}" is listed twice.`, code: 'IME_RATE_DUPLICATE' };
    seen.add(code);
    rates.push({ code, label, rateCents: cents });
  }
  return { value: { entity, rates, placeholder: rates.length === 0, note: str(b && b.note, 500) } };
}

/**
 * The exams waiting to be billed: report submitted, not on a live invoice.
 * Each says whether its entity has rates yet.
 */
function unbilled(cases, invoices, schedules) {
  const billed = new Set();
  for (const inv of invoices || []) if (inv && inv.status !== 'void') for (const l of inv.lines || []) billed.add(String(l.caseId));
  return (cases || []).filter(c => c && c.status === 'report_submitted' && !billed.has(String(c.id))).map(c => {
    const s = (schedules || {})[c.contractingEntity];
    return {
      caseId: String(c.id), entity: c.contractingEntity, entityLabel: ENTITIES[c.contractingEntity] || c.contractingEntity,
      referenceId: c.referenceId || null, examDate: c.examDate || null, reportSubmittedAt: c.reportSubmittedAt || null,
      examinerId: c.examinerId || null,
      ratesReady: !!(s && s.rates && s.rates.length), rates: s ? s.rates : []
    };
  }).sort((a, b) => String(a.reportSubmittedAt).localeCompare(String(b.reportSubmittedAt)));
}

/**
 * One invoice to one entity from the picked exams. `picks` = [{ caseId, code }].
 */
function buildInvoice({ entity, picks, cases, invoices, schedules, period }) {
  if (!ENTITIES[entity]) return { error: 'Unknown contracting entity.', code: 'IME_ENTITY' };
  const s = (schedules || {})[entity];
  if (!s || !s.rates || !s.rates.length) return { error: `${ENTITIES[entity]} has no fee schedule yet. Enter its rates first.`, code: 'IME_NO_SCHEDULE' };
  const open = new Map(unbilled(cases, invoices, schedules).map(u => [u.caseId, u]));
  const lines = [];
  for (const p of picks || []) {
    const u = open.get(String(p && p.caseId));
    if (!u) return { error: 'An exam picked is not waiting to be billed (already billed, or the report is not in).', code: 'IME_NOT_BILLABLE' };
    if (u.entity !== entity) return { error: `Exam ${u.referenceId || u.caseId} belongs to ${u.entityLabel}, not ${ENTITIES[entity]}.`, code: 'IME_WRONG_ENTITY' };
    const rate = s.rates.find(r => r.code === p.code);
    if (!rate) return { error: `Pick the exam type for ${u.referenceId || u.caseId}.`, code: 'IME_NO_RATE' };
    lines.push({ caseId: u.caseId, referenceId: u.referenceId, examDate: u.examDate, code: rate.code, label: rate.label, amountCents: rate.rateCents });
  }
  if (!lines.length) return { error: 'Pick at least one exam.', code: 'IME_NO_LINES' };
  return { value: { entity, entityLabel: ENTITIES[entity], period: period || null, lines, totalCents: lines.reduce((a, l) => a + l.amountCents, 0) } };
}

function invoiceNumber(entity, ymd, taken) {
  const base = `GFC-IME-${({ lsgs: 'LSGS', leidos_qtc: 'QTC', ves: 'VES' })[entity]}-${ymd.slice(2, 4)}${ymd.slice(5, 7)}${ymd.slice(8, 10)}`;
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  throw new Error('no free number');
}

function transition(inv, to, { at, by, reason, reference }) {
  if (!inv) return { error: 'Invoice not found.', code: 'IME_INVOICE_NOT_FOUND' };
  if (inv.status === 'paid' || inv.status === 'void') return { error: `This invoice is already ${inv.status}.`, code: 'IME_INVOICE_FINAL' };
  if (to === 'sent') { if (inv.status !== 'draft') return { error: 'Only a draft can be sent.', code: 'IME_NOT_DRAFT' }; return { inv: { ...inv, status: 'sent', sentAt: at, sentBy: by } }; }
  if (to === 'paid') {
    if (inv.status !== 'sent') return { error: 'Mark it sent first.', code: 'IME_NOT_SENT' };
    const ref = str(reference, 120);
    if (!ref) return { error: 'Give the payment reference (check or remittance number).', code: 'IME_PAYMENT_REFERENCE' };
    return { inv: { ...inv, status: 'paid', paidAt: at, paidBy: by, paymentReference: ref } };
  }
  if (to === 'void') { const r = str(reason, 500); if (!r) return { error: 'Give a reason for voiding it.', code: 'IME_VOID_REASON' }; return { inv: { ...inv, status: 'void', voidedAt: at, voidedBy: by, voidReason: r } }; }
  return { error: 'Unknown action.', code: 'IME_BAD_ACTION' };
}

// A 1099 examiner's completed exams not yet on a payout invoice.
function examinerPayoutLines({ cases, examinerId, perExamRateCents, paidCaseIds, from, to, localDate }) {
  return (cases || []).filter(c => c && c.status === 'report_submitted' && String(c.examinerId) === String(examinerId) && !paidCaseIds.has(String(c.id)))
    .filter(c => { const d = localDate(c.reportSubmittedAt); return d && d >= from && d <= to; })
    .map(c => ({ serviceDate: localDate(c.reportSubmittedAt), description: `IME exam${c.referenceId ? ` ${c.referenceId}` : ''}`, clientId: null, unit: 'exam', qty: 1, rateCents: perExamRateCents, amountCents: perExamRateCents, imeCaseId: String(c.id) }));
}

module.exports = { ENTITIES, STATUSES, normalizeSchedule, unbilled, buildInvoice, invoiceNumber, transition, examinerPayoutLines };
