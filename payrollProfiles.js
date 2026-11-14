'use strict';
const { STATE_NAMES } = require('./payrollTaxTables');
// ============================================================================
// payrollProfiles.js — one payroll record per person (spec v2 §2 items 7, 13).
//
// PEOPLE ARE THE APP'S EXISTING USER RECORDS. This adds what payroll needs
// beside each one, in its own collection (`payroll_profiles`), so the users
// blob read on every request never carries a bank number.
//
// WHAT MOVES IN FROM GUSTO (owner, 2026-11-08): W-4, G-4, I-9, direct
// deposit, offer letter and handbook acknowledgement, and consent to receive
// W-2s and 1099s electronically. A contractor gives a W-9 (or a W-8BEN when
// paid abroad through Wise).
//
// PURE. No store, no clock, no network: callers pass `at` and the sealer.
// Secret values (SSN, TIN, routing, account) arrive here in the clear and
// leave sealed; only the last four are kept readable.
// ============================================================================

const WORKER_TYPES = Object.freeze({ W2: 'W2', C1099: '1099', HYBRID: 'HYBRID' });
const PAY_TYPES = Object.freeze(['hourly', 'salary', 'per_visit']);
const PAY_METHODS = Object.freeze(['direct_deposit', 'check', 'wise', 'intl_wire']);
// For a contractor living outside the U.S. (owner, 2026-11-13). Which of these
// are offered is a payroll setting (Settings → Overseas contractors).
const OVERSEAS_PAY_METHODS = Object.freeze({ wise: 'Wise', intl_wire: 'International wire' });
// A $Cashtag: a letter, then letters, numbers or underscores (Cash App rules).
// Used for GFC's own P2P sending account (Payroll → Settings), never chosen
// by an employee: how a payroll is sent is the office's choice per run.
const normalizeCashtag = (v) => { const t = String(v || '').trim().replace(/^\$/, ''); return /^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(t) ? `$${t}` : null; };
const WAGE_ACCOUNTS = Object.freeze(['home_care', 'clinical']);
const W4_FILING = Object.freeze({ single: 'Single or Married filing separately', mfj: 'Married filing jointly', hoh: 'Head of household' });
// Georgia Form G-4 (rev. 06/03/26), line 3.
const G4_FILING = Object.freeze({
  A: 'Single', B: 'Married filing separate, or married filing joint with both spouses working',
  C: 'Married filing joint, one spouse working', D: 'Head of household'
});
const I9_STATUS = Object.freeze({
  citizen: 'A citizen of the United States', noncitizen_national: 'A noncitizen national of the United States',
  lpr: 'A lawful permanent resident', authorized: 'A noncitizen authorized to work'
});
const W9_CLASS = Object.freeze({
  individual: 'Individual / sole proprietor', llc_single: 'Single-member LLC', llc_c: 'LLC taxed as C corp', llc_s: 'LLC taxed as S corp',
  llc_p: 'LLC taxed as partnership', c_corp: 'C corporation', s_corp: 'S corporation', partnership: 'Partnership'
});

const str = (v, n = 200) => (v === null || v === undefined ? '' : String(v)).trim().slice(0, n);
const money = (v) => {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 && n < 10000000 ? Math.round(n * 100) : null;
};
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(`${s}T12:00:00Z`));

// ---- Identifiers -------------------------------------------------------------
// An SSN the SSA never issues is refused: area 000, 666 or 900-999, group 00,
// serial 0000.
function checkSsn(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length !== 9) return 'An SSN has 9 digits.';
  const a = d.slice(0, 3), g = d.slice(3, 5), s = d.slice(5);
  if (a === '000' || a === '666' || a[0] === '9' || g === '00' || s === '0000') return 'That is not a valid SSN.';
  return null;
}
const checkEin = (raw) => (String(raw || '').replace(/\D/g, '').length === 9 ? null : 'An EIN has 9 digits.');
// ABA routing number checksum: 3, 7, 1 weights.
function checkRouting(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length !== 9) return 'A routing number has 9 digits.';
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  const sum = d.split('').reduce((a, c, i) => a + Number(c) * w[i], 0);
  return sum % 10 === 0 ? null : 'That routing number does not check out. Copy it again from a check or the bank.';
}
const checkAccount = (raw) => (/^\d{4,17}$/.test(String(raw || '').replace(/[\s-]/g, '')) ? null : 'An account number is 4 to 17 digits.');

