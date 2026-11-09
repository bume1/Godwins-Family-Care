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
const ye = require('../payrollYearEnd');
const gusto = require('../payrollGustoImport');
const { ORG } = require('../public/consent-text');
const { contentDisposition } = require('../contentDisposition');

const PROFILES = 'payroll_profiles';          // { [userId]: profile }
const SETTINGS = 'payroll_settings';
const TAX_TABLES = 'payroll_tax_tables';
const RUNS = 'payroll_runs';
const CONTRACTOR_INVOICES = 'contractor_invoices';
const TAX_PAYMENTS = 'payroll_tax_payments';
const FILINGS = 'payroll_filing_confirmations';
const YEAR_END = 'payroll_year_end';          // one row per released tax year
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
  // Every profile read carries the user record's employmentType (one source).
  const readProfiles = async () => {
    const raw = (await db.get(PROFILES)) || {};
    const users = new Map(((await getUsers()) || []).filter(Boolean).map(u => [String(u.id), u]));
    const out = {};
    for (const [id, p] of Object.entries(raw)) out[id] = pp.withEmploymentType(p, users.get(id));
    return out;
  };
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
    return all[String(user.id)] || pp.withEmploymentType(pp.defaultProfile(user, { relationship: await relationshipFor(user.id) }), user);
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
    if (!(fed && ga)) return null;
    // Every other state approved for the year (Texas, then any later one).
    const states = {}, ids = [fed.id, ga.id];
    for (const j of [...new Set(all.filter(t => t.jurisdiction !== 'federal' && t.jurisdiction !== 'GA').map(t => t.jurisdiction))].sort()) {
      const t = pick(j);
      if (t) { states[j] = t.data; ids.push(t.id); }
    }
    return { federal: fed.data, GA: ga.data, states, ids };
  };
  const ctxFor = (req) => ({ at: nowIso(), ipHash: hashIp ? hashIp(req) : null });

  // ===================================================================================
  // EACH PERSON'S OWN: pay setup (My GFC → Hours & Pay)
  // ===================================================================================
  // Whether this person's work state (not Georgia) taxes wages, from that
  // state's approved table for this year. Unknown reads as false: no form is
  // asked for until the state is set up.
  const stateTaxesWages = async (p) => {
    const st = (p && p.workState) || 'GA';
    if (st === 'GA') return false;
    const t = (await rows(TAX_TABLES)).filter(x => x.jurisdiction === st && x.status === 'active').sort((a, b) => Number(b.year) - Number(a.year))[0];
    return !!(t && t.data && t.data.incomeTax);
  };
  router.get('/api/my/pay-setup', authenticateToken, requireStaff, async (req, res) => {
    const p = await profileFor(req.user);
    const stateIncomeTax = await stateTaxesWages(p);
    res.json({
      profile: pp.publicProfile(p, { stateIncomeTax }), workState: p.workState || 'GA', workStateName: tables.stateName(p.workState || 'GA'),
      employee: pp.isEmployee(p), contractor: pp.isContractor(p), caregiver: !!p.isCaregiver,
      secretsStorable: pc.configured(env),
      options: { w4Filing: pp.W4_FILING, g4Filing: pp.G4_FILING, i9Status: pp.I9_STATUS, w9Class: pp.W9_CLASS, workTypes: WORK_TYPES, units: CI_UNITS,
        // Shown before someone agrees to electronic W-2s and 1099s (Pub 1141 2.4).
        eDelivery: { version: ye.E_DELIVERY_VERSION, disclosure: ye.E_DELIVERY_DISCLOSURE } }
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
        case 'state-cert': {
          const st = p.workState || 'GA';
          if (st === 'GA') return res.status(409).json({ error: 'You work in Georgia: sign the G-4.', code: 'STATE_CERT_GEORGIA' });
          const n = pp.normalizeStateCert(b, ctx, st); if (n.error) return res.status(400).json(n);
          p.stateCert = n.value; change = `${tables.stateName(st)} withholding certificate signed`; break;
        }
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
        case 'tax-address': {
          const n = ye.normalizeTaxAddress(b); if (n.error) return res.status(400).json(n);
          p.taxAddress = { ...n.value, at: ctx.at }; change = 'Legal name and mailing address for tax forms saved'; break;
        }
        case 'e-delivery': {
          // Consent is given against the disclosure the person was shown.
          if (b.consented === true && b.disclosureVersion !== ye.E_DELIVERY_VERSION) return res.status(409).json({ error: 'Read the current terms, then agree again.', code: 'E_DELIVERY_TERMS_CHANGED' });
          const was = !!(p.eDelivery && p.eDelivery.consented);
          p.eDelivery = { consented: b.consented === true, version: b.consented === true ? ye.E_DELIVERY_VERSION : null, at: ctx.at, ipHash: ctx.ipHash };
          change = b.consented === true ? 'Agreed to electronic W-2/1099' : 'Withdrew electronic W-2/1099 consent';
          // A withdrawal is confirmed in writing with its effective date (Pub 1141 2.4.02).
          if (was && b.consented !== true && req.user.email) {
            await queueNotification('tax_form_consent_withdrawn', req.user.id, req.user.email, req.user.name, {
              subject: 'You will get your W-2 or 1099 on paper',
              body: `We received your request on ${localDate(ctx.at) || ctx.at.slice(0, 10)}, and it takes effect today. Your W-2 or 1099 will come by mail. Forms already issued stay available in My GFC.`
            }, { relatedEntityId: `edelivery:${req.user.id}:${ctx.at}` }).catch(e => console.error('Consent withdrawal notice (non-fatal):', e.message));
          }
          break;
        }
        default: return res.status(404).json({ error: 'Unknown form.' });
      }
      const saved = await saveProfile(req.user.id, p, change, req.user);
      res.json({ profile: pp.publicProfile(saved, { stateIncomeTax: await stateTaxesWages(saved) }) });
    } catch (e) {
      if (e.code === 'PAYROLL_KEY_MISSING') return res.status(503).json({ error: e.message, code: e.code });
      console.error('Pay setup error:', e);
      res.status(500).json({ error: 'Server error' });
    }
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
  const formsFor = (row, userId) => [
    ...(row.w2 || []).filter(x => String(x.userId) === String(userId)).map(x => ({ form: 'w2', label: 'W-2', ...x })),
    ...(row.nec || []).filter(x => String(x.userId) === String(userId)).map(x => ({ form: '1099-nec', label: '1099-NEC', ...x }))
  ];
  router.get('/api/my/tax-forms', authenticateToken, requireStaff, async (req, res) => {
    const forms = (await rows(YEAR_END)).filter(r => r.released).flatMap(r => formsFor(r, req.user.id).map(x => ({
      year: r.year, form: x.form, label: x.label, releasedAt: r.releasedAt, corrected: !!x.corrected
    }))).sort((a, b) => b.year - a.year);
    res.json({ forms });
  });
  router.get('/api/my/tax-forms/:year/:form.pdf', authenticateToken, requireStaff, async (req, res) => {
    try {
      const all = await rows(YEAR_END);
      const i = all.findIndex(r => r.released && String(r.year) === String(req.params.year));
      const item = i === -1 ? null : formsFor(all[i], req.user.id).find(x => x.form === req.params.form);
      if (!item) return res.status(404).json({ error: 'Form not found.' });
      const buf = await renderTaxForm(all[i], item);
      // The first open is recorded: the reminder job stops chasing once it is.
      const list = item.form === 'w2' ? all[i].w2 : all[i].nec;
      const k = list.findIndex(x => String(x.userId) === String(req.user.id));
      if (k !== -1 && !list[k].openedAt) { list[k].openedAt = nowIso(); await db.set(YEAR_END, all); }
      await logActivity(req.user.id, req.user.name, 'tax_form_opened', 'tax_form', `${req.params.year}:${item.form}`, {});
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', contentDisposition('inline', `${req.params.year}_${item.label}.pdf`));
      res.send(buf);
    } catch (e) { console.error('Tax form error:', e); res.status(500).json({ error: 'The form could not be built.' }); }
  });

  // One copy of the employer as the forms and files print it.
  const employerFor = (settings) => {
    const y = settings.yearEnd || {};
    return {
      ein: settings.employerEin || null,
      name: y.employerName || ORG.name,
      address: y.employerAddress || ye.parseAddress(ORG.address),
      gaWithholdingId: y.gaWithholdingId || null,
      ssaUserId: y.ssaUserId || null,
      contactName: y.contactName || null,
      contactPhone: y.contactPhone || String(ORG.phone || '').replace(/\D/g, '') || null,
      contactEmail: y.contactEmail || ORG.email || null,
      phone: ORG.phone
    };
  };
  // Renders from the FROZEN released row; never from today's records.
  const renderTaxForm = async (row, item) => {
    if (item.form === 'w2') {
      return pdf.generateW2EmployeePDF({ year: row.year, employer: row.employer, corrected: !!item.corrected, boxes: item.boxes,
        employee: { ...item.taxName, ssnTruncated: item.ssnLast4 ? `XXX-XX-${item.ssnLast4}` : '', address: item.address } });
    }
    return pdf.generate1099NecPDF({ year: row.year, corrected: !!item.corrected, boxes: item.boxes,
      payer: { name: row.employer.name, ein: row.employer.ein, address: row.employer.address, phone: row.employer.phone },
      recipient: { name: item.name, tinTruncated: item.tinLast4 ? (item.tinType === 'ein' ? `XX-XXX${item.tinLast4}` : `XXX-XX-${item.tinLast4}`) : '', address: item.address } });
  };

  // ===================================================================================
  // THE OWNER'S: /api/payroll/admin/*
  // ===================================================================================
  const staffPeople = async () => {
    const users = (await getUsers()).filter(u => u && isStaff(u) && u.accountStatus !== 'inactive');
    const all = await readProfiles();
    const out = [];
    for (const u of users) {
      const p = all[String(u.id)] || pp.withEmploymentType(pp.defaultProfile(u, { relationship: await relationshipFor(u.id) }), u);
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
          caregiverPayRate: profile.isCaregiver ? (user.payRate || null) : null,
          // Set in User Management: the page shows it and does not edit it.
          employmentTypeOnUser: profile.isCaregiver || ['W2', '1099', 'HYBRID'].includes(user.employmentType)
        })).sort((a, b) => a.name.localeCompare(b.name)),
        runs: runs.map(r => ({ id: r.id, status: r.status, source: r.source || 'app', schedule: (r.source || 'app') === 'app' ? runSchedule(r) : null, period: r.period, totals: r.totals, blocked: r.blocked, createdAt: r.createdAt, approvedAt: r.approvedAt || null, paidAt: r.paidAt || null }))
          .sort((a, b) => String(b.period.start).localeCompare(String(a.period.start))),
        nextPeriod: tax.periodFor((localDate(nowIso()) || nowIso().slice(0, 10)), settings),
        // Both schedules, each with the period running today.
        schedules: Object.entries(tax.PAY_SCHEDULES).map(([key, v]) => ({
          key, label: v.label, ...tax.scheduleSettings(settings, key),
          current: tax.periodFor((localDate(nowIso()) || nowIso().slice(0, 10)), settings, key),
          people: people.filter(x => pp.isEmployee(x.profile) && x.profile.status !== 'inactive' && pp.scheduleFor(x.profile) === key).length
        })),
        contractorInvoices: (await rows(CONTRACTOR_INVOICES)).filter(x => x.status !== 'paid' && x.status !== 'rejected'),
        workTypes: WORK_TYPES, payTypes: pp.PAY_TYPES, workerTypes: pp.WORKER_TYPES, wageAccounts: pp.WAGE_ACCOUNTS,
        stateNames: tables.STATE_NAMES,
        // Each state's other payroll programs, for the Settings card.
        statePrograms: Object.fromEntries(Object.entries(tables.STATE_SOURCES).map(([k, v]) => [k, v.otherPrograms || []]))
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
    const today = localDate(nowIso()) || nowIso().slice(0, 10);
    if (n.value.frequency !== cur.frequency && (req.body || {}).anchor === undefined && (req.body || {}).schedules === undefined) {
      const curPeriod = tax.periodFor(today, cur);
      n.value.anchor = tax.addDays(curPeriod.end, 1);
    }
    // Same rule for each schedule: a frequency change starts at that
    // schedule's next period, never re-cutting one already running.
    if ((req.body || {}).schedules !== undefined) {
      for (const key of Object.keys(tax.PAY_SCHEDULES)) {
        const was = tax.scheduleSettings(cur, key);
        const now = n.value.schedules[key];
        const asked = (req.body.schedules || {})[key] || {};
        if (now.frequency !== was.frequency && asked.anchor === undefined) {
          now.anchor = tax.addDays(tax.periodFor(today, cur, key).end, 1);
        }
      }
      n.value.frequency = n.value.schedules.staff.frequency; n.value.anchor = n.value.schedules.staff.anchor;
    }
    if ((req.body || {}).states !== undefined) {
      const next = { ...(cur.states || {}) };
      for (const [st, v] of Object.entries(req.body.states || {})) {
        if (st === 'GA' || !tables.STATE_NAMES[st]) return res.status(400).json({ error: `${st} is not a state code (Georgia's settings are above).`, code: 'STATE_SETTINGS' });
        const rate = v.sutaRatePct === '' || v.sutaRatePct === null || v.sutaRatePct === undefined ? null : Number(v.sutaRatePct);
        if (rate !== null && !(rate >= 0 && rate <= 15)) return res.status(400).json({ error: `${tables.stateName(st)} unemployment rate is a percent between 0 and 15.`, code: 'STATE_SUTA_RATE' });
        if (v.withholdingFrequency && !['monthly', 'quarterly', 'semiweekly'].includes(v.withholdingFrequency)) return res.status(400).json({ error: 'Withholding is filed monthly, quarterly or semiweekly.', code: 'STATE_FREQUENCY' });
        next[st] = { sutaRatePct: rate, accountNumber: str(v.accountNumber, 40) || null, withholdingId: str(v.withholdingId, 40) || null, withholdingFrequency: v.withholdingFrequency || null };
      }
      n.value.states = next;
    }
    if ((req.body || {}).yearEnd !== undefined) {
      const y = ye.normalizeYearEnd(req.body.yearEnd, cur.yearEnd);
      if (y.error) return res.status(400).json(y);
      n.value.yearEnd = y.value;
    }
    if ((req.body || {}).employerEin !== undefined) {
      const e = String(req.body.employerEin || '').replace(/\D/g, '');
      if (e && e.length !== 9) return res.status(400).json({ error: 'An EIN has 9 digits.', code: 'EMPLOYER_EIN' });
      n.value.employerEin = e ? `${e.slice(0, 2)}-${e.slice(2)}` : null;
    }
    await db.set(SETTINGS, n.value);
    await logActivity(req.user.id, req.user.name, 'payroll_settings_updated', 'payroll_settings', null, { frequency: n.value.frequency, anchor: n.value.anchor, schedules: n.value.schedules || null });
    res.json({ settings: n.value });
  });

  router.put('/api/payroll/admin/people/:userId', authenticateToken, requireAdmin, async (req, res) => {
    const user = (await getUsers()).find(u => u && String(u.id) === String(req.params.userId));
    if (!user || !isStaff(user)) return res.status(404).json({ error: 'Staff member not found.' });
    const n = pp.normalizePaySetup(req.body);
    if (n.error) return res.status(400).json(n);
    // W-2 or 1099 is set on the user record once it is set there, so the
    // clock and payroll cannot disagree.
    if (n.value.workerType !== undefined && ['W2', '1099', 'HYBRID'].includes(user.employmentType) && n.value.workerType !== user.employmentType) {
      return res.status(409).json({ error: 'W-2 or 1099 is set in User Management for this person. Change it there.', code: 'EMPLOYMENT_TYPE_ON_USER' });
    }
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
      imeCases: await rows('ime_cases'),
      paidRefs: engine.paidRefsFrom(runs), localDate, resolvePayRate
    });
  };
  // A run belongs to one pay schedule; only the people on it are paid in it.
  // A run saved before the two schedules existed has none, and is read as
  // "staff" (the single schedule it was cut from).
  const runSchedule = (r) => (r && (r.schedule || (r.period && r.period.schedule))) || 'staff';
  const sameRun = (r, period) => r && r.period && r.period.start === period.start && runSchedule(r) === (period.schedule || 'staff') && (r.source || 'app') === 'app';
  const draftFor = async (period, settings, adjustments) => {
    const runs = await rows(RUNS);
    const tbl = await activeTables(Number(period.payDate.slice(0, 4)));
    if (!tbl) return { error: `No approved ${period.payDate.slice(0, 4)} tax tables. Approve the federal and Georgia tables under Taxes first.`, code: 'PAYROLL_NO_TABLES' };
    const gathered = await gatherFor(period, runs.filter(r => r.status !== 'draft'));
    const schedule = period.schedule || 'staff';
    const people = (await staffPeople()).filter(x => pp.isEmployee(x.profile) && x.profile.status !== 'inactive' && pp.scheduleFor(x.profile) === schedule);
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
      const schedule = String((req.body || {}).schedule || '');
      if (!tax.PAY_SCHEDULES[schedule]) return res.status(400).json({ error: 'Choose the caregivers (weekly) or everyone-else schedule.', code: 'RUN_SCHEDULE' });
      const period = tax.periodFor(start, settings, schedule);
      const runs = await rows(RUNS);
      const existing = runs.find(r => sameRun(r, period) && r.status !== 'void');
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
  // opts.notify false: past pay dates imported from Gusto get stubs without
  // an email per pay date.
  const writeStubs = async (run, settings, opts = {}) => {
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
          ssnLast4: p.ssn ? p.ssn.last4 : null,
          accountLast4: w.imported ? null : p.payMethod ? p.payMethod.accountLast4 : null,
          payMethod: w.imported ? w.payMethod : p.payMethod ? p.payMethod.method : null,
          workState: (w.imported && w.imported.workState) || p.workState || 'GA', paidThrough: w.imported ? w.imported.from : null });
        const stored = await drive.uploadStaffDocumentFile(roleFolderFor(accountTypeOf(user)), personFolderName(user.name, user.id), `Pay stub ${run.period.payDate}.pdf`, buf, 'application/pdf');
        driveFileId = stored.fileId || stored.id || null;
      } catch (e) { report.pdfFailed++; console.error('Pay stub PDF error (non-fatal):', e.message); }
      const hours = Math.round(((w.earnings.find(e => e.code === 'regular') || {}).minutes || 0) / 60 * 100) / 100;
      const row = { id: uuidv4(), userId: w.userId, payDate: run.period.payDate, periodStart: run.period.start, periodEnd: run.period.end,
        gross: w.pay.grossCents / 100, net: w.pay.netCents / 100, hours, reference: `run:${run.id}`, driveFileId, source: run.source === 'gusto' ? 'gusto' : 'app', runId: run.id, importedAt: nowIso() };
      const at = stubs.findIndex(x => String(x.userId) === row.userId && x.payDate === row.payDate && x.reference === row.reference);
      if (at === -1) stubs.push(row); else { row.id = stubs[at].id; stubs[at] = row; }
      report.written++;
      if (opts.notify !== false && user && user.email && queueNotification) {
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

  // ---- import past pay dates from Gusto ------------------------------------------------
  // The owner pastes Gusto's Payroll Journal CSV. preview: what would be
  // imported and who could not be matched. commit: the paid runs, their pay
  // stubs in My GFC (no emails), and the app's own hours in those periods
  // locked so a later app run never pays them again. The file is not stored.
  router.post('/api/payroll/admin/import/gusto', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const parsed = gusto.parseJournal(b.csv);
      if (parsed.error) return res.status(400).json(parsed);
      const entries = gusto.netEntries(parsed.lines);
      const users = await getUsers();
      const profiles = await readProfiles();
      const logs = await rows('time_logs');
      const visits = await rows('visit_timings');
      const inP = (iso, p) => { const d = localDate(iso); return d && d >= p.start && d <= p.end; };
      const refsFor = (uid, p) => [
        ...logs.filter(l => l && String(l.caregiver_id) === uid && l.clock_out_at && inP(l.clock_in_at, p)).map(l => `log:${l.id}`),
        ...visits.filter(t => t && String(t.byId) === uid && t.endedAt && inP(t.startedAt, p)).map(t => `visit:${t.id}`)
      ];
      const built = gusto.buildImport({ entries, users: users.filter(u => isStaff(u)), profiles, refsFor, at: nowIso(), by: req.user.name || req.user.email });
      for (const r of built.runs) r.totals = engine.runTotals(r.workers);
      const existing = await rows(RUNS);
      // An app run already covering the same person and pay date would mean
      // paying twice; that pay date is left out and named.
      const appPaid = new Set(existing.filter(r => r.source !== 'gusto' && r.status !== 'draft').flatMap(r => (r.workers || []).filter(w => w.pay).map(w => `${w.userId}|${r.period.payDate}`)));
      const clashes = [];
      for (const r of built.runs) {
        r.workers = r.workers.filter(w => { const clash = appPaid.has(`${w.userId}|${r.period.payDate}`); if (clash) clashes.push(`${w.name}, pay date ${r.period.payDate}`); return !clash; });
        r.totals = engine.runTotals(r.workers);
      }
      const runs = built.runs.filter(r => r.workers.length);
      const replacing = runs.filter(r => existing.some(x => x.id === r.id)).length;
      const nonGeorgia = built.matched.filter(m => m.workStates.some(st => st !== 'GA')).map(m => ({ userId: m.userId, name: m.name, states: m.workStates }));
      const summary = {
        payDates: [...new Set(runs.map(r => r.period.payDate))].length, stubs: runs.reduce((a, r) => a + r.workers.length, 0),
        grossCents: runs.reduce((a, r) => a + r.totals.grossCents, 0), matched: built.matched, unmatched: built.unmatched,
        warnings: [...parsed.warnings, ...built.warnings, ...clashes.map(c => `${c}: already paid by a payroll run in the app; not imported.`)],
        replacing, nonGeorgia
      };
      if (b.commit !== true) return res.json({ preview: true, ...summary });

      // Commit. Re-importing the same file replaces the same pay dates.
      const ids = new Set(runs.map(r => r.id));
      await db.set(RUNS, [...existing.filter(r => !ids.has(r.id)), ...runs]);
      // Lock the app's hours inside imported periods, as an approval does.
      const locked = new Map();
      for (const r of runs) for (const w of r.workers) for (const ref of w.refs) if (ref.startsWith('log:')) locked.set(ref.slice(4), r.id);
      if (locked.size) await db.set('time_logs', logs.map(l => (l && locked.has(String(l.id)) && !l.payroll_run_id ? { ...l, payroll_run_id: locked.get(String(l.id)) } : l)));
      // Record the work state Gusto paid them in; a non-Georgia worker is
      // then blocked from app runs by name.
      const all = await db.get(PROFILES) || {};
      for (const m of nonGeorgia) {
        const p = all[m.userId] || pp.defaultProfile(users.find(u => String(u.id) === m.userId) || { id: m.userId });
        const st = m.states[m.states.length - 1];
        if (p.workState === st) continue;
        all[m.userId] = { ...p, workState: st, history: [...(p.history || []), { at: nowIso(), change: `Work state set to ${st} from the Gusto import`, byId: req.user.id, byName: req.user.name || null }].slice(-200) };
      }
      if (nonGeorgia.length) await db.set(PROFILES, all);
      const settings = await readSettings();
      const stubReport = { written: 0, pdfFailed: 0 };
      for (const r of runs) { const x = await writeStubs(r, settings, { notify: false }); stubReport.written += x.written; stubReport.pdfFailed += x.pdfFailed; }
      await logActivity(req.user.id, req.user.name, 'payroll_gusto_imported', 'payroll', null, { payDates: summary.payDates, stubs: summary.stubs, unmatched: built.unmatched.length });
      res.json({ committed: true, ...summary, stubsWritten: stubReport.written, pdfFailed: stubReport.pdfFailed });
    } catch (e) { console.error('Gusto import error:', e); res.status(500).json({ error: 'The import could not be completed.' }); }
  });

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
    const s = cal.quarterSummary(await rows(RUNS), { year: req.params.year, quarter: req.params.q, fed: tbl.federal, sutaWageBaseCents: tbl.GA.sutaWageBaseCents,
      stateWageBases: Object.fromEntries(Object.entries(tbl.states || {}).map(([k, d]) => [k, d.sutaWageBaseCents])) });
    await logActivity(req.user.id, req.user.name, 'quarter_summary_opened', 'payroll', null, { year: req.params.year, quarter: req.params.q });
    res.json(s);
  });
  // ---- year end: W-2, 1099-NEC, filing ---------------------------------------------
  const yearEndPreview = async (year) => {
    const tbl = await activeTables(Number(year));
    if (!tbl) return { error: 'No approved tables for that year.', code: 'PAYROLL_NO_TABLES', status: 409 };
    const settings = await readSettings();
    const runs = await rows(RUNS);
    const paid = (await rows(CONTRACTOR_INVOICES)).filter(x => x.status === 'paid').map(x => ({ userId: x.userId, name: x.name, amountCents: x.totalCents, paidAt: x.paidAt }));
    const figures = cal.yearEnd(runs, paid, { year, fed: tbl.federal, incomeTaxStates: Object.entries(tbl.states || {}).filter(([, d]) => d.incomeTax).map(([k]) => k) });
    const profiles = await readProfiles();
    const users = new Map((await getUsers()).filter(Boolean).map(u => [String(u.id), u]));
    const employer = employerFor(settings);
    const w2 = figures.w2.map(e => {
      const p = profiles[String(e.userId)] || {};
      const missing = [];
      if (!p.taxAddress) missing.push('Legal name and mailing address');
      if (!p.ssn) missing.push('SSN');
      // Box 15: Georgia's withholding number, or that state's own.
      const stateId = e.stateCode === 'GA' ? employer.gaWithholdingId : (((settings.states || {})[e.stateCode] || {}).withholdingId || null);
      return { userId: String(e.userId), name: e.name, boxes: { ...e, stateId }, missing, eDelivery: !!(p.eDelivery && p.eDelivery.consented), email: (users.get(String(e.userId)) || {}).email || null };
    });
    const nec = figures.nec.map(e => {
      const p = profiles[String(e.userId)] || {};
      const missing = [];
      if (!p.taxAddress) missing.push('Mailing address');
      if (!(p.w9 && p.tin)) missing.push('W-9');
      return { userId: String(e.userId), name: (p.w9 && (p.w9.businessName || p.w9.name)) || e.name, boxes: { box1a: e.box1, box4: 0 }, missing, eDelivery: !!(p.eDelivery && p.eDelivery.consented) };
    });
    return {
      year: Number(year), employer, employerMissing: ye.employerMissing(employer), fileMissing: ye.fileMissing(employer),
      draftRuns: ye.openRunsIn(runs, year).length, unpaidRuns: ye.unpaidRunsIn(runs, year).length,
      // Wages paid through Gusto this year are in these figures. If Gusto also
      // files this year's W-2s, releasing here would report them twice.
      gustoGrossCents: runs.filter(r => r.source === 'gusto' && String(r.period.payDate).startsWith(String(year))).reduce((t, r) => t + ((r.totals && r.totals.grossCents) || 0), 0),
      w2, nec, necBelowThreshold: figures.necBelowThreshold, necThresholdCents: figures.necThresholdCents,
      g1003: ye.g1003Totals(w2.map(w => ({ boxes: w.boxes }))),
      layouts: { efw2: ye.EFW2_LAYOUT_YEARS.includes(Number(year)), irisNec: ye.IRIS_NEC_LAYOUT_YEARS.includes(Number(year)) },
      released: (await rows(YEAR_END)).find(r => String(r.year) === String(year)) || null
    };
  };
  router.get('/api/payroll/admin/year-end/:year', authenticateToken, requireAdmin, async (req, res) => {
    const y = await yearEndPreview(req.params.year);
    if (y.error) return res.status(y.status).json({ error: y.error, code: y.code });
    await logActivity(req.user.id, req.user.name, 'year_end_opened', 'payroll', null, { year: req.params.year });
    if (req.query.format === 'csv') {
      // The summary (no SSNs or TINs). The filing sheet below carries them.
      const head = 'Form,Name,Box 1/1a,Box 2,Box 3,Box 4,Box 5,Box 6,Box 12 TT,Box 16 (GA wages),Box 17 (GA tax)\r\n';
      const d = (c) => (Number(c || 0) / 100).toFixed(2);
      const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
      const body = [...y.w2.map(e => ['W-2', q(e.name), d(e.boxes.box1), d(e.boxes.box2), d(e.boxes.box3), d(e.boxes.box4), d(e.boxes.box5), d(e.boxes.box6), d(e.boxes.box12TT), d(e.boxes.box16), d(e.boxes.box17)].join(',')),
        ...y.nec.map(e => ['1099-NEC', q(e.name), d(e.boxes.box1a), '', '', '', '', '', '', '', ''].join(','))].join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', contentDisposition('attachment', `gfc_year_end_${req.params.year}.csv`));
      return res.send(head + body + '\r\n');
    }
    res.json(y);
  });

  // Release: freezes the figures, makes the forms visible in My GFC and emails
  // a link (never the form) to everyone who agreed to electronic delivery.
  // Everyone else is on the paper list.
  router.post('/api/payroll/admin/year-end/:year/release', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const year = Number(req.params.year);
      const today = localDate(nowIso()) || nowIso().slice(0, 10);
      if (!(Number(today.slice(0, 4)) > year)) return res.status(409).json({ error: `${year} is not over yet. Release its forms in January.`, code: 'YE_YEAR_NOT_OVER' });
      const all = await rows(YEAR_END);
      if (all.some(r => Number(r.year) === year && r.released)) return res.status(409).json({ error: 'These forms are already released. A change now is a corrected form (W-2c or a corrected 1099).', code: 'YE_ALREADY_RELEASED' });
      const y = await yearEndPreview(year);
      if (y.error) return res.status(y.status).json({ error: y.error, code: y.code });
      if (y.draftRuns || y.unpaidRuns) return res.status(409).json({ error: `${y.draftRuns} draft and ${y.unpaidRuns} unpaid run(s) with a ${year} pay date. Finish them first.`, code: 'YE_RUNS_OPEN' });
      if (y.employerMissing.length) return res.status(409).json({ error: `Missing: ${y.employerMissing.join(', ')}.`, code: 'YE_EMPLOYER_MISSING' });
      const blocked = [...y.w2, ...y.nec].filter(x => x.missing.length);
      if (blocked.length) return res.status(409).json({ error: `Missing for ${blocked.map(x => `${x.name} (${x.missing.join(', ')})`).join('; ')}.`, code: 'YE_PEOPLE_MISSING' });
      const profiles = await readProfiles();
      const freeze = (x, form) => {
        const p = profiles[x.userId] || {};
        const t = p.taxAddress || {};
        const base = { userId: x.userId, boxes: x.boxes, eDelivery: x.eDelivery, openedAt: null, mailedAt: null,
          address: { line1: t.line1, line2: t.line2, city: t.city, state: t.state, zip: t.zip, zip4: t.zip4 } };
        // Only the last four of an SSN or TIN is kept with the released form;
        // the filing sheet reads the sealed number from the profile.
        return form === 'w2'
          ? { ...base, name: [t.firstName, t.lastName].join(' '), taxName: { firstName: t.firstName, middle: t.middle, lastName: t.lastName, suffix: t.suffix }, ssnLast4: p.ssn && p.ssn.last4 }
          : { ...base, name: x.name, tinType: p.tin && p.tin.type, tinLast4: p.tin && p.tin.last4 };
      };
      const row = { id: uuidv4(), year, released: true, releasedAt: nowIso(), releasedBy: req.user.name,
        employer: y.employer, w2: y.w2.map(x => freeze(x, 'w2')), nec: y.nec.map(x => freeze(x, 'nec')) };
      await db.set(YEAR_END, [...all.filter(r => Number(r.year) !== year), row]);
      await logActivity(req.user.id, req.user.name, 'tax_forms_released', 'payroll', String(year), { w2: row.w2.length, nec: row.nec.length });
      const users = new Map((await getUsers()).filter(Boolean).map(u => [String(u.id), u]));
      let emailed = 0;
      for (const x of [...row.w2.map(v => ({ ...v, label: 'W-2' })), ...row.nec.map(v => ({ ...v, label: '1099-NEC' }))]) {
        const u = users.get(x.userId);
        if (!x.eDelivery || !u || !u.email) continue;
        await queueNotification('tax_form_ready', u.id, u.email, u.name, {
          subject: `Your ${year} ${x.label} is ready`,
          body: `Your ${year} ${x.label} is ready in My GFC under Hours & Pay. Sign in to open, download or print it.`,
          ctaUrl: `${getAppBaseUrl ? await getAppBaseUrl() : ''}${links.payFor(u)}`, ctaLabel: 'Open My GFC'
        }, { relatedEntityId: `taxform:${year}:${x.userId}:${x.label}` });
        emailed++;
      }
      res.json({ released: row, emailed, paper: [...row.w2, ...row.nec].filter(x => !x.eDelivery).map(x => ({ userId: x.userId, name: x.name })) });
    } catch (e) { console.error('Tax form release error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  const releasedItem = async (year, userId, form) => {
    const all = await rows(YEAR_END);
    const i = all.findIndex(r => r.released && String(r.year) === String(year));
    if (i === -1) return null;
    const list = form === 'w2' ? all[i].w2 : form === '1099-nec' ? all[i].nec : null;
    const k = (list || []).findIndex(x => String(x.userId) === String(userId));
    return k === -1 ? null : { all, row: all[i], list, k, item: { form, label: form === 'w2' ? 'W-2' : '1099-NEC', ...list[k] } };
  };
  // The paper copy for someone who did not agree to electronic delivery.
  router.get('/api/payroll/admin/year-end/:year/forms/:userId/:form.pdf', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const r = await releasedItem(req.params.year, req.params.userId, req.params.form);
      if (!r) return res.status(404).json({ error: 'Form not found.' });
      const buf = await renderTaxForm(r.row, r.item);
      await logActivity(req.user.id, req.user.name, 'tax_form_printed', 'tax_form', `${req.params.year}:${req.params.form}:${req.params.userId}`, {});
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', contentDisposition('inline', `${req.params.year}_${r.item.label}_${r.item.name}.pdf`));
      res.send(buf);
    } catch (e) { console.error('Tax form print error:', e); res.status(500).json({ error: 'The form could not be built.' }); }
  });
  router.post('/api/payroll/admin/year-end/:year/forms/:userId/:form/mailed', authenticateToken, requireAdmin, async (req, res) => {
    const r = await releasedItem(req.params.year, req.params.userId, req.params.form);
    if (!r) return res.status(404).json({ error: 'Form not found.' });
    const mailedOn = tax.isYmd((req.body || {}).mailedOn) ? req.body.mailedOn : (localDate(nowIso()) || nowIso().slice(0, 10));
    r.list[r.k] = { ...r.list[r.k], mailedAt: mailedOn, mailedBy: req.user.name };
    await db.set(YEAR_END, r.all);
    await logActivity(req.user.id, req.user.name, 'tax_form_mailed', 'tax_form', `${req.params.year}:${req.params.form}:${req.params.userId}`, { mailedOn });
    res.json({ ok: true, mailedAt: mailedOn });
  });

  // Filing downloads carry FULL SSNs and TINs: built on request from the
  // sealed numbers, never stored, every download logged (counts only).
  const filingPeople = async (row) => {
    const profiles = await readProfiles();
    const open = (sealed) => (sealed ? pc.open(sealed, env) : null);
    return {
      w2s: row.w2.map(x => ({ ...x, ...(x.taxName || {}), ssn: open((profiles[x.userId] || {}).ssn && profiles[x.userId].ssn.enc) })),
      necs: row.nec.map(x => {
        const p = profiles[x.userId] || {};
        const t = p.taxAddress || {};
        const isBusiness = !!(p.w9 && (p.w9.businessName || p.tin && p.tin.type === 'ein'));
        return { ...x, tin: open(p.tin && p.tin.enc), tinType: (p.tin && p.tin.type) || 'ssn', isBusiness, businessName: (p.w9 && (p.w9.businessName || p.w9.name)) || x.name,
          firstName: t.firstName, middle: t.middle, lastName: t.lastName, suffix: t.suffix, box1Cents: x.boxes.box1a };
      })
    };
  };
  const sendFile = (res, type, name, body) => {
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', contentDisposition('attachment', name));
    res.setHeader('Cache-Control', 'no-store');
    res.send(body);
  };
  const FILING_FILES = { 'filing-sheet.csv': 'filing_sheet', 'ssa-w2.txt': 'efw2', 'iris-1099-nec.csv': 'iris' };
  const filingFile = (file) => async (req, res) => {
    const kind = FILING_FILES[file];
    req.params.file = file;
    try {
      const row = (await rows(YEAR_END)).find(r => r.released && String(r.year) === String(req.params.year));
      if (!row) return res.status(409).json({ error: 'Release the forms first, so the file matches what people received.', code: 'YE_NOT_RELEASED' });
      if (kind === 'efw2') {
        const missing = ye.fileMissing(row.employer);
        if (missing.length) return res.status(409).json({ error: `Missing: ${missing.join(', ')}.`, code: 'YE_FILE_SETTINGS' });
      }
      const people = await filingPeople(row);
      let body;
      if (kind === 'filing_sheet') body = ye.filingSheetCsv({ year: row.year, gaWithholdingId: row.employer.gaWithholdingId, w2s: people.w2s, necs: people.necs });
      else if (kind === 'efw2') body = ye.efw2File({ year: row.year, employer: row.employer, employees: people.w2s });
      else body = ye.irisNecCsv({ year: row.year, payer: row.employer, recipients: people.necs });
      await logActivity(req.user.id, req.user.name, `tax_filing_${kind}_downloaded`, 'payroll', String(row.year), { w2: people.w2s.length, nec: people.necs.length });
      sendFile(res, kind === 'efw2' ? 'text/plain; charset=us-ascii' : 'text/csv; charset=utf-8', `gfc_${row.year}_${req.params.file.replace(/-/g, '_')}`, body);
    } catch (e) {
      if (e.code === 'EFW2_LAYOUT_UNKNOWN' || e.code === 'IRIS_LAYOUT_UNKNOWN') return res.status(409).json({ error: e.message, code: e.code });
      if (e.code === 'PAYROLL_KEY_MISSING') return res.status(503).json({ error: e.message, code: e.code });
      console.error('Year-end file error:', e);
      res.status(500).json({ error: 'The file could not be built.' });
    }
  };
  router.get('/api/payroll/admin/year-end/:year/filing-sheet.csv', authenticateToken, requireAdmin, filingFile('filing-sheet.csv'));
  router.get('/api/payroll/admin/year-end/:year/ssa-w2.txt', authenticateToken, requireAdmin, filingFile('ssa-w2.txt'));
  router.get('/api/payroll/admin/year-end/:year/iris-1099-nec.csv', authenticateToken, requireAdmin, filingFile('iris-1099-nec.csv'));

  // ===================================================================================
  // AUTOMATIONS (Apps Script): POST /api/payroll/automation/:job
  // Same key and header as the pay stub import. Each job only READS and
  // DRAFTS; it never approves, pays or activates anything.
  // ===================================================================================
  // The pages the Apps Script watches: federal, Georgia, and every state
  // someone on payroll works in. A state with no known pages is reported as
  // unwatched rather than silently skipped.
  router.get('/api/payroll/automation/tax-sources', async (req, res) => {
    const key = payrollKey();
    if (!key) return res.status(503).json({ error: 'Payroll automations are not switched on. Set PAYROLL_INGEST_KEY.', code: 'PAYROLL_INGEST_NOT_CONFIGURED' });
    if (!keyOk(req, key)) return res.status(401).json({ error: 'Wrong payroll key.', code: 'PAYROLL_KEY_INVALID' });
    const states = Object.values((await db.get(PROFILES)) || {}).filter(p => p && p.status !== 'inactive').map(p => p.workState || 'GA');
    res.json(tables.sourcesFor(states));
  });
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
  // Unopened electronic forms are reminded once; the owner hears about paper
  // not yet mailed, or forms not released at all.
  const yearEndReminders = async (year, today) => {
    const row = (await rows(YEAR_END)).find(r => r.released && Number(r.year) === Number(year));
    if (!row) {
      await tellOwner('tax_forms_not_released', `${year} W-2s and 1099s are not released`, 'They are due to employees and contractors by January 31. Open Payroll → Year End.', `ye-unreleased:${year}:${today}`);
      return { summary: 'not released' };
    }
    const users = new Map((await getUsers()).filter(Boolean).map(u => [String(u.id), u]));
    let reminded = 0;
    for (const x of [...row.w2.map(v => ({ ...v, label: 'W-2' })), ...row.nec.map(v => ({ ...v, label: '1099-NEC' }))]) {
      const u = users.get(x.userId);
      if (!x.eDelivery || x.openedAt || !u || !u.email) continue;
      await queueNotification('tax_form_reminder', u.id, u.email, u.name, {
        subject: `Your ${row.year} ${x.label} is waiting`, body: `Your ${row.year} ${x.label} is in My GFC under Hours & Pay. You need it to file your taxes.`,
        ctaUrl: `${getAppBaseUrl ? await getAppBaseUrl() : ''}${links.payFor(u)}`, ctaLabel: 'Open My GFC'
      }, { relatedEntityId: `taxform-reminder:${row.year}:${x.userId}:${x.label}` });
      reminded++;
    }
    const unmailed = [...row.w2, ...row.nec].filter(x => !x.eDelivery && !x.mailedAt);
    if (unmailed.length) await tellOwner('tax_forms_unmailed', `${unmailed.length} paper tax form(s) not marked mailed`, 'Print and mail them, then mark each one mailed in Payroll → Year End. They are due by January 31.', `ye-unmailed:${year}:${today}`);
    return { summary: `${reminded} reminded, ${unmailed.length} unmailed` };
  };
  const automationJobs = {
    // The day after a period ends: draft its run and tell the owner.
    // One draft per schedule: the weekly caregiver run and the every-two-weeks
    // run for everyone else close on their own dates.
    'period-close': async () => {
      const settings = await readSettings();
      const today = localDate(nowIso()) || nowIso().slice(0, 10);
      const out = [];
      for (const schedule of Object.keys(tax.PAY_SCHEDULES)) {
        const label = tax.PAY_SCHEDULES[schedule].label;
        const period = tax.periodFor(tax.addDays(tax.periodFor(today, settings, schedule).start, -1), settings, schedule);
        const runs = await rows(RUNS);
        const existing = runs.find(r => sameRun(r, period));
        if (existing && existing.status !== 'draft') { out.push({ schedule, summary: 'already approved', period }); continue; }
        const d = await draftFor(period, settings, existing ? existing.adjustments || [] : []);
        if (d.error) { await tellOwner('payroll_period_close', `${label} payroll could not be drafted`, d.error, `close:${schedule}:${period.start}`); out.push({ schedule, summary: d.code, period }); continue; }
        // Nobody on this schedule had pay: no empty run to review.
        if (!existing && !d.run.workers.length) { out.push({ schedule, summary: 'nobody to pay', period }); continue; }
        const run = { id: existing ? existing.id : uuidv4(), status: 'draft', ...d.run, adjustments: existing ? existing.adjustments || [] : [], createdAt: existing ? existing.createdAt : nowIso(), rebuiltAt: nowIso(), createdBy: 'Payroll automation' };
        await db.set(RUNS, existing ? runs.map(r => (r.id === run.id ? run : r)) : [...runs, run]);
        await tellOwner('payroll_period_close', `${label} payroll for ${period.start} to ${period.end} is ready to review`,
          `The draft is ready. ${run.workers.length} people, ${run.blocked.length} missing paperwork. Review and approve it in the app.`, `close:${schedule}:${period.start}`);
        out.push({ schedule, summary: 'drafted', period, workers: run.workers.length, blocked: run.blocked.length });
      }
      return { summary: out.map(o => `${o.schedule}: ${o.summary}`).join('; '), runs: out };
    },
    // Open clock-ins and missing clock-outs.
    'missing-time': async () => {
      // Main's one clock (time_logs): a shift or staff clock-in left open 12+ hours.
      const open = (await rows('time_logs')).filter(e => e && e.clock_in_at && !e.clock_out_at && Date.now() - Date.parse(e.clock_in_at) > 12 * 3600000);
      const users = await getUsers();
      for (const e of open) {
        const u = users.find(x => String(x.id) === String(e.caregiver_id));
        if (u && u.email) await queueNotification('staff_clock_open', u.id, u.email, u.name, { subject: 'You are still clocked in', body: 'You clocked in more than 12 hours ago and have not clocked out. Clock out, or tell the office the right time.', ctaUrl: `${getAppBaseUrl ? await getAppBaseUrl() : ''}${links.payFor(u)}`, ctaLabel: 'Open My GFC' }, { relatedEntityId: e.id });
      }
      return { summary: `${open.length} open` };
    },
    // From January 20: anyone who has not opened an electronic form is
    // reminded once; the owner is told what paper is still unmailed. Forms
    // are due to people by January 31.
    'tax-form-reminders': async () => {
      const today = localDate(nowIso()) || nowIso().slice(0, 10);
      if (!(today.slice(5) >= '01-20' && today.slice(5) <= '02-15')) return { summary: 'not in season' };
      return yearEndReminders(Number(today.slice(0, 4)) - 1, today);
    },
    // Rev 2 of the script: Jan 20, for the year it names.
    'year-end-reminders': async (b) => {
      const year = Number(b.taxYear);
      if (!(year >= 2026 && year <= 2100)) return { summary: 'taxYear missing' };
      return yearEndReminders(year, localDate(nowIso()) || nowIso().slice(0, 10));
    },
    // Jan 2: the figures are built and the owner is told what is ready and
    // what is missing. Nothing is released: that stays the owner's click.
    'year-end-build': async (b) => {
      const year = Number(b.taxYear);
      if (!(year >= 2026 && year <= 2100)) return { summary: 'taxYear missing' };
      const y = await yearEndPreview(year);
      if (y.error) { await tellOwner('tax_forms_build_blocked', `${year} W-2s and 1099s cannot be built yet`, y.error, `ye-build:${year}`); return { summary: y.code }; }
      if (y.released) return { summary: 'already released' };
      const blockers = [
        ...y.employerMissing.map(m => `Missing: ${m}`),
        ...(y.draftRuns || y.unpaidRuns ? [`${y.draftRuns} draft and ${y.unpaidRuns} unpaid run(s) with a ${year} pay date`] : []),
        ...[...y.w2, ...y.nec].filter(x => x.missing.length).map(x => `${x.name}: ${x.missing.join(', ')}`),
        ...(y.gustoGrossCents ? ['Some of these wages were paid through Gusto. Release here only if the app files this year\'s W-2s.'] : [])
      ];
      await tellOwner('tax_forms_ready_for_review', `${year} W-2s and 1099s are ready for your review`,
        [`${y.w2.length} W-2(s) and ${y.nec.length} 1099-NEC(s). Review them in Payroll → Year End, then release. They are due by January 31.`, ...(blockers.length ? ['Before you can release:', ...blockers] : [])].join('\n'),
        `ye-build:${year}`);
      return { summary: `${y.w2.length} W-2, ${y.nec.length} 1099-NEC, ${blockers.length} blocker(s)` };
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
      await tellOwner('payroll_tax_source_changed', 'A payroll tax source changed', `${src || 'A tax source'}${b.jurisdiction ? ` (${str(b.jurisdiction, 20)})` : ''} changed (${url}). Review the new figures and approve a new table before they apply.`, `src:${src}:${str(b.hash, 80)}`);
      return { summary: 'owner told' };
    },
    'qbo-sync': async () => (deps.qboRetry ? deps.qboRetry() : { summary: 'QuickBooks not connected' })
  };

  return router;
};

module.exports.WORK_TYPES = WORK_TYPES;
module.exports.keyOk = keyOk;
