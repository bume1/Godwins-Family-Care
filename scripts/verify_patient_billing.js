#!/usr/bin/env node
/**
 * Patient billing through the REAL server and routes (owner, 2026-10-12).
 * Stripe's API is faked (every call it would receive is captured and checked
 * for PHI); the webhook is signed with a test secret exactly as Stripe signs.
 *   node scripts/verify_patient_billing.js
 */
process.env.PORT = process.env.PORT || '4619';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'billing-verification-secret';
process.env.AUTO_CHANGELOG = 'false';
process.env.MFA_ENFORCE = 'false';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake';
const path = require('path'); const Module = require('module'); const crypto = require('crypto');
const STORE = new Map();
class MemDb {
  async get(k) { return STORE.has(k) ? JSON.parse(JSON.stringify(STORE.get(k))) : null; }
  async set(k, v) { STORE.set(k, JSON.parse(JSON.stringify(v))); return true; }
  async delete(k) { STORE.delete(k); return true; }
  async list(prefix) { return [...STORE.keys()].filter(k => !prefix || k.startsWith(prefix)); }
  async empty() { STORE.clear(); return true; }
}
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) { if (request === '@replit/database') return '__memdb__'; return realResolve.call(this, request, ...rest); };
require.cache['__memdb__'] = { id: '__memdb__', filename: '__memdb__', loaded: true, exports: MemDb };
const SENT = [];
const email = require(path.join(__dirname, '..', 'email.js'));
email.sendEmail = async (to, subject, text, opts) => { SENT.push({ to, subject, text, html: opts && opts.htmlBody }); return { success: true }; };
// Fake Stripe: capture every request it would get.
const STRIPE_CALLS = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.stripe.com/')) {
    STRIPE_CALLS.push({ url: String(url), body: String(opts && opts.body || '') });
    return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, opts);
};
const jwt = require('jsonwebtoken');
const config = require(path.join(__dirname, '..', 'config.js'));
const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); } };
const tok = (u) => { const sid = `sess_${u.id}`; const at = new Date().toISOString();
  STORE.set(`auth_session:${sid}`, { id: sid, userId: u.id, role: u.role, createdAt: at, lastSeenAt: at, absoluteExpiresAt: null, revokedAt: null, revokedReason: null, ipHash: null, userAgent: null, mfaVerified: true, surface: null });
  return jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, sid }, process.env.JWT_SECRET, { expiresIn: '1h' }); };