// A typed signature: the person's name, the date and time, and that they
// agreed to the statement shown. The same standard as the client consents.
function signature(body, { at, ipHash }) {
  const name = str(body && body.signedName, 120);
  if (!name) return { error: 'Type your full name to sign.', code: 'SIGNATURE_REQUIRED' };
  if (!(body && body.agree === true)) return { error: 'Tick the box to agree to the statement.', code: 'AGREEMENT_REQUIRED' };
  return { value: { signedName: name, signedAt: at, ipHash: ipHash || null } };
}

// ---- Forms ---------------------------------------------------------------------
function normalizeW4(b, ctx) {
  b = b || {};
  if (!W4_FILING[b.filingStatus]) return { error: 'Choose a filing status (Step 1c).', code: 'W4_FILING_STATUS' };
  const dependents = money(b.dependentsAmount), other = money(b.otherIncome), ded = money(b.deductions), extra = money(b.extraWithholding);
  if ([dependents, other, ded, extra].some(v => v === null)) return { error: 'Enter amounts as dollars, or leave them blank.', code: 'W4_AMOUNT' };
  const sig = signature(b, ctx);
  if (sig.error) return sig;
  return {
    value: {
      filingStatus: b.filingStatus, multipleJobs: b.multipleJobs === true,
      dependentsCents: dependents, otherIncomeCents: other, deductionsCents: ded, extraWithholdingCents: extra,
      exempt: b.exempt === true, ...sig.value
    }
  };
}
function normalizeG4(b, ctx) {
  b = b || {};
  if (!G4_FILING[b.filingStatus]) return { error: 'Choose a marital status (line 3).', code: 'G4_FILING_STATUS' };
  const n = (v) => (v === '' || v === undefined || v === null ? 0 : Number(v));
  const dep = n(b.dependentAllowances), add = n(b.additionalAllowances);
  if (![dep, add].every(v => Number.isInteger(v) && v >= 0 && v < 100)) return { error: 'Allowances are whole numbers.', code: 'G4_ALLOWANCES' };
  const extra = money(b.extraWithholding);
  if (extra === null) return { error: 'Enter extra withholding as dollars.', code: 'G4_AMOUNT' };
  const sig = signature(b, ctx);
  if (sig.error) return sig;
  return { value: { filingStatus: b.filingStatus, dependentAllowances: dep, additionalAllowances: add, extraWithholdingCents: extra, exempt: b.exempt === true, ...sig.value } };
}
// The withholding certificate for a state other than Georgia, in the generic
// shape that state's approved table reads (filing status and allowances).
function normalizeStateCert(b, ctx, state) {
  b = b || {};
  if (!['single', 'married'].includes(b.filingStatus)) return { error: 'Choose single or married.', code: 'STATE_CERT_STATUS' };
  const allowances = b.allowances === '' || b.allowances === undefined || b.allowances === null ? 0 : Number(b.allowances);
  if (!(Number.isInteger(allowances) && allowances >= 0 && allowances < 100)) return { error: 'Allowances are a whole number.', code: 'STATE_CERT_ALLOWANCES' };
  const extra = money(b.extraWithholding);
  if (extra === null) return { error: 'Enter extra withholding as dollars.', code: 'STATE_CERT_AMOUNT' };
  const sig = signature(b, ctx);
  if (sig.error) return sig;
  return { value: { state, filingStatus: b.filingStatus, allowances, extraWithholdingCents: extra, exempt: b.exempt === true, ...sig.value } };
}
// Section 1 has everything the official form asks the employee (owner,
// 2026-11-13: the app fills the real I-9). The A-Number, Form I-94 number and
// foreign passport are returned apart as `ids`: the route seals them, and they
// never come back to a browser.
const ALIEN_NO = /^A?\d{7,9}$/i;
function normalizeI9Section1(b, ctx) {
  b = b || {};
  if (!I9_STATUS[b.status]) return { error: 'Choose your citizenship or immigration status.', code: 'I9_STATUS' };
  if (!isYmd(b.dob) || b.dob > (ctx.at || '').slice(0, 10)) return { error: 'Give your date of birth.', code: 'I9_DOB' };
  if (b.status === 'authorized' && b.workAuthExpires && !isYmd(b.workAuthExpires)) return { error: 'Work authorization expiration must be a date.', code: 'I9_EXPIRES' };
  const alien = str(b.alienNumber, 12).replace(/[\s-]/g, '').toUpperCase();
  const i94 = str(b.i94Number, 11).replace(/\s/g, '');
  const passport = str(b.passport, 80);
  if (alien && !ALIEN_NO.test(alien)) return { error: 'An A-Number or USCIS number is 7 to 9 digits.', code: 'I9_ALIEN_NUMBER' };
  if (i94 && !/^[A-Z0-9]{11}$/i.test(i94)) return { error: 'A Form I-94 admission number is 11 characters.', code: 'I9_I94' };
  if (b.status === 'lpr' && !alien) return { error: 'Give your A-Number or USCIS number.', code: 'I9_ALIEN_NUMBER' };
  if (b.status === 'authorized' && !alien && !i94 && !passport) return { error: 'Give one of: A-Number or USCIS number, Form I-94 number, or foreign passport number and country.', code: 'I9_AUTH_NUMBER' };
  const sig = signature(b, ctx);
  if (sig.error) return sig;
  const ids = b.status === 'lpr' ? { alienNumber: alien.replace(/^A/, '') } : b.status === 'authorized' ? { alienNumber: alien.replace(/^A/, '') || null, i94Number: i94 || null, passport: passport || null } : null;
  return {
    value: { status: b.status, workAuthExpires: b.status === 'authorized' ? (b.workAuthExpires || null) : null, dob: b.dob, otherLastNames: str(b.otherLastNames, 80) || null, phone: str(b.phone, 20) || null, idsOnFile: !!ids, ...sig.value },
    ids
  };
}
// Section 2 is the employer's: which documents were examined. Document
// numbers are not stored, only what they were and when they expire.
function normalizeI9Section2(b, { at, by }) {
  b = b || {};
  // The document number is kept for the official form, sealed by the route
  // (returned apart as `numbers`, in the same order as the documents).
  const raw = (Array.isArray(b.documents) ? b.documents : []).map(d => ({ list: str(d && d.list, 1).toUpperCase(), title: str(d && d.title, 120), issuer: str(d && d.issuer, 120) || null, expires: d && isYmd(d.expires) ? d.expires : null, number: str(d && d.number, 40) }))
    .filter(d => d.title && ['A', 'B', 'C'].includes(d.list));
  const numbers = raw.map(d => d.number || null);
  const docs = raw.map(({ number, ...d }) => d);
  const hasA = docs.some(d => d.list === 'A'), hasBC = docs.some(d => d.list === 'B') && docs.some(d => d.list === 'C');
  if (!hasA && !hasBC) return { error: 'Record one List A document, or one List B and one List C document.', code: 'I9_DOCUMENTS' };
  if (!isYmd(b.firstDay)) return { error: 'Give the employee\'s first day of work.', code: 'I9_FIRST_DAY' };
  // Additional Information prints on the form (for a late Section 2, why).
  // The alternative procedure box is for an E-Verify employer examining
  // documents remotely under the DHS procedure.
  return { value: { documents: docs, firstDay: b.firstDay, reviewedAt: at, reviewedBy: by, reviewerTitle: str(b.reviewerTitle, 60) || null, numbersOnFile: numbers.some(Boolean),
    additionalInfo: str(b.additionalInfo, 300) || null, altProcedure: b.altProcedure === true }, numbers };
}
// An I-9 already on file (owner, 2026-11-13). Someone hired before GFC moved
// payroll into the app has a completed Form I-9 from Gusto or on paper. That
// form stays valid: changing payroll provider does not call for a new one.
// The office records that it is on file, and where, instead of asking the
// employee to fill Section 1 again. Required: their first day of work as the
// form shows it, and confirmation the signed copy is filed on their Staff
// Record, so the form itself can always be produced on request.
const I9_ON_FILE_SOURCES = Object.freeze({ gusto: 'Gusto', paper: 'Paper form' });
function normalizeI9OnFile(b, { at, by }) {
  b = b || {};
  if (!isYmd(b.firstDay)) return { error: 'Give the first day of work shown on their I-9.', code: 'I9_FIRST_DAY' };
  if (b.completedOn !== undefined && b.completedOn !== null && b.completedOn !== '' && !isYmd(b.completedOn)) return { error: 'The date Section 2 was completed is not a date.', code: 'I9_COMPLETED_ON' };
  if (b.copyFiled !== true) return { error: 'File their signed I-9 on their Staff Record (Documents → Work authorization documents) first, then tick the box.', code: 'I9_COPY_NOT_FILED' };
  const source = I9_ON_FILE_SOURCES[b.source] ? b.source : 'gusto';
  return { value: { source, firstDay: b.firstDay, completedOn: isYmd(b.completedOn) ? b.completedOn : null, note: str(b.note, 300) || null, recordedAt: at, recordedBy: by } };
}
// The I-9 is complete when both sections were done in the app, or a completed
// form is on file from before.
const i9Complete = (p) => !!(p && p.i9 && ((p.i9.section1 && p.i9.section2) || p.i9.onFile));
function normalizeW9(b, ctx) {
  b = b || {};
  const name = str(b.name, 160);
  if (!name) return { error: 'Give the name on your tax return.', code: 'W9_NAME' };
  if (!W9_CLASS[b.taxClass]) return { error: 'Choose a tax classification.', code: 'W9_CLASS' };
  const tinType = b.tinType === 'ein' ? 'ein' : 'ssn';
  const bad = tinType === 'ein' ? checkEin(b.tin) : checkSsn(b.tin);
  if (bad) return { error: bad, code: 'W9_TIN' };
  const sig = signature(b, ctx);
  if (sig.error) return sig;
  return { value: { name, businessName: str(b.businessName, 160), taxClass: b.taxClass, tinType, address: str(b.address, 300), ...sig.value }, tin: String(b.tin).replace(/\D/g, '') };
}

