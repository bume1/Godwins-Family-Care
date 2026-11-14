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
const ts = require('../payrollTimesheets');
const { ORG } = require('../public/consent-text');
const { contentDisposition } = require('../contentDisposition');

const PROFILES = 'payroll_profiles';          // { [userId]: profile }
const SETTINGS = 'payroll_settings';
const TAX_TABLES = 'payroll_tax_tables';
const RUNS = 'payroll_runs';
const CONTRACTOR_INVOICES = 'contractor_invoices';
const TIMESHEETS = 'payroll_timesheets';
// A draft deleted by the Super Admin (owner, 2026-11-14): who, when and which
// period, so the morning automation does not draft that period again.
const DELETED_DRAFTS = 'payroll_deleted_drafts';
// How a payment imported from Gusto was actually sent (owner, 2026-11-14):
// some Gusto "check" pay dates were sent by Zelle or Cash App while moving off
// Gusto. Append-only; the latest for a run and person is the one in force.
const CORRECTIONS = 'payroll_payment_corrections';
const CORRECTION_METHODS = Object.freeze({ zelle: 'Zelle', cashapp: 'Cash App', direct_deposit: 'Direct deposit', check: 'Paper check' });
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
  // Payroll preparers (owner, 2026-11-13): anyone the Super Admin granted the
  // Payroll module drafts runs, adds lines, reads the taxes and records
  // deposits. Approving, paying, bank numbers, settings, tax tables, people's
  // pay setup, contractor approvals and year-end release stay requireAdmin.
  // Without the dependency (an older caller, a test harness), it is admin only.
  const requirePayrollPreparer = deps.requirePayrollPreparer || requireAdmin;
  // Timesheets (owner, 2026-11-13): managers and care coordinators (the Staff
  // Scheduling module) also view hours and edit them. Their edit goes to the
  // Super Admin as a time adjustment request; the Super Admin's applies.
  const accountTypes = require('../accountTypes');
  const isPreparer = (u) => !!u && (u.role === 'admin' || (!!deps.requirePayrollPreparer && accountTypes.hasModule(u, 'payroll')));
  const isHoursEditor = (u) => !!u && accountTypes.hasModule(u, 'caregiverScheduling');
  const requireTimesheetViewer = (req, res, next) => (isPreparer(req.user) || isHoursEditor(req.user) ? next()
    : res.status(403).json({ error: 'Payroll is the Super Admin\'s.', code: 'PAYROLL_PREPARER_ONLY' }));

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
  // ---- The official forms, filled (owner, 2026-11-13) ---------------------------
  // What a signed W-4, G-4, I-9 or W-9 puts on the real government form. The
  // secrets are opened here, on the server, only to draw that form.
  const gov = require('../govForms');
  const overseasOf = (settings) => ({ enabled: false, payMethods: ['wise'], ...((settings && settings.overseas) || {}) });
  const openJson = (box) => { try { return box && box.enc ? JSON.parse(pc.open(box.enc, env)) : null; } catch (e) { return null; } };
  const openPlain = (box) => { try { return box && box.enc ? pc.open(box.enc, env) : null; } catch (e) { return null; } };
  // `extra` carries the preview's options (owner, 2026-11-14): no signature,
  // a PREVIEW mark, and secret numbers as their last four only.
  const govPdf = async (user, p, key, extra = {}) => {
    const settings = await readSettings();
    const person = { address: p.taxAddress || null, email: user.email || null, phone: user.phone || null };
    // The employer block is the Year End one when set (Settings → Year End), so
    // the forms and the W-2 name GFC the same way.
    const yeE = settings.yearEnd || {};
    const ya = yeE.employerAddress;
    const employer = { name: yeE.employerName || ORG.name, address: ya && ya.line1 ? [ya.line1, ya.line2, ya.city, `${ya.state || ''} ${ya.zip || ''}`.trim()].filter(Boolean).join(', ') : ORG.address,
      ein: settings.employerEin || null, gaWithholdingNumber: yeE.gaWithholdingId || null };
    const firstDay = (p.i9 && ((p.i9.section2 && p.i9.section2.firstDay) || (p.i9.onFile && p.i9.onFile.firstDay))) || null;
    const pv = !!extra.preview;
    const ssn = pv ? null : openPlain(p.ssn);
    if (key === 'w4' && p.w4) return gov.fillW4({ person, ssn, w4: p.w4, employer, firstDay, ...extra });
    if (key === 'g4' && p.g4) return gov.fillG4({ person, ssn, g4: p.g4, employer, ...extra });
    if (key === 'i9' && p.i9 && p.i9.section1) return gov.fillI9({ person, ssn, i9: p.i9, employer, immigration: pv ? extra.immigration : openJson(p.i9Ids), docNumbers: pv ? null : openJson(p.i9DocNumbers), ...extra });
    if (key === 'w9' && p.w9) return gov.fillW9({ w9: p.w9, tin: pv ? null : openPlain(p.tin), ...extra });
    if (key === 'w8ben' && p.w8ben) return gov.fillW8BEN({ w8: p.w8ben, tins: pv ? null : openJson(p.w8benTins), ...extra });
    if (key === 'state' && p.stateCert) return gov.fillStateCert({ person, stateCert: p.stateCert, stateName: tables.stateName(p.stateCert.state), employer, ...extra });
    return null;
  };
  // File the signed copy on their Staff Record folder in Drive, and note it on
  // the profile. Best-effort: a Drive failure never undoes a signature, and the
  // form can always be produced again from what was signed.
  const fileGovForm = async (user, p, key, by) => {
    if (!drive || !drive.uploadStaffDocumentFile) return null;
    const buf = await govPdf(user, p, key);
    if (!buf) return null;
    const stamp = (localDate(nowIso()) || nowIso().slice(0, 10));
    const stored = await drive.uploadStaffDocumentFile(roleFolderFor(accountTypeOf(user)), personFolderName(user.name, user.id), `${gov.FILE_NAMES[key]} signed ${stamp}.pdf`, buf, 'application/pdf');
    const all = await readProfiles();
    const cur = all[String(user.id)];
    if (!cur) return null;
    cur.formsFiled = { ...(cur.formsFiled || {}), [key]: { driveFileId: (stored && (stored.fileId || stored.id)) || null, at: nowIso() } };
    all[String(user.id)] = cur;
    await db.set(PROFILES, all);
    await logActivity(by.id, by.name || by.email, 'payroll_form_filed', 'payroll_profile', String(user.id), { form: key });
    return stored;
  };
  const sendGovPdf = async (res, user, p, key) => {
    const buf = await govPdf(user, p, key);
    if (!buf) return res.status(404).json({ error: 'That form is not signed yet.', code: 'FORM_NOT_SIGNED' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition('attachment', `${gov.FILE_NAMES[key]} - ${user.name || 'employee'}.pdf`));
    res.setHeader('Cache-Control', 'no-store');
    return res.end(buf);
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
    const ov = overseasOf(await readSettings());
    res.json({
      profile: pp.publicProfile(p, { stateIncomeTax, overseasAllowed: ov.enabled || p.taxResidence === 'foreign' }),
      overseas: { enabled: ov.enabled, payMethods: Object.fromEntries(ov.payMethods.map(m => [m, pp.OVERSEAS_PAY_METHODS[m]])) }, workState: p.workState || 'GA', workStateName: tables.stateName(p.workState || 'GA'),
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
      // The official forms are filled from the legal name and address, and the
      // W-4 and withholding certificates from the SSN too (owner, 2026-11-14),
      // so a signed copy is never missing them. The SSN is asked for only once
      // it can be stored.
      if (['w4', 'g4', 'state-cert', 'i9'].includes(req.params.form)) {
        if (!p.taxAddress) return res.status(409).json({ error: 'Save your legal name and mailing address first. The form is filled in from them.', code: 'FORM_NEEDS_ADDRESS' });
        if (req.params.form !== 'i9' && !p.ssn && pc.configured(env)) return res.status(409).json({ error: 'Save your Social Security number first. The form is filled in from it.', code: 'FORM_NEEDS_SSN' });
      }
      switch (req.params.form) {
        case 'tax-residence': {
          if (!pp.isContractor(p)) return res.status(409).json({ error: 'This is for contractors.', code: 'RESIDENCE_NOT_CONTRACTOR' });
          if (!['us', 'foreign'].includes(b.residence)) return res.status(400).json({ error: 'Choose in the U.S. or outside the U.S.', code: 'RESIDENCE' });
          if (b.residence === 'foreign' && !overseasOf(await readSettings()).enabled) return res.status(409).json({ error: 'GFC is not set up to pay contractors abroad yet. Ask the office.', code: 'OVERSEAS_OFF' });
          p.taxResidence = b.residence; change = `Tax residence set: ${b.residence === 'foreign' ? 'outside the U.S.' : 'U.S.'}`; break;
        }
        case 'w8ben': {
          if (p.taxResidence !== 'foreign') return res.status(409).json({ error: 'A W-8BEN is for someone living outside the U.S. Choose that first.', code: 'W8_NOT_FOREIGN' });
          const n = pp.normalizeW8BEN(b, ctx); if (n.error) return res.status(400).json(n);
          p.w8ben = n.value;
          p.w8benTins = (n.foreignTin || n.usTin) ? { enc: pc.seal(JSON.stringify({ foreignTin: n.foreignTin, usTin: n.usTin }), env), at: ctx.at } : null;
          change = 'W-8BEN signed'; break;
        }
        case 'w4': { const n = pp.normalizeW4(b, ctx); if (n.error) return res.status(400).json(n); p.w4 = n.value; change = 'W-4 signed'; break; }
        case 'g4': { const n = pp.normalizeG4(b, ctx); if (n.error) return res.status(400).json(n); p.g4 = n.value; change = 'G-4 signed'; break; }
        case 'state-cert': {
          const st = p.workState || 'GA';
          if (st === 'GA') return res.status(409).json({ error: 'You work in Georgia: sign the G-4.', code: 'STATE_CERT_GEORGIA' });
          const n = pp.normalizeStateCert(b, ctx, st); if (n.error) return res.status(400).json(n);
          p.stateCert = n.value; change = `${tables.stateName(st)} withholding certificate signed`; break;
        }
        case 'i9': {
          const n = pp.normalizeI9Section1(b, ctx); if (n.error) return res.status(400).json(n);
          p.i9 = { ...(p.i9 || {}), section1: n.value };
          p.i9Ids = n.ids ? { enc: pc.seal(JSON.stringify(n.ids), env), at: ctx.at } : null;
          change = 'I-9 Section 1 signed'; break;
        }
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
          if (n.value.method === 'intl_wire') {
            const ov = overseasOf(await readSettings());
            if (p.taxResidence !== 'foreign' || !ov.enabled || !ov.payMethods.includes('intl_wire')) return res.status(409).json({ error: 'An international wire is for contractors abroad, where the office has turned it on.', code: 'WIRE_NOT_OFFERED' });
            p.payMethod = { ...n.value, accountEnc: pc.seal(n.account, env), accountLast4: pc.last4(n.account), at: ctx.at };
            change = 'Pay method set: intl_wire'; break;
          }
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
      const signed = { w4: 'w4', g4: 'g4', 'state-cert': 'state', i9: 'i9', w9: 'w9', w8ben: 'w8ben' }[req.params.form];
      if (signed) fileGovForm(req.user, saved, signed, req.user).catch(e => console.error('Form filing (non-fatal):', e.message));
      // A corrected name, address or SSN re-files the forms already signed, so
      // the copy in their folder matches what they would download now.
      if (['tax-address', 'ssn'].includes(req.params.form)) {
        (async () => { for (const k of gov.formsFor(saved).filter(k => ['w4', 'g4', 'state', 'i9'].includes(k))) await fileGovForm(req.user, saved, k, req.user); })()
          .catch(e => console.error('Form re-filing (non-fatal):', e.message));
      }
      res.json({ profile: pp.publicProfile(saved, { stateIncomeTax: await stateTaxesWages(saved), overseasAllowed: overseasOf(await readSettings()).enabled || saved.taxResidence === 'foreign' }) });
    } catch (e) {
      if (e.code === 'PAYROLL_KEY_MISSING') return res.status(503).json({ error: e.message, code: e.code });
      console.error('Pay setup error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  });


  // A live preview of the official form while they fill it in (owner,
  // 2026-11-14): the answers so far on the real form, marked PREVIEW, with
  // no signature and secret numbers as their last four. It writes nothing:
  // no profile change, no Drive copy, no activity row, and the answers are
  // never logged. Like signing, it needs the legal name and address first,
  // because the form is filled from them.
  const PREVIEW_FORMS = { w4: 'w4', g4: 'g4', 'state-cert': 'state', i9: 'i9', w9: 'w9', w8ben: 'w8ben' };
  router.post('/api/my/pay-setup/preview/:form', authenticateToken, requireStaff, async (req, res) => {
    try {
      const key = PREVIEW_FORMS[req.params.form];
      if (!key) return res.status(404).json({ error: 'Unknown form.' });
      const p = await profileFor(req.user);
      if (['w4', 'g4', 'state', 'i9'].includes(key) && !p.taxAddress) return res.status(409).json({ error: 'Save your legal name and mailing address first. The form is filled in from them.', code: 'FORM_NEEDS_ADDRESS' });
      const v = pp.previewValue(req.params.form, req.body || {}, { at: nowIso() });
      const draft = { ...p };
      const extra = { preview: true, ssnLast4: (p.ssn && p.ssn.last4) || null };
      if (key === 'w4') draft.w4 = v.value;
      if (key === 'g4') draft.g4 = v.value;
      if (key === 'state') draft.stateCert = { ...v.value, state: p.workState || 'GA' };
      if (key === 'i9') { draft.i9 = { ...(p.i9 || {}), section1: v.value }; extra.immigration = v.ids; }
      if (key === 'w9') { draft.w9 = v.value; extra.tinLast4 = v.tinLast4; }
      if (key === 'w8ben') { draft.w8ben = v.value; extra.usTinLast4 = v.usTinLast4; extra.foreignTinLast4 = v.foreignTinLast4; }
      const buf = await govPdf(req.user, draft, key, extra);
      if (!buf) return res.status(404).json({ error: 'That form has no preview.' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(buf);
    } catch (e) { console.error('Form preview error:', e.message); res.status(500).json({ error: 'Server error' }); }
  });
  // Where each answer sits on the blank form, for outlining the box being
  // filled. Template geometry only.
  router.get('/api/my/pay-setup/preview/:form/fields', authenticateToken, requireStaff, async (req, res) => {
    try {
      const key = PREVIEW_FORMS[req.params.form];
      if (!key) return res.status(404).json({ error: 'Unknown form.' });
      res.json(key === 'state' ? { pages: [{ width: 612, height: 792 }], fields: {} } : await gov.fieldBoxes(key));
    } catch (e) { console.error('Form fields error:', e.message); res.status(500).json({ error: 'Server error' }); }
  });

  // The signed official form, filled. Their own, or anyone's for the Super
  // Admin. It carries their full SSN, so every download is logged.
  router.get('/api/my/pay-setup/forms/:form.pdf', authenticateToken, requireStaff, async (req, res) => {
    try {
      if (!gov.FILE_NAMES[req.params.form]) return res.status(404).json({ error: 'Unknown form.' });
      await logActivity(req.user.id, req.user.name, 'payroll_form_downloaded', 'payroll_profile', String(req.user.id), { form: req.params.form });
      return sendGovPdf(res, req.user, await profileFor(req.user), req.params.form);
    } catch (e) { console.error('Form PDF error:', e); res.status(500).json({ error: 'Server error' }); }
  });
  router.get('/api/payroll/admin/people/:userId/forms/:form.pdf', authenticateToken, requireAdmin, async (req, res) => {
    try {
      if (!gov.FILE_NAMES[req.params.form]) return res.status(404).json({ error: 'Unknown form.' });
      const user = (await getUsers()).find(u => u && String(u.id) === String(req.params.userId));
      if (!user || !isStaff(user)) return res.status(404).json({ error: 'Staff member not found.' });
      await logActivity(req.user.id, req.user.name, 'payroll_form_downloaded', 'payroll_profile', String(user.id), { form: req.params.form });
      return sendGovPdf(res, user, await profileFor(user), req.params.form);
    } catch (e) { console.error('Form PDF error:', e); res.status(500).json({ error: 'Server error' }); }
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
    // An uploaded invoice (PDF or spreadsheet) with its total stands without
    // lines (owner, 2026-11-13). Lines, when given, must add up to the total.
    const given = !(b.total === undefined || b.total === '' || b.total === null);
    const total = given ? toCents(b.total) : null;
    if (given && !(total > 0)) return { error: 'Give the invoice total in dollars.', code: 'CI_TOTAL' };
    if (!lines.length) {
      if (!b.hasAttachment) return { error: 'Add at least one line, or upload your invoice with its total.', code: 'CI_NO_LINES' };
      if (!(total > 0)) return { error: 'Give the invoice total in dollars.', code: 'CI_TOTAL' };
      return { value: { invoiceNo: number, periodStart: b.periodStart, periodEnd: b.periodEnd, lines: [], totalCents: total } };
    }
    const sum = lines.reduce((a, l) => a + l.amountCents, 0);
    if (total !== null && total !== sum) return { error: `The lines add up to $${(sum / 100).toFixed(2)}, not the total you gave.`, code: 'CI_TOTAL_MISMATCH' };
    return { value: { invoiceNo: number, periodStart: b.periodStart, periodEnd: b.periodEnd, lines, totalCents: sum } };
  };
  // An invoice file: a PDF, an Excel workbook or a CSV, up to 10 MB, sent as
  // base64. Typed by its bytes, never by the name alone.
  const INVOICE_MAX = 10 * 1024 * 1024;
  const invoiceAttachment = (a) => {
    if (!a || !a.dataBase64) return null;
    const name = str(a.name, 120).replace(/[\\/]/g, '_') || 'invoice';
    const buf = Buffer.from(String(a.dataBase64), 'base64');
    if (!buf.length) return { error: 'That file is empty.', code: 'CI_FILE_EMPTY' };
    if (buf.length > INVOICE_MAX) return { error: 'The invoice file is over 10 MB.', code: 'CI_FILE_TOO_LARGE' };
    const m = name.match(/\.([a-z0-9]+)$/i);
    const ext = m ? m[1].toLowerCase() : '';
    if (buf.slice(0, 4).toString('latin1') === '%PDF') return { name, buf, type: 'application/pdf' };
    if (ext === 'xlsx' && buf[0] === 0x50 && buf[1] === 0x4B) return { name, buf, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    if (ext === 'csv' && !buf.includes(0)) return { name, buf, type: 'text/csv' };
    return { error: 'Upload a PDF, an Excel file (.xlsx) or a CSV.', code: 'CI_FILE_TYPE' };
  };
  // Managers and care coordinators review contractor invoices with the Super
  // Admin: approve, or send back with what to fix (owner, 2026-11-13). Paying
  // stays the Super Admin's.
  const canReviewInvoices = (u) => !!u && (u.role === 'admin' || isHoursEditor(u));
  router.get('/api/payroll/admin/contractor-invoices', authenticateToken, requireTimesheetViewer, async (req, res) => {
    const profiles = await readProfiles();
    const isSuper = !!req.user && req.user.role === 'admin';
    // How each is paid, for the Super Admin who pays it: never a full number.
    const payTo = (uid) => { const p = profiles[String(uid)] || {}; const pm = p.payMethod || {};
      return { method: pm.method || null, bankName: pm.bankName || null, bankCountry: pm.bankCountry || null, swift: pm.swift || null, accountLast4: pm.accountLast4 || null, wiseEmail: pm.wiseEmail || null, abroad: p.taxResidence === 'foreign' }; };
    const open = (await rows(CONTRACTOR_INVOICES)).filter(x => x.status === 'submitted' || x.status === 'approved')
      .sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)))
      .map(x => ({ ...x, payTo: isSuper ? payTo(x.userId) : null }));
    res.json({ invoices: open, canReview: canReviewInvoices(req.user), canPay: isSuper });
  });
  // The invoice file: its contractor, anyone who reviews invoices, or a preparer.
  router.get('/api/payroll/contractor-invoices/:id/file', authenticateToken, async (req, res) => {
    try {
      const inv = (await rows(CONTRACTOR_INVOICES)).find(x => x.id === req.params.id);
      const mine = inv && String(inv.userId) === String(req.user.id);
      if (!inv || !(mine || canReviewInvoices(req.user) || isPreparer(req.user))) return res.status(404).json({ error: 'Invoice not found.' });
      if (!inv.attachment || !inv.attachment.driveFileId) return res.status(404).json({ error: 'No file on this invoice.', code: 'CI_NO_FILE' });
      const buf = await drive.downloadFileBuffer(inv.attachment.driveFileId);
      await logActivity(req.user.id, req.user.name, 'contractor_invoice_file_opened', 'contractor_invoice', inv.id, {});
      res.setHeader('Content-Type', inv.attachment.type || 'application/octet-stream');
      res.setHeader('Content-Disposition', contentDisposition('attachment', inv.attachment.name || 'invoice'));
      res.setHeader('Cache-Control', 'no-store');
      return res.end(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    } catch (e) { console.error('Invoice file error:', e.message); res.status(502).json({ error: 'That file could not be opened right now.', code: 'CI_FILE_UNAVAILABLE' }); }
  });
  router.get('/api/my/contractor-invoices', authenticateToken, requireStaff, async (req, res) => {
    const p = await profileFor(req.user);
    const mine = (await rows(CONTRACTOR_INVOICES)).filter(x => String(x.userId) === String(req.user.id)).sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
    const year = nowIso().slice(0, 4);
    res.json({ contractor: pp.isContractor(p), abroad: p.taxResidence === 'foreign', invoices: mine, paidThisYearCents: mine.filter(x => x.status === 'paid' && String(x.paidAt).startsWith(year)).reduce((a, x) => a + x.totalCents, 0) });
  });
  router.post('/api/my/contractor-invoices', authenticateToken, requireStaff, async (req, res) => {
    const p = await profileFor(req.user);
    if (!pp.isContractor(p)) return res.status(403).json({ error: 'Invoices are for contractors. Ask the office if you are paid as one.', code: 'CI_NOT_CONTRACTOR' });
    const all = await rows(CONTRACTOR_INVOICES);
    const mine = all.filter(x => String(x.userId) === String(req.user.id) && x.status !== 'rejected');
    const att = invoiceAttachment((req.body || {}).attachment);
    if (att && att.error) return res.status(400).json(att);
    const n = normalizeContractorInvoice({ ...(req.body || {}), hasAttachment: !!att }, new Set(mine.map(x => String(x.invoiceNo).toLowerCase())));
    if (n.error) return res.status(400).json(n);
    // The file goes to their Staff Record folder first. If Drive refuses it,
    // nothing is recorded: an invoice pointing at a missing file is worse.
    let attachment = null;
    if (att) {
      try {
        const stored = await drive.uploadStaffDocumentFile(roleFolderFor(accountTypeOf(req.user)), personFolderName(req.user.name, req.user.id), `Invoice ${n.value.invoiceNo} - ${att.name}`, att.buf, att.type);
        attachment = { name: att.name, type: att.type, bytes: att.buf.length, driveFileId: (stored && (stored.fileId || stored.id)) || null };
      } catch (e) {
        console.error('Invoice upload error:', e.message);
        return res.status(502).json({ error: 'Your invoice file could not be stored. Try again in a few minutes.', code: 'CI_FILE_NOT_STORED' });
      }
    }
    // A line naming an exam or visit date with nothing on the schedule is
    // flagged for the owner, never refused: the contractor knows their work.
    const inv = { id: uuidv4(), userId: String(req.user.id), name: req.user.name || req.user.email, ...n.value, attachment, status: 'submitted', submittedAt: nowIso(), history: [{ at: nowIso(), action: 'submitted' }] };
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

  router.get('/api/payroll/admin/overview', authenticateToken, requireTimesheetViewer, async (req, res) => {
    try {
      const settings = await readSettings();
      // A manager or care coordinator without the Payroll module: timesheets only.
      if (!isPreparer(req.user)) {
        const allRuns = await rows(RUNS);
        return res.json({
          superAdmin: false, timesheetsOnly: true, stateNames: tables.STATE_NAMES,
          schedules: Object.entries(tax.PAY_SCHEDULES).map(([key, v]) => ({ key, label: v.label, ...tax.scheduleSettings(settings, key), current: tax.periodFor(today(), settings, key), periods: periodList(allRuns, settings, key) }))
        });
      }
      const people = await staffPeople();
      const runs = await rows(RUNS);
      const allTables = await rows(TAX_TABLES);
      const year = Number(nowIso().slice(0, 4));
      res.json({
        // A preparer (a Payroll grant) sees the page without the Super
        // Admin's buttons; the routes refuse those whatever the page shows.
        superAdmin: !!req.user && req.user.role === 'admin',
        settings, frequencies: Object.keys(tax.FREQUENCIES),
        secretsStorable: pc.configured(env), automationKeySet: !!payrollKey(),
        tablesActive: !!(await activeTables(year)), tablesActiveNextYear: !!(await activeTables(year + 1)),
        taxTables: allTables.map(t => ({ id: t.id, year: t.year, jurisdiction: t.jurisdiction, status: t.status, source: t.source, stagedAt: t.stagedAt, approvedAt: t.approvedAt || null, approvedBy: t.approvedBy || null, data: t.data })),
        people: people.map(({ user, profile }) => ({
          userId: String(user.id), name: user.name || user.email, accountType: accountTypeOf(user), email: user.email,
          profile: pp.publicProfile(profile), missing: pp.missingForPerson(profile), missingContractor: pp.isContractor(profile) ? pp.missingForPay(profile, { asContractor: true }) : [],
          caregiverPayRate: profile.isCaregiver ? (user.payRate || null) : null,
          // Set in User Management: the page shows it and does not edit it.
          employmentTypeOnUser: profile.isCaregiver || ['W2', '1099', 'HYBRID'].includes(user.employmentType)
        })).sort((a, b) => a.name.localeCompare(b.name)),
        // How it was sent and how many payments are marked paid, so the list
        // reads true at a glance (owner, 2026-11-14: an approved run sent by
        // Cash App showed only "approved").
        runs: runs.map(r => {
          const toPay = (r.workers || []).filter(w => w.pay);
          const p2p = toPay.filter(w => w.channel === 'p2p').length;
          return { id: r.id, status: r.status, source: r.source || 'app', schedule: (r.source || 'app') === 'app' ? runSchedule(r) : null, period: r.period, totals: r.totals, blocked: r.blocked, createdAt: r.createdAt, approvedAt: r.approvedAt || null, paidAt: r.paidAt || null,
            people: toPay.length, markedPaid: toPay.filter(w => (r.payments || {})[w.userId]).length, p2p };
        })
          .sort((a, b) => String(b.period.start).localeCompare(String(a.period.start))),
        nextPeriod: tax.periodFor((localDate(nowIso()) || nowIso().slice(0, 10)), settings),
        // Both schedules, each with the period running today and the pay
        // periods to pick from (standard ones, then any custom run's).
        schedules: Object.entries(tax.PAY_SCHEDULES).map(([key, v]) => ({
          key, label: v.label, ...tax.scheduleSettings(settings, key),
          current: tax.periodFor((localDate(nowIso()) || nowIso().slice(0, 10)), settings, key),
          periods: periodList(runs, settings, key),
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
    res.json({ profile: pp.publicProfile(saved), missing: pp.missingForPerson(saved) });
  });

  router.put('/api/payroll/admin/people/:userId/i9-section2', authenticateToken, requireAdmin, async (req, res) => {
   try {
    const user = (await getUsers()).find(u => u && String(u.id) === String(req.params.userId));
    if (!user || !isStaff(user)) return res.status(404).json({ error: 'Staff member not found.' });
    const p = await profileFor(user);
    if (!(p.i9 && p.i9.section1)) return res.status(409).json({ error: 'The employee completes Section 1 first.', code: 'I9_SECTION1_FIRST' });
    const n = pp.normalizeI9Section2(req.body, { at: nowIso(), by: req.user.name || req.user.email });
    if (n.error) return res.status(400).json(n);
    p.i9 = { ...p.i9, section2: n.value };
    p.i9DocNumbers = n.numbers.some(Boolean) ? { enc: pc.seal(JSON.stringify(n.numbers), env), at: nowIso() } : null;
    const saved = await saveProfile(user.id, p, 'I-9 Section 2 completed', req.user);
    fileGovForm(user, saved, 'i9', req.user).catch(e => console.error('I-9 filing (non-fatal):', e.message));
    res.json({ profile: pp.publicProfile(saved), missing: pp.missingForPerson(saved) });
   } catch (e) {
    if (e.code === 'PAYROLL_KEY_MISSING') return res.status(503).json({ error: e.message, code: e.code });
    console.error('I-9 Section 2 error:', e); res.status(500).json({ error: 'Server error' });
   }
  });

  // An I-9 already on file from Gusto or paper (owner, 2026-11-13). The
  // Super Admin records it once the signed copy is on their Staff Record.
  router.put('/api/payroll/admin/people/:userId/i9-on-file', authenticateToken, requireAdmin, async (req, res) => {
    const user = (await getUsers()).find(u => u && String(u.id) === String(req.params.userId));
    if (!user || !isStaff(user)) return res.status(404).json({ error: 'Staff member not found.' });
    const p = await profileFor(user);
    if (pp.i9Complete(p)) return res.status(409).json({ error: 'Their I-9 is already complete.', code: 'I9_ALREADY_COMPLETE' });
    const n = pp.normalizeI9OnFile(req.body, { at: nowIso(), by: req.user.name || req.user.email });
    if (n.error) return res.status(400).json(n);
    p.i9 = { ...(p.i9 || {}), onFile: n.value };
    const saved = await saveProfile(user.id, p, `I-9 on file from ${pp.I9_ON_FILE_SOURCES[n.value.source]}`, req.user);
    res.json({ profile: pp.publicProfile(saved), missing: pp.missingForPerson(saved) });
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
  const wasDeleted = (x, period) => x && period && x.start === period.start && x.end === period.end && x.schedule === (period.schedule || 'staff');
  const sameRun = (r, period) => r && r.period && r.period.start === period.start && (!period.end || !r.period.end || r.period.end === period.end) && runSchedule(r) === (period.schedule || 'staff') && (r.source || 'app') === 'app';
  // The pay periods to pick from (owner, 2026-11-14): the schedule's standard
  // periods around today, and any custom period a run was drafted for, each
  // with the run's status when there is one.
  const periodList = (runs, settings, schedule) => {
    const appRuns = (runs || []).filter(r => r && r.status !== 'void' && (r.source || 'app') === 'app' && runSchedule(r) === schedule);
    // A week paid before the app (imported from Gusto) reads as paid in Gusto,
    // never as "no payroll yet".
    const gusto = (runs || []).filter(r => r && r.source === 'gusto' && r.period);
    const status = (p) => { const r = appRuns.find(x => x.period.start === p.start && x.period.end === p.end); if (r) return r.status; return gusto.some(x => x.period.start === p.start && x.period.end === p.end) ? 'gusto' : null; };
    const std = tax.periodsAround(today(), settings, schedule).map(p => ({ start: p.start, end: p.end, payDate: p.payDate, custom: false, status: status(p) }));
    const custom = appRuns.filter(r => r.period.custom).map(r => ({ start: r.period.start, end: r.period.end, payDate: r.period.payDate, frequency: r.period.frequency, custom: true, status: r.status }));
    return [...std, ...custom].sort((a, b) => String(b.start).localeCompare(String(a.start)));
  };
  // A period named by its first and last day: a standard one, or the custom
  // period a run was drafted for. Null when it is neither.
  const resolvePeriod = async (schedule, start, end, settings) => {
    const std = tax.periodFor(start, settings, schedule);
    if (std.start === start && (!end || std.end === end)) return std;
    const r = (await rows(RUNS)).find(x => x && x.status !== 'void' && x.period && x.period.custom && x.period.start === start && x.period.end === end && runSchedule(x) === schedule);
    return r ? { ...r.period, schedule } : null;
  };
  const sheetKey = (schedule, period) => (period.custom ? `${period.start}~${period.end}` : period.start);
  const draftFor = async (period, settings, adjustments, channels, manualTaxes) => {
    const runs = await rows(RUNS);
    const tbl = await activeTables(Number(period.payDate.slice(0, 4)));
    if (!tbl) return { error: `No approved ${period.payDate.slice(0, 4)} tax tables. Approve the federal and Georgia tables under Taxes first.`, code: 'PAYROLL_NO_TABLES' };
    const gathered = await gatherFor(period, runs.filter(r => r.status !== 'draft'));
    const schedule = period.schedule || 'staff';
    const people = (await staffPeople()).filter(x => pp.isEmployee(x.profile) && x.profile.status !== 'inactive' && pp.scheduleFor(x.profile) === schedule);
    const run = engine.buildRun({
      period, settings, people, gathered, tables: tbl,
      ytdByUser: engine.ytdFrom(runs, { year: period.payDate.slice(0, 4), beforePayDate: period.payDate }),
      adjustments, channels, manualTaxes
    });
    run.channels = channels || { default: 'direct_deposit', byUser: {} };
    run.manualTaxes = manualTaxes || {};
    run.skippedItems = gathered.skipped;
    run.tableIds = tbl.ids;
    // Whose hours are not approved yet (owner, 2026-11-13). A warning, never a
    // hold: hours worked are paid on payday.
    run.unapprovedTimesheets = await unapprovedFor(period, run.workers, gathered);
    return { run, gathered };
  };
  const printsFrom = (gathered) => new Map([...gathered.byUser.entries()].map(([uid, items]) => [String(uid), ts.fingerprint(items)]));
  const sheetsFor = async (period) => (await rows(TIMESHEETS)).filter(x => x.schedule === (period.schedule || 'staff') && x.periodStart === period.start && (period.custom ? x.periodEnd === period.end && x.custom : !x.custom));
  const unapprovedFor = async (period, workers, gathered) => {
    const prints = printsFrom(gathered);
    const empty = ts.fingerprint([]);
    const withPrint = new Map((workers || []).map(w => [String(w.userId), prints.get(String(w.userId)) || empty]));
    return ts.unapproved(workers, await sheetsFor(period), withPrint);
  };

  // ---- Timesheets: hours approved before payroll (owner, 2026-11-13) -----------------
  // One person's timesheet for one period: their hour items as payroll would
  // pay them, still clocked in, anything payroll cannot pay, and where it stands.
  const today = () => (localDate(nowIso()) || nowIso().slice(0, 10));
  const sheetView = async (user, period, gathered, sheets, runs) => {
    const uid = String(user.id);
    const run = runs.find(r => sameRun(r, period) && r.status !== 'draft' && r.status !== 'void');
    const worker = run && (run.workers || []).find(w => String(w.userId) === uid);
    const items = gathered.byUser.get(uid) || [];
    const sheet = sheets.find(x => String(x.userId) === uid) || null;
    const print = ts.fingerprint(items);
    const allLogs = await rows('time_logs');
    const openLogs = allLogs.filter(l => l && String(l.caregiver_id) === uid && !l.clock_out_at && (() => { const d = localDate(l.clock_in_at); return d && d >= period.start && d <= period.end; })())
      .map(l => ({ id: l.id, date: localDate(l.clock_in_at) }));
    // Each clocked line carries its times and any change waiting on the Super
    // Admin, so the employee, the managers and the office see the same thing.
    const logById = new Map(allLogs.filter(Boolean).map(l => [String(l.id), l]));
    const pendingByLog = new Map((await rows('time_log_adjustment_requests')).filter(r => r && r.status === 'pending').map(r => [String(r.time_log_id), r]));
    const sheetLines = ts.lines(items).map(line => {
      if (!String(line.ref).startsWith('log:')) return { ...line, editable: false };
      const l = logById.get(String(line.ref).slice(4));
      if (!l) return { ...line, editable: false };
      const pr = pendingByLog.get(String(l.id));
      return {
        ...line, timeLogId: l.id, clockIn: l.clock_in_at, clockOut: l.clock_out_at, client: l.client_name || null,
        edited: !!l.edited, editReason: l.edited ? (l.edit_reason || null) : null, editedBy: l.edited ? (l.edited_by_name || null) : null,
        editable: !l.payroll_run_id,
        pendingChange: pr ? { id: pr.id, clockIn: pr.requested_clock_in, clockOut: pr.requested_clock_out, reason: pr.reason, by: pr.requested_by_name, self: pr.requested_by_role === 'self', at: pr.requested_at } : null
      };
    });
    return {
      schedule: period.schedule || 'staff', period, userId: uid, name: user.name || user.email,
      paid: !!run, paidMinutes: worker ? (worker.earnings || []).reduce((a, e) => a + (Number(e.minutes) || 0), 0) : null,
      lines: sheetLines, totals: ts.totals(items), openClockIns: openLogs,
      cannotPay: gathered.skipped.filter(x => String(x.userId) === uid).map(x => x.reason),
      ended: period.end < today(),
      status: ts.statusOf(sheet, print),
      employee: sheet && sheet.employee ? { status: sheet.employee.status, note: sheet.employee.note, at: sheet.employee.at } : null,
      office: sheet && sheet.office ? { status: sheet.office.status, note: sheet.office.note, at: sheet.office.at, by: sheet.office.by } : null
    };
  };
  const paidRuns = async () => (await rows(RUNS)).filter(r => r.status !== 'draft');
  const userFor = async (id) => (await getUsers()).find(u => u && String(u.id) === String(id)) || null;

  // The employee's own: this period and the two before it.
  router.get('/api/my/timesheets', authenticateToken, requireStaff, async (req, res) => {
    try {
      const p = await profileFor(req.user);
      if (!pp.isEmployee(p)) return res.json({ employee: false, timesheets: [] });
      const settings = await readSettings();
      const schedule = pp.scheduleFor(p);
      const cur = tax.periodFor(today(), settings, schedule);
      const periods = [cur];
      for (let k = 0; k < 2; k++) periods.push(tax.periodFor(tax.addDays(periods[periods.length - 1].start, -1), settings, schedule));
      const runs = await rows(RUNS); const paid = runs.filter(r => r.status !== 'draft');
      const all = await rows(TIMESHEETS);
      const out = [];
      for (const period of periods) {
        const gathered = await gatherFor(period, paid);
        out.push(await sheetView(req.user, period, gathered, all.filter(x => x.schedule === schedule && x.periodStart === period.start && !x.custom), runs));
      }
      res.json({ employee: true, timesheets: out });
    } catch (e) { console.error('My timesheets error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // "Looks right" or "Something is wrong" (with a note), once the period ends.
  router.post('/api/my/timesheets/:schedule/:periodStart', authenticateToken, requireStaff, async (req, res) => {
    try {
      const p = await profileFor(req.user);
      const schedule = pp.scheduleFor(p);
      if (!pp.isEmployee(p) || req.params.schedule !== schedule) return res.status(404).json({ error: 'No such timesheet.', code: 'TIMESHEET_UNKNOWN' });
      const settings = await readSettings();
      if (!tax.isYmd(req.params.periodStart)) return res.status(400).json({ error: 'No such period.', code: 'TIMESHEET_UNKNOWN' });
      const period = tax.periodFor(req.params.periodStart, settings, schedule);
      if (period.start !== req.params.periodStart) return res.status(404).json({ error: 'No such period.', code: 'TIMESHEET_UNKNOWN' });
      if (!(period.end < today())) return res.status(409).json({ error: 'You can confirm your hours once the pay period ends.', code: 'TIMESHEET_PERIOD_OPEN' });
      const runs = await rows(RUNS);
      if (runs.some(r => sameRun(r, period) && r.status !== 'draft' && r.status !== 'void')) return res.status(409).json({ error: 'This period is already paid. Tell the office about anything wrong; it is corrected on your next pay.', code: 'TIMESHEET_PAID' });
      const n = ts.normalizeEmployee(req.body); if (n.error) return res.status(400).json(n);
      const gathered = await gatherFor(period, runs.filter(r => r.status !== 'draft'));
      const print = ts.fingerprint(gathered.byUser.get(String(req.user.id)) || []);
      const all = await rows(TIMESHEETS);
      const id = ts.sheetId(schedule, period.start, req.user.id);
      const i = all.findIndex(x => x.id === id);
      const next = ts.record(i === -1 ? null : all[i], { id, schedule, periodStart: period.start, periodEnd: period.end, userId: String(req.user.id), name: req.user.name || req.user.email }, 'employee', n.value, { at: nowIso(), by: req.user.name || req.user.email, byId: req.user.id, print });
      if (i === -1) all.push(next); else all[i] = next;
      await db.set(TIMESHEETS, all);
      await logActivity(req.user.id, req.user.name, `timesheet_${n.value.status}`, 'payroll_timesheet', id, { period: period.start });
      if (n.value.status === 'flagged') await tellOwner('timesheet_flagged', `${req.user.name || 'An employee'} flagged their hours`, `${req.user.name || 'An employee'} says something is wrong with their hours for ${period.start} to ${period.end}. Review it under Payroll → Timesheets.`, `ts-flag:${id}:${next.employee.at}`).catch(() => {});
      res.json({ timesheet: await sheetView(req.user, period, gathered, [next], runs) });
    } catch (e) { console.error('Timesheet confirm error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // The office's view of one period: everyone on the schedule.
  router.get('/api/payroll/admin/timesheets', authenticateToken, requireTimesheetViewer, async (req, res) => {
    try {
      const settings = await readSettings();
      const schedule = tax.PAY_SCHEDULES[req.query.schedule] ? req.query.schedule : 'caregivers';
      let period;
      if (tax.isYmd(req.query.start) && tax.isYmd(req.query.end)) {
        period = await resolvePeriod(schedule, req.query.start, req.query.end, settings);
        if (!period) return res.status(404).json({ error: 'No such pay period.', code: 'TIMESHEET_UNKNOWN' });
      } else {
        const date = tax.isYmd(req.query.date) ? req.query.date : tax.addDays(tax.periodFor(today(), settings, schedule).start, -1);
        period = tax.periodFor(date, settings, schedule);
      }
      const runs = await rows(RUNS);
      const gathered = await gatherFor(period, runs.filter(r => r.status !== 'draft'));
      const sheets = await sheetsFor(period);
      const people = (await staffPeople()).filter(x => pp.isEmployee(x.profile) && x.profile.status !== 'inactive' && pp.scheduleFor(x.profile) === schedule);
      const out = [];
      for (const x of people) {
        const u = x.user;
        const v = await sheetView(u, period, gathered, sheets, runs);
        if (v.lines.length || v.openClockIns.length || v.cannotPay.length || v.employee || v.office || v.paid) out.push(v);
      }
      // How this viewer edits hours: the Super Admin directly (with a reason),
      // a manager or coordinator by request, a preparer not at all.
      const isSuper = !!req.user && req.user.role === 'admin';
      // Whether this period's payroll exists yet, so the screen never reads
      // the payday as though it had already been paid (owner, 2026-11-14).
      const run = runs.find(r => sameRun(r, period) && r.status !== 'void')
        || runs.find(r => r && r.source === 'gusto' && r.period && r.period.start === period.start && r.period.end === period.end);
      res.json({ period, schedule, ended: period.end < today(), run: run ? { id: run.id, status: run.source === 'gusto' ? 'gusto' : run.status } : null, superAdmin: isSuper, canDecide: isSuper || isHoursEditor(req.user), editHours: isSuper ? 'direct' : isHoursEditor(req.user) ? 'request' : null, timesheets: out.sort((a, b) => a.name.localeCompare(b.name)) });
    } catch (e) { console.error('Office timesheets error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // Approve, or send back with what to correct. The Super Admin, managers and
  // care coordinators (owner, 2026-11-14: they review hours). Approving the
  // payroll itself stays the Super Admin's.
  const requireTimesheetDecider = (req, res, next) => (req.user && (req.user.role === 'admin' || isHoursEditor(req.user)) ? next()
    : res.status(403).json({ error: 'Approving timesheets is for the Super Admin, managers and care coordinators.', code: 'TIMESHEET_DECIDER_ONLY' }));
  router.post('/api/payroll/admin/timesheets/decide', authenticateToken, requireTimesheetDecider, async (req, res) => {
    try {
      const b = req.body || {};
      if (!tax.PAY_SCHEDULES[b.schedule] || !tax.isYmd(b.periodStart)) return res.status(400).json({ error: 'Which schedule and period?', code: 'TIMESHEET_UNKNOWN' });
      const settings = await readSettings();
      const period = await resolvePeriod(b.schedule, b.periodStart, tax.isYmd(b.periodEnd) ? b.periodEnd : null, settings);
      if (!period) return res.status(400).json({ error: 'No such period.', code: 'TIMESHEET_UNKNOWN' });
      const user = await userFor(b.userId);
      if (!user || !isStaff(user)) return res.status(404).json({ error: 'Staff member not found.' });
      const n = ts.normalizeOffice(b); if (n.error) return res.status(400).json(n);
      const runs = await rows(RUNS);
      if (runs.some(r => sameRun(r, period) && r.status !== 'draft' && r.status !== 'void')) return res.status(409).json({ error: 'This period is already paid. A correction goes on the next run as an adjustment.', code: 'TIMESHEET_PAID' });
      const gathered = await gatherFor(period, runs.filter(r => r.status !== 'draft'));
      const print = ts.fingerprint(gathered.byUser.get(String(user.id)) || []);
      const all = await rows(TIMESHEETS);
      const id = ts.sheetId(b.schedule, sheetKey(b.schedule, period), user.id);
      const i = all.findIndex(x => x.id === id);
      const next = ts.record(i === -1 ? null : all[i], { id, schedule: b.schedule, periodStart: period.start, periodEnd: period.end, custom: !!period.custom, userId: String(user.id), name: user.name || user.email }, 'office', n.value, { at: nowIso(), by: req.user.name || req.user.email, byId: req.user.id, print });
      if (i === -1) all.push(next); else all[i] = next;
      await db.set(TIMESHEETS, all);
      await logActivity(req.user.id, req.user.name, `timesheet_${n.value.status}`, 'payroll_timesheet', id, { period: period.start, userId: String(user.id) });
      // The note stays in the app: it can name a client. The email only says where to look.
      if (n.value.status === 'sent_back' && user.email && queueNotification) {
        const base = getAppBaseUrl ? await getAppBaseUrl().catch(() => '') : '';
        await queueNotification('timesheet_sent_back', user.id, user.email, user.name, {
          subject: 'Your hours need a correction',
          body: `The office sent back your hours for ${period.start} to ${period.end}. Open My GFC, then Hours & Pay, to see what to correct.`,
          ctaUrl: base ? `${base}/${accountTypeOf(user) === 'caregiver' ? 'caregiver' : 'my'}#hours` : undefined, ctaLabel: 'Open Hours & Pay'
        }, { relatedEntityId: `ts-back:${id}:${next.office.at}` }).catch(e => console.error('Timesheet notice (non-fatal):', e.message));
      }
      res.json({ timesheet: await sheetView(user, period, gathered, [next], runs) });
    } catch (e) { console.error('Timesheet decide error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  router.post('/api/payroll/admin/runs', authenticateToken, requirePayrollPreparer, async (req, res) => {
    try {
      const settings = await readSettings();
      const b = req.body || {};
      const schedule = String(b.schedule || '');
      if (!tax.PAY_SCHEDULES[schedule]) return res.status(400).json({ error: 'Choose the caregivers (weekly) or everyone-else schedule.', code: 'RUN_SCHEDULE' });
      // A standard pay period (by its first day), or a custom one.
      let period;
      if (b.custom) {
        const c = tax.customPeriod(b.custom, schedule);
        if (c.error) return res.status(400).json(c);
        period = c.value;
      } else {
        const start = String(b.periodStart || '');
        if (!tax.isYmd(start)) return res.status(400).json({ error: 'Choose a pay period.', code: 'RUN_PERIOD' });
        period = tax.periodFor(start, settings, schedule);
      }
      const runs = await rows(RUNS);
      const existing = runs.find(r => sameRun(r, period) && r.status !== 'void');
      if (existing && existing.status !== 'draft') return res.status(409).json({ error: 'That period is already approved.', code: 'RUN_ALREADY_APPROVED', runId: existing.id });
      const d = await draftFor(period, settings, existing ? existing.adjustments : [], existing ? existing.channels : null, existing ? existing.manualTaxes : null);
      if (d.error) return res.status(409).json(d);
      const run = { id: existing ? existing.id : uuidv4(), status: 'draft', ...d.run, adjustments: existing ? existing.adjustments || [] : [], createdAt: existing ? existing.createdAt : nowIso(), rebuiltAt: nowIso(), createdBy: req.user.name };
      const next = existing ? runs.map(r => (r.id === run.id ? run : r)) : [...runs, run];
      await db.set(RUNS, next);
      // Drafting a deleted period by hand brings it back for the automation too.
      const gone = await rows(DELETED_DRAFTS);
      if (gone.some(x => wasDeleted(x, period))) await db.set(DELETED_DRAFTS, gone.filter(x => !wasDeleted(x, period)));
      await logActivity(req.user.id, req.user.name, 'payroll_run_drafted', 'payroll_run', run.id, { period: period.start, workers: run.workers.length, grossCents: run.totals.grossCents });
      res.json({ run });
    } catch (e) { console.error('Payroll draft error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // Delete a draft (owner, 2026-11-14). A draft has paid nothing, locked no
  // hours and sent no stubs, so it is removed outright. An approved run is
  // never deleted; a mistake there goes on the next run. The Super Admin's
  // alone, since a draft can carry their channel choice and hand-entered taxes.
  router.delete('/api/payroll/admin/runs/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const runs = await rows(RUNS);
      const run = runs.find(r => r.id === req.params.id);
      if (!run) return res.status(404).json({ error: 'Run not found.' });
      if (run.status !== 'draft') return res.status(409).json({ error: 'Only a draft can be deleted. An approved payroll is corrected on the next run.', code: 'RUN_LOCKED' });
      await db.set(RUNS, runs.filter(r => r.id !== run.id));
      const gone = (await rows(DELETED_DRAFTS)).filter(x => !wasDeleted(x, run.period));
      gone.push({ schedule: runSchedule(run), start: run.period.start, end: run.period.end, custom: !!run.period.custom, runId: run.id, deletedAt: nowIso(), deletedBy: req.user.name || req.user.email });
      await db.set(DELETED_DRAFTS, gone);
      await logActivity(req.user.id, req.user.name, 'payroll_run_draft_deleted', 'payroll_run', run.id, { period: run.period.start, end: run.period.end, schedule: runSchedule(run), workers: (run.workers || []).length });
      res.json({ deleted: true });
    } catch (e) { console.error('Payroll draft delete error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  router.get('/api/payroll/admin/runs/:id', authenticateToken, requirePayrollPreparer, async (req, res) => {
    const run = (await rows(RUNS)).find(r => r.id === req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found.' });
    // A draft's timesheet warning is read now, not when it was built, so a
    // timesheet approved since then no longer shows (owner, 2026-11-14).
    if (run.status === 'draft' && run.period) {
      try {
        const gathered = await gatherFor(run.period, (await rows(RUNS)).filter(r => r.status !== 'draft'));
        run.unapprovedTimesheets = await unapprovedFor(run.period, run.workers, gathered);
      } catch (e) { /* keep the stored list */ }
    }
    // A Gusto run: the payment correction in force for each person, and their
    // other Gusto paydays, so one correction can cover several.
    if (run.source === 'gusto') {
      const corr = await rows(CORRECTIONS);
      const gustoRuns = (await rows(RUNS)).filter(r => r && r.source === 'gusto');
      run.correctionOptions = {};
      for (const w of run.workers || []) {
        const fix = correctionFor(corr, run.id, w.userId);
        if (fix) w.paymentCorrection = { method: fix.method, label: CORRECTION_METHODS[fix.method], receipt: fix.receipt, sentOn: fix.sentOn, reason: fix.reason, recordedAs: fix.recordedAs, by: fix.by, at: fix.at };
        run.correctionOptions[w.userId] = gustoRuns.filter(r => r.id !== run.id && (r.workers || []).some(x => String(x.userId) === String(w.userId) && x.pay))
          .map(r => { const f = correctionFor(corr, r.id, w.userId); const x = r.workers.find(y => String(y.userId) === String(w.userId)); return { runId: r.id, payDate: r.period.payDate, recordedAs: x.payMethod || null, correctedTo: f ? f.method : null }; })
          .sort((a, b) => String(b.payDate).localeCompare(String(a.payDate)));
      }
      run.correctionMethods = CORRECTION_METHODS;
    }
    res.json({ run });
  });

  // Taxes entered by hand for one person on a draft (owner, 2026-11-14): the
  // Super Admin's alone, with a reason, kept on the run and its activity log.
  router.put('/api/payroll/admin/runs/:id/manual-taxes/:userId', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const runs = await rows(RUNS);
      const i = runs.findIndex(r => r.id === req.params.id);
      if (i === -1) return res.status(404).json({ error: 'Run not found.' });
      if (runs[i].status !== 'draft') return res.status(409).json({ error: 'This payroll is approved. A correction goes on the next run.', code: 'RUN_LOCKED' });
      const uid = String(req.params.userId);
      if (!(runs[i].workers || []).some(w => String(w.userId) === uid)) return res.status(404).json({ error: 'That person is not on this payroll.' });
      const b = req.body || {};
      const manualTaxes = { ...(runs[i].manualTaxes || {}) };
      if (b.clear === true) delete manualTaxes[uid];
      else {
        const amt = {};
        for (const k of ['federal', 'socialSecurity', 'medicare', 'stateTax']) {
          const c = toCents(b[k] === undefined || b[k] === '' ? '0' : b[k]);
          if (c === null || c < 0) return res.status(400).json({ error: 'Enter each tax as dollars, 0 or more.', code: 'MANUAL_TAX_AMOUNT' });
          amt[k] = c;
        }
        const reason = str(b.reason, 300);
        if (!reason) return res.status(400).json({ error: 'Say why these taxes are entered by hand.', code: 'MANUAL_TAX_REASON' });
        manualTaxes[uid] = { ...amt, reason, by: req.user.name || req.user.email, at: nowIso() };
      }
      const settings = await readSettings();
      const d = await draftFor(runs[i].period, settings, runs[i].adjustments || [], runs[i].channels, manualTaxes);
      if (d.error) return res.status(409).json(d);
      const w = d.run.workers.find(x => String(x.userId) === uid);
      if (w && w.pay && w.pay.netCents < 0) return res.status(400).json({ error: 'Those taxes are more than their pay.', code: 'MANUAL_TAX_TOO_HIGH' });
      // Remember the gross these taxes were entered against.
      if (manualTaxes[uid] && w && w.pay) { manualTaxes[uid].grossCents = w.pay.grossCents; w.manualTaxes.grossCents = w.pay.grossCents; w.manualTaxes.grossChanged = false; }
      runs[i] = { ...runs[i], ...d.run, status: 'draft', rebuiltAt: nowIso() };
      await db.set(RUNS, runs);
      await logActivity(req.user.id, req.user.name, b.clear === true ? 'payroll_manual_taxes_cleared' : 'payroll_manual_taxes_set', 'payroll_run', runs[i].id, { userId: uid, reason: b.clear === true ? null : manualTaxes[uid].reason });
      res.json({ run: runs[i] });
    } catch (e) { console.error('Manual taxes error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // The run's register (owner, 2026-11-09: "ensure all exports match the
  // data recorded in app"). Built from the run itself, never recomputed, so
  // every figure is exactly what the run, the pay stubs and QuickBooks carry,
  // and the TOTAL row is the run's own totals. No SSN or bank number.
  router.get('/api/payroll/admin/runs/:id/register.csv', authenticateToken, requirePayrollPreparer, async (req, res) => {
    const run = (await rows(RUNS)).find(r => r.id === req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found.' });
    const d = (c) => (Number(c || 0) / 100).toFixed(2);
    const h = (m) => (Number(m || 0) / 60).toFixed(2);
    const q = (v) => { const t = String(v === null || v === undefined ? '' : v); return /^[=+\-@]/.test(t) ? `"'${t.replace(/"/g, '""')}"` : `"${t.replace(/"/g, '""')}"`; };
    // Each kind of pay in its own column, and every line added by hand named
    // with its note (owner, 2026-11-14: a bonus must show as a line, not only
    // as a bigger gross).
    const amt = (w, codes) => (w.earnings || []).filter(e => codes.includes(e.code)).reduce((a, e) => a + (e.amountCents || 0), 0);
    const kinds = [['Regular Pay', ['regular']], ['Overtime Pay', ['overtime']], ['Salary', ['salary']], ['Visit and Exam Pay', ['per_visit', 'per_exam']], ['Bonus', ['bonus']], ['Correction', ['correction']]];
    const added = (w) => (run.adjustments || []).filter(a => String(a.userId) === String(w.userId))
      .map(a => `${engine.ADJUSTMENT_TYPES[a.type] || a.type} ${a.amountCents < 0 ? '-' : ''}$${d(Math.abs(a.amountCents))}: ${a.note || ''}`).join('; ');
    const head = ['Name', 'Work State', 'Regular Hours', 'Overtime Hours', ...kinds.map(k => k[0]), 'Gross', 'Federal Income Tax', 'Social Security', 'Medicare', 'State Income Tax', 'Net Pay', 'Reimbursements', 'Employer Social Security', 'Employer Medicare', 'FUTA', 'State Unemployment', 'Pay Method', 'Payment Confirmation', 'Recorded In Gusto As', 'Payment Correction', 'Added Lines', 'Taxes Entered By Hand', 'Missing Paperwork'];
    const corr = run.source === 'gusto' ? await rows(CORRECTIONS) : [];
    const lines = [head.map(q).join(',')];
    for (const w of run.workers || []) {
      const reg = (w.earnings || []).find(e => e.code === 'regular'), ot = (w.earnings || []).find(e => e.code === 'overtime');
      const p = w.pay;
      const pay = (run.payments || {})[w.userId];
      lines.push([q(w.name), q((p && p.workState) || w.workState || 'GA'), h(reg && reg.minutes), h(ot && ot.minutes),
        ...kinds.map(k => d(amt(w, k[1]))),
        p ? d(p.grossCents) : '', p ? d(p.taxes.federal) : '', p ? d(p.taxes.socialSecurity) : '', p ? d(p.taxes.medicare) : '',
        p ? d((p.taxes.georgia || 0) + (p.taxes.state || 0)) : '', p ? d(p.netCents) : '', p ? d(p.reimbursementsCents) : '',
        p ? d(p.employer.socialSecurity) : '', p ? d(p.employer.medicare) : '', p ? d(p.employer.futa) : '',
        p ? d((p.employer.gaSuta || 0) + (p.employer.stateSuta || 0)) : '',
        ...(() => { const fix = correctionFor(corr, run.id, w.userId); return fix
          ? [q(CORRECTION_METHODS[fix.method] || fix.method), q(fix.receipt || ''), q(w.payMethod || ''), q(`${fix.reason} (${fix.by}, ${String(fix.at).slice(0, 10)})`)]
          : [q(w.payMethod || ''), q(pay ? pay.confirmation : ''), q(''), q('')]; })(),
        q(added(w)), q(w.manualTaxes ? `Yes: ${w.manualTaxes.reason || ''}` : ''), q((w.missing || []).join('; '))].join(','));
    }
    const t = run.totals || {};
    lines.push([q('TOTAL'), q(''), '', '', ...kinds.map(k => d((run.workers || []).reduce((a, w) => a + amt(w, k[1]), 0))), d(t.grossCents), d(t.federalCents), d(t.socialSecurityCents), d(t.medicareCents),
      d((t.georgiaCents || 0) + (t.stateWithholdingCents || 0)), d(t.netCents), d(t.reimbursementsCents),
      d(t.employerSocialSecurityCents), d(t.employerMedicareCents), d(t.futaCents), d((t.gaSutaCents || 0) + (t.stateSutaCents || 0)), q(''), q(''), q(''), q(''), q(''), q(''), q('')].join(','));
    await logActivity(req.user.id, req.user.name, 'payroll_register_exported', 'payroll_run', run.id, { period: run.period && run.period.start });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', contentDisposition('attachment', `payroll_register_${(run.period && run.period.payDate) || run.id}.csv`));
    res.send(lines.join('\r\n') + '\r\n');
  });

  // How this payroll is sent (owner, 2026-11-13): Direct deposit or P2P
  // (Cash App from GFC's account), chosen by the Super Admin on the draft, with
  // a per-person override. The draft is rebuilt so blocking follows it: a
  // person sent P2P needs no bank details.
  router.put('/api/payroll/admin/runs/:id/channel', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const runs = await rows(RUNS);
      const i = runs.findIndex(r => r.id === req.params.id);
      if (i === -1) return res.status(404).json({ error: 'Run not found.' });
      if (runs[i].status !== 'draft') return res.status(409).json({ error: 'This payroll is approved; how it was sent is on its pay stubs.', code: 'RUN_LOCKED' });
      const b = req.body || {};
      if (!engine.PAY_CHANNELS[b.default]) return res.status(400).json({ error: 'Choose Direct deposit or P2P.', code: 'RUN_CHANNEL' });
      const byUser = {};
      for (const [uid, ch] of Object.entries(b.byUser || {})) {
        if (!engine.PAY_CHANNELS[ch]) return res.status(400).json({ error: 'Choose Direct deposit or P2P for each person.', code: 'RUN_CHANNEL' });
        if (ch !== b.default) byUser[String(uid)] = ch;
      }
      const channels = { default: b.default, byUser };
      const settings = await readSettings();
      const d = await draftFor(runs[i].period, settings, runs[i].adjustments || [], channels, runs[i].manualTaxes);
      if (d.error) return res.status(409).json(d);
      runs[i] = { ...runs[i], ...d.run, status: 'draft', rebuiltAt: nowIso() };
      await db.set(RUNS, runs);
      await logActivity(req.user.id, req.user.name, 'payroll_run_channel_set', 'payroll_run', runs[i].id, { default: channels.default, overrides: Object.keys(byUser).length });
      res.json({ run: runs[i] });
    } catch (e) { console.error('Payroll channel error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  router.post('/api/payroll/admin/runs/:id/adjustments', authenticateToken, requirePayrollPreparer, async (req, res) => {
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
    // The run's own choices (how it is sent, taxes entered by hand) carry over.
    const d = await draftFor(runs[i].period, await readSettings(), adjustments, runs[i].channels, runs[i].manualTaxes);
    if (d.error) return res.status(409).json(d);
    runs[i] = { ...runs[i], ...d.run, adjustments, rebuiltAt: nowIso() };
    await db.set(RUNS, runs);
    await logActivity(req.user.id, req.user.name, 'payroll_adjustment_added', 'payroll_run', runs[i].id, { type: b.type, amountCents: cents });
    res.json({ run: runs[i] });
  });

  // Remove a line added to a draft (owner, 2026-11-14: a bonus entered by
  // mistake must come off before approval).
  router.delete('/api/payroll/admin/runs/:id/adjustments/:adjId', authenticateToken, requirePayrollPreparer, async (req, res) => {
    try {
      const runs = await rows(RUNS);
      const i = runs.findIndex(r => r.id === req.params.id);
      if (i === -1) return res.status(404).json({ error: 'Run not found.' });
      if (runs[i].status !== 'draft') return res.status(409).json({ error: 'An approved run is locked. Add the correction to the next run.', code: 'RUN_LOCKED' });
      const gone = (runs[i].adjustments || []).find(a => a.id === req.params.adjId);
      if (!gone) return res.status(404).json({ error: 'That line is not on this payroll.' });
      const adjustments = runs[i].adjustments.filter(a => a.id !== gone.id);
      const d = await draftFor(runs[i].period, await readSettings(), adjustments, runs[i].channels, runs[i].manualTaxes);
      if (d.error) return res.status(409).json(d);
      runs[i] = { ...runs[i], ...d.run, adjustments, rebuiltAt: nowIso() };
      await db.set(RUNS, runs);
      await logActivity(req.user.id, req.user.name, 'payroll_adjustment_removed', 'payroll_run', runs[i].id, { type: gone.type, amountCents: gone.amountCents, userId: gone.userId });
      res.json({ run: runs[i] });
    } catch (e) { console.error('Remove adjustment error:', e); res.status(500).json({ error: 'Server error' }); }
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
      const d = await draftFor(runs[i].period, settings, runs[i].adjustments || [], runs[i].channels, runs[i].manualTaxes);
      if (d.error) return res.status(409).json(d);
      if (d.run.blocked.length) return res.status(409).json({ error: `${d.run.blocked.length} ${d.run.blocked.length === 1 ? 'person is' : 'people are'} missing paperwork. Nobody can be paid until it is on file.`, code: 'RUN_BLOCKED', blocked: d.run.blocked });
      if (!d.run.workers.length) return res.status(409).json({ error: 'Nobody has pay in this period.', code: 'RUN_EMPTY' });
      if (d.run.sutaRateMissing) return res.status(409).json({ error: 'Set GFC\'s Georgia unemployment rate under Settings first. It is on the GA DOL notice.', code: 'RUN_NO_SUTA_RATE' });
      // Unapproved timesheets (owner, 2026-11-13): never a hold, because hours
      // worked are paid on payday, but the Super Admin says why they go ahead.
      const pending = d.run.unapprovedTimesheets || [];
      const overrideReason = String((req.body || {}).timesheetReason || '').trim().slice(0, 300);
      if (pending.length && !overrideReason) return res.status(409).json({ error: `${pending.length} ${pending.length === 1 ? 'timesheet is' : 'timesheets are'} not approved: ${pending.map(x => x.name).join(', ')}. Approve them under Timesheets, or give a reason to pay the hours as clocked.`, code: 'RUN_TIMESHEETS_UNAPPROVED', unapproved: pending });
      const at = nowIso();
      const approved = { ...runs[i], ...d.run, status: 'approved', approvedAt: at, approvedBy: req.user.name || req.user.email, payments: {},
        timesheetOverride: pending.length ? { reason: overrideReason, by: req.user.name || req.user.email, at, people: pending.map(x => x.name) } : null };
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
      // Pay stubs go out as each payment is marked paid, with its receipt
      // (owner, 2026-11-14), not at approval.
      const stubs = { written: 0, waitingOnPayment: approved.workers.filter(w => w.pay).length };
      if (deps.onRunApproved) await deps.onRunApproved(approved).catch(e => console.error('QuickBooks payroll sync (non-fatal):', e.message));
      res.json({ run: approved, stubs });
    } catch (e) { console.error('Payroll approve error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // Each worker's stub: a PDF filed in their role folder, a row in
  // staff_paystubs (the store My GFC already lists), and a link-only email.
  // opts.notify false: past pay dates imported from Gusto get stubs without
  // an email per pay date.
  // Year to date as of a run's pay date: that run and every earlier one, never
  // a later one, so a stub drawn again later reads as it did on payday.
  const longDay = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
  const ytdAsOf = (allRuns, run) => engine.ytdFrom((allRuns || []).filter(r => r && r.period && r.period.payDate <= run.period.payDate), { year: run.period.payDate.slice(0, 4) });
  // What a stub says about the person and the payment, taken when it is
  // issued and kept on the stub row, so a stub reads as it did on payday even
  // after they change their address, SSN or bank (owner, 2026-11-14). How it
  // was paid comes from the payment as marked (P2P is the Super Admin's
  // choice per run); the receipt is that payment's confirmation number.
  // The correction in force for one person on one run: the latest.
  const correctionFor = (corr, runId, userId) => (corr || []).filter(c => c.runId === runId && String(c.userId) === String(userId)).sort((a, b) => String(a.at).localeCompare(String(b.at))).pop() || null;
  const stubSnapshot = (run, w, settings, p, corr) => {
    const paid = (run.payments || {})[w.userId] || null;
    const fix = w.imported ? correctionFor(corr, run.id, w.userId) : null;
    const method = fix ? fix.method : w.imported ? w.payMethod : paid && paid.method ? paid.method : w.channel === 'p2p' ? 'p2p' : p.payMethod ? p.payMethod.method : null;
    return {
      ssnLast4: p.ssn ? p.ssn.last4 : null,
      payMethod: method,
      accountLast4: w.imported || method !== 'direct_deposit' ? null : paid && paid.accountLast4 ? paid.accountLast4 : p.payMethod ? p.payMethod.accountLast4 : null,
      p2pAccount: method === 'p2p' ? (settings.p2pAccount || '$GodwinsFamilyCare') : null,
      workState: (w.imported && w.imported.workState) || p.workState || 'GA', paidThrough: w.imported ? w.imported.from : null,
      payment: fix ? { confirmation: fix.receipt || null, at: fix.sentOn ? `${fix.sentOn}T12:00:00Z` : null } : paid ? { confirmation: paid.confirmation, at: paid.at } : null,
      correction: fix ? { recordedAs: fix.recordedAs, at: fix.at } : null
    };
  };
  const stubPdf = (run, w, ytd, settings, snap) => pdf.generatePayStubPDF({ run, worker: w, ytd: ytd.get(w.userId), employerEin: settings.employerEin || null, ...snap });
  // A stub drawn from its run when the Drive copy is missing or cannot be
  // read (audit, 2026-11-14): the employee is never told a stub is ready that
  // they cannot open. Null when the stub did not come from an app run.
  router.stubPdfForRow = async (row) => {
    if (!row || !row.runId) return null;
    const allRuns = await rows(RUNS);
    const run = allRuns.find(r => r && r.id === row.runId && r.status !== 'draft' && r.status !== 'void');
    const w = run && (run.workers || []).find(x => String(x.userId) === String(row.userId) && x.pay);
    if (!w) return null;
    const settings = await readSettings();
    // The snapshot kept when the stub was issued; the payment is read from the
    // run, where it is final once marked.
    const corr = await rows(CORRECTIONS);
    const live = stubSnapshot(run, w, settings, {}, corr);
    const snap = row.snap ? { ...row.snap, payment: live.payment, ...(live.correction ? { payMethod: live.payMethod, accountLast4: null, p2pAccount: null, correction: live.correction } : {}) }
      : stubSnapshot(run, w, settings, (await readProfiles())[w.userId] || {}, corr);
    return stubPdf(run, w, ytdAsOf(allRuns, run), settings, snap);
  };
  const writeStubs = async (run, settings, opts = {}) => {
    const users = await getUsers();
    const all = await readProfiles();
    const ytd = ytdAsOf(await rows(RUNS), run);   // includes this run
    const stubs = await rows(PAYSTUBS);
    const report = { written: 0, pdfFailed: 0 };
    const only = opts.only ? new Set(opts.only.map(String)) : null;
    const corr = await rows(CORRECTIONS);
    for (const w of run.workers.filter(x => x.pay && (!only || only.has(String(x.userId))))) {
      const user = users.find(u => String(u.id) === w.userId);
      const p = all[w.userId] || {};
      const snap = stubSnapshot(run, w, settings, p, corr);
      let driveFileId = null;
      try {
        const buf = await stubPdf(run, w, ytd, settings, snap);
        // The finance folder, never the person's role documents (owner, 2026-11-14).
        const stored = await drive.uploadPayStubFile(settings.payStubFolderId || null, run.period.payDate, `Pay stub ${run.period.payDate} - ${(user && user.name) || w.name}.pdf`, buf);
        driveFileId = stored.fileId || stored.id || null;
      } catch (e) { report.pdfFailed++; console.error('Pay stub PDF error (non-fatal):', e.message); }
      const hours = Math.round(((w.earnings.find(e => e.code === 'regular') || {}).minutes || 0) / 60 * 100) / 100;
      const row = { id: uuidv4(), userId: w.userId, payDate: run.period.payDate, periodStart: run.period.start, periodEnd: run.period.end,
        gross: w.pay.grossCents / 100, net: w.pay.netCents / 100, hours, reference: `run:${run.id}`, driveFileId, source: run.source === 'gusto' ? 'gusto' : 'app', runId: run.id, importedAt: nowIso(),
        // `final`: the filed copy is the stub as issued, receipt and all.
        snap: { ...snap, payment: null, correction: null }, final: true };
      const at = stubs.findIndex(x => String(x.userId) === row.userId && x.payDate === row.payDate && x.reference === row.reference);
      if (at === -1) stubs.push(row); else { row.id = stubs[at].id; stubs[at] = row; }
      report.written++;
      if (opts.notify !== false && user && user.email && queueNotification) {
        // Link-only: says a stub is ready, never an amount (spec v2 item 16).
        const base = getAppBaseUrl ? await getAppBaseUrl() : '';
        await queueNotification('paystub_ready', user.id, user.email, user.name, {
          subject: 'Your pay stub is ready',
          body: `Your pay for payday ${longDay(run.period.payDate)} has been sent, and your pay stub is ready. Sign in to GFC to view or download it.`,
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
  router.get('/api/payroll/admin/runs/:id/payment-sheet', authenticateToken, requirePayrollPreparer, async (req, res) => {
    const run = (await rows(RUNS)).find(r => r.id === req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found.' });
    if (run.status === 'draft') return res.status(409).json({ error: 'Approve the run first.', code: 'RUN_NOT_APPROVED' });
    const all = await readProfiles();
    const users = await getUsers();
    const sheet = run.workers.filter(w => w.pay).map(w => {
      const pm = w.channel === 'p2p' ? { method: 'p2p' } : ((all[w.userId] || {}).payMethod || {});
      const person = (users || []).find(u => u && String(u.id) === String(w.userId)) || {};
      const paid = (run.payments || {})[w.userId] || null;
      return { userId: w.userId, name: w.name, netCents: w.pay.netCents, net: usd(w.pay.netCents), method: pm.method || null,
        bankName: pm.bankName || null, accountType: pm.accountType || null, routingLast4: pm.routingLast4 || null, accountLast4: pm.accountLast4 || null, phone: w.channel === 'p2p' ? (person.phone || null) : null, paid };
    });
    await logActivity(req.user.id, req.user.name, 'payment_sheet_opened', 'payroll_run', run.id, {});
    // How each approved contractor invoice is paid: never a full account number.
    const payTo = (uid) => { const pm = (all[uid] || {}).payMethod || {}; return { method: pm.method || null, bankName: pm.bankName || null, bankCountry: pm.bankCountry || null, swift: pm.swift || null, accountLast4: pm.accountLast4 || null, wiseEmail: pm.wiseEmail || null, abroad: (all[uid] || {}).taxResidence === 'foreign' }; };
    res.json({ run: { id: run.id, status: run.status, period: run.period }, sendBy: tax.sendByDate(run.period.payDate), p2pAccount: (await readSettings()).p2pAccount, sheet, contractors: (await rows(CONTRACTOR_INVOICES)).filter(x => x.status === 'approved').map(x => ({ ...x, payTo: payTo(x.userId) })) });
  });
  router.post('/api/payroll/admin/runs/:id/payments/:userId', authenticateToken, requireAdmin, async (req, res) => {
    const runs = await rows(RUNS);
    const i = runs.findIndex(r => r.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'Run not found.' });
    if (runs[i].status === 'draft') return res.status(409).json({ error: 'Approve the run first.', code: 'RUN_NOT_APPROVED' });
    const w = runs[i].workers.find(x => x.userId === String(req.params.userId) && x.pay);
    if (!w) return res.status(404).json({ error: 'Nobody by that id is paid in this run.' });
    const conf = str((req.body || {}).confirmation, 80);
    if (!conf) return res.status(400).json({ error: 'Paste the confirmation number: the PNC or Cash App transaction number, or the check number.', code: 'PAYMENT_CONFIRMATION' });
    const prof = (await readProfiles())[w.userId] || {};
    const method = w.channel === 'p2p' ? 'p2p' : prof.payMethod ? prof.payMethod.method : (w.payMethod || null);
    runs[i].payments = { ...(runs[i].payments || {}), [w.userId]: { confirmation: conf, at: nowIso(), by: req.user.name, method, accountLast4: method === 'direct_deposit' && prof.payMethod ? prof.payMethod.accountLast4 || null : null } };
    // Paid only when every worker has a confirmation.
    const everyone = runs[i].workers.filter(x => x.pay).every(x => runs[i].payments[x.userId]);
    if (everyone && runs[i].status !== 'paid') { runs[i].status = 'paid'; runs[i].paidAt = nowIso(); }
    await db.set(RUNS, runs);
    await logActivity(req.user.id, req.user.name, 'payroll_payment_confirmed', 'payroll_run', runs[i].id, { userId: w.userId, runPaid: runs[i].status === 'paid' });
    if (deps.onWorkerPaid) await deps.onWorkerPaid(runs[i], w).catch(e => console.error('QuickBooks payment sync (non-fatal):', e.message));
    if (everyone && deps.onRunPaid) await deps.onRunPaid(runs[i]).catch(() => {});
    // Their stub goes out now, with the receipt (owner, 2026-11-14).
    const stub = await writeStubs(runs[i], await readSettings(), { only: [w.userId] });
    res.json({ run: { id: runs[i].id, status: runs[i].status, payments: runs[i].payments }, stub });
  });

  // How a Gusto payment was actually sent (owner, 2026-11-14). Only for
  // Gusto-imported pay dates, while GFC moves off Gusto: some "check" pay
  // dates were sent by Zelle or Cash App. The Super Admin's alone, with a
  // reason. Amounts never change; the stub is filed again saying what Gusto
  // recorded and that the office corrected it. Nobody is emailed. A pay date
  // run in the app records how it was sent when it is marked paid, so it has
  // no correction.
  router.post('/api/payroll/admin/runs/:id/payment-correction', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const all = await rows(RUNS);
      const run = all.find(r => r.id === req.params.id);
      if (!run) return res.status(404).json({ error: 'Run not found.' });
      if (run.source !== 'gusto') return res.status(409).json({ error: 'Only pay dates imported from Gusto can be corrected this way. In the app, how someone was paid is recorded when you mark the payment paid.', code: 'PAYMENT_CORRECTION_GUSTO_ONLY' });
      const b = req.body || {};
      const userId = String(b.userId || '');
      if (!(run.workers || []).some(w => String(w.userId) === userId && w.pay)) return res.status(404).json({ error: 'That person is not paid on this pay date.' });
      if (!CORRECTION_METHODS[b.method]) return res.status(400).json({ error: 'Choose how it was actually sent: Zelle, Cash App, direct deposit or paper check.', code: 'PAYMENT_CORRECTION_METHOD' });
      const reason = str(b.reason, 300);
      if (!reason) return res.status(400).json({ error: 'Say why, for the record (for example, paid by Zelle while direct deposit was set up).', code: 'PAYMENT_CORRECTION_REASON' });
      if (b.sentOn && !tax.isYmd(b.sentOn)) return res.status(400).json({ error: 'The date sent is not a date.', code: 'PAYMENT_CORRECTION_DATE' });
      // This pay date, and any other Gusto pay dates ticked for the same person.
      const targets = [run, ...all.filter(r => r && r.source === 'gusto' && r.id !== run.id && (b.alsoRunIds || []).includes(r.id) && (r.workers || []).some(w => String(w.userId) === userId && w.pay))];
      const corr = await rows(CORRECTIONS);
      const at = nowIso();
      for (const r of targets) {
        const w = r.workers.find(x => String(x.userId) === userId);
        const prev = correctionFor(corr, r.id, userId);
        // The receipt and date sent belong to the pay date the form was opened on.
        corr.push({ id: uuidv4(), runId: r.id, userId, payDate: r.period.payDate, method: b.method, receipt: r === run ? (str(b.receipt, 80) || null) : null,
          sentOn: r === run && b.sentOn ? b.sentOn : null, reason, recordedAs: w.payMethod || null, replaces: prev ? prev.id : null, by: req.user.name || req.user.email, at });
      }
      await db.set(CORRECTIONS, corr);
      const settings = await readSettings();
      const report = { written: 0, pdfFailed: 0 };
      for (const r of targets) {
        const x = await writeStubs(r, settings, { only: [userId], notify: false });
        report.written += x.written; report.pdfFailed += x.pdfFailed;
        await logActivity(req.user.id, req.user.name, 'payroll_payment_corrected', 'payroll_run', r.id, { userId, payDate: r.period.payDate, method: b.method, recordedAs: (r.workers.find(y => String(y.userId) === userId) || {}).payMethod || null });
      }
      res.json({ corrected: targets.map(r => r.period.payDate), stubs: report });
    } catch (e) { console.error('Payment correction error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // Issue a run's stubs again for everyone marked paid (owner, 2026-11-14):
  // for runs paid before stubs carried the receipt or lived in the finance
  // folder. Nobody is emailed again.
  router.post('/api/payroll/admin/runs/:id/stubs', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const run = (await rows(RUNS)).find(r => r.id === req.params.id);
      if (!run) return res.status(404).json({ error: 'Run not found.' });
      if (run.status === 'draft') return res.status(409).json({ error: 'Approve the run first.', code: 'RUN_NOT_APPROVED' });
      const paid = Object.keys(run.payments || {});
      if (!paid.length) return res.status(409).json({ error: 'Nobody on this payroll is marked paid yet. Stubs go out as each payment is marked.', code: 'STUBS_NONE_PAID' });
      const report = await writeStubs(run, await readSettings(), { only: paid, notify: false });
      await logActivity(req.user.id, req.user.name, 'payroll_stubs_reissued', 'payroll_run', run.id, { people: report.written });
      res.json({ ...report });
    } catch (e) { console.error('Reissue stubs error:', e); res.status(500).json({ error: 'Server error' }); }
  });

  // ---- contractor invoices, the owner's side (step 8) -------------------------------
  const requireInvoiceAction = (req, res, next) => {
    if (req.params.action === 'pay') return requireAdmin(req, res, next);
    return canReviewInvoices(req.user) ? next() : res.status(403).json({ error: 'Reviewing invoices is for the Super Admin, managers and care coordinators.', code: 'CI_REVIEWER_ONLY' });
  };
  router.post('/api/payroll/admin/contractor-invoices/:id/:action', authenticateToken, requireInvoiceAction, async (req, res) => {
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
    // Sent back: the contractor is told where to look. The note stays in the app.
    if (act === 'reject' && queueNotification) {
      const who = (await getUsers()).find(u => u && String(u.id) === String(inv.userId));
      if (who && who.email) await queueNotification('contractor_invoice_sent_back', who.id, who.email, who.name, {
        subject: 'Your invoice needs a correction', body: `Your invoice ${inv.invoiceNo} was sent back. Open My GFC, then Contractor Invoices, to see what to fix and send it again.`
      }, { relatedEntityId: `ci-back:${inv.id}` }).catch(e => console.error('Invoice notice (non-fatal):', e.message));
    }
    res.json({ invoice: inv });
  });

  // ---- examiner payouts (step 7) -----------------------------------------------------
  // A 1099 examiner, or one set up as both (contractor for exams), is paid from
  // their completed exams as a contractor invoice the office builds. It goes
  // through the same approve and pay steps as any other, and an exam already
  // on a payout is never paid twice.
  router.post('/api/payroll/admin/examiner-payouts', authenticateToken, requirePayrollPreparer, async (req, res) => {
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
  router.get('/api/payroll/admin/taxes', authenticateToken, requirePayrollPreparer, async (req, res) => res.json(await taxView()));
  router.post('/api/payroll/admin/taxes/payments', authenticateToken, requirePayrollPreparer, async (req, res) => {
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
  router.post('/api/payroll/admin/filings/:key/confirm', authenticateToken, requirePayrollPreparer, async (req, res) => {
    const conf = str((req.body || {}).confirmation, 80);
    if (!conf) return res.status(400).json({ error: 'Give the filing confirmation.', code: 'FILING_CONFIRMATION' });
    const all = (await rows(FILINGS)).filter(f => f.key !== req.params.key);
    all.push({ key: req.params.key, confirmation: conf, at: nowIso(), by: req.user.name });
    await db.set(FILINGS, all);
    await logActivity(req.user.id, req.user.name, 'tax_filing_confirmed', 'tax_filing', req.params.key, {});
    res.json({ ok: true });
  });
  router.get('/api/payroll/admin/quarter/:year/:q', authenticateToken, requirePayrollPreparer, async (req, res) => {
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
    const profiles = await readProfiles();
    // A contractor living outside the U.S. with a W-8BEN on file gets no 1099
    // (owner, 2026-11-13): payment for work done abroad by a foreign person is
    // not U.S.-source income. They are counted apart so nothing is hidden.
    const abroad = (uid) => { const p = profiles[String(uid)]; return !!(p && p.taxResidence === 'foreign' && p.w8ben); };
    const allPaid = (await rows(CONTRACTOR_INVOICES)).filter(x => x.status === 'paid').map(x => ({ userId: x.userId, name: x.name, amountCents: x.totalCents, paidAt: x.paidAt }));
    const paid = allPaid.filter(x => !abroad(x.userId));
    const paidAbroad = allPaid.filter(x => abroad(x.userId) && String(x.paidAt || '').startsWith(String(year)));
    const figures = cal.yearEnd(runs, paid, { year, fed: tbl.federal, incomeTaxStates: Object.entries(tbl.states || {}).filter(([, d]) => d.incomeTax).map(([k]) => k) });
    figures.foreignContractors = [...new Set(paidAbroad.map(x => x.userId))].map(uid => ({ userId: uid, name: (paidAbroad.find(x => x.userId === uid) || {}).name, totalCents: paidAbroad.filter(x => x.userId === uid).reduce((a, x) => a + x.amountCents, 0) }));
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
      foreignContractors: figures.foreignContractors || [],
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
        if (!existing && (await rows(DELETED_DRAFTS)).some(x => wasDeleted(x, period))) { out.push({ schedule, summary: 'draft deleted by the Super Admin', period }); continue; }
        const d = await draftFor(period, settings, existing ? existing.adjustments || [] : [], existing ? existing.channels : null, existing ? existing.manualTaxes : null);
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
