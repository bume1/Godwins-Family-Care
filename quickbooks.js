'use strict';
// ============================================================================
// quickbooks.js — QuickBooks Online sync (spec v1 "QuickBooks Online
// integration"; spec v2 item 1: PRIVATE HOME CARE AND PAYROLL ONLY).
//
// NEVER CLINICAL. No clinical client, claim, copay or clinical payment is ever
// sent. `assertPhc` refuses anything that is not a home care invoice for a
// client on the private home care line, and it is the only door an invoice
// passes through (build-enforced).
//
// WHAT POSTS (each event once; a retry reuses the same requestid, which
// QuickBooks treats as the same request, so nothing is ever doubled):
//   payroll run approved   JournalEntry: wages + employer tax expense against
//                          Payroll Clearing and each liability
//   a worker paid          Purchase from PNC Checking, debit Payroll Clearing
//   a tax deposit          Purchase from PNC Checking, debit the liabilities
//   a contractor paid      Purchase, vendor = contractor (1099 on), Contract Labor
//   a PHC invoice sent     Invoice; customer = the client's name and account
//                          number (owner, 2026-11-08), or the LTC carrier
//   a PHC invoice paid     Payment against that invoice
//
// Tokens are SEALED (payrollCrypto) and refreshed before they expire.
// ============================================================================
const crypto = require('crypto');
const pc = require('./payrollCrypto');

const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const API = { sandbox: 'https://sandbox-quickbooks.api.intuit.com', production: 'https://quickbooks.api.intuit.com' };
const SCOPE = 'com.intuit.quickbooks.accounting';
const MINOR = '75';

// The chart of accounts the sync posts to (spec v1). Created by the owner in
// QuickBooks first; the status screen names any that are missing.
const ACCOUNTS = Object.freeze({
  bank: 'PNC Business Checking',
  clearing: 'Payroll Clearing',
  fedWh: 'Payroll Liabilities: Federal Withholding',
  fica: 'Payroll Liabilities: FICA',
  gaWh: 'Payroll Liabilities: GA Withholding',
  futa: 'Payroll Liabilities: FUTA',
  suta: 'Payroll Liabilities: GA SUTA',
  wagesHomeCare: 'Wages: Home Care',
  wagesClinical: 'Wages: Clinical',
  taxExpense: 'Payroll Tax Expense',
  contractLabor: 'Contract Labor',
  incomePhc: 'Income: Private Home Care'
});
const PHC_ITEM = 'Private Home Care Services';

const cents = (c) => Math.round(Number(c || 0)) / 100;
// The account number a client is known by in QuickBooks.
const accountNumberFor = (clientId) => `GFC-${String(clientId).replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase()}`;
const requestIdFor = (eventKey) => crypto.createHash('sha256').update(String(eventKey)).digest('hex').slice(0, 36);

// ---- the one door for invoices ---------------------------------------------------
function assertPhc(inv, client) {
  if (!inv || inv.kind !== 'home_care') return 'Only private home care invoices go to QuickBooks.';
  if (!client || String(client.serviceLine || '').toUpperCase() === 'IHPC') return 'This client is not on the private home care line.';
  return null;
}