// Form W-8BEN (owner, 2026-11-13): a contractor who is not a U.S. person and
// lives outside the U.S. gives this instead of a W-9. Part I identifies them;
// Part II (a tax treaty claim) is optional and rarely needed for work done
// outside the U.S. The U.S. and foreign tax ID numbers are returned apart, for
// the route to seal.
const isUS = (c) => /^(us|usa|u\.s\.a?\.?|united states( of america)?)$/i.test(String(c || '').trim());
function normalizeW8BEN(b, ctx) {
  b = b || {};
  const name = str(b.name, 160);
  if (!name) return { error: 'Give your name as on your passport or national ID.', code: 'W8_NAME' };
  const citizenship = str(b.citizenship, 60);
  if (!citizenship || isUS(citizenship)) return { error: 'Give your country of citizenship. A U.S. citizen gives a W-9 instead.', code: 'W8_CITIZENSHIP' };
  const perm = { line: str(b.permLine, 120), city: str(b.permCity, 120), country: str(b.permCountry, 60) };
  if (!perm.line || !perm.city || !perm.country) return { error: 'Give your permanent home address, city and country.', code: 'W8_ADDRESS' };
  if (isUS(perm.country)) return { error: 'A W-8BEN is for someone living outside the U.S. Give a W-9 instead.', code: 'W8_US_ADDRESS' };
  const mail = { line: str(b.mailLine, 120), city: str(b.mailCity, 120), country: str(b.mailCountry, 60) };
  if (!isYmd(b.dob)) return { error: 'Give your date of birth.', code: 'W8_DOB' };
  const foreignTin = str(b.foreignTin, 40);
  const ftinNotRequired = b.ftinNotRequired === true;
  if (!foreignTin && !ftinNotRequired) return { error: 'Give your tax ID number from your country, or tick that your country does not require one.', code: 'W8_FTIN' };
  const usTin = String(b.usTin || '').replace(/\D/g, '');
  if (usTin && usTin.length !== 9) return { error: 'A U.S. taxpayer ID (SSN or ITIN) has 9 digits. Leave it blank if you have none.', code: 'W8_US_TIN' };
  const treaty = b.treatyCountry ? { country: str(b.treatyCountry, 60), article: str(b.treatyArticle, 30), rate: str(b.treatyRate, 10), incomeType: str(b.treatyIncomeType, 80), conditions: str(b.treatyConditions, 300) } : null;
  const sig = signature(b, ctx);
  if (sig.error) return sig;
  return {
    value: { name, citizenship, permanentAddress: perm, mailingAddress: mail.line ? mail : null, dob: b.dob, ftinNotRequired, foreignTinOnFile: !!foreignTin, usTinOnFile: !!usTin, treaty, ...sig.value },
    foreignTin: foreignTin || null, usTin: usTin || null
  };
}