const call = async (method, url, token, body, raw, headers) => {
  const res = await realFetch(`${BASE}${url}`, { method, headers: Object.assign({}, token ? { Authorization: `Bearer ${token}` } : {}, body || raw ? { 'Content-Type': 'application/json' } : {}, headers || {}), body: raw != null ? raw : (body ? JSON.stringify(body) : undefined) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const signed = (payload, secret = 'whsec_fake', t = Math.floor(Date.now() / 1000)) => {
  const raw = JSON.stringify(payload);
  return { raw, header: `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}` };
};

const CLIENT = { id: 'client_bill_1', role: 'client', email: 'juanita@example.test', name: 'Juanita Guess', slug: 'juanita-guess', enrollmentStatus: 'enrolled', consents: { roiFamily: 'signed' }, intake: {},
  rateAgreement: { hourlyRate: 30, dailyMinimumHours: 4 } };
const POA = { id: 'poa_bill', role: 'family', email: 'poa@example.test', name: 'Pat Poa', familyOfClientId: CLIENT.id, familyIsPoa: true };
const COUSIN = { id: 'fam_bill', role: 'family', email: 'cousin@example.test', name: 'Cee', familyOfClientId: CLIENT.id, familyIsPoa: false };
const ADMIN = { id: 'admin_bill', role: 'admin', email: 'billadmin@example.test', name: 'Bill Admin' };
const MGR = { id: 'mgr_bill', role: 'user', isManager: true, email: 'mgr@example.test', name: 'Mo Manager' };
const CM = { id: 'cm_bill', role: 'caseManager', email: 'cm@example.test', name: 'Cass CM' };

(async () => {
  STORE.set('users', [CLIENT, POA, COUSIN, ADMIN, MGR, CM]);
  STORE.set('time_logs', [
    { id: 't1', client_id: CLIENT.id, clock_in_at: '2026-10-05T13:00:00Z', clock_out_at: '2026-10-05T15:00:00Z', total_minutes: 120 },
    { id: 't2', client_id: CLIENT.id, clock_in_at: '2026-10-06T13:00:00Z', clock_out_at: '2026-10-06T18:30:00Z', total_minutes: 330 },
    { id: 't3', client_id: CLIENT.id, clock_in_at: '2026-10-07T13:00:00Z', clock_out_at: null, total_minutes: null }
  ]);
  require(path.join(__dirname, '..', 'server.js'));
  await new Promise(r => setTimeout(r, 2500));
  const at = tok(ADMIN), mt = tok(MGR), cmt = tok(CM), ct = tok(CLIENT), pt = tok(POA), ft = tok(COUSIN);
  const B = `/api/gfc/admin/billing/${CLIENT.id}`;

  console.log('\n── Who bills ──');
  let r = await call('GET', B, cmt);
  check('a case manager cannot open billing', r.status === 403);
  r = await call('GET', B, mt);
  check('a manager can', r.status === 200 && r.body.stripe.configured === true);

  console.log('\n── Copay setting ──');
  r = await call('PUT', `${B}/copay`, at, { copay: 'twenty' });
  check('a copay that is not an amount is refused', r.status === 400);
  r = await call('PUT', `${B}/copay`, at, { copay: '25' });
  check('a fixed copay is saved in cents', r.status === 200 && STORE.get('users').find(u => u.id === CLIENT.id).billingSettings.copayCents === 2500);

  console.log('\n── Home care statement ──');
  r = await call('POST', `${B}/home-care/preview`, at, { from: '2026-10-01', to: '2026-10-14' });
  check('the preview has one line per day, the 2-hour day raised to the 4-hour minimum, the open visit left out',
    r.status === 200 && JSON.stringify(r.body.lines.map(l => [l.date, l.hours])) === JSON.stringify([['2026-10-05', 4], ['2026-10-06', 5.5]]) && r.body.totalCents === 28500, JSON.stringify(r.body));
  r = await call('POST', `${B}/home-care`, mt, { from: '2026-10-01', to: '2026-10-14' });
  const inv = r.body.invoice;
  check('creating it makes a DRAFT the patient cannot see yet', r.status === 200 && inv.status === 'draft');
  r = await call('GET', '/api/gfc/billing', ct);
  check('the patient sees no draft', r.status === 200 && r.body.invoices.length === 0 && r.body.balanceCents === 0);
  r = await call('POST', `/api/gfc/admin/billing/invoices/${inv.id}/send`, at);
  check('sending it opens it', r.status === 200 && r.body.invoice.status === 'open');
  check('the patient is emailed, with no amount and no care details', SENT.some(m => m.to === CLIENT.email && !/\$|home care|285/i.test(m.text + (m.html || ''))));
  check('and the POA is emailed too, but not plain family', SENT.some(m => m.to === POA.email) && !SENT.some(m => m.to === COUSIN.email));

  console.log('\n── The patient pays ──');
  r = await call('GET', '/api/gfc/billing', ct);
  check('the balance is the open statement', r.body.balanceCents === 28500 && r.body.balance === '$285.00' && r.body.onlinePayment === true);
  r = await call('GET', '/api/gfc/billing', ft);
  check('plain family never see billing', r.status === 403);
  r = await call('GET', '/api/gfc/billing', pt);
  check('a POA does', r.status === 200);
  r = await call('POST', `/api/gfc/billing/invoices/${inv.id}/pay`, ct);
  check('paying opens Stripe checkout', r.status === 200 && /checkout\.stripe\.com/.test(r.body.url));
  const sent = STRIPE_CALLS[0] ? decodeURIComponent(STRIPE_CALLS[0].body.replace(/\+/g, ' ')) : '';
  check('Stripe received only the invoice number and amount: no name, email, dates or care', sent.includes(inv.number) && sent.includes('28500') && !/Juanita|juanita@|2026-10-0|Home care|copay/i.test(sent), sent);

  console.log('\n── Stripe says it is paid ──');
  const evt = (amount) => ({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', payment_status: 'paid', amount_total: amount, payment_intent: 'pi_1', metadata: { invoice_id: inv.id } } } });
  let w = signed(evt(28500), 'whsec_wrong');
  r = await call('POST', '/api/webhooks/stripe', null, null, w.raw, { 'Stripe-Signature': w.header });
  check('a wrongly signed webhook is refused', r.status === 400 && STORE.get('patient_invoices')[0].status === 'open');
  w = signed(evt(100));
  r = await call('POST', '/api/webhooks/stripe', null, null, w.raw, { 'Stripe-Signature': w.header });
  check('a payment for the wrong amount does not mark it paid', STORE.get('patient_invoices')[0].status === 'open');
  w = signed(evt(28500));
  r = await call('POST', '/api/webhooks/stripe', null, null, w.raw, { 'Stripe-Signature': w.header });
  check('a correctly signed payment marks it paid', r.status === 200 && STORE.get('patient_invoices')[0].status === 'paid' && STORE.get('patient_invoices')[0].payments[0].method === 'stripe');
  r = await call('POST', '/api/webhooks/stripe', null, null, w.raw, { 'Stripe-Signature': w.header });
  check('Stripe retrying the same event changes nothing', r.status === 200 && STORE.get('patient_invoices')[0].payments.length === 1);
  r = await call('GET', '/api/gfc/billing', ct);
  check('the patient now owes nothing and sees it as paid', r.body.balanceCents === 0 && r.body.invoices[0].status === 'paid');

  console.log('\n── Paid at the office, and voiding ──');
  r = await call('POST', `${B}/home-care`, at, { from: '2026-10-05', to: '2026-10-05' });
  const inv2 = r.body.invoice;
  await call('POST', `/api/gfc/admin/billing/invoices/${inv2.id}/send`, at);
  r = await call('POST', `/api/gfc/admin/billing/invoices/${inv2.id}/record-payment`, at, { method: 'stripe' });
  check('staff cannot claim a payment came through Stripe', r.status === 409);
  r = await call('POST', `/api/gfc/admin/billing/invoices/${inv2.id}/record-payment`, at, { method: 'check', reference: '1042' });
  check('a check payment is recorded', r.status === 200 && r.body.invoice.status === 'paid');
  r = await call('POST', `${B}/home-care`, at, { from: '2026-10-06', to: '2026-10-06' });
  const inv3 = r.body.invoice;
  r = await call('POST', `/api/gfc/admin/billing/invoices/${inv3.id}/void`, at, {});
  check('voiding needs a reason', r.status === 409);
  r = await call('POST', `/api/gfc/admin/billing/invoices/${inv3.id}/void`, at, { reason: 'Billed twice by mistake' });
  check('voided with a reason', r.status === 200 && r.body.invoice.status === 'void');

  const acts = JSON.stringify(STORE.get('activity_log') || []);
  check('the activity log carries amounts and ids, never a name or date of service', !/Juanita|2026-10-05T/.test(acts.replace(/"(timestamp|at|createdAt)":"[^"]*"/g, '')));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
