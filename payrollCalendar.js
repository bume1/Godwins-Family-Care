'use strict';
const { stateName } = require('./payrollTaxTables');
// ============================================================================
// payrollCalendar.js — what GFC owes the tax agencies, when, and the figures
// each quarterly and year-end filing needs (spec v1 "Tax deposits, filings
// and reminders"; build step 10).
//
// PURE. The app never pays or files anything: the owner pays in EFTPS and the
// Georgia portals and records the confirmation here. The calendar and the
// reminders read what is still unconfirmed.
//
// DUE DATES follow the published rules, moved to the next business day when
// they fall on a weekend. Federal holidays are not modelled (that needs a
// holiday calendar the app does not keep), so a due date on a holiday shows
// the holiday itself: early, which is the safe side.
// ============================================================================
const DAY = 86400000;
const ms = (ymd) => Date.parse(`${ymd}T12:00:00Z`);
const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (d, n) => ymd(ms(d) + n * DAY);
const dow = (d) => new Date(ms(d)).getUTCDay();
const nextBusinessDay = (d) => { let x = d; while ([0, 6].includes(dow(x))) x = addDays(x, 1); return x; };
const lastDayOfMonth = (y, m) => ymd(Date.UTC(y, m, 0, 12));            // m is 1-12
const fifteenthAfter = (d) => { const y = +d.slice(0, 4), m = +d.slice(5, 7); return m === 12 ? `${y + 1}-01-15` : `${y}-${String(m + 1).padStart(2, '0')}-15`; };
const quarterOf = (d) => Math.floor((+d.slice(5, 7) - 1) / 3) + 1;
const quarterKey = (d) => `${d.slice(0, 4)}-Q${quarterOf(d)}`;
const quarterDue = (d) => {      // last day of the month after the quarter
  const y = +d.slice(0, 4), q = quarterOf(d);
  return q === 4 ? lastDayOfMonth(y + 1, 1) : lastDayOfMonth(y, q * 3 + 1);
};

// Semiweekly: a Wed, Thu or Fri payday deposits by the next Wednesday; a Sat,
// Sun, Mon or Tue payday by the next Friday.
function semiweeklyDue(payDate) {
  const d = dow(payDate);
  if ([3, 4, 5].includes(d)) { let x = addDays(payDate, 1); while (dow(x) !== 3) x = addDays(x, 1); return x; }
  let x = addDays(payDate, 1); while (dow(x) !== 5) x = addDays(x, 1); return x;
}

const AGENCIES = Object.freeze({ IRS: 'IRS (EFTPS)', GA_DOR: 'Georgia DOR (Georgia Tax Center)', GA_DOL: 'Georgia DOL (employer portal)', TX_TWC: 'Texas Workforce Commission (Unemployment Tax Services)' });
// Another state's agencies: named for that state until it has its own entry.
const agencyLabel = (agency) => AGENCIES[agency] || (/^([A-Z]{2})_(DOR|UI)$/.test(agency)
  ? `${stateName(agency.slice(0, 2))} ${agency.endsWith('_DOR') ? 'revenue department' : 'unemployment agency'}` : agency);

/**
 * Every tax liability one approved run creates. Amounts in cents.
 */