// The bank account, or a paper check, or Wise for a contractor abroad.
function normalizePayMethod(b) {
  b = b || {};
  const method = b.method;
  if (!PAY_METHODS.includes(method)) return { error: 'Choose direct deposit, paper check or Wise.', code: 'PAY_METHOD' };
  // An international wire: the bank's SWIFT/BIC and the IBAN or account
  // number. The account is returned apart for the route to seal.
  if (method === 'intl_wire') {
    const swift = str(b.swift, 11).replace(/\s/g, '').toUpperCase();
    const account = str(b.iban, 40).replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swift)) return { error: 'A SWIFT/BIC code is 8 or 11 letters and numbers.', code: 'WIRE_SWIFT' };
    if (!/^[A-Z0-9]{6,34}$/.test(account)) return { error: 'Give the IBAN or account number.', code: 'WIRE_ACCOUNT' };
    if (!str(b.bankName, 120) || !str(b.bankCountry, 60)) return { error: 'Give the bank name and country.', code: 'WIRE_BANK' };
    return { value: { method, bankName: str(b.bankName, 120), bankCountry: str(b.bankCountry, 60), swift, beneficiaryName: str(b.beneficiaryName, 120) || null }, account };
  }
  if (method !== 'direct_deposit') return { value: { method, wiseEmail: method === 'wise' ? str(b.wiseEmail, 200) : null } };
  const r = checkRouting(b.routing), a = checkAccount(b.account);
  if (r) return { error: r, code: 'BANK_ROUTING' };
  if (a) return { error: a, code: 'BANK_ACCOUNT' };
  if (!['checking', 'savings'].includes(b.accountType)) return { error: 'Is it a checking or savings account?', code: 'BANK_TYPE' };
  return {
    value: { method, bankName: str(b.bankName, 120), accountType: b.accountType },
    routing: String(b.routing).replace(/\D/g, ''), account: String(b.account).replace(/[\s-]/g, '')
  };
}

