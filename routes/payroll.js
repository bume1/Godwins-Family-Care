'use strict';
// ============================================================================
// routes/payroll.js — payroll inside the app (spec v2, build steps 1-5, 8, 10)
//
// WIRED INTO MY GFC, NOT BESIDE IT (owner, 2026-11-08). Each person's pay
// paperwork, staff clock, contractor invoices and tax forms are served under
// /api/my/* and drawn in My GFC's Hours & Pay section. An approved run writes
// its stubs into `staff_paystubs`, the same store the payroll Apps Script
// fills, so a stub reads the same whichever produced it. The automation
// routes take the same PAYROLL_INGEST_KEY in the same X-GFC-Payroll-Key
// header that the Apps Script already uses for pay stubs: one secret, one
// script project.
//
// WHO: the owner's screen (/payroll and /api/payroll/admin/*) is Super Admin
// only (spec v2 item 17: only the owner approves runs, rates and payments).
// Each person reads and writes only their own pay setup.
// ============================================================================
const express = require('express');
const crypto = require('crypto');
const pc = require('../payrollCrypto');
const pp = require('../payrollProfiles');
const tax = require('../payrollTax');
const engine = require('../payrollEngine');
const cal = require('../payrollCalendar');
const tables = require('../payrollTaxTables');
const links = require('../appLinks');
const { contentDisposition } = require('../contentDisposition');

const PROFILES = 'payroll_profiles';          // { [userId]: profile }
const SETTINGS = 'payroll_settings';
const TAX_TABLES = 'payroll_tax_tables';
const RUNS = 'payroll_runs';
const CLOCK = 'staff_time_entries';
const CONTRACTOR_INVOICES = 'contractor_invoices';
const TAX_PAYMENTS = 'payroll_tax_payments';
const FILINGS = 'payroll_filing_confirmations';
const PAYSTUBS = 'staff_paystubs';            // shared with routes/staffPortal.js
const STAFF_TYPES = ['admin', 'manager', 'provider', 'rn', 'lcsw', 'lmsw', 'coordinator', 'caregiver', 'liaison'];
const WORK_TYPES = Object.freeze({ admin: 'Admin', training: 'Training', clinical: 'Clinical (not a visit)', exam: 'IME exam work', client_visit: 'Client visit' });
const CI_UNITS = Object.freeze(['hour', 'visit', 'exam', 'flat']);

