// ============================================================================
// patientBilling.js — patient statements and Stripe payment (owner,
// 2026-10-12: "bill copays and then home care hour payments, so both").
// Pure rules only; the routes live in server.js.
//
// TWO KINDS OF STATEMENT
//   copay      A FIXED dollar amount the office sets per patient (the plan's
//              stated copay, e.g. some Medicare Advantage plans). Created when
//              billing submits a signed visit. The app NEVER works a copay out
//              from a charge: for Medicare the patient's share is 20% of the
//              allowed amount and only the insurer's payment report knows it
//              (GFC_Billing_Segment_App_Integration_Spec.md §6). No fixed
//              copay set means nothing is collected at the visit.
//   home_care  Completed, clocked caregiver visits in a date range × the
//              client's agreed hourly rate, with the agreed daily minimum
//              applied per day. Created as a DRAFT for staff to check.
//
// STRIPE NEVER SEES PHI. Being a patient of a care provider is itself health
// information, so Stripe gets the invoice number, an amount in cents and our
// own internal invoice id, and nothing else: no name, no email from us, no
// dates of service, no description of care. `stripeSafe()` is the one door
// every payload passes through and it refuses anything else (build-enforced).
// ============================================================================
const crypto = require('crypto');

const KINDS = Object.freeze(['copay', 'home_care']);
const STATUSES = Object.freeze(['draft', 'open', 'paid', 'void']);
// What a line says on the patient's own statement. Neutral on purpose.
const LINE_LABEL = Object.freeze({ copay: 'Visit copay', home_care: 'Home care services' });
// No 0/O, 1/I/L, 2/Z, 5/S, 8/B: read off paper and typed back in.
const REF_ALPHABET = '34679ACDEFGHJKMNPQRTUVWXY';
const MAX_CENTS = 5000000; // $50,000: a sanity ceiling, not a policy

const toCents = (dollars) => {
  const n = Number(String(dollars == null ? '' : dollars).replace(/[$,\s]/g, ''));
  if (!isFinite(n) || n < 0) return null;
  const c = Math.round(n * 100);
  return c <= MAX_CENTS ? c : null;
};
const fmtUsd = (cents) => `$${(Number(cents || 0) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

function invoiceNumber(rand = crypto.randomBytes(8)) {
  let s = '';
  for (let i = 0; i < 6; i++) s += REF_ALPHABET[rand[i] % REF_ALPHABET.length];
  return `GFC-INV-${s}`;
}

// The office's billing settings for one client: a fixed copay or none.
function normalizeCopaySetting(body) {
  const b = body || {};
  if (b.copay === null || b.copay === '' || b.copay === undefined || b.copay === 0 || b.copay === '0') return { value: { copayCents: null } };
  const c = toCents(b.copay);
  if (c == null || c === 0) return { error: 'Enter the copay as a dollar amount, or leave it blank for none.', code: 'BILLING_COPAY_INVALID' };
  return { value: { copayCents: c } };
}

/**
 * Home care lines from completed time logs. One line per day in Georgia:
 * the day's clocked hours, raised to the daily minimum when below it.
 * `localDate(iso)` gives Georgia's YYYY-MM-DD (injected; gfc-time in the app).
 */
function homeCareLines(timeLogs, { clientId, from, to, hourlyRate, dailyMinimumHours, localDate }) {
  const rateCents = toCents(hourlyRate);
  if (!rateCents) return { error: 'This client has no agreed hourly rate on file. Set it on their Rate card first.', code: 'BILLING_NO_RATE' };
  const minHours = Number(dailyMinimumHours) > 0 ? Number(dailyMinimumHours) : 0;
  const byDay = new Map();
  for (const l of timeLogs || []) {
    if (!l || String(l.client_id) !== String(clientId) || !l.clock_out_at || !(l.total_minutes > 0)) continue;
    const d = localDate(l.clock_in_at);
    if (!d || d < from || d > to) continue;
    byDay.set(d, (byDay.get(d) || 0) + Number(l.total_minutes));
  }
  const lines = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, mins]) => {
    const actual = Math.round((mins / 60) * 100) / 100;
    const hours = Math.max(actual, minHours);
    return {
      date, description: LINE_LABEL.home_care,
      hours, actualHours: actual, minimumApplied: hours > actual,
      rateCents, amountCents: Math.round(hours * rateCents)
    };
  });
  return { lines };
}

function buildInvoice({ id, number, clientId, kind, lines, at, by, status, encounterUuid }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown invoice kind ${kind}`);
  const totalCents = lines.reduce((a, l) => a + (Number(l.amountCents) || 0), 0);
  return {
    id, number, clientId, kind, lines, totalCents,
    status: status || 'draft',
    encounterUuid: encounterUuid || null,
    createdAt: at, createdBy: by ? { id: by.id, name: by.name || null } : null,
    sentAt: status === 'open' ? at : null,
    payments: []
  };
}