// ---- Pay setup (the owner's) -------------------------------------------------
function normalizePaySetup(b) {
  b = b || {};
  const out = {};
  if (b.workerType !== undefined) {
    if (!Object.values(WORKER_TYPES).includes(b.workerType)) return { error: 'Choose W-2, 1099 or both.', code: 'WORKER_TYPE' };
    out.workerType = b.workerType;
  }
  if (b.payType !== undefined) {
    if (!PAY_TYPES.includes(b.payType)) return { error: 'Choose hourly, salary or per visit.', code: 'PAY_TYPE' };
    out.payType = b.payType;
  }
  for (const [k, ck] of [['hourlyRate', 'hourlyRateCents'], ['salaryAnnual', 'salaryAnnualCents'], ['perVisitRate', 'perVisitRateCents'], ['perExamRate', 'perExamRateCents']]) {
    if (b[k] === undefined) continue;
    const c = b[k] === '' || b[k] === null ? null : money(b[k]);
    if (c === null && b[k] !== '' && b[k] !== null) return { error: `${k} must be a dollar amount.`, code: 'PAY_RATE' };
    out[ck] = c;
  }
  if (b.wageAccount !== undefined) {
    if (!WAGE_ACCOUNTS.includes(b.wageAccount)) return { error: 'Choose home care or clinical wages.', code: 'WAGE_ACCOUNT' };
    out.wageAccount = b.wageAccount;
  }
  if (b.workState !== undefined) {
    // Georgia only today; another state needs its own tables before it can run.
    const st = String(b.workState).toUpperCase();
    if (!STATE_NAMES[st]) return { error: 'Choose the state they work in.', code: 'WORK_STATE' };
    out.workState = st;
  }
  if (b.hireDate !== undefined) {
    if (b.hireDate && !isYmd(b.hireDate)) return { error: 'Hire date must be a date.', code: 'HIRE_DATE' };
    out.hireDate = b.hireDate || null;
  }
  if (b.paySchedule !== undefined) {
    // '' or null puts them back on the default for their role.
    if (b.paySchedule && !PAY_SCHEDULE_KEYS.includes(b.paySchedule)) return { error: 'Choose the caregivers (weekly) or everyone-else schedule.', code: 'PAY_SCHEDULE' };
    out.paySchedule = b.paySchedule || null;
  }
  if (b.status !== undefined) {
    if (!['active', 'inactive'].includes(b.status)) return { error: 'Status is active or inactive.', code: 'STATUS' };
    out.status = b.status;
  }
  return { value: out };
}

