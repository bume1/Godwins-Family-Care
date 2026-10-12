// Patient billing (owner, 2026-10-12): copays and home care hours, paid on Stripe.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const B = require('../patientBilling');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const inv = (o) => Object.assign({ id: '3f2a9c1e-0000-4000-8000-000000000001', number: 'GFC-INV-AC34KM', totalCents: 2500, status: 'open' }, o || {});
const URLS = { successUrl: 'https://app.godwinsfamilycarellc.com/portal?billing=paid', cancelUrl: 'https://app.godwinsfamilycarellc.com/portal?billing=cancelled' };

test('STRIPE NEVER SEES PHI: the checkout carries an invoice number, an amount and our id, and nothing else', () => {
  const f = B.checkoutForm(inv(), URLS);
  assert.equal(f['line_items[0][price_data][product_data][name]'], 'Godwins Family Care · Invoice GFC-INV-AC34KM');
  assert.equal(f['line_items[0][price_data][unit_amount]'], '2500');
  const all = JSON.stringify(f);
  for (const leak of ['Juanita', 'copay', 'home care', 'Home care', 'visit', 'I10', '99349', 'Medicare', '@']) assert.ok(!all.includes(leak), `"${leak}" must not reach Stripe`);
  assert.deepEqual(Object.keys(f).filter(k => !B.STRIPE_SAFE_KEYS.includes(k)), []);
});

test('stripeSafe refuses an extra field, a descriptive name, a foreign id or a foreign URL', () => {
  const ok = B.checkoutForm(inv(), URLS);
  assert.throws(() => B.stripeSafe({ ...ok, customer_email: 'j@example.com' }), /not allowed/);
  assert.throws(() => B.stripeSafe({ ...ok, 'line_items[0][price_data][product_data][name]': 'Home care for Juanita Guess, 10/12' }), /neutral/);
  assert.throws(() => B.stripeSafe({ ...ok, 'payment_intent_data[description]': 'Office visit 99349' }), /neutral/);
  assert.throws(() => B.stripeSafe({ ...ok, 'metadata[invoice_id]': 'Juanita Guess' }), /internal id/);
  assert.throws(() => B.stripeSafe({ ...ok, success_url: 'https://evil.example/x' }), /portal billing/);
  assert.throws(() => B.stripeSafe({ ...ok, 'line_items[0][price_data][unit_amount]': '25.00' }), /whole cents/);
});

test('home care: one line per Georgia day, raised to the daily minimum, from completed visits only', () => {
  const localDate = (iso) => iso.slice(0, 10);
  const logs = [
    { client_id: 'c1', clock_in_at: '2026-10-05T13:00:00Z', clock_out_at: 'x', total_minutes: 120 },   // 2h, min 4
    { client_id: 'c1', clock_in_at: '2026-10-06T13:00:00Z', clock_out_at: 'x', total_minutes: 180 },
    { client_id: 'c1', clock_in_at: '2026-10-06T19:00:00Z', clock_out_at: 'x', total_minutes: 150 },   // same day: 5.5h
    { client_id: 'c1', clock_in_at: '2026-10-07T13:00:00Z', clock_out_at: null, total_minutes: null },   // still running
    { client_id: 'c2', clock_in_at: '2026-10-05T13:00:00Z', clock_out_at: 'x', total_minutes: 600 },     // someone else
    { client_id: 'c1', clock_in_at: '2026-10-20T13:00:00Z', clock_out_at: 'x', total_minutes: 600 }      // outside the range
  ];
  const r = B.homeCareLines(logs, { clientId: 'c1', from: '2026-10-01', to: '2026-10-14', hourlyRate: 30, dailyMinimumHours: 4, localDate });
  assert.deepEqual(r.lines.map(l => [l.date, l.hours, l.minimumApplied, l.amountCents]), [['2026-10-05', 4, true, 12000], ['2026-10-06', 5.5, false, 16500]]);
  assert.equal(B.homeCareLines(logs, { clientId: 'c1', from: '2026-10-01', to: '2026-10-14', hourlyRate: null, localDate }).code, 'BILLING_NO_RATE');
});

test('a copay is a fixed amount the office sets, or none; never worked out from a charge', () => {
  assert.deepEqual(B.normalizeCopaySetting({ copay: '$25.00' }).value, { copayCents: 2500 });
  assert.deepEqual(B.normalizeCopaySetting({ copay: '' }).value, { copayCents: null });
  assert.equal(B.normalizeCopaySetting({ copay: 'twenty' }).code, 'BILLING_COPAY_INVALID');
  assert.equal(B.normalizeCopaySetting({ copay: '-5' }).code, 'BILLING_COPAY_INVALID');
});

