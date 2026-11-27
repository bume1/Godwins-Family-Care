// ============================================================================
// FINANCE COPY ON PAYROLL AND BILLING MAIL (owner, 2026-11-27)
// ============================================================================
// "The finance email should always be cc'd for outgoing payroll and billing
// communications in the app", and replies go to finance too. One list, read
// by the notification drain and by the two direct billing sends, so a new
// payroll or billing notice is copied by adding its type here, not by every
// caller remembering.
//
// Deliberately NOT here: shift and time-clock notices (time_adjustment_*,
// staff_clock_open, shift_*). They are scheduling, even though hours feed pay.
// ============================================================================

const config = require('./config');

const FINANCE_TYPES = Object.freeze(new Set([
  // Payroll: employees and contractors
  'paystub_ready', 'timesheet_sent_back', 'tax_form_ready', 'tax_form_reminder', 'tax_form_consent_withdrawn',
  'contractor_invoice_paid', 'contractor_invoice_rejected',
  // Payroll: reminders to whoever runs payroll
  'timesheet_flagged', 'payroll_period_close', 'payroll_payment_reminder', 'payroll_tax_reminder',
  'payroll_tax_source_changed', 'tax_forms_not_released', 'tax_forms_unmailed', 'tax_forms_build_blocked',
  'tax_forms_ready_for_review',
  // Pay and rate changes
  'financial_change_requested', 'financial_change_decided',
  // Client billing
  'payment_received'
]));

const isFinanceType = (type) => FINANCE_TYPES.has(String(type || ''));

// The options a finance email carries: finance copied and set as Reply-To.
const financeOptions = () => {
  const e = config.ORG_FINANCE_EMAIL;
  return e ? { cc: [e], replyTo: e } : {};
};

module.exports = { FINANCE_TYPES, isFinanceType, financeOptions };