// A new record. A caregiver is a home care W-2 by default; other staff take
// the W-2 / 1099 / both answer from clinician onboarding when there is one.
function defaultProfile(user, { relationship } = {}) {
  const isCaregiver = user && (user.role === 'vendor' || !!user.licenseLevel);
  const wt = Object.values(WORKER_TYPES).includes(relationship) ? relationship : WORKER_TYPES.W2;
  return {
    userId: String(user.id), workerType: isCaregiver ? WORKER_TYPES.W2 : wt,
    payType: 'hourly', hourlyRateCents: null, salaryAnnualCents: null, perVisitRateCents: null, perExamRateCents: null,
    wageAccount: isCaregiver ? 'home_care' : 'clinical', workState: 'GA', hireDate: null, status: 'active',
    isCaregiver: !!isCaregiver,
    ssn: null, tin: null, payMethod: null, w4: null, g4: null, i9: null, w9: null,
    offerLetter: null, handbook: null, eDelivery: null, history: []
  };
}

// W-2 / 1099 / both has ONE home: the user record's employmentType, set in
// User Management (main, 2026-11-08), which the staff clock also reads. The
// payroll profile follows it; its own workerType is only the fallback for an
// account nobody has set yet. A caregiver is always W-2.
const EMPLOYMENT_TYPES = Object.freeze(Object.values(WORKER_TYPES));
function withEmploymentType(profile, user) {
  if (!profile) return profile;
  if (profile.isCaregiver) return profile.workerType === WORKER_TYPES.W2 ? profile : { ...profile, workerType: WORKER_TYPES.W2 };
  const et = user && user.employmentType;
  if (!EMPLOYMENT_TYPES.includes(et) || profile.workerType === et) return profile;
  return { ...profile, workerType: et };
}