const nowIso = () => new Date().toISOString();
const str = (v, n = 300) => (v === null || v === undefined ? '' : String(v)).trim().slice(0, n);
const toCents = (v) => { const n = Number(String(v === undefined || v === null ? '' : v).replace(/[$,\s]/g, '')); return Number.isFinite(n) && n >= 0 && n < 10000000 ? Math.round(n * 100) : null; };
const usd = (c) => `$${(Number(c || 0) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

// Constant-time key check, the same one the pay stub import uses.
function keyOk(req, key) {
  if (!key) return false;
  const given = Buffer.from(String(req.get('X-GFC-Payroll-Key') || ''));
  const want = Buffer.from(String(key));
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

module.exports = function createPayrollRoutes(deps) {
  const { db, logActivity, getUsers, authenticateToken, requireAdmin, uuidv4, accountTypeOf, localDate, resolvePayRate,
    pdf, drive, roleFolderFor, personFolderName, queueNotification, hashIp, getAppBaseUrl } = deps;
  const env = deps.env || process.env;
  const payrollKey = () => (deps.payrollKey !== undefined ? deps.payrollKey : env.PAYROLL_INGEST_KEY);
  const router = express.Router();

  // ---- storage helpers --------------------------------------------------------------
  const rows = async (k) => (await db.get(k)) || [];
  const readProfiles = async () => (await db.get(PROFILES)) || {};
  const readSettings = async () => ({ ...tax.DEFAULT_SETTINGS, ...((await db.get(SETTINGS)) || {}) });
  const isStaff = (u) => !!u && STAFF_TYPES.includes(accountTypeOf(u));
  const requireStaff = (req, res, next) => (isStaff(req.user) ? next()
    : res.status(403).json({ error: 'Pay setup is for GFC staff.', code: 'PAYROLL_STAFF_ONLY' }));
  const relationshipFor = async (userId) => {
    const rec = ((await db.get('clinician_onboarding')) || []).find(r => r && String(r.userId) === String(userId));
    return rec && rec.inputs ? rec.inputs.relationship : null;
  };
  const profileFor = async (user) => {
    const all = await readProfiles();
    return all[String(user.id)] || pp.defaultProfile(user, { relationship: await relationshipFor(user.id) });
  };
  // Saves one profile. The history records WHAT changed and who, never a value.
  const saveProfile = async (userId, next, change, by) => {
    const all = await readProfiles();
    next.history = [...(next.history || []), { at: nowIso(), change, byId: by.id, byName: by.name || by.email || null }].slice(-200);
    next.updatedAt = nowIso();
    all[String(userId)] = next;
    await db.set(PROFILES, all);
    await logActivity(by.id, by.name || by.email, 'payroll_profile_updated', 'payroll_profile', String(userId), { change });
    return next;
  };
  // The tables in force: an approved table for the year of the pay date.
  const activeTables = async (year) => {
    const all = await rows(TAX_TABLES);
    const pick = (j) => all.filter(t => t.jurisdiction === j && t.status === 'active' && Number(t.year) === Number(year))
      .sort((a, b) => String(b.approvedAt).localeCompare(String(a.approvedAt)))[0] || null;
    const fed = pick('federal'), ga = pick('GA');
    return fed && ga ? { federal: fed.data, GA: ga.data, ids: [fed.id, ga.id] } : null;
  };
  const ctxFor = (req) => ({ at: nowIso(), ipHash: hashIp ? hashIp(req) : null });

  // ===================================================================================
  // EACH PERSON'S OWN: pay setup (My GFC → Hours & Pay)
  // ===================================================================================
  router.get('/api/my/pay-setup', authenticateToken, requireStaff, async (req, res) => {
    const p = await profileFor(req.user);
    res.json({
      profile: pp.publicProfile(p),
      employee: pp.isEmployee(p), contractor: pp.isContractor(p), caregiver: !!p.isCaregiver,
      secretsStorable: pc.configured(env),
      options: { w4Filing: pp.W4_FILING, g4Filing: pp.G4_FILING, i9Status: pp.I9_STATUS, w9Class: pp.W9_CLASS, workTypes: WORK_TYPES, units: CI_UNITS }
    });
  });

  // One door per form. A secret (SSN, TIN, routing, account) is sealed before
  // it is stored and never comes back to the browser.
  router.put('/api/my/pay-setup/:form', authenticateToken, requireStaff, async (req, res) => {
    try {
      const p = await profileFor(req.user);
      const ctx = ctxFor(req);
      const b = req.body || {};
      let change;
      switch (req.params.form) {
        case 'w4': { const n = pp.normalizeW4(b, ctx); if (n.error) return res.status(400).json(n); p.w4 = n.value; change = 'W-4 signed'; break; }
        case 'g4': { const n = pp.normalizeG4(b, ctx); if (n.error) return res.status(400).json(n); p.g4 = n.value; change = 'G-4 signed'; break; }
        case 'i9': { const n = pp.normalizeI9Section1(b, ctx); if (n.error) return res.status(400).json(n); p.i9 = { ...(p.i9 || {}), section1: n.value }; change = 'I-9 Section 1 signed'; break; }
        case 'ssn': {
          const bad = pp.checkSsn(b.ssn); if (bad) return res.status(400).json({ error: bad, code: 'SSN_INVALID' });
          const d = String(b.ssn).replace(/\D/g, '');
          p.ssn = { enc: pc.seal(d, env), last4: pc.last4(d), at: ctx.at }; change = 'SSN saved'; break;
        }
        case 'w9': {
          const n = pp.normalizeW9(b, ctx); if (n.error) return res.status(400).json(n);
          p.w9 = n.value; p.tin = { enc: pc.seal(n.tin, env), last4: pc.last4(n.tin), type: n.value.tinType }; change = 'W-9 signed'; break;
        }
        case 'pay-method': {
          const n = pp.normalizePayMethod(b); if (n.error) return res.status(400).json(n);
          p.payMethod = n.value.method === 'direct_deposit'
            ? { ...n.value, routingEnc: pc.seal(n.routing, env), routingLast4: pc.last4(n.routing), accountEnc: pc.seal(n.account, env), accountLast4: pc.last4(n.account), at: ctx.at }
            : { ...n.value, at: ctx.at };
          change = `Pay method set: ${n.value.method}`; break;
        }
        case 'offer': case 'handbook': {
          const sig = pp.signature(b, ctx); if (sig.error) return res.status(400).json(sig);
          p[req.params.form === 'offer' ? 'offerLetter' : 'handbook'] = sig.value;
          change = req.params.form === 'offer' ? 'Offer letter acknowledged' : 'Handbook acknowledged'; break;
        }
        case 'e-delivery':
          p.eDelivery = { consented: b.consented === true, at: ctx.at, ipHash: ctx.ipHash };
          change = b.consented === true ? 'Agreed to electronic W-2/1099' : 'Withdrew electronic W-2/1099 consent'; break;
        default: return res.status(404).json({ error: 'Unknown form.' });
      }
      const saved = await saveProfile(req.user.id, p, change, req.user);
      res.json({ profile: pp.publicProfile(saved) });
    } catch (e) {
      if (e.code === 'PAYROLL_KEY_MISSING') return res.status(503).json({ error: e.message, code: e.code });
      console.error('Pay setup error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ---- the staff clock (admin, training, clinical, exam time) -----------------------
  // Caregivers clock client visits on their shifts; this is everyone's other time.
  router.get('/api/my/clock', authenticateToken, requireStaff, async (req, res) => {
    const mine = (await rows(CLOCK)).filter(e => String(e.userId) === String(req.user.id) && !e.voided)
      .sort((a, b) => String(b.clockInAt).localeCompare(String(a.clockInAt))).slice(0, 60);
    res.json({ entries: mine, open: mine.find(e => !e.clockOutAt) || null, workTypes: WORK_TYPES });
  });
  router.post('/api/my/clock/in', authenticateToken, requireStaff, async (req, res) => {
    const all = await rows(CLOCK);
    if (all.some(e => String(e.userId) === String(req.user.id) && !e.clockOutAt && !e.voided)) return res.status(409).json({ error: 'You are already clocked in.', code: 'CLOCK_ALREADY_IN' });
    const wt = String((req.body || {}).workType || '');
    if (!WORK_TYPES[wt]) return res.status(400).json({ error: 'Say what the time is for.', code: 'CLOCK_WORK_TYPE' });
    const e = { id: uuidv4(), userId: String(req.user.id), workType: wt, clockInAt: nowIso(), clockOutAt: null, note: str((req.body || {}).note, 300) };
    all.push(e);
    await db.set(CLOCK, all);
    await logActivity(req.user.id, req.user.name, 'staff_clock_in', 'staff_time', e.id, { workType: wt });
    res.json({ entry: e });
  });
  router.post('/api/my/clock/out', authenticateToken, requireStaff, async (req, res) => {
    const all = await rows(CLOCK);
    const i = all.findIndex(e => String(e.userId) === String(req.user.id) && !e.clockOutAt && !e.voided);
    if (i === -1) return res.status(409).json({ error: 'You are not clocked in.', code: 'CLOCK_NOT_IN' });
    all[i] = { ...all[i], clockOutAt: nowIso() };
    await db.set(CLOCK, all);
    await logActivity(req.user.id, req.user.name, 'staff_clock_out', 'staff_time', all[i].id, {});
    res.json({ entry: all[i] });
  });

  // ---- contractor invoices (step 8) -------------------------------------------------
  const normalizeContractorInvoice = (b, existingNumbers) => {
    b = b || {};
    const number = str(b.invoiceNo, 40);
    if (!number) return { error: 'Give your invoice number.', code: 'CI_NUMBER' };
    if (existingNumbers.has(number.toLowerCase())) return { error: `You already used invoice number ${number}.`, code: 'CI_NUMBER_USED' };
    if (!tax.isYmd(b.periodStart) || !tax.isYmd(b.periodEnd) || b.periodEnd < b.periodStart) return { error: 'Give the period this invoice covers.', code: 'CI_PERIOD' };
    const lines = [];
    for (const [i, l] of (Array.isArray(b.lines) ? b.lines : []).entries()) {
      const qty = Number(l && l.qty), rate = toCents(l && l.rate);
      if (!str(l && l.description)) return { error: `Line ${i + 1}: describe the work.`, code: 'CI_LINE' };
      if (!tax.isYmd(l.serviceDate)) return { error: `Line ${i + 1}: give the date.`, code: 'CI_LINE' };
      if (!CI_UNITS.includes(l.unit)) return { error: `Line ${i + 1}: unit is hour, visit, exam or flat.`, code: 'CI_LINE' };
      if (!(qty > 0) || qty > 1000 || rate === null) return { error: `Line ${i + 1}: quantity and rate must be numbers.`, code: 'CI_LINE' };
      lines.push({ serviceDate: l.serviceDate, description: str(l.description, 300), clientId: l.clientId ? String(l.clientId) : null, unit: l.unit, qty, rateCents: rate, amountCents: Math.round(qty * rate) });
    }
    if (!lines.length) return { error: 'Add at least one line.', code: 'CI_NO_LINES' };
    return { value: { invoiceNo: number, periodStart: b.periodStart, periodEnd: b.periodEnd, lines, totalCents: lines.reduce((a, l) => a + l.amountCents, 0) } };
  };
  router.get('/api/my/contractor-invoices', authenticateToken, requireStaff, async (req, res) => {
    const p = await profileFor(req.user);
    const mine = (await rows(CONTRACTOR_INVOICES)).filter(x => String(x.userId) === String(req.user.id)).sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
    const year = nowIso().slice(0, 4);
    res.json({ contractor: pp.isContractor(p), invoices: mine, paidThisYearCents: mine.filter(x => x.status === 'paid' && String(x.paidAt).startsWith(year)).reduce((a, x) => a + x.totalCents, 0) });
  });
  router.post('/api/my/contractor-invoices', authenticateToken, requireStaff, async (req, res) => {
    const p = await profileFor(req.user);
    if (!pp.isContractor(p)) return res.status(403).json({ error: 'Invoices are for contractors. Ask the office if you are paid as one.', code: 'CI_NOT_CONTRACTOR' });
    const all = await rows(CONTRACTOR_INVOICES);
    const mine = all.filter(x => String(x.userId) === String(req.user.id) && x.status !== 'rejected');
    const n = normalizeContractorInvoice(req.body, new Set(mine.map(x => String(x.invoiceNo).toLowerCase())));
    if (n.error) return res.status(400).json(n);
    // A line naming an exam or visit date with nothing on the schedule is
    // flagged for the owner, never refused: the contractor knows their work.
    const inv = { id: uuidv4(), userId: String(req.user.id), name: req.user.name || req.user.email, ...n.value, status: 'submitted', submittedAt: nowIso(), history: [{ at: nowIso(), action: 'submitted' }] };
    all.push(inv);
    await db.set(CONTRACTOR_INVOICES, all);
    await logActivity(req.user.id, req.user.name, 'contractor_invoice_submitted', 'contractor_invoice', inv.id, { totalCents: inv.totalCents });
    res.json({ invoice: inv });
  });

  // ---- tax forms (W-2, 1099-NEC), link-only ------------------------------------------
  router.get('/api/my/tax-forms', authenticateToken, requireStaff, async (req, res) => {
    const forms = ((await db.get('payroll_year_end')) || []).filter(f => f.released && (f.w2 || []).concat(f.nec || []).some(x => String(x.userId) === String(req.user.id)))
      .map(f => ({ year: f.year, forms: [...(f.w2 || []).filter(x => String(x.userId) === String(req.user.id)).map(() => 'W-2'), ...(f.nec || []).filter(x => String(x.userId) === String(req.user.id)).map(() => '1099-NEC')] }));
    res.json({ forms });
  });

  // ===================================================================================
  // THE OWNER'S: /api/payroll/admin/*
  // ===================================================================================
  const staffPeople = async () => {
    const users = (await getUsers()).filter(u => u && isStaff(u) && u.accountStatus !== 'inactive');
    const all = await readProfiles();
    const out = [];
    for (const u of users) {
      const p = all[String(u.id)] || pp.defaultProfile(u, { relationship: await relationshipFor(u.id) });
      out.push({ user: u, profile: p });
    }
    return out;
  };

  router.get('/api/payroll/admin/overview', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const settings = await readSettings();
      const people = await staffPeople();
      const runs = await rows(RUNS);
      const allTables = await rows(TAX_TABLES);
      const year = Number(nowIso().slice(0, 4));
      res.json({
        settings, frequencies: Object.keys(tax.FREQUENCIES),
        secretsStorable: pc.configured(env), automationKeySet: !!payrollKey(),
        tablesActive: !!(await activeTables(year)), tablesActiveNextYear: !!(await activeTables(year + 1)),
        taxTables: allTables.map(t => ({ id: t.id, year: t.year, jurisdiction: t.jurisdiction, status: t.status, source: t.source, stagedAt: t.stagedAt, approvedAt: t.approvedAt || null, approvedBy: t.approvedBy || null, data: t.data })),
        people: people.map(({ user, profile }) => ({
          userId: String(user.id), name: user.name || user.email, accountType: accountTypeOf(user), email: user.email,
          profile: pp.publicProfile(profile), missing: pp.missingForPay(profile), missingContractor: pp.isContractor(profile) ? pp.missingForPay(profile, { asContractor: true }) : [],
          caregiverPayRate: profile.isCaregiver ? (user.payRate || null) : null
        })).sort((a, b) => a.name.localeCompare(b.name)),
        runs: runs.map(r => ({ id: r.id, status: r.status, period: r.period, totals: r.totals, blocked: r.blocked, createdAt: r.createdAt, approvedAt: r.approvedAt || null, paidAt: r.paidAt || null }))
          .sort((a, b) => String(b.period.start).localeCompare(String(a.period.start))),
        nextPeriod: tax.periodFor((localDate(nowIso()) || nowIso().slice(0, 10)), settings),
        contractorInvoices: (await rows(CONTRACTOR_INVOICES)).filter(x => x.status !== 'paid' && x.status !== 'rejected'),
        workTypes: WORK_TYPES, payTypes: pp.PAY_TYPES, workerTypes: pp.WORKER_TYPES, wageAccounts: pp.WAGE_ACCOUNTS
      });
    } catch (e) { console.error('Payroll overview error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  router.put('/api/payroll/admin/settings', authenticateToken, requireAdmin, async (req, res) => {
    const cur = await readSettings();
    const n = tax.normalizeSettings(req.body, cur);
    if (n.error) return res.status(400).json(n);
    // A frequency change takes effect from the next period that has not
    // started: the anchor moves to that period's Monday, so a run already
    // drafted is never re-cut.
    if (n.value.frequency !== cur.frequency && (req.body || {}).anchor === undefined) {
      const today = localDate(nowIso()) || nowIso().slice(0, 10);
      const curPeriod = tax.periodFor(today, cur);
      n.value.anchor = tax.addDays(curPeriod.end, 1);
    }
    if ((req.body || {}).employerEin !== undefined) {
      const e = String(req.body.employerEin || '').replace(/\D/g, '');
      if (e && e.length !== 9) return res.status(400).json({ error: 'An EIN has 9 digits.', code: 'EMPLOYER_EIN' });
      n.value.employerEin = e ? `${e.slice(0, 2)}-${e.slice(2)}` : null;
    }
    await db.set(SETTINGS, n.value);
    await logActivity(req.user.id, req.user.name, 'payroll_settings_updated', 'payroll_settings', null, { frequency: n.value.frequency, anchor: n.value.anchor });
    res.json({ settings: n.value });
  });

  router.put('/api/payroll/admin/people/:userId', authenticateToken, requireAdmin, async (req, res) => {
    const user = (await getUsers()).find(u => u && String(u.id) === String(req.params.userId));
    if (!user || !isStaff(user)) return res.status(404).json({ error: 'Staff member not found.' });
    const n = pp.normalizePaySetup(req.body);
    if (n.error) return res.status(400).json(n);
    const p = await profileFor(user);
    Object.assign(p, n.value);
    const saved = await saveProfile(user.id, p, `Pay setup: ${Object.keys(n.value).join(', ')}`, req.user);
    res.json({ profile: pp.publicProfile(saved), missing: pp.missingForPay(saved) });
  });

  router.put('/api/payroll/admin/people/:userId/i9-section2', authenticateToken, requireAdmin, async (req, res) => {
    const user = (await getUsers()).find(u => u && String(u.id) === String(req.params.userId));
    if (!user || !isStaff(user)) return res.status(404).json({ error: 'Staff member not found.' });
    const p = await profileFor(user);
    if (!(p.i9 && p.i9.section1)) return res.status(409).json({ error: 'The employee completes Section 1 first.', code: 'I9_SECTION1_FIRST' });
    const n = pp.normalizeI9Section2(req.body, { at: nowIso(), by: req.user.name || req.user.email });
    if (n.error) return res.status(400).json(n);
    p.i9 = { ...p.i9, section2: n.value };
    const saved = await saveProfile(user.id, p, 'I-9 Section 2 completed', req.user);
    res.json({ profile: pp.publicProfile(saved), missing: pp.missingForPay(saved) });
  });

  router.post('/api/payroll/admin/people/:userId/new-hire-reported', authenticateToken, requireAdmin, async (req, res) => {
    const user = (await getUsers()).find(u => u && String(u.id) === String(req.params.userId));
    if (!user || !isStaff(user)) return res.status(404).json({ error: 'Staff member not found.' });
    const p = await profileFor(user);
    p.newHireReportedAt = nowIso();
    const saved = await saveProfile(user.id, p, 'Georgia new hire report filed', req.user);
    res.json({ profile: pp.publicProfile(saved) });
  });

  // The owner's on-demand reveal of one full number. Every reveal is logged:
  // who, whose, which field. The value itself is never logged.
  router.post('/api/payroll/admin/people/:userId/reveal', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const all = await readProfiles();
      const p = all[String(req.params.userId)];
      const field = String((req.body || {}).field || '');
      const sealed = !p ? null : field === 'ssn' ? p.ssn && p.ssn.enc : field === 'tin' ? p.tin && p.tin.enc
        : field === 'routing' ? p.payMethod && p.payMethod.routingEnc : field === 'account' ? p.payMethod && p.payMethod.accountEnc : undefined;
      if (sealed === undefined) return res.status(400).json({ error: 'Reveal ssn, tin, routing or account.', code: 'REVEAL_FIELD' });
      if (!sealed) return res.status(404).json({ error: 'Nothing on file.', code: 'REVEAL_NONE' });
      const value = pc.open(sealed, env);
      await logActivity(req.user.id, req.user.name, 'payroll_secret_revealed', 'payroll_profile', String(req.params.userId), { field });
      res.json({ value });
    } catch (e) {
      if (e.code === 'PAYROLL_KEY_MISSING') return res.status(503).json({ error: e.message, code: e.code });
      res.status(500).json({ error: 'That value could not be read.' });
    }
  });

  // ---- tax tables (step 2) -----------------------------------------------------------
  // Shipped tables are seeded STAGED. Nothing pays from a table the owner has
  // not approved.
  router.post('/api/payroll/admin/tax-tables', authenticateToken, requireAdmin, async (req, res) => {
    const v = tables.validateTable(req.body || {});
    if (v.error) return res.status(400).json(v);
    const all = await rows(TAX_TABLES);
    const t = { id: uuidv4(), ...v.value, status: 'staged', stagedAt: nowIso(), stagedBy: req.user.name, source: str((req.body || {}).source, 500) || 'Entered by the owner' };
    all.push(t);
    await db.set(TAX_TABLES, all);
    await logActivity(req.user.id, req.user.name, 'tax_table_staged', 'tax_table', t.id, { year: t.year, jurisdiction: t.jurisdiction });
    res.json({ table: t });
  });
  router.post('/api/payroll/admin/tax-tables/:id/approve', authenticateToken, requireAdmin, async (req, res) => {
    const all = await rows(TAX_TABLES);
    const i = all.findIndex(t => t.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'Table not found.' });
    if (all[i].status !== 'staged') return res.status(409).json({ error: 'Only a staged table can be approved.', code: 'TABLE_NOT_STAGED' });
    for (const t of all) if (t.jurisdiction === all[i].jurisdiction && Number(t.year) === Number(all[i].year) && t.status === 'active') { t.status = 'retired'; t.retiredAt = nowIso(); }
    all[i] = { ...all[i], status: 'active', approvedAt: nowIso(), approvedBy: req.user.name || req.user.email };
    await db.set(TAX_TABLES, all);
    await logActivity(req.user.id, req.user.name, 'tax_table_approved', 'tax_table', all[i].id, { year: all[i].year, jurisdiction: all[i].jurisdiction });
    res.json({ table: all[i] });
  });

  // ---- runs (steps 3-4) -----------------------------------------------------------------
  const gatherFor = async (period, runs) => {
    const users = await getUsers();
    const all = await readProfiles();
    const profilesById = new Map(Object.entries(all));
    return engine.gatherItems({
      period, users, profilesById,
      timeLogs: await rows('time_logs'), shifts: await rows('shifts'), visitTimings: await rows('visit_timings'),
      staffEntries: await rows(CLOCK), imeCases: await rows('ime_cases'),
      paidRefs: engine.paidRefsFrom(runs), localDate, resolvePayRate
    });
  };
  const draftFor = async (period, settings, adjustments) => {
    const runs = await rows(RUNS);
    const tbl = await activeTables(Number(period.payDate.slice(0, 4)));
    if (!tbl) return { error: `No approved ${period.payDate.slice(0, 4)} tax tables. Approve the federal and Georgia tables under Taxes first.`, code: 'PAYROLL_NO_TABLES' };
    const gathered = await gatherFor(period, runs.filter(r => r.status !== 'draft'));
    const people = (await staffPeople()).filter(x => pp.isEmployee(x.profile) && x.profile.status !== 'inactive');
    const run = engine.buildRun({
      period, settings, people, gathered, tables: tbl,
      ytdByUser: engine.ytdFrom(runs, { year: period.payDate.slice(0, 4), beforePayDate: period.payDate }),
      adjustments
    });
    run.skippedItems = gathered.skipped;
    run.tableIds = tbl.ids;
    return { run };
  };

  router.post('/api/payroll/admin/runs', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const settings = await readSettings();
      const start = String((req.body || {}).periodStart || '');
      if (!tax.isYmd(start)) return res.status(400).json({ error: 'Give a date in the pay period.', code: 'RUN_PERIOD' });
      const period = tax.periodFor(start, settings);
      const runs = await rows(RUNS);
      const existing = runs.find(r => r.period.start === period.start && r.status !== 'void');
      if (existing && existing.status !== 'draft') return res.status(409).json({ error: 'That period is already approved.', code: 'RUN_ALREADY_APPROVED', runId: existing.id });
      const d = await draftFor(period, settings, existing ? existing.adjustments : []);
      if (d.error) return res.status(409).json(d);
      const run = { id: existing ? existing.id : uuidv4(), status: 'draft', ...d.run, adjustments: existing ? existing.adjustments || [] : [], createdAt: existing ? existing.createdAt : nowIso(), rebuiltAt: nowIso(), createdBy: req.user.name };
      const next = existing ? runs.map(r => (r.id === run.id ? run : r)) : [...runs, run];
      await db.set(RUNS, next);
      await logActivity(req.user.id, req.user.name, 'payroll_run_drafted', 'payroll_run', run.id, { period: period.start, workers: run.workers.length, grossCents: run.totals.grossCents });
      res.json({ run });
    } catch (e) { console.error('Payroll draft error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  router.get('/api/payroll/admin/runs/:id', authenticateToken, requireAdmin, async (req, res) => {
    const run = (await rows(RUNS)).find(r => r.id === req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found.' });
    res.json({ run });
  });

  router.post('/api/payroll/admin/runs/:id/adjustments', authenticateToken, requireAdmin, async (req, res) => {
    const runs = await rows(RUNS);
    const i = runs.findIndex(r => r.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'Run not found.' });
    if (runs[i].status !== 'draft') return res.status(409).json({ error: 'An approved run is locked. Add the correction to the next run.', code: 'RUN_LOCKED' });
    const b = req.body || {};
    if (!engine.ADJUSTMENT_TYPES[b.type]) return res.status(400).json({ error: 'Bonus, reimbursement or correction.', code: 'ADJ_TYPE' });
    const cents = b.type === 'correction' ? Math.round(Number(b.amount) * 100) : toCents(b.amount);
    if (!Number.isFinite(cents) || cents === 0) return res.status(400).json({ error: 'Give an amount.', code: 'ADJ_AMOUNT' });
    const note = str(b.note, 300);
    if (!note) return res.status(400).json({ error: 'Say what it is for.', code: 'ADJ_NOTE' });
    const adjustments = [...(runs[i].adjustments || []), { id: uuidv4(), userId: String(b.userId), type: b.type, amountCents: cents, note, by: req.user.name, at: nowIso() }];
    const d = await draftFor(runs[i].period, await readSettings(), adjustments);
    if (d.error) return res.status(409).json(d);
    runs[i] = { ...runs[i], ...d.run, adjustments, rebuiltAt: nowIso() };
    await db.set(RUNS, runs);
    await logActivity(req.user.id, req.user.name, 'payroll_adjustment_added', 'payroll_run', runs[i].id, { type: b.type, amountCents: cents });
    res.json({ run: runs[i] });
  });

  // Approve: only the owner, never with anyone missing paperwork. The run is
  // rebuilt from the hours one last time, frozen, and its hours lock.
  router.post('/api/payroll/admin/runs/:id/approve', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const runs = await rows(RUNS);
      const i = runs.findIndex(r => r.id === req.params.id);
      if (i === -1) return res.status(404).json({ error: 'Run not found.' });
      if (runs[i].status !== 'draft') return res.status(409).json({ error: 'Already approved.', code: 'RUN_LOCKED' });
      const settings = await readSettings();
      const d = await draftFor(runs[i].period, settings, runs[i].adjustments || []);
      if (d.error) return res.status(409).json(d);
      if (d.run.blocked.length) return res.status(409).json({ error: `${d.run.blocked.length} ${d.run.blocked.length === 1 ? 'person is' : 'people are'} missing paperwork. Nobody can be paid until it is on file.`, code: 'RUN_BLOCKED', blocked: d.run.blocked });
      if (!d.run.workers.length) return res.status(409).json({ error: 'Nobody has pay in this period.', code: 'RUN_EMPTY' });
      if (d.run.sutaRateMissing) return res.status(409).json({ error: 'Set GFC\'s Georgia unemployment rate under Settings first. It is on the GA DOL notice.', code: 'RUN_NO_SUTA_RATE' });
      const at = nowIso();
      const approved = { ...runs[i], ...d.run, status: 'approved', approvedAt: at, approvedBy: req.user.name || req.user.email, payments: {} };
      approved.liabilities = cal.liabilitiesForRun(approved, settings);
      runs[i] = approved;
      await db.set(RUNS, runs);
      // Lock the caregiver time logs this run paid, so an edit cannot quietly
      // change hours already paid.
      const logIds = new Set(approved.workers.flatMap(w => w.refs).filter(r => r.startsWith('log:')).map(r => r.slice(4)));
      if (logIds.size) {
        const logs = await rows('time_logs');
        for (const l of logs) if (l && logIds.has(String(l.id))) { l.payroll_run_id = approved.id; l.payroll_locked_at = at; }
        await db.set('time_logs', logs);
      }
      await logActivity(req.user.id, req.user.name, 'payroll_run_approved', 'payroll_run', approved.id, { period: approved.period.start, grossCents: approved.totals.grossCents, netCents: approved.totals.netCents });
      const stubs = await writeStubs(approved, settings);
      if (deps.onRunApproved) await deps.onRunApproved(approved).catch(e => console.error('QuickBooks payroll sync (non-fatal):', e.message));
      res.json({ run: approved, stubs });
    } catch (e) { console.error('Payroll approve error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // Each worker's stub: a PDF filed in their role folder, a row in
  // staff_paystubs (the store My GFC already lists), and a link-only email.
  const writeStubs = async (run, settings) => {
    const users = await getUsers();
    const all = await readProfiles();
    const ytd = engine.ytdFrom((await rows(RUNS)), { year: run.period.payDate.slice(0, 4) });   // includes this run
    const stubs = await rows(PAYSTUBS);
    const report = { written: 0, pdfFailed: 0 };
    for (const w of run.workers.filter(x => x.pay)) {
      const user = users.find(u => String(u.id) === w.userId);
      const p = all[w.userId] || {};
      let driveFileId = null;
      try {
        const buf = await pdf.generatePayStubPDF({ run, worker: w, ytd: ytd.get(w.userId), employerEin: settings.employerEin || null,
          ssnLast4: p.ssn ? p.ssn.last4 : null, accountLast4: p.payMethod ? p.payMethod.accountLast4 : null, payMethod: p.payMethod ? p.payMethod.method : null });
        const stored = await drive.uploadStaffDocumentFile(roleFolderFor(accountTypeOf(user)), personFolderName(user.name, user.id), `Pay stub ${run.period.payDate}.pdf`, buf, 'application/pdf');
        driveFileId = stored.fileId || stored.id || null;
      } catch (e) { report.pdfFailed++; console.error('Pay stub PDF error (non-fatal):', e.message); }
      const hours = Math.round(((w.earnings.find(e => e.code === 'regular') || {}).minutes || 0) / 60 * 100) / 100;
      const row = { id: uuidv4(), userId: w.userId, payDate: run.period.payDate, periodStart: run.period.start, periodEnd: run.period.end,
        gross: w.pay.grossCents / 100, net: w.pay.netCents / 100, hours, reference: `run:${run.id}`, driveFileId, source: 'app', runId: run.id, importedAt: nowIso() };
      const at = stubs.findIndex(x => String(x.userId) === row.userId && x.payDate === row.payDate && x.reference === row.reference);
      if (at === -1) stubs.push(row); else { row.id = stubs[at].id; stubs[at] = row; }
      report.written++;
      if (user && user.email && queueNotification) {
        // Link-only: says a stub is ready, never an amount (spec v2 item 16).
        const base = getAppBaseUrl ? await getAppBaseUrl() : '';
        await queueNotification('paystub_ready', user.id, user.email, user.name, {
          subject: 'Your pay stub is ready',
          body: `Your pay stub for the pay date ${run.period.payDate} is ready. Sign in to GFC to view it.`,
          ctaUrl: `${base}${links.payFor(user)}`, ctaLabel: 'View Pay Stub'
        }, { relatedEntityId: `${run.id}:${w.userId}`, relatedEntityType: 'paystub' });
      }
    }
    await db.set(PAYSTUBS, stubs);
    return report;
  };

  // ---- PNC payment sheet (step 5) ------------------------------------------------------
  router.get('/api/payroll/admin/runs/:id/payment-sheet', authenticateToken, requireAdmin, async (req, res) => {
    const run = (await rows(RUNS)).find(r => r.id === req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found.' });
    if (run.status === 'draft') return res.status(409).json({ error: 'Approve the run first.', code: 'RUN_NOT_APPROVED' });
    const all = await readProfiles();
    const sheet = run.workers.filter(w => w.pay).map(w => {
      const pm = (all[w.userId] || {}).payMethod || {};
      const paid = (run.payments || {})[w.userId] || null;
      return { userId: w.userId, name: w.name, netCents: w.pay.netCents, net: usd(w.pay.netCents), method: pm.method || null,
        bankName: pm.bankName || null, accountType: pm.accountType || null, routingLast4: pm.routingLast4 || null, accountLast4: pm.accountLast4 || null, paid };
    });
    await logActivity(req.user.id, req.user.name, 'payment_sheet_opened', 'payroll_run', run.id, {});
    res.json({ run: { id: run.id, status: run.status, period: run.period }, sendBy: tax.sendByDate(run.period.payDate), sheet, contractors: (await rows(CONTRACTOR_INVOICES)).filter(x => x.status === 'approved') });
  });
  router.post('/api/payroll/admin/runs/:id/payments/:userId', authenticateToken, requireAdmin, async (req, res) => {
    const runs = await rows(RUNS);
    const i = runs.findIndex(r => r.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'Run not found.' });
    if (runs[i].status === 'draft') return res.status(409).json({ error: 'Approve the run first.', code: 'RUN_NOT_APPROVED' });
    const w = runs[i].workers.find(x => x.userId === String(req.params.userId) && x.pay);
    if (!w) return res.status(404).json({ error: 'Nobody by that id is paid in this run.' });
    const conf = str((req.body || {}).confirmation, 80);
    if (!conf) return res.status(400).json({ error: 'Paste the PNC confirmation number (or the check number).', code: 'PAYMENT_CONFIRMATION' });
    runs[i].payments = { ...(runs[i].payments || {}), [w.userId]: { confirmation: conf, at: nowIso(), by: req.user.name } };
    // Paid only when every worker has a confirmation.
    const everyone = runs[i].workers.filter(x => x.pay).every(x => runs[i].payments[x.userId]);
    if (everyone && runs[i].status !== 'paid') { runs[i].status = 'paid'; runs[i].paidAt = nowIso(); }
    await db.set(RUNS, runs);
    await logActivity(req.user.id, req.user.name, 'payroll_payment_confirmed', 'payroll_run', runs[i].id, { userId: w.userId, runPaid: runs[i].status === 'paid' });
    if (deps.onWorkerPaid) await deps.onWorkerPaid(runs[i], w).catch(e => console.error('QuickBooks payment sync (non-fatal):', e.message));
    if (everyone && deps.onRunPaid) await deps.onRunPaid(runs[i]).catch(() => {});
    res.json({ run: { id: runs[i].id, status: runs[i].status, payments: runs[i].payments } });
  });

  // ---- contractor invoices, the owner's side (step 8) -------------------------------
  router.post('/api/payroll/admin/contractor-invoices/:id/:action', authenticateToken, requireAdmin, async (req, res) => {
    const all = await rows(CONTRACTOR_INVOICES);
    const i = all.findIndex(x => x.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'Invoice not found.' });
    const inv = all[i], b = req.body || {}, act = req.params.action;
    if (act === 'approve') {
      if (inv.status !== 'submitted') return res.status(409).json({ error: 'Only a submitted invoice can be approved.', code: 'CI_STATE' });
      const p = (await readProfiles())[inv.userId];
      const missing = pp.missingForPay(p, { asContractor: true });
      if (missing.length) return res.status(409).json({ error: `Missing before they can be paid: ${missing.join(', ')}.`, code: 'CI_MISSING_PAPERWORK' });
      Object.assign(inv, { status: 'approved', reviewedAt: nowIso(), reviewedBy: req.user.name });
    } else if (act === 'reject') {
      if (inv.status !== 'submitted') return res.status(409).json({ error: 'Only a submitted invoice can be sent back.', code: 'CI_STATE' });
      const note = str(b.note, 500);
      if (!note) return res.status(400).json({ error: 'Say what to fix, so they can resubmit.', code: 'CI_REJECT_NOTE' });
      Object.assign(inv, { status: 'rejected', reviewedAt: nowIso(), reviewedBy: req.user.name, reviewNote: note });
    } else if (act === 'pay') {
      if (inv.status !== 'approved') return res.status(409).json({ error: 'Approve it first.', code: 'CI_STATE' });
      const conf = str(b.confirmation, 80);
      if (!conf) return res.status(400).json({ error: 'Paste the PNC or Wise confirmation number.', code: 'CI_CONFIRMATION' });
      Object.assign(inv, { status: 'paid', paidAt: nowIso(), paidBy: req.user.name, paymentConfirmation: conf });
    } else return res.status(404).json({ error: 'Unknown action.' });
    inv.history = [...(inv.history || []), { at: nowIso(), action: act, by: req.user.name }];
    all[i] = inv;
    await db.set(CONTRACTOR_INVOICES, all);
    await logActivity(req.user.id, req.user.name, `contractor_invoice_${act === 'pay' ? 'paid' : act + 'd'}`, 'contractor_invoice', inv.id, { totalCents: inv.totalCents });
    if (act === 'pay' && deps.onContractorPaid) await deps.onContractorPaid(inv).catch(e => console.error('QuickBooks contractor sync (non-fatal):', e.message));
    res.json({ invoice: inv });
  });

  // ---- examiner payouts (step 7) -----------------------------------------------------
  // A 1099 examiner, or one set up as both (contractor for exams), is paid from
  // their completed exams as a contractor invoice the office builds. It goes
  // through the same approve and pay steps as any other, and an exam already
  // on a payout is never paid twice.
  router.post('/api/payroll/admin/examiner-payouts', authenticateToken, requireAdmin, async (req, res) => {
    const b = req.body || {};
    if (!tax.isYmd(b.from) || !tax.isYmd(b.to) || b.to < b.from) return res.status(400).json({ error: 'Give the period.', code: 'PAYOUT_PERIOD' });
    const ime = require('../imeBilling');
    const all = await rows(CONTRACTOR_INVOICES);
    const paidCaseIds = new Set(all.filter(x => x.status !== 'rejected').flatMap(x => (x.lines || []).map(l => l.imeCaseId).filter(Boolean)));
    const cases = await rows('ime_cases');
    const profiles = await readProfiles();
    const users = await getUsers();
    const made = [], skipped = [];
    for (const examinerId of [...new Set(cases.map(c => c && c.examinerId).filter(Boolean).map(String))]) {
      const p = profiles[examinerId];
      if (!p || !pp.isContractor(p)) continue;    // W-2 examiners are paid through payroll
      const u = users.find(x => String(x.id) === examinerId);
      if (!(p.perExamRateCents > 0)) { skipped.push({ name: u ? u.name : examinerId, reason: 'No per-exam rate set.' }); continue; }
      const lines = ime.examinerPayoutLines({ cases, examinerId, perExamRateCents: p.perExamRateCents, paidCaseIds, from: b.from, to: b.to, localDate });
      if (!lines.length) continue;
      const inv = { id: uuidv4(), userId: examinerId, name: u ? u.name : examinerId, invoiceNo: `IME-${b.to}`, periodStart: b.from, periodEnd: b.to,
        lines, totalCents: lines.reduce((s, l) => s + l.amountCents, 0), status: 'submitted', source: 'ime_exams', submittedAt: nowIso(),
        history: [{ at: nowIso(), action: 'built from completed exams', by: req.user.name }] };
      all.push(inv); made.push(inv);
    }
    await db.set(CONTRACTOR_INVOICES, all);
    await logActivity(req.user.id, req.user.name, 'examiner_payouts_built', 'contractor_invoice', null, { count: made.length, from: b.from, to: b.to });
    res.json({ created: made.length, skipped });
  });

  // ---- taxes: calendar, payments, filings, exports (step 10) -------------------------
  const taxView = async () => {
    const settings = await readSettings();
    const runs = await rows(RUNS);
    const year = Number(nowIso().slice(0, 4));
    const filingConf = await rows(FILINGS);
    return {
      settings,
      deposits: cal.calendar(runs, await rows(TAX_PAYMENTS), settings),
      filings: [...cal.filings(year - 1), ...cal.filings(year)].map(f => ({ ...f, confirmation: filingConf.find(c => c.key === f.key) || null }))
        .filter(f => !f.confirmation || f.dueDate >= `${year}-01-01`)
    };
  };
  router.get('/api/payroll/admin/taxes', authenticateToken, requireAdmin, async (req, res) => res.json(await taxView()));
  router.post('/api/payroll/admin/taxes/payments', authenticateToken, requireAdmin, async (req, res) => {
    const b = req.body || {};
    const cents = toCents(b.amount);
    const conf = str(b.confirmation, 80);
    if (!str(b.key) || !cents || !conf) return res.status(400).json({ error: 'Give the deposit, the amount and the confirmation number.', code: 'TAX_PAYMENT' });
    const all = await rows(TAX_PAYMENTS);
    const pay = { id: uuidv4(), key: str(b.key, 80), amountCents: cents, confirmation: conf, paidAt: tax.isYmd(b.paidAt) ? b.paidAt : nowIso().slice(0, 10), by: req.user.name, at: nowIso() };
    all.push(pay);
    await db.set(TAX_PAYMENTS, all);
    await logActivity(req.user.id, req.user.name, 'tax_deposit_recorded', 'tax_payment', pay.id, { key: pay.key, amountCents: cents });
    if (deps.onTaxPaid) await deps.onTaxPaid(pay).catch(e => console.error('QuickBooks tax sync (non-fatal):', e.message));
    res.json({ payment: pay });
  });
  router.post('/api/payroll/admin/filings/:key/confirm', authenticateToken, requireAdmin, async (req, res) => {
    const conf = str((req.body || {}).confirmation, 80);
    if (!conf) return res.status(400).json({ error: 'Give the filing confirmation.', code: 'FILING_CONFIRMATION' });
    const all = (await rows(FILINGS)).filter(f => f.key !== req.params.key);
    all.push({ key: req.params.key, confirmation: conf, at: nowIso(), by: req.user.name });
    await db.set(FILINGS, all);
    await logActivity(req.user.id, req.user.name, 'tax_filing_confirmed', 'tax_filing', req.params.key, {});
    res.json({ ok: true });
  });
  router.get('/api/payroll/admin/quarter/:year/:q', authenticateToken, requireAdmin, async (req, res) => {
    const tbl = await activeTables(Number(req.params.year));
    if (!tbl) return res.status(409).json({ error: 'No approved tables for that year.', code: 'PAYROLL_NO_TABLES' });
    const s = cal.quarterSummary(await rows(RUNS), { year: req.params.year, quarter: req.params.q, fed: tbl.federal, sutaWageBaseCents: tbl.GA.sutaWageBaseCents });
    await logActivity(req.user.id, req.user.name, 'quarter_summary_opened', 'payroll', null, { year: req.params.year, quarter: req.params.q });
    res.json(s);
  });
  router.get('/api/payroll/admin/year-end/:year', authenticateToken, requireAdmin, async (req, res) => {
    const tbl = await activeTables(Number(req.params.year));
    if (!tbl) return res.status(409).json({ error: 'No approved tables for that year.', code: 'PAYROLL_NO_TABLES' });
    const paid = (await rows(CONTRACTOR_INVOICES)).filter(x => x.status === 'paid').map(x => ({ userId: x.userId, name: x.name, amountCents: x.totalCents, paidAt: x.paidAt }));
    const y = cal.yearEnd(await rows(RUNS), paid, { year: req.params.year, fed: tbl.federal });
    await logActivity(req.user.id, req.user.name, 'year_end_opened', 'payroll', null, { year: req.params.year });
    if (req.query.format === 'csv') {
      const head = 'Form,Name,Box 1,Box 2,Box 3,Box 4,Box 5,Box 6,Box 16 (GA wages),Box 17 (GA tax)\r\n';
      const d = (c) => (Number(c || 0) / 100).toFixed(2);
      const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
      const body = [...y.w2.map(e => ['W-2', q(e.name), d(e.box1), d(e.box2), d(e.box3), d(e.box4), d(e.box5), d(e.box6), d(e.box16), d(e.box17)].join(',')),
        ...y.nec.map(e => ['1099-NEC', q(e.name), d(e.box1), '', '', '', '', '', '', ''].join(','))].join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', contentDisposition('attachment', `gfc_year_end_${req.params.year}.csv`));
      return res.send(head + body + '\r\n');
    }
    res.json(y);
  });

  // ===================================================================================
  // AUTOMATIONS (Apps Script): POST /api/payroll/automation/:job
  // Same key and header as the pay stub import. Each job only READS and
  // DRAFTS; it never approves, pays or activates anything.
  // ===================================================================================
  router.post('/api/payroll/automation/:job', async (req, res) => {
    const key = payrollKey();
    if (!key) return res.status(503).json({ error: 'Payroll automations are not switched on. Set PAYROLL_INGEST_KEY.', code: 'PAYROLL_INGEST_NOT_CONFIGURED' });
    if (!keyOk(req, key)) return res.status(401).json({ error: 'Wrong payroll key.', code: 'PAYROLL_KEY_INVALID' });
    try {
      const out = await (deps.automationJobs || automationJobs)[req.params.job]?.(req.body || {});
      if (out === undefined) return res.status(404).json({ error: 'Unknown job.', code: 'AUTOMATION_UNKNOWN_JOB' });
      await logActivity(null, 'Payroll automation', `payroll_automation_${req.params.job.replace(/-/g, '_')}`, 'payroll', null, { result: out.summary || null });
      res.json(out);
    } catch (e) { console.error('Payroll automation error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  const admins = async () => (await getUsers()).filter(u => u && u.role === 'admin' && u.accountStatus !== 'inactive' && u.email);
  const tellOwner = async (type, subject, body, related) => {
    for (const a of await admins()) {
      await queueNotification(type, a.id, a.email, a.name, { subject, body, ctaUrl: `${getAppBaseUrl ? await getAppBaseUrl() : ''}${links.PATHS.PAYROLL_ADMIN}`, ctaLabel: 'Open Payroll' }, { relatedEntityId: related });
    }
  };
  const automationJobs = {
    // The day after a period ends: draft its run and tell the owner.
    'period-close': async () => {
      const settings = await readSettings();
      const today = localDate(nowIso()) || nowIso().slice(0, 10);
      const period = tax.periodFor(tax.addDays(tax.periodFor(today, settings).start, -1), settings);
      const runs = await rows(RUNS);
      const existing = runs.find(r => r.period.start === period.start);
      if (existing && existing.status !== 'draft') return { summary: 'already approved', period };
      const d = await draftFor(period, settings, existing ? existing.adjustments || [] : []);
      if (d.error) { await tellOwner('payroll_period_close', 'Payroll could not be drafted', d.error, `close:${period.start}`); return { summary: d.code, period }; }
      const run = { id: existing ? existing.id : uuidv4(), status: 'draft', ...d.run, adjustments: existing ? existing.adjustments || [] : [], createdAt: existing ? existing.createdAt : nowIso(), rebuiltAt: nowIso(), createdBy: 'Payroll automation' };
      await db.set(RUNS, existing ? runs.map(r => (r.id === run.id ? run : r)) : [...runs, run]);
      await tellOwner('payroll_period_close', `Payroll for ${period.start} to ${period.end} is ready to review`,
        `The draft is ready. ${run.workers.length} people, ${run.blocked.length} missing paperwork. Review and approve it in the app.`, `close:${period.start}`);
      return { summary: 'drafted', period, workers: run.workers.length, blocked: run.blocked.length };
    },
    // Open clock-ins and missing clock-outs.
    'missing-time': async () => {
      const open = (await rows(CLOCK)).filter(e => !e.clockOutAt && !e.voided && Date.now() - Date.parse(e.clockInAt) > 12 * 3600000);
      const users = await getUsers();
      for (const e of open) {
        const u = users.find(x => String(x.id) === e.userId);
        if (u && u.email) await queueNotification('staff_clock_open', u.id, u.email, u.name, { subject: 'You are still clocked in', body: 'You clocked in more than 12 hours ago and have not clocked out. Clock out, or tell the office the right time.', ctaUrl: `${getAppBaseUrl ? await getAppBaseUrl() : ''}${links.payFor(u)}`, ctaLabel: 'Open My GFC' }, { relatedEntityId: e.id });
      }
      return { summary: `${open.length} open` };
    },
    // On the send-by date, any approved run not fully paid.
    'payment-reminder': async () => {
      const today = localDate(nowIso()) || nowIso().slice(0, 10);
      const due = (await rows(RUNS)).filter(r => r.status === 'approved' && tax.sendByDate(r.period.payDate) <= today);
      for (const r of due) await tellOwner('payroll_payment_reminder', `Send payroll for pay date ${r.period.payDate}`, 'Send the PNC payments, then enter each confirmation number in the app.', `pay:${r.id}:${today}`);
      return { summary: `${due.length} due` };
    },
    // Deposits and filings coming due within the lead time.
    'tax-reminders': async () => {
      const v = await taxView();
      const today = localDate(nowIso()) || nowIso().slice(0, 10);
      let lead = today; for (let i = 0; i < v.settings.reminderLeadBusinessDays; i++) { lead = tax.addDays(lead, 1); while ([0, 6].includes(new Date(`${lead}T12:00:00Z`).getUTCDay())) lead = tax.addDays(lead, 1); }
      const deposits = v.deposits.filter(d => d.open && d.dueDate <= lead);
      const filingsDue = v.filings.filter(f => !f.confirmation && f.dueDate <= lead && f.dueDate >= today);
      if (deposits.length || filingsDue.length) {
        await tellOwner('payroll_tax_reminder', 'Payroll taxes coming due',
          [...deposits.map(d => `${d.label}: due ${d.dueDate}`), ...filingsDue.map(f => `${f.form}: due ${f.dueDate}`)].join('\n'), `tax:${today}`);
      }
      return { summary: `${deposits.length} deposits, ${filingsDue.length} filings` };
    },
    // A tax source the script watches changed. The owner reviews and stages
    // the new figures; nothing changes pay on its own.
    'tax-source-changed': async (b) => {
      const src = str(b.source, 200), url = str(b.url, 500);
      await tellOwner('payroll_tax_source_changed', 'A payroll tax source changed', `${src || 'A tax source'} changed (${url}). Review the new figures and approve a new table before they apply.`, `src:${src}:${str(b.hash, 80)}`);
      return { summary: 'owner told' };
    },
    'qbo-sync': async () => (deps.qboRetry ? deps.qboRetry() : { summary: 'QuickBooks not connected' })
  };

  return router;
};

module.exports.WORK_TYPES = WORK_TYPES;
module.exports.keyOk = keyOk;