// ---- builders (pure) -------------------------------------------------------------------
const line = (accountId, amount, postingType, description) => ({
  DetailType: 'JournalEntryLineDetail', Amount: cents(amount), Description: description,
  JournalEntryLineDetail: { PostingType: postingType, AccountRef: { value: accountId } }
});
function journalForRun(run, ids) {
  const t = run.totals;
  const wages = { home_care: 0, clinical: 0 };
  for (const w of run.workers) if (w.pay) wages[w.wageAccount === 'home_care' ? 'home_care' : 'clinical'] += w.pay.grossCents + (w.pay.reimbursementsCents || 0);
  const employerTax = t.employerSocialSecurityCents + t.employerMedicareCents + t.futaCents + (t.gaSutaCents || 0);
  const lines = [
    wages.home_care && line(ids.wagesHomeCare, wages.home_care, 'Debit', 'Gross wages, home care'),
    wages.clinical && line(ids.wagesClinical, wages.clinical, 'Debit', 'Gross wages, clinical'),
    employerTax && line(ids.taxExpense, employerTax, 'Debit', 'Employer payroll taxes'),
    line(ids.clearing, t.netCents, 'Credit', 'Net pay owed'),
    t.federalCents && line(ids.fedWh, t.federalCents, 'Credit', 'Federal income tax withheld'),
    line(ids.fica, t.socialSecurityCents + t.medicareCents + t.employerSocialSecurityCents + t.employerMedicareCents, 'Credit', 'Social Security and Medicare, employee and employer'),
    t.georgiaCents && line(ids.gaWh, t.georgiaCents, 'Credit', 'Georgia income tax withheld'),
    t.futaCents && line(ids.futa, t.futaCents, 'Credit', 'FUTA'),
    t.gaSutaCents && line(ids.suta, t.gaSutaCents, 'Credit', 'Georgia unemployment')
  ].filter(Boolean);
  const dr = lines.filter(l => l.JournalEntryLineDetail.PostingType === 'Debit').reduce((a, l) => a + Math.round(l.Amount * 100), 0);
  const cr = lines.filter(l => l.JournalEntryLineDetail.PostingType === 'Credit').reduce((a, l) => a + Math.round(l.Amount * 100), 0);
  if (dr !== cr) throw new Error(`payroll journal does not balance (${dr} vs ${cr})`);
  return { TxnDate: run.period.payDate, DocNumber: `PR-${run.period.payDate}`, PrivateNote: `GFC payroll ${run.period.start} to ${run.period.end}`, Line: lines };
}
// No employee name or bank number goes to QuickBooks with a paycheck: the
// bank feed line matches on amount and date.
function purchaseForPay(run, w, ids) {
  return {
    TxnDate: (run.payments && run.payments[w.userId] && run.payments[w.userId].at || run.period.payDate).slice(0, 10),
    PaymentType: 'Check', AccountRef: { value: ids.bank }, PrivateNote: `Net pay, pay date ${run.period.payDate}`,
    Line: [{ DetailType: 'AccountBasedExpenseLineDetail', Amount: cents(w.pay.netCents), AccountBasedExpenseLineDetail: { AccountRef: { value: ids.clearing } } }]
  };
}
function purchaseForTax(pay, split, ids) {
  return {
    TxnDate: pay.paidAt, PaymentType: 'Check', AccountRef: { value: ids.bank }, PrivateNote: `Tax deposit ${pay.key} · ${pay.confirmation}`,
    Line: split.filter(s => s.amountCents > 0).map(s => ({ DetailType: 'AccountBasedExpenseLineDetail', Amount: cents(s.amountCents), AccountBasedExpenseLineDetail: { AccountRef: { value: ids[s.account] } } }))
  };
}
// Which liability accounts one tax deposit pays down.
function taxSplit(pay, runs) {
  const type = String(pay.key).split(':')[0];
  if (type === 'ga_withholding') return [{ account: 'gaWh', amountCents: pay.amountCents }];
  if (type === 'futa') return [{ account: 'futa', amountCents: pay.amountCents }];
  if (type === 'ga_suta') return [{ account: 'suta', amountCents: pay.amountCents }];
  // A 941 deposit pays federal withholding and FICA together. Split it in the
  // proportion the runs owed, the remainder on FICA so the cents add up.
  let fed = 0, fica = 0;
  for (const r of runs || []) { fed += r.totals.federalCents; fica += r.totals.socialSecurityCents + r.totals.medicareCents + r.totals.employerSocialSecurityCents + r.totals.employerMedicareCents; }
  const fedPart = fed + fica ? Math.round(pay.amountCents * fed / (fed + fica)) : 0;
  return [{ account: 'fedWh', amountCents: fedPart }, { account: 'fica', amountCents: pay.amountCents - fedPart }];
}
function purchaseForContractor(inv, vendorId, ids) {
  return {
    TxnDate: String(inv.paidAt).slice(0, 10), PaymentType: 'Check', AccountRef: { value: ids.bank }, EntityRef: { value: vendorId, type: 'Vendor' },
    PrivateNote: `Contractor invoice ${inv.invoiceNo} · ${inv.paymentConfirmation}`,
    Line: [{ DetailType: 'AccountBasedExpenseLineDetail', Amount: cents(inv.totalCents), Description: `Invoice ${inv.invoiceNo}, ${inv.periodStart} to ${inv.periodEnd}`, AccountBasedExpenseLineDetail: { AccountRef: { value: ids.contractLabor } } }]
  };
}
function invoiceForPhc(inv, customerId, itemId, accountNumber) {
  return {
    CustomerRef: { value: customerId }, DocNumber: String(inv.displayNumber || inv.number).slice(0, 21),
    TxnDate: String(inv.sentAt || inv.createdAt).slice(0, 10),
    PrivateNote: `GFC ${inv.displayNumber || inv.number} · account ${accountNumber}`,
    Line: (inv.lines || []).map(l => ({ DetailType: 'SalesItemLineDetail', Amount: cents(l.amountCents), Description: `${l.kind === 'minimum' ? 'Daily minimum' : 'Home care services'} ${l.date || ''}`.trim(),
      SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: l.hours || 1, UnitPrice: l.rateCents ? cents(l.rateCents) : cents(l.amountCents) } }))
  };
}