// Which pay schedule a person is on: what the owner set, else caregivers for
// a caregiver and staff for everyone else.
const PAY_SCHEDULE_KEYS = Object.freeze(['caregivers', 'staff']);
function scheduleFor(p) {
  if (p && PAY_SCHEDULE_KEYS.includes(p.paySchedule)) return p.paySchedule;
  return p && p.isCaregiver ? 'caregivers' : 'staff';
}

const isEmployee = (p) => p && (p.workerType === WORKER_TYPES.W2 || p.workerType === WORKER_TYPES.HYBRID);
const isContractor = (p) => p && (p.workerType === WORKER_TYPES.C1099 || p.workerType === WORKER_TYPES.HYBRID);

// What still stops this person being paid. A run refuses anyone with an item
// here (spec: a run cannot be approved if any worker is missing a W-4, G-4 or
// bank details, unless paid by check).
function missingForPay(p, { asContractor = false, p2p = false } = {}) {
  const out = [];
  if (!p) return ['Payroll record'];
  // Paid P2P on this run (the office's choice, owner 2026-11-13): GFC sends it
  // from its own Cash App, so their bank details are not needed for it.
  if (!p.payMethod && !p2p) out.push('How they are paid (bank details, check or Wise)');
  if (asContractor) {
    // Living outside the U.S. (owner, 2026-11-13): a W-8BEN instead of a W-9.
    if (p.taxResidence === 'foreign') { if (!p.w8ben) out.push('W-8BEN'); }
    else if (!p.w9) out.push('W-9');
    return out;
  }
  if (!p.ssn) out.push('SSN');
  if (!p.w4) out.push('W-4');
  if (!p.g4 && (p.workState || 'GA') === 'GA') out.push('G-4');
  // The I-9's two halves are named apart (owner, 2026-11-14), so a missing
  // Section 1 is never hidden behind "I-9".
  if (!i9Complete(p)) {
    if (!(p.i9 && p.i9.section1)) out.push('I-9 Section 1 (theirs)');
    out.push('I-9 Section 2 (the office)');
  }
  if (p.payType === 'hourly' && !p.isCaregiver && !(p.hourlyRateCents > 0)) out.push('Hourly rate');
  if (p.payType === 'salary' && !(p.salaryAnnualCents > 0)) out.push('Salary');
  if (p.payType === 'per_visit' && !(p.perVisitRateCents > 0)) out.push('Per-visit rate');
  return out;
}

// What the office's People list shows (2026-11-11): a W-2 employee owes the
// employee forms, a 1099 contractor owes a W-9 and how they are paid, and a
// hybrid owes both. Listing W-4, G-4 and I-9 against a pure contractor sent
// the office chasing forms that person never files.
function missingForPerson(p) {
  if (!p) return missingForPay(p);
  const out = isEmployee(p) ? missingForPay(p) : [];
  if (isContractor(p)) for (const m of missingForPay(p, { asContractor: true })) if (!out.includes(m)) out.push(m);
  return out;
}