function liabilitiesForRun(run, settings) {
  const t = run.totals, pay = run.period.payDate;
  const fedDue = settings.federalDepositSchedule === 'semiweekly' ? semiweeklyDue(pay) : fifteenthAfter(pay);
  const gaDue = settings.gaWithholdingFrequency === 'semiweekly' ? semiweeklyDue(pay)
    : settings.gaWithholdingFrequency === 'quarterly' ? quarterDue(pay) : fifteenthAfter(pay);
  const out = [
    { agency: 'IRS', type: 'federal_deposit', label: 'Federal income tax + Social Security + Medicare (941 deposit)',
      amountCents: t.federalCents + t.socialSecurityCents + t.medicareCents + t.employerSocialSecurityCents + t.employerMedicareCents,
      dueDate: nextBusinessDay(fedDue) },
    { agency: 'GA_DOR', type: 'ga_withholding', label: 'Georgia income tax withheld', amountCents: t.georgiaCents, dueDate: nextBusinessDay(gaDue) },
    { agency: 'IRS', type: 'futa', label: 'Federal unemployment (FUTA)', amountCents: t.futaCents, dueDate: nextBusinessDay(quarterDue(pay)), quarter: quarterKey(pay) },
    { agency: 'GA_DOL', type: 'ga_suta', label: 'Georgia unemployment (DOL-4N)', amountCents: t.gaSutaCents || 0, dueDate: nextBusinessDay(quarterDue(pay)), quarter: quarterKey(pay) }
  ];
  // Every other state, after Georgia. Unemployment is quarterly, due the last
  // day of the month after the quarter (Texas's C-3 and most states). State
  // withholding follows the schedule the owner set for that state.
  for (const [st, b] of Object.entries(t.byState || {}).sort((a, c) => a[0].localeCompare(c[0]))) {
    const conf = (settings.states || {})[st] || {};
    out.push({ agency: st === 'TX' ? 'TX_TWC' : `${st}_UI`, type: `${st.toLowerCase()}_suta`, label: `${stateName(st)} unemployment (quarterly report)`, amountCents: b.sutaCents || 0, dueDate: nextBusinessDay(quarterDue(pay)), quarter: quarterKey(pay) });
    const whDue = conf.withholdingFrequency === 'quarterly' ? quarterDue(pay) : conf.withholdingFrequency === 'semiweekly' ? semiweeklyDue(pay) : fifteenthAfter(pay);
    out.push({ agency: `${st}_DOR`, type: `${st.toLowerCase()}_withholding`, label: `${stateName(st)} income tax withheld`, amountCents: b.withheldCents || 0, dueDate: nextBusinessDay(whDue),
      note: conf.withholdingFrequency ? null : `Check ${stateName(st)}'s deposit schedule and set it in Settings.` });
  }
  return out.filter(l => l.amountCents > 0).map(l => ({ ...l, runId: run.id, payDate: pay }));
}

/**
 * The calendar: liabilities grouped by agency, type and due date, with what
 * has been paid against each. FUTA under $500 for the year so far rolls to
 * the next quarter, as the IRS allows.
 */
function calendar(runs, payments, settings) {
  const groups = new Map();
  for (const r of runs || []) {
    if (!r || r.status === 'draft') continue;
    // History imported from Gusto: Gusto made those deposits.
    if (r.source === 'gusto') continue;
    for (const l of liabilitiesForRun(r, settings)) {
      const key = `${l.type}:${l.dueDate}`;
      const g = groups.get(key) || { key, agency: l.agency, agencyLabel: agencyLabel(l.agency), type: l.type, label: l.label, dueDate: l.dueDate, quarter: l.quarter || null, amountCents: 0, runIds: [] };
      g.amountCents += l.amountCents; g.runIds.push(l.runId);
      groups.set(key, g);
    }
  }
  // FUTA: deposit only once the running undeposited total passes $500.
  const futa = [...groups.values()].filter(g => g.type === 'futa').sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  let carry = 0;
  for (const g of futa) {
    const total = g.amountCents + carry;
    const isQ4 = /-Q4$/.test(g.quarter || '');
    if (total <= 50000 && !isQ4) { carry = total; g.amountCents = 0; g.note = 'Under $500 so far this year; carried to next quarter.'; }
    else { g.amountCents = total; carry = 0; }
  }
  const paidBy = new Map();
  for (const p of payments || []) paidBy.set(p.key, [...(paidBy.get(p.key) || []), p]);
  return [...groups.values()].filter(g => g.amountCents > 0 || g.note).map(g => {
    const ps = paidBy.get(g.key) || [];
    const paidCents = ps.reduce((a, p) => a + (p.amountCents || 0), 0);
    return { ...g, payments: ps, paidCents, open: g.amountCents > 0 && paidCents < g.amountCents };
  }).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.type.localeCompare(b.type));
}