// ---- the client ----------------------------------------------------------------------
function createQbo({ db, env = process.env, fetchImpl = fetch, uuid, logActivity = async () => {}, getUsers, getRuns }) {
  const cfg = () => ({ id: env.QBO_CLIENT_ID, secret: env.QBO_CLIENT_SECRET, redirect: env.QBO_REDIRECT_URI, environment: env.QBO_ENVIRONMENT === 'production' ? 'production' : 'sandbox' });
  const missing = () => [['QBO_CLIENT_ID', cfg().id], ['QBO_CLIENT_SECRET', cfg().secret], ['QBO_REDIRECT_URI', cfg().redirect], ['PAYROLL_ENCRYPTION_KEY', pc.configured(env)]].filter(([, v]) => !v).map(([k]) => k);
  const readConn = async () => (await db.get('qbo_connection')) || null;
  const basic = () => `Basic ${Buffer.from(`${cfg().id}:${cfg().secret}`).toString('base64')}`;

  async function connectUrl(user) {
    const state = crypto.randomBytes(24).toString('hex');
    const states = ((await db.get('qbo_oauth_states')) || []).filter(s => Date.parse(s.expiresAt) > Date.now());
    states.push({ state, userId: String(user.id), expiresAt: new Date(Date.now() + 10 * 60000).toISOString() });
    await db.set('qbo_oauth_states', states);
    const q = new URLSearchParams({ client_id: cfg().id, response_type: 'code', scope: SCOPE, redirect_uri: cfg().redirect, state });
    return `${AUTH_URL}?${q}`;
  }
  async function tokenCall(body) {
    const r = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { Authorization: basic(), Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) { const e = new Error(`QuickBooks refused the token request${j.error ? ` (${j.error})` : ''}.`); e.code = 'QBO_TOKEN_FAILED'; throw e; }
    return j;
  }
  const store = async (j, realmId, extra) => {
    const now = Date.now();
    const prev = (await readConn()) || {};
    const conn = { ...prev, ...extra, realmId: realmId || prev.realmId, environment: cfg().environment,
      accessEnc: pc.seal(j.access_token, env), refreshEnc: pc.seal(j.refresh_token, env),
      accessExpiresAt: new Date(now + (Number(j.expires_in) || 3600) * 1000).toISOString(),
      refreshExpiresAt: new Date(now + (Number(j.x_refresh_token_expires_in) || 8726400) * 1000).toISOString() };
    await db.set('qbo_connection', conn);
    return conn;
  };
  async function handleCallback({ code, state, realmId }) {
    const states = (await db.get('qbo_oauth_states')) || [];
    const s = states.find(x => x.state === state && Date.parse(x.expiresAt) > Date.now());
    await db.set('qbo_oauth_states', states.filter(x => x.state !== state));   // single use
    if (!s) { const e = new Error('That QuickBooks sign-in link expired. Connect again.'); e.code = 'QBO_STATE'; throw e; }
    if (!code || !realmId) { const e = new Error('QuickBooks did not return a company.'); e.code = 'QBO_NO_COMPANY'; throw e; }
    const j = await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: cfg().redirect });
    await store(j, realmId, { connectedAt: new Date().toISOString(), connectedBy: s.userId, accountIds: null });
    await logActivity(s.userId, 'QuickBooks', 'qbo_connected', 'quickbooks', realmId, {});
  }
  async function accessToken() {
    const c = await readConn();
    if (!c || !c.refreshEnc) { const e = new Error('QuickBooks is not connected.'); e.code = 'QBO_NOT_CONNECTED'; throw e; }
    if (Date.parse(c.accessExpiresAt) - Date.now() > 5 * 60000) return { token: pc.open(c.accessEnc, env), conn: c };
    const j = await tokenCall({ grant_type: 'refresh_token', refresh_token: pc.open(c.refreshEnc, env) });
    const next = await store(j, c.realmId);
    return { token: j.access_token, conn: next };
  }
  async function api(method, path, body, requestId) {
    const { token, conn } = await accessToken();
    const q = new URLSearchParams({ minorversion: MINOR });
    if (requestId) q.set('requestid', requestId);
    const r = await fetchImpl(`${API[conn.environment]}/v3/company/${conn.realmId}/${path}${path.includes('?') ? '&' : '?'}${q}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.Fault) { const m = (j.Fault && j.Fault.Error && j.Fault.Error[0] && (j.Fault.Error[0].Detail || j.Fault.Error[0].Message)) || `HTTP ${r.status}`; const e = new Error(`QuickBooks: ${m}`); e.code = 'QBO_API'; throw e; }
    return j;
  }
  const query = async (sql) => (await api('GET', `query?query=${encodeURIComponent(sql)}`)).QueryResponse || {};
  const esc = (s) => String(s).replace(/'/g, "\\'");

  // Account ids by name, looked up once and kept.
  async function accountIds({ refresh } = {}) {
    const c = await readConn();
    if (c && c.accountIds && !refresh) return c.accountIds;
    const found = {}, missingNames = [];
    for (const [k, name] of Object.entries(ACCOUNTS)) {
      const a = ((await query(`select Id, Name, FullyQualifiedName from Account where FullyQualifiedName = '${esc(name)}'`)).Account || [])[0]
        || ((await query(`select Id, Name from Account where Name = '${esc(name.split(':').pop().trim())}'`)).Account || [])[0];
      if (a) found[k] = a.Id; else missingNames.push(name);
    }
    if (missingNames.length) { const e = new Error(`Create these accounts in QuickBooks first: ${missingNames.join(', ')}.`); e.code = 'QBO_ACCOUNTS_MISSING'; e.missing = missingNames; throw e; }
    await db.set('qbo_connection', { ...(await readConn()), accountIds: found });
    return found;
  }
  async function findOrCreate(entity, where, create) {
    const hit = ((await query(`select * from ${entity} where ${where}`))[entity] || [])[0];
    if (hit) return hit.Id;
    return (await api('POST', entity.toLowerCase(), create))[entity].Id;
  }

  // Each event runs once. The log row is keyed by the event; a retry uses the
  // same requestid.
  async function once(eventKey, label, fn) {
    if (!(await readConn())) return { skipped: 'not connected' };
    const log = (await db.get('qbo_sync_log')) || [];
    if (log.some(l => l.eventKey === eventKey && l.status === 'ok')) return { skipped: 'already synced' };
    const requestId = requestIdFor(eventKey);
    let row;
    try {
      const out = await fn(requestId);
      row = { id: uuid(), eventKey, event: label, requestId, status: 'ok', qboId: out && out.Id ? out.Id : null, at: new Date().toISOString() };
    } catch (e) {
      row = { id: uuid(), eventKey, event: label, requestId, status: 'failed', error: e.message, at: new Date().toISOString() };
    }
    const next = ((await db.get('qbo_sync_log')) || []).filter(l => !(l.eventKey === eventKey && l.status === 'failed'));
    next.push(row);
    await db.set('qbo_sync_log', next.slice(-2000));
    return row;
  }

  const runApproved = (run) => once(`run:${run.id}`, 'Payroll journal', async (rid) => (await api('POST', 'journalentry', journalForRun(run, await accountIds()), rid)).JournalEntry);
  const workerPaid = (run, w) => once(`pay:${run.id}:${w.userId}`, 'Net pay', async (rid) => (await api('POST', 'purchase', purchaseForPay(run, w, await accountIds()), rid)).Purchase);
  const taxPaid = (pay) => once(`tax:${pay.id}`, 'Tax deposit', async (rid) => {
    const runs = getRuns ? (await getRuns()).filter(r => r.status !== 'draft') : [];
    return (await api('POST', 'purchase', purchaseForTax(pay, taxSplit(pay, runs), await accountIds()), rid)).Purchase;
  });
  const contractorPaid = (inv) => once(`contractor:${inv.id}`, 'Contractor payment', async (rid) => {
    const ids = await accountIds();
    const vendorId = await findOrCreate('Vendor', `DisplayName = '${esc(inv.name)}'`, { DisplayName: inv.name, Vendor1099: true });
    return (await api('POST', 'purchase', purchaseForContractor(inv, vendorId, ids), rid)).Purchase;
  });
  async function itemId() {
    const ids = await accountIds();
    return findOrCreate('Item', `Name = '${esc(PHC_ITEM)}'`, { Name: PHC_ITEM, Type: 'Service', IncomeAccountRef: { value: ids.incomePhc } });
  }
  const invoiceSent = async (inv) => {
    const client = (await getUsers()).find(u => u && u.id === inv.clientId);
    const refused = assertPhc(inv, client);
    if (refused) return { skipped: refused };
    return once(`invoice:${inv.id}`, 'PHC invoice', async (rid) => {
      const acct = accountNumberFor(inv.clientId);
      const isCarrier = inv.format === 'carrier' && inv.billTo && inv.billTo.name;
      const display = isCarrier ? inv.billTo.name : `${client.name} (${acct})`;
      const customerId = await findOrCreate('Customer', `DisplayName = '${esc(display)}'`, { DisplayName: display, ...(isCarrier ? {} : { AcctNum: acct }) });
      const created = (await api('POST', 'invoice', invoiceForPhc(inv, customerId, await itemId(), acct), rid)).Invoice;
      const rows = (await db.get('patient_invoices')) || [];
      const i = rows.findIndex(r => r.id === inv.id);
      if (i !== -1) { rows[i] = { ...rows[i], qboInvoiceId: created.Id, qboCustomerId: customerId }; await db.set('patient_invoices', rows); }
      return created;
    });
  };
  const invoicePaid = async (inv) => {
    const client = (await getUsers()).find(u => u && u.id === inv.clientId);
    if (assertPhc(inv, client)) return { skipped: 'not PHC' };
    const fresh = ((await db.get('patient_invoices')) || []).find(r => r.id === inv.id) || inv;
    if (!fresh.qboInvoiceId) return { skipped: 'invoice not in QuickBooks yet' };
    return once(`payment:${inv.id}`, 'PHC payment', async (rid) => (await api('POST', 'payment', {
      CustomerRef: { value: fresh.qboCustomerId }, TotalAmt: cents(fresh.totalCents), TxnDate: String(fresh.paidAt || '').slice(0, 10) || undefined,
      Line: [{ Amount: cents(fresh.totalCents), LinkedTxn: [{ TxnId: fresh.qboInvoiceId, TxnType: 'Invoice' }] }]
    }, rid)).Payment);
  };

  // Retry every failed event. The events are rebuilt from the records.
  async function retry() {
    const failed = ((await db.get('qbo_sync_log')) || []).filter(l => l.status === 'failed');
    const runs = getRuns ? await getRuns() : [];
    const invoices = (await db.get('patient_invoices')) || [];
    const contractors = (await db.get('contractor_invoices')) || [];
    const taxPays = (await db.get('payroll_tax_payments')) || [];
    let ok = 0, still = 0;
    for (const f of failed) {
      const [kind, a, b] = f.eventKey.split(':');
      let r = null;
      if (kind === 'run') { const run = runs.find(x => x.id === a); if (run) r = await runApproved(run); }
      else if (kind === 'pay') { const run = runs.find(x => x.id === a); const w = run && run.workers.find(x => x.userId === b); if (w) r = await workerPaid(run, w); }
      else if (kind === 'tax') { const p = taxPays.find(x => x.id === a); if (p) r = await taxPaid(p); }
      else if (kind === 'contractor') { const c = contractors.find(x => x.id === a); if (c) r = await contractorPaid(c); }
      else if (kind === 'invoice') { const i = invoices.find(x => x.id === a); if (i) r = await invoiceSent(i); }
      else if (kind === 'payment') { const i = invoices.find(x => x.id === a); if (i) r = await invoicePaid(i); }
      if (r && r.status === 'ok') ok++; else still++;
    }
    return { summary: `${ok} synced, ${still} still failing`, ok, still };
  }

  async function status() {
    const c = await readConn();
    const log = ((await db.get('qbo_sync_log')) || []).slice(-30).reverse();
    let accounts = [];
    if (c) { try { await accountIds(); } catch (e) { accounts = e.missing || []; } }
    return { configured: !missing().length, missing: missing(), connected: !!c, environment: c ? c.environment : cfg().environment,
      connectedAt: c ? c.connectedAt : null, refreshExpiresAt: c ? c.refreshExpiresAt : null, accounts, log };
  }
  async function disconnect(user) {
    const c = await readConn();
    if (c && c.refreshEnc) {
      try { await fetchImpl(REVOKE_URL, { method: 'POST', headers: { Authorization: basic(), 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ token: pc.open(c.refreshEnc, env) }) }); } catch (e) { /* revoking is best effort */ }
    }
    await db.set('qbo_connection', null);
    await logActivity(user.id, user.name, 'qbo_disconnected', 'quickbooks', c && c.realmId, {});
  }

  return { connectUrl, handleCallback, status, disconnect, runApproved, workerPaid, taxPaid, contractorPaid, invoiceSent, invoicePaid, retry, missing };
}

module.exports = { ACCOUNTS, PHC_ITEM, accountNumberFor, requestIdFor, assertPhc, journalForRun, purchaseForPay, purchaseForTax, taxSplit, purchaseForContractor, invoiceForPhc, createQbo };