// The paperwork checklist the person sees on My Pay.
function checklist(p, opts = {}) {
  const rows = [];
  const emp = isEmployee(p), con = isContractor(p);
  // PAY AND TAX ONLY (owner, 2026-11-09). The offer letter and handbook are
  // hiring paperwork and live in onboarding; listing them here as well is
  // what made this read as "the list, plus more". Each row names its group.
  // Your legal name and address come first, and for an employee the SSN:
  // every form is filled from them (owner, 2026-11-14), so the signed copy is
  // never missing them.
  rows.push({ key: 'taxaddress', label: 'Legal name and mailing address (for your tax forms)', done: !!p.taxAddress });
  if (emp) rows.push({ key: 'ssn', label: 'Social Security number', done: !!p.ssn });
  if (emp) {
    rows.push({ key: 'w4', label: 'Form W-4 (federal withholding)', done: !!p.w4 });
    // Georgia's G-4 for a Georgia worker; another state's certificate only
    // where that state taxes wages (Texas does not).
    if ((p.workState || 'GA') === 'GA') rows.push({ key: 'g4', label: 'Form G-4 (Georgia withholding)', done: !!p.g4 });
    else if (opts.stateIncomeTax) rows.push({ key: 'statecert', label: `${STATE_NAMES[p.workState] || p.workState} withholding certificate`, done: !!(p.stateCert && p.stateCert.state === p.workState) });
    rows.push({ key: 'i9', label: 'Form I-9, Section 1', done: !!(p.i9 && (p.i9.section1 || p.i9.onFile)), locked: !!(p.i9 && p.i9.onFile && !p.i9.section1),
      note: p.i9 && p.i9.onFile && !p.i9.section1 ? 'Already on file from your earlier hire paperwork. Nothing to do.' : p.i9 && p.i9.section1 && !p.i9.section2 ? 'The office completes Section 2 when they see your documents.' : null });
  }
  if (con && opts.overseasAllowed) rows.push({ key: 'residence', label: 'Where you live for tax', done: !!p.taxResidence, note: p.taxResidence === 'foreign' ? 'Outside the U.S.: you give a W-8BEN, and no 1099 is issued.' : p.taxResidence === 'us' ? 'In the U.S.: you give a W-9.' : null });
  if (con && p.taxResidence === 'foreign') rows.push({ key: 'w8ben', label: 'Form W-8BEN (living outside the U.S.)', done: !!p.w8ben });
  else if (con) rows.push({ key: 'w9', label: 'Form W-9 (for your 1099)', done: !!p.w9 });
  rows.push({ key: 'pay', label: 'How you are paid', done: !!p.payMethod });
  rows.push({ key: 'edelivery', label: 'Get tax forms electronically', done: !!(p.eDelivery && p.eDelivery.consented), optional: true, note: p.eDelivery && p.eDelivery.consented ? null : 'Otherwise they come by mail.' });
  const GROUP = { w4: 'tax', g4: 'tax', statecert: 'tax', i9: 'tax', ssn: 'tax', w9: 'tax', residence: 'tax', w8ben: 'tax', pay: 'paid', taxaddress: 'tax', edelivery: 'paid' };
  return rows.map(r => ({ ...r, group: GROUP[r.key] }));
}

// What a screen may see. Never a full number: the last four, and whether one
// is on file. `full` is for the owner's audited reveal only.
function publicProfile(p, opts = {}) {
  if (!p) return null;
  const { ssn, tin, payMethod, history, i9Ids, i9DocNumbers, w8benTins, ...rest } = p;
  return {
    ...rest,
    paySchedule: scheduleFor(p), paySchedulePinned: PAY_SCHEDULE_KEYS.includes(p.paySchedule),
    ssnLast4: ssn ? ssn.last4 : null,
    tinLast4: tin ? tin.last4 : null, tinType: tin ? tin.type : null,
    payMethod: payMethod ? {
      method: payMethod.method, bankName: payMethod.bankName || null, accountType: payMethod.accountType || null,
      routingLast4: payMethod.routingLast4 || null, accountLast4: payMethod.accountLast4 || null, wiseEmail: payMethod.wiseEmail || null,
      swift: payMethod.swift || null, bankCountry: payMethod.bankCountry || null
    } : null,
    checklist: checklist(p, opts)
  };
}

module.exports = {
  WORKER_TYPES, PAY_TYPES, PAY_METHODS, WAGE_ACCOUNTS, W4_FILING, G4_FILING, I9_STATUS, W9_CLASS,
  checkSsn, checkEin, checkRouting, checkAccount, signature, normalizeCashtag,
  normalizeW4, normalizeG4, normalizeW8BEN, OVERSEAS_PAY_METHODS, normalizeStateCert, normalizeI9Section1, normalizeI9Section2, normalizeI9OnFile, I9_ON_FILE_SOURCES, i9Complete, normalizeW9, normalizePayMethod, normalizePaySetup,
  defaultProfile, withEmploymentType, PAY_SCHEDULE_KEYS, scheduleFor, isEmployee, isContractor, missingForPay, missingForPerson, checklist, publicProfile
};