// The filing deadlines for a year, beside the deposits.
function filings(year) {
  const y = Number(year);
  const out = [];
  for (const q of [1, 2, 3, 4]) {
    const due = q === 4 ? lastDayOfMonth(y + 1, 1) : lastDayOfMonth(y, q * 3 + 1);
    out.push({ key: `941:${y}-Q${q}`, form: 'Form 941', agency: 'IRS', quarter: `${y}-Q${q}`, dueDate: nextBusinessDay(due) });
    out.push({ key: `G-7:${y}-Q${q}`, form: 'Georgia G-7', agency: 'GA_DOR', quarter: `${y}-Q${q}`, dueDate: nextBusinessDay(due) });
    out.push({ key: `DOL-4N:${y}-Q${q}`, form: 'Georgia DOL-4N', agency: 'GA_DOL', quarter: `${y}-Q${q}`, dueDate: nextBusinessDay(due) });
  }
  const jan31 = nextBusinessDay(`${y + 1}-01-31`);
  for (const [k, form, agency] of [['940', 'Form 940 (FUTA)', 'IRS'], ['W-2', 'W-2s to employees and SSA, with W-3', 'IRS'], ['G-1003', 'Georgia G-1003', 'GA_DOR'], ['1099-NEC', '1099-NEC to contractors and IRS', 'IRS']]) {
    out.push({ key: `${k}:${y}`, form, agency, year: y, dueDate: jan31 });
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

/**
 * The figures for Form 941, G-7 and DOL-4N for one quarter, from approved
 * runs whose pay date falls in it. Laid out by form line.
 */
// The state a paid worker worked in on that run: Georgia unless recorded.
const stateOf = (w) => (w.pay && w.pay.workState) || w.workState || (w.imported && w.imported.workState) || 'GA';

function quarterSummary(runs, { year, quarter, fed, sutaWageBaseCents, stateWageBases }) {
  const inQ = (runs || []).filter(r => r && r.status !== 'draft' && r.period && r.period.payDate.startsWith(String(year)) && quarterOf(r.period.payDate) === Number(quarter))
    .sort((a, b) => a.period.payDate.localeCompare(b.period.payDate));
  const people = new Set();
  let wages = 0, fedWh = 0, ssWages = 0, medWages = 0, addlMedWages = 0, gaWh = 0;
  const months = {};
  const ytdBefore = new Map();
  for (const r of (runs || []).filter(x => x && x.status !== 'draft' && x.period && x.period.payDate.startsWith(String(year)) && quarterOf(x.period.payDate) < Number(quarter))) {
    for (const w of r.workers || []) if (w.pay) ytdBefore.set(w.userId, (ytdBefore.get(w.userId) || 0) + w.pay.grossCents);
  }
  const ytd = new Map(ytdBefore);
  const perEmployee = new Map();
  const other = {};      // every state but Georgia: its own unemployment report
  for (const r of inQ) {
    const m = +r.period.payDate.slice(5, 7);
    months[m] = months[m] || { federalLiabilityCents: 0, gaWithheldCents: 0 };
    for (const w of r.workers || []) {
      if (!w.pay) continue;
      people.add(w.userId);
      const before = ytd.get(w.userId) || 0, g = w.pay.grossCents;
      wages += g; fedWh += w.pay.taxes.federal; gaWh += w.pay.taxes.georgia;
      ssWages += Math.max(0, Math.min(g, fed.ssWageBaseCents - before));
      medWages += g;
      addlMedWages += Math.max(0, before + g - fed.addlMedicareThresholdCents) - Math.max(0, before - fed.addlMedicareThresholdCents);
      ytd.set(w.userId, before + g);
      months[m].federalLiabilityCents += w.pay.taxes.federal + w.pay.taxes.socialSecurity + w.pay.taxes.medicare + w.pay.employer.socialSecurity + w.pay.employer.medicare;
      months[m].gaWithheldCents += w.pay.taxes.georgia;
      const st = stateOf(w);
      if (st !== 'GA') {
        const o = other[st] || (other[st] = { state: st, name: stateName(st), totalWagesCents: 0, taxableWagesCents: 0, withheldCents: 0, employees: new Set() });
        o.totalWagesCents += g; o.withheldCents += w.pay.taxes.state || 0; o.employees.add(w.userId);
        o.taxableWagesCents += Math.max(0, Math.min(g, ((stateWageBases || {})[st] || 0) - before));
        continue;     // never on Georgia's DOL-4N
      }
      const pe = perEmployee.get(w.userId) || { userId: w.userId, name: w.name, wagesCents: 0, sutaTaxableCents: 0 };
      pe.wagesCents += g;
      pe.sutaTaxableCents += Math.max(0, Math.min(g, (sutaWageBaseCents || 0) - before));
      perEmployee.set(w.userId, pe);
    }
  }
  const r2 = (n) => Math.round(n);
  const line5a = r2(ssWages * 0.124), line5c = r2(medWages * 0.029), line5d = r2(addlMedWages * 0.009);
  const sutaTaxable = [...perEmployee.values()].reduce((a, p) => a + p.sutaTaxableCents, 0);
  return {
    year: Number(year), quarter: Number(quarter), runs: inQ.map(r => r.id),
    form941: {
      line1_employees: people.size, line2_wagesCents: wages, line3_federalWithheldCents: fedWh,
      line5a_ssWagesCents: ssWages, line5a_taxCents: line5a, line5c_medicareWagesCents: medWages, line5c_taxCents: line5c,
      line5d_addlMedicareWagesCents: addlMedWages, line5d_taxCents: line5d,
      line6_totalBeforeAdjustmentsCents: fedWh + line5a + line5c + line5d,
      line16_monthlyLiabilityCents: [1, 2, 3].map(i => (months[(Number(quarter) - 1) * 3 + i] || {}).federalLiabilityCents || 0)
    },
    formG7: { monthlyWithheldCents: [1, 2, 3].map(i => (months[(Number(quarter) - 1) * 3 + i] || {}).gaWithheldCents || 0), totalWithheldCents: gaWh },
    formDOL4N: (() => { const ga = [...perEmployee.values()].reduce((a, p) => a + p.wagesCents, 0); return { totalWagesCents: ga, excessWagesCents: ga - sutaTaxable, taxableWagesCents: sutaTaxable, employees: [...perEmployee.values()] }; })(),
    otherStates: Object.values(other).sort((a, b) => a.state.localeCompare(b.state)).map(o => ({ ...o, employees: o.employees.size, excessWagesCents: o.totalWagesCents - o.taxableWagesCents }))
  };
}

/**
 * Year-end figures: W-2 boxes per employee and 1099-NEC box 1 per contractor
 * at or above the year's reporting threshold.
 */
function yearEnd(runs, contractorPayments, { year, fed, incomeTaxStates }) {
  const w2 = new Map();
  const yr = (runs || []).filter(r => r && r.status !== 'draft' && r.period && r.period.payDate.startsWith(String(year)))
    .sort((a, b) => a.period.payDate.localeCompare(b.period.payDate));
  for (const r of yr) for (const w of r.workers || []) {
    if (!w.pay) continue;
    const e = w2.get(w.userId) || { userId: w.userId, name: w.name, box1: 0, box2: 0, box3: 0, box4: 0, box5: 0, box6: 0, box12TT: 0, box16: 0, box17: 0, stateCode: 'GA' };
    // Boxes 15-17: Georgia, or the state they worked in. A state with no
    // income tax (Texas) reports no state wages on the W-2.
    const st = stateOf(w);
    e.stateCode = st;
    const before = e.box5;
    e.box1 += w.pay.grossCents; e.box2 += w.pay.taxes.federal;
    e.box3 += Math.max(0, Math.min(w.pay.grossCents, fed.ssWageBaseCents - before));
    e.box4 += w.pay.taxes.socialSecurity; e.box5 += w.pay.grossCents; e.box6 += w.pay.taxes.medicare;
    if (st === 'GA') { e.box16 += w.pay.grossCents; e.box17 += w.pay.taxes.georgia; }
    else if ((incomeTaxStates || []).includes(st) || (w.pay.taxes.state || 0) > 0) { e.box16 += w.pay.grossCents; e.box17 += w.pay.taxes.state || 0; }
    // Box 12 code TT (new for 2026): qualified overtime, which is only the
    // premium half; the overtime earnings line is already exactly that.
    for (const l of w.earnings || []) if (l.code === 'overtime') e.box12TT += l.amountCents || 0;
    w2.set(w.userId, e);
  }
  const nec = new Map();
  for (const p of contractorPayments || []) {
    if (!p || !String(p.paidAt || '').startsWith(String(year))) continue;
    const e = nec.get(p.userId) || { userId: p.userId, name: p.name, box1: 0 };
    e.box1 += p.amountCents;
    nec.set(p.userId, e);
  }
  const threshold = fed.necThresholdCents;
  return {
    year: Number(year),
    w2: [...w2.values()].sort((a, b) => a.name.localeCompare(b.name)),
    nec: [...nec.values()].filter(e => e.box1 >= threshold).sort((a, b) => a.name.localeCompare(b.name)),
    necBelowThreshold: [...nec.values()].filter(e => e.box1 < threshold).length,
    necThresholdCents: threshold
  };
}

module.exports = {
  AGENCIES, nextBusinessDay, semiweeklyDue, fifteenthAfter, quarterDue, quarterOf, quarterKey,
  liabilitiesForRun, calendar, filings, quarterSummary, yearEnd
};