test('statements move draft → open → paid (or void, with a reason); paid and void are final', () => {
  const by = { id: 'a', name: 'Admin' };
  const draft = B.buildInvoice({ id: 'i', number: 'GFC-INV-AAAAAA', clientId: 'c', kind: 'home_care', lines: [{ amountCents: 100 }], at: 't', by });
  assert.equal(B.transition(draft, 'paid', { method: 'check' }).code, 'INVOICE_NOT_OPEN', 'a draft was never sent, so it cannot be paid');
  const open = B.transition(draft, 'open', { at: 't', by }).inv;
  assert.equal(B.transition(open, 'paid', { method: 'barter' }).code, 'INVOICE_PAYMENT_METHOD');
  const paid = B.transition(open, 'paid', { at: 't2', method: 'check', reference: '1042', by }).inv;
  assert.equal(paid.status, 'paid'); assert.equal(paid.payments[0].amountCents, 100);
  assert.equal(B.transition(paid, 'void', { reason: 'x' }).code, 'INVOICE_FINAL');
  assert.equal(B.transition(open, 'void', {}).code, 'INVOICE_VOID_REASON_REQUIRED');
  assert.equal(B.transition(B.buildInvoice({ id: 'e', number: 'n', clientId: 'c', kind: 'copay', lines: [], at: 't' }), 'open', { at: 't' }).code, 'INVOICE_EMPTY');
  const pub = B.publicInvoice(paid);
  assert.ok(!('payments' in pub) && !('createdBy' in pub), 'the patient never sees who on staff did what');
});

test('a Stripe webhook counts only if correctly signed and recent', () => {
  const secret = 'whsec_test'; const body = '{"type":"checkout.session.completed"}'; const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  assert.equal(B.verifyStripeSignature(body, `t=${t},v1=${sig}`, secret), true);
  assert.equal(B.verifyStripeSignature(body + ' ', `t=${t},v1=${sig}`, secret), false, 'a changed body fails');
  assert.equal(B.verifyStripeSignature(body, `t=${t - 3600},v1=${crypto.createHmac('sha256', secret).update(`${t - 3600}.${body}`).digest('hex')}`, secret), false, 'an old replay fails');
  assert.equal(B.verifyStripeSignature(body, `t=${t},v1=${sig}`, ''), false, 'no secret, no trust');
});

test('build guard: the webhook reads raw bytes before the JSON parser, Stripe is only called through checkoutForm, and a copay follows billing submit', () => {
  assert.ok(server.indexOf("app.use('/api/webhooks/stripe', express.raw(") < server.indexOf('app.use(bodyParser.json('), 'the signature is over the raw body');
  assert.match(server, /if \(!billing\.verifyStripeSignature\(req\.body, req\.headers\['stripe-signature'\], process\.env\.STRIPE_WEBHOOK_SECRET\)\)/);
  const stripeCalls = server.match(/api\.stripe\.com[^'"`]*/g) || [];
  assert.deepEqual(stripeCalls, ['api.stripe.com/v1/checkout/sessions'], 'one Stripe call in the app');
  const pay = server.slice(server.indexOf("app.post('/api/gfc/billing/invoices/:id/pay'"), server.indexOf("app.get('/api/gfc/admin/billing/:clientId'"));
  assert.match(pay, /body: new URLSearchParams\(form\)\.toString\(\)/);
  assert.match(pay, /const form = billing\.checkoutForm\(inv, /);
  const hook = server.slice(server.indexOf("app.post('/api/webhooks/stripe'"), server.indexOf("app.post('/api/webhooks/stripe'") + 2500);
  assert.match(hook, /if \(Number\(s\.amount_total\) !== Number\(rows\[i\]\.totalCents\)\)/, 'a payment for the wrong amount never marks an invoice paid');
  const submit = server.slice(server.indexOf("encounters/:euuid/billing-submit'"), server.indexOf("app.post('/api/clinical/facilities/sync'"));
  assert.match(submit, /await createCopayInvoice\(\{ client: ctx\.client, encounterUuid: ctx\.encounterUuid/);
  // Staff can never claim a payment came through Stripe; only the signed webhook can.
  assert.match(server, /method: to === 'paid' \? \(b\.method === 'stripe' \? null : b\.method\) : undefined/);
});
