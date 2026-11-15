'use strict';
// ============================================================================
// payrollTax.js — pay periods and the withholding math (spec v2 §3, step 2).
//
// PURE. Every rate is DATA (a tax table row the owner approved), never a
// literal in the math: a new year is a new table, not a code change. The
// tables the app ships are in payrollTaxTables.js, each with its source.
//
// PAY PERIODS (owner, 2026-11-08): weekly runs Monday to Sunday; biweekly runs
// Monday through the second Sunday. The overtime workweek is Monday to Sunday
// to match, so no workweek is ever split across two pay periods.
//
// ROUNDING: every line is rounded to the cent once, at the end of its own
// calculation. Pub 15-T allows rounding withholding to whole dollars; this
// does not, so a stub ties to the penny.
// ============================================================================

const DAY = 86400000;
const ymdMs = (ymd) => Date.parse(`${ymd}T12:00:00Z`);
const toYmd = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (ymd, n) => toYmd(ymdMs(ymd) + n * DAY);
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(ymdMs(s));
const cents = (n) => Math.round(Number(n) || 0);

const FREQUENCIES = Object.freeze({ weekly: { days: 7, perYear: 52 }, biweekly: { days: 14, perYear: 26 } });
const DEFAULT_SETTINGS = Object.freeze({
  frequency: 'biweekly',
  anchor: '2026-01-05',          // a Monday; periods count from here
  payDateOffsetDays: 5,          // the Friday after the period's last Sunday
  federalDepositSchedule: 'monthly',
  gaWithholdingFrequency: 'monthly',
  gaSutaRatePct: null,           // GFC's assigned rate, from the GA DOL notice
  p2pAccount: '$GodwinsFamilyCare', // GFC's Cash App, for a payroll sent P2P (owner, 2026-11-13)
  // The Drive folder pay stubs are filed in (owner, 2026-11-14: the finance
  // folder, never the person's role documents). Null: 07 Finance → Payroll.
  payStubFolderId: null,
  // Contractors living outside the U.S. (owner, 2026-11-13): off until the
  // owner turns it on, and which ways they may be paid.
  overseas: { enabled: false, payMethods: ['wise'] },
  reminderLeadBusinessDays: 5
});

// TWO PAY SCHEDULES (owner, 2026-11-09): caregivers are paid every week,
// everyone else every two weeks. Each schedule has its own frequency, first
// Monday and payday, and a run belongs to exactly one of them. Settings saved
// before this kept one schedule at the top level; that one is now "staff",
// so an existing anchor and payday carry over untouched.
const PAY_SCHEDULES = Object.freeze({
  caregivers: { label: 'Caregivers', defaults: { frequency: 'weekly', anchor: '2026-01-05', payDateOffsetDays: 5 } },
  staff: { label: 'Everyone else', defaults: { frequency: 'biweekly', anchor: '2026-01-05', payDateOffsetDays: 5 } }
});
function scheduleSettings(settings, key) {
  const s = settings || {};
  const def = PAY_SCHEDULES[key] ? PAY_SCHEDULES[key].defaults : PAY_SCHEDULES.staff.defaults;
  const saved = (s.schedules || {})[key];
  if (saved) return { ...def, ...saved };
  if (key === 'staff' || !PAY_SCHEDULES[key]) {
    return { frequency: s.frequency || def.frequency, anchor: s.anchor || def.anchor, payDateOffsetDays: s.payDateOffsetDays !== undefined ? s.payDateOffsetDays : def.payDateOffsetDays };
  }
  return { ...def };
}
function normalizeSchedule(b, cur, label) {
  const out = { ...cur };
  if (b.frequency !== undefined) {
    if (!FREQUENCIES[b.frequency]) return { error: `${label}: pay frequency is weekly or every two weeks.`, code: 'PAY_FREQUENCY' };
    out.frequency = b.frequency;
  }
  if (b.anchor !== undefined) {
    if (!isYmd(b.anchor) || new Date(ymdMs(b.anchor)).getUTCDay() !== 1) return { error: `${label}: the first pay period must start on a Monday.`, code: 'PAY_ANCHOR' };
    out.anchor = b.anchor;
  }
  if (b.payDateOffsetDays !== undefined) {
    const n = Number(b.payDateOffsetDays);
    if (!Number.isInteger(n) || n < 0 || n > 14) return { error: `${label}: payday is 0 to 14 days after the period ends.`, code: 'PAY_DATE_OFFSET' };
    out.payDateOffsetDays = n;
  }
  return { value: out };
}