// Status moves, one place. Paid and void are final.
function transition(inv, to, { at, by, reason, method, reference } = {}) {
  if (!inv) return { error: 'Invoice not found.', code: 'INVOICE_NOT_FOUND' };
  const who = by ? { id: by.id, name: by.name || null } : null;
  if (inv.status === 'paid' || inv.status === 'void') return { error: `This invoice is already ${inv.status}.`, code: 'INVOICE_FINAL' };
  if (to === 'open') {
    if (inv.status !== 'draft') return { error: 'Only a draft can be sent.', code: 'INVOICE_NOT_DRAFT' };
    if (!(inv.totalCents > 0)) return { error: 'This invoice has nothing to charge.', code: 'INVOICE_EMPTY' };
    return { inv: { ...inv, status: 'open', sentAt: at, sentBy: who } };
  }
  if (to === 'void') {
    const r = String(reason || '').trim().slice(0, 500);
    if (!r) return { error: 'Give a reason for voiding it.', code: 'INVOICE_VOID_REASON_REQUIRED' };
    return { inv: { ...inv, status: 'void', voidedAt: at, voidedBy: who, voidReason: r } };
  }
  if (to === 'paid') {
    if (inv.status !== 'open') return { error: 'Only a sent invoice can be paid.', code: 'INVOICE_NOT_OPEN' };
    const m = ['stripe', 'check', 'cash', 'other'].includes(method) ? method : null;
    if (!m) return { error: 'Say how it was paid.', code: 'INVOICE_PAYMENT_METHOD' };
    const payment = { at, method: m, amountCents: inv.totalCents, reference: reference ? String(reference).slice(0, 120) : null, recordedBy: who };
    return { inv: { ...inv, status: 'paid', paidAt: at, payments: [...(inv.payments || []), payment] } };
  }
  return { error: 'Unknown status.', code: 'INVOICE_BAD_STATUS' };
}

// What the patient's screen is given: their statement, never who on staff did what.
function publicInvoice(inv) {
  return {
    id: inv.id, number: inv.number, kind: inv.kind, status: inv.status,
    totalCents: inv.totalCents, total: fmtUsd(inv.totalCents),
    lines: (inv.lines || []).map(l => ({ date: l.date, description: l.description, hours: l.hours != null ? l.hours : null, minimumApplied: !!l.minimumApplied, amount: fmtUsd(l.amountCents) })),
    sentAt: inv.sentAt || null, paidAt: inv.paidAt || null,
    paidBy: inv.status === 'paid' && inv.payments && inv.payments.length ? inv.payments[inv.payments.length - 1].method : null
  };
}

// ---- Stripe: the only door ------------------------------------------------
const STRIPE_SAFE_KEYS = Object.freeze(['mode', 'line_items[0][price_data][currency]', 'line_items[0][price_data][unit_amount]',
  'line_items[0][price_data][product_data][name]', 'line_items[0][quantity]', 'success_url', 'cancel_url',
  'client_reference_id', 'metadata[invoice_id]', 'payment_intent_data[description]', 'payment_intent_data[metadata][invoice_id]', 'submit_type']);
const SAFE_NAME = /^Godwins Family Care · Invoice GFC-INV-[3-9A-Y]{6}$/;
const UUIDISH = /^[0-9a-f-]{8,64}$/i;

// Build the Checkout Session form for one invoice. Everything Stripe sees.
function checkoutForm(inv, { successUrl, cancelUrl }) {
  const name = `Godwins Family Care · Invoice ${inv.number}`;
  return stripeSafe({
    mode: 'payment',
    submit_type: 'pay',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(inv.totalCents),
    'line_items[0][price_data][product_data][name]': name,
    'line_items[0][quantity]': '1',
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: inv.id,
    'metadata[invoice_id]': inv.id,
    'payment_intent_data[description]': name,
    'payment_intent_data[metadata][invoice_id]': inv.id
  });
}

// Refuses any field outside the allow-list, any name that is not the neutral
// invoice line, any id that is not one of ours, and any URL that is not our
// own billing page. A payload that fails this is never sent.
function stripeSafe(form) {
  for (const [k, v] of Object.entries(form)) {
    if (!STRIPE_SAFE_KEYS.includes(k)) throw new Error(`stripeSafe: field ${k} is not allowed to reach Stripe`);
    const s = String(v);
    if (/product_data\]\[name\]$|\[description\]$/.test(k) && !SAFE_NAME.test(s)) throw new Error(`stripeSafe: ${k} must be the neutral invoice line`);
    if (/invoice_id\]$|^client_reference_id$/.test(k) && !UUIDISH.test(s)) throw new Error(`stripeSafe: ${k} must be an internal id`);
    if (/_url$/.test(k) && !/^https?:\/\/[^\s?#]+\/portal(\/[a-z0-9-]+)?\?billing=(paid|cancelled)$/.test(s)) throw new Error(`stripeSafe: ${k} must be the portal billing page`);
    if (/unit_amount\]$/.test(k) && !/^\d{1,9}$/.test(s)) throw new Error('stripeSafe: amount must be whole cents');
  }
  return form;
}

// Stripe signs each webhook: "t=<ts>,v1=<hex hmac of `${t}.${rawBody}`>".
function verifyStripeSignature(rawBody, header, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!secret || !header || !rawBody) return false;
  const parts = Object.fromEntries(String(header).split(',').map(p => p.split('=')).filter(p => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const t = Number(parts.t);
  const sigs = String(header).split(',').filter(p => p.trim().startsWith('v1=')).map(p => p.trim().slice(3));
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody}`).digest('hex');
  return sigs.some(s => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

function stripeStatus() {
  const key = String(process.env.STRIPE_SECRET_KEY || '').trim();
  const hook = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  const blockers = [];
  if (!/^(sk|rk)_(test|live)_/.test(key)) blockers.push('STRIPE_SECRET_KEY is not set');
  if (!/^whsec_/.test(hook)) blockers.push('STRIPE_WEBHOOK_SECRET is not set');
  return { configured: !blockers.length, live: /_live_/.test(key), blockers };
}

module.exports = {
  KINDS, STATUSES, LINE_LABEL, toCents, fmtUsd, invoiceNumber, normalizeCopaySetting, homeCareLines,
  buildInvoice, transition, publicInvoice, checkoutForm, stripeSafe, verifyStripeSignature, stripeStatus, STRIPE_SAFE_KEYS
};
