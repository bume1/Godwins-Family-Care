// ============================================================================
// userFinancialFields.js — the fields on a user record that move money.
//
// Owner instruction, 2026-11-03: a manager or care coordinator may change
// anything about a person except what affects money. A money change goes to
// the Super Admin as a request (user_financial_change_requests), and nothing
// applies it until they approve.
//
// WHAT IS ON A USER RECORD TODAY, found by searching the codebase rather than
// guessed (grep for rate / pay / bill / copay / mileage / overtime / bonus /
// stipend / wage / salary on user records, 2026-11-03):
//
//   payRate          caregiver's base hourly pay (caregiverRepository
//                    normalizePayRate). Feeds the payroll export.
//   clientPayRates   caregiver's per-client hourly pay, keyed by client id.
//                    Feeds the payroll export.
//   rateAgreement    the client's billed hourly rate and daily minimum.
//                    Feeds home care invoicing and prints on two consents.
//   billingSettings  the client's fixed copay (patientBilling.js). Written
//                    only by the billing route today, listed so a user-route
//                    write of it is held like the others.
//
// There is NO overtime, mileage, reimbursement, bonus or stipend field in the
// codebase today. When one is added, it goes on this list in the same change.
// ============================================================================

const FINANCIAL_FIELDS = Object.freeze(['payRate', 'clientPayRates', 'rateAgreement', 'billingSettings']);

const LABELS = Object.freeze({
  payRate: 'Base pay rate',
  clientPayRates: 'Per-client pay rates',
  rateAgreement: 'Client billed rate',
  billingSettings: 'Copay'
});

const isFinancialField = (name) => FINANCIAL_FIELDS.includes(String(name || ''));

// Split a request body: the financial keys that were sent, and the body with
// them removed. A key sent as `undefined` was not sent.
function splitFinancial(body) {
  const rest = { ...(body || {}) };
  const held = {};
  for (const f of FINANCIAL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(rest, f)) {
      if (rest[f] !== undefined) held[f] = rest[f];
      delete rest[f];
    }
  }
  return { held, rest };
}

module.exports = { FINANCIAL_FIELDS, LABELS, isFinancialField, splitFinancial };