function normalizeSettings(b, current) {
  const s = { ...DEFAULT_SETTINGS, ...(current || {}) };
  b = b || {};
  if (b.frequency !== undefined) {
    if (!FREQUENCIES[b.frequency]) return { error: 'Pay frequency is weekly or every two weeks.', code: 'PAY_FREQUENCY' };
    s.frequency = b.frequency;
  }
  if (b.anchor !== undefined) {
    if (!isYmd(b.anchor) || new Date(ymdMs(b.anchor)).getUTCDay() !== 1) return { error: 'The first pay period must start on a Monday.', code: 'PAY_ANCHOR' };
    s.anchor = b.anchor;
  }
  if (b.payDateOffsetDays !== undefined) {
    const n = Number(b.payDateOffsetDays);
    if (!Number.isInteger(n) || n < 0 || n > 14) return { error: 'Payday is 0 to 14 days after the period ends.', code: 'PAY_DATE_OFFSET' };
    s.payDateOffsetDays = n;
  }
  if (b.federalDepositSchedule !== undefined) {
    if (!['monthly', 'semiweekly'].includes(b.federalDepositSchedule)) return { error: 'Federal deposits are monthly or semiweekly.', code: 'DEPOSIT_SCHEDULE' };
    s.federalDepositSchedule = b.federalDepositSchedule;
  }
  if (b.gaWithholdingFrequency !== undefined) {
    if (!['monthly', 'quarterly', 'semiweekly'].includes(b.gaWithholdingFrequency)) return { error: 'Georgia withholding is filed monthly, quarterly or semiweekly.', code: 'GA_FREQUENCY' };
    s.gaWithholdingFrequency = b.gaWithholdingFrequency;
  }
  if (b.gaSutaRatePct !== undefined) {
    const n = b.gaSutaRatePct === '' || b.gaSutaRatePct === null ? null : Number(b.gaSutaRatePct);
    if (n !== null && !(n >= 0 && n <= 15)) return { error: 'The Georgia unemployment rate is a percent between 0 and 15.', code: 'GA_SUTA_RATE' };
    s.gaSutaRatePct = n;
  }
  if (b.schedules !== undefined) {
    const next = {};
    for (const key of Object.keys(PAY_SCHEDULES)) next[key] = scheduleSettings(s, key);
    for (const [key, v] of Object.entries(b.schedules || {})) {
      if (!PAY_SCHEDULES[key]) return { error: `There is no "${key}" pay schedule.`, code: 'PAY_SCHEDULE' };
      const n = normalizeSchedule(v || {}, next[key], PAY_SCHEDULES[key].label);
      if (n.error) return n;
      next[key] = n.value;
    }
    s.schedules = next;
    // The top-level fields mirror "staff", which older readers still use.
    s.frequency = next.staff.frequency; s.anchor = next.staff.anchor; s.payDateOffsetDays = next.staff.payDateOffsetDays;
  }
  if (b.overseas !== undefined) {
    const o = b.overseas || {};
    const methods = (Array.isArray(o.payMethods) ? o.payMethods : []).filter(m => ['wise', 'intl_wire'].includes(m));
    if (o.enabled === true && !methods.length) return { error: 'Choose at least one way to pay contractors abroad.', code: 'OVERSEAS_METHODS' };
    s.overseas = { enabled: o.enabled === true, payMethods: methods.length ? [...new Set(methods)] : ['wise'] };
  }
  if (b.p2pAccount !== undefined) {
    const t = String(b.p2pAccount || '').trim().replace(/^\$/, '');
    if (!/^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(t)) return { error: 'GFC\'s Cash App is a $Cashtag, for example $GodwinsFamilyCare.', code: 'P2P_ACCOUNT' };
    s.p2pAccount = `$${t}`;
  }
  if (b.payStubFolder !== undefined) {
    const raw = String(b.payStubFolder || '').trim();
    const m = raw.match(/\/folders\/([A-Za-z0-9_-]{10,})/) || raw.match(/^([A-Za-z0-9_-]{10,})$/);
    if (raw && !m) return { error: 'Paste the Drive folder link, for example https://drive.google.com/drive/folders/…', code: 'PAY_STUB_FOLDER' };
    s.payStubFolderId = raw ? m[1] : null;
  }
  if (b.reminderLeadBusinessDays !== undefined) {
    const n = Number(b.reminderLeadBusinessDays);
    if (!Number.isInteger(n) || n < 1 || n > 20) return { error: 'Reminder lead time is 1 to 20 business days.', code: 'REMINDER_LEAD' };
    s.reminderLeadBusinessDays = n;
  }
  return { value: s };
}

// The period a date falls in. A frequency change applies only from a period
// that has not started (the route passes the anchor the change took effect).
// With a schedule key, the period on that schedule; without one, the
// top-level (staff) fields, as before.
function periodFor(ymd, settings, schedule) {
  const s = schedule ? scheduleSettings(settings, schedule) : { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const len = FREQUENCIES[s.frequency].days;
  const idx = Math.floor((ymdMs(ymd) - ymdMs(s.anchor)) / DAY / len);
  const start = addDays(s.anchor, idx * len);
  const end = addDays(start, len - 1);
  const out = { start, end, payDate: addDays(end, s.payDateOffsetDays), frequency: s.frequency, perYear: FREQUENCIES[s.frequency].perYear };
  if (schedule) out.schedule = schedule;
  return out;
}
// The standard pay periods around a date, newest first (owner, 2026-11-14:
// pick a real pay period, not "a date in it").
function periodsAround(ymd, settings, schedule, { back = 8, ahead = 2 } = {}) {
  const cur = periodFor(ymd, settings, schedule);
  const len = FREQUENCIES[cur.frequency].days;
  const out = [];
  for (let k = ahead; k >= -back; k--) out.push(periodFor(addDays(cur.start, k * len), settings, schedule));
  return out;
}
// A custom pay period (owner, 2026-11-14): for a catch-up or an odd-length
// payroll. Any start and end up to 31 days, a payday on or after the end, and
// the frequency withholding is figured for (weekly or every two weeks).
function customPeriod(b, schedule) {
  b = b || {};
  if (!isYmd(b.start) || !isYmd(b.end) || b.end < b.start) return { error: 'Give the first and last day of the custom period.', code: 'CUSTOM_PERIOD_DATES' };
  const days = Math.round((ymdMs(b.end) - ymdMs(b.start)) / DAY) + 1;
  if (days > 31) return { error: 'A custom period is at most 31 days.', code: 'CUSTOM_PERIOD_LENGTH' };
  if (!isYmd(b.payDate) || b.payDate < b.end || ymdMs(b.payDate) - ymdMs(b.end) > 30 * DAY) return { error: 'Payday is on or after the last day, within 30 days.', code: 'CUSTOM_PERIOD_PAYDAY' };
  const frequency = FREQUENCIES[b.frequency] ? b.frequency : days <= 10 ? 'weekly' : 'biweekly';
  const out = { start: b.start, end: b.end, payDate: b.payDate, frequency, perYear: FREQUENCIES[frequency].perYear, custom: true };
  if (schedule) out.schedule = schedule;
  return { value: out };
}
// The Monday that starts the overtime workweek a date falls in.
function workweekStart(ymd) {
  const dow = new Date(ymdMs(ymd)).getUTCDay();   // 0 Sun .. 6 Sat
  return addDays(ymd, -((dow + 6) % 7));
}
// The business day before payday: the default "send by" for PNC.
function sendByDate(payDate) {
  let d = addDays(payDate, -1);
  while ([0, 6].includes(new Date(ymdMs(d)).getUTCDay())) d = addDays(d, -1);
  return d;
}

// ---- Federal income tax: Pub 15-T, Worksheet 1A (2020+ Form W-4) -------------
// tables.federal.annual[schedule][status] = [[atLeast, butLessThan|null, base, ratePct], ...]
function bracket(rows, amount) {
  const row = rows.find(r => amount >= r[0] && (r[1] === null || amount < r[1]));
  if (!row) throw new Error('no withholding bracket for that wage');
  return row[2] + (amount - row[0]) * row[3] / 100;
}
/**
 * Federal income tax for one period, in cents.
 *   wagesCents: this period's taxable wages
 *   w4: the employee's W-4 (normalized)
 *   fed: the year's federal table data
 */
function federalWithholding(wagesCents, w4, fed, perYear) {
  if (!w4 || w4.exempt) return 0;
  const status = w4.filingStatus === 'mfj' ? 'mfj' : w4.filingStatus === 'hoh' ? 'hoh' : 'single';
  const annualWages = (wagesCents / 100) * perYear;                                  // 1c
  const plusOther = annualWages + (w4.otherIncomeCents || 0) / 100;                  // 1e
  const line1g = w4.multipleJobs ? 0 : fed.worksheet1g[status === 'mfj' ? 'mfj' : 'other'];
  const adjusted = Math.max(0, plusOther - ((w4.deductionsCents || 0) / 100 + line1g)); // 1i
  const schedule = w4.multipleJobs ? 'checkbox' : 'standard';
  const annualTentative = bracket(fed.annual[schedule][status], adjusted);           // 2g
  const periodTentative = annualTentative / perYear;                                 // 2h
  const credits = (w4.dependentsCents || 0) / 100 / perYear;                         // 3b
  const afterCredits = Math.max(0, periodTentative - credits);                       // 3c
  return cents((afterCredits + (w4.extraWithholdingCents || 0) / 100) * 100);        // 4b
}

// ---- FICA ----------------------------------------------------------------------
function socialSecurity(wagesCents, ytdWagesCents, fed) {
  const base = fed.ssWageBaseCents;
  const room = Math.max(0, base - ytdWagesCents);
  return cents(Math.min(wagesCents, room) * fed.ssRatePct / 100);
}
function medicare(wagesCents, ytdWagesCents, fed) {
  const regular = wagesCents * fed.medicareRatePct / 100;
  const over = Math.max(0, ytdWagesCents + wagesCents - fed.addlMedicareThresholdCents) - Math.max(0, ytdWagesCents - fed.addlMedicareThresholdCents);
  return cents(regular + over * fed.addlMedicareRatePct / 100);
}

// ---- Georgia income tax ----------------------------------------------------------
// Annualize, take off the standard deduction for the G-4 status and the
// allowances, apply the flat rate, de-annualize, add any extra.
function georgiaWithholding(wagesCents, g4, ga, perYear) {
  if (!g4 || g4.exempt) return 0;
  const st = g4.filingStatus;
  const annual = (wagesCents / 100) * perYear;
  const std = ga.standardDeduction[st];
  const personal = ga.personalAllowance[st];
  if (std === undefined || personal === undefined) throw new Error(`no Georgia figures for G-4 status ${st}`);
  const allowances = ((g4.dependentAllowances || 0) + (g4.additionalAllowances || 0)) * ga.dependentAllowance;
  const taxable = Math.max(0, annual - std - personal - allowances);
  const annualTax = taxable * ga.ratePct / 100;
  return cents((annualTax / perYear + (g4.extraWithholdingCents || 0) / 100) * 100);
}

// ---- Another state's income tax (Georgia is above) -------------------------------
// From that state's approved table and the person's state certificate
// ({ filingStatus: 'single'|'married', allowances, extraWithholdingCents,
// exempt }). A state with no income tax withholds nothing.
function stateWithholding(wagesCents, table, cert, perYear) {
  if (!table || !table.incomeTax) return 0;
  if (!cert) throw new Error('no state withholding certificate');
  if (cert.exempt) return 0;
  const annual = (wagesCents / 100) * perYear;
  const allowances = Number(cert.allowances) || 0;
  let annualTax;
  if (table.method === 'flat') {
    annualTax = Math.max(0, annual - allowances * table.exemptionCents / 100) * table.ratePct / 100;
  } else if (table.method === 'brackets') {
    const st = cert.filingStatus === 'married' ? 'married' : 'single';
    const taxable = Math.max(0, annual - table.standardDeductionCents[st] / 100 - allowances * table.allowanceCents / 100);
    const row = table.brackets[st].find(r => taxable * 100 >= r[0] && (r[1] === null || taxable * 100 < r[1]));
    annualTax = row ? row[2] / 100 + (taxable - row[0] / 100) * row[3] / 100 : 0;
  } else throw new Error(`unknown state method ${table.method}`);
  return cents((annualTax / perYear + (cert.extraWithholdingCents || 0) / 100) * 100);
}

// ---- Employer taxes ----------------------------------------------------------------
function employerTaxes(wagesCents, ytdWagesCents, fed, sutaRatePct, ga, workState = 'GA') {
  const futaRoom = Math.max(0, fed.futaWageBaseCents - ytdWagesCents);
  const sutaBase = ga && ga.sutaWageBaseCents ? ga.sutaWageBaseCents : 0;
  const sutaRoom = Math.max(0, sutaBase - ytdWagesCents);
  if (workState !== 'GA') {
    // Another state: its own wage base and GFC's rate there; no Georgia unemployment.
    return {
      socialSecurity: socialSecurity(wagesCents, ytdWagesCents, fed),
      medicare: cents(wagesCents * fed.medicareRatePct / 100),
      futa: cents(Math.min(wagesCents, futaRoom) * fed.futaNetRatePct / 100),
      gaSuta: 0,
      sutaState: workState,
      stateSuta: sutaRatePct === null || sutaRatePct === undefined ? null : cents(Math.min(wagesCents, sutaRoom) * sutaRatePct / 100)
    };
  }
  return {
    socialSecurity: socialSecurity(wagesCents, ytdWagesCents, fed),
    medicare: cents(wagesCents * fed.medicareRatePct / 100),     // no additional 0.9% for the employer
    futa: cents(Math.min(wagesCents, futaRoom) * fed.futaNetRatePct / 100),
    gaSuta: sutaRatePct === null || sutaRatePct === undefined ? null : cents(Math.min(wagesCents, sutaRoom) * sutaRatePct / 100)
  };
}

// ---- Gross pay, with overtime ------------------------------------------------------
/**
 * Hourly items for one employee across a pay period, each { date, minutes,
 * rateCents, source, ref }. Overtime is over 40 hours in a Monday-to-Sunday
 * workweek at 1.5x the REGULAR RATE, which for someone paid two rates in a
 * week is the weighted average of that week's straight-time pay (29 CFR
 * 778.115). Returns earnings lines and the minutes counted.
 */
function hourlyEarnings(items) {
  const weeks = new Map();
  for (const it of items || []) {
    const wk = workweekStart(it.date);
    if (!weeks.has(wk)) weeks.set(wk, []);
    weeks.get(wk).push(it);
  }
  let regularCents = 0, otPremiumCents = 0, totalMinutes = 0, otMinutes = 0;
  const weekSummaries = [];
  for (const [wk, list] of [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const mins = list.reduce((a, i) => a + i.minutes, 0);
    const straight = list.reduce((a, i) => a + (i.minutes * i.rateCents) / 60, 0);
    const over = Math.max(0, mins - 40 * 60);
    const regularRate = mins ? straight / (mins / 60) : 0;          // cents per hour
    const premium = (over / 60) * regularRate * 0.5;                 // the extra half; straight time is already paid
    regularCents += straight; otPremiumCents += premium; totalMinutes += mins; otMinutes += over;
    weekSummaries.push({ weekStart: wk, minutes: mins, overtimeMinutes: over, regularRateCents: Math.round(regularRate) });
  }
  return { straightTimeCents: cents(regularCents), overtimePremiumCents: cents(otPremiumCents), totalMinutes, overtimeMinutes: otMinutes, weeks: weekSummaries };
}

/**
 * One employee's paycheck. Every input is already gathered; YTD is from
 * approved runs earlier in the same calendar year (by pay date).
 * Returns earnings, employee taxes, net, employer taxes.
 */
function paycheck({ earnings, reimbursementsCents = 0, ytd, w4, g4, tables, perYear, sutaRatePct, workState = 'GA', stateCert }) {
  const fed = tables.federal;
  const st = workState || 'GA';
  // Georgia first, with its own G-4 formula; any other state from its own table.
  const stateTable = st === 'GA' ? tables.GA : (tables.states || {})[st];
  if (!stateTable) throw new Error(`no approved ${st} table`);
  const grossCents = earnings.reduce((a, e) => a + e.amountCents, 0);
  const y = ytd || { grossCents: 0 };
  const taxes = {
    federal: federalWithholding(grossCents, w4, fed, perYear),
    socialSecurity: socialSecurity(grossCents, y.grossCents, fed),
    medicare: medicare(grossCents, y.grossCents, fed),
    georgia: st === 'GA' ? georgiaWithholding(grossCents, g4, stateTable, perYear) : 0
  };
  if (st !== 'GA') taxes.state = stateWithholding(grossCents, stateTable, stateCert, perYear);
  const taxCents = Object.values(taxes).reduce((a, v) => a + v, 0);
  return {
    grossCents, taxes, taxCents,
    reimbursementsCents,
    netCents: grossCents - taxCents + reimbursementsCents,
    workState: st,
    employer: employerTaxes(grossCents, y.grossCents, fed, sutaRatePct, stateTable, st)
  };
}

module.exports = {
  FREQUENCIES, DEFAULT_SETTINGS, PAY_SCHEDULES, scheduleSettings, normalizeSettings, periodFor, workweekStart, sendByDate, addDays, isYmd,
  bracket, federalWithholding, socialSecurity, medicare, georgiaWithholding, stateWithholding, employerTaxes, hourlyEarnings, paycheck,
  periodsAround, customPeriod
};
