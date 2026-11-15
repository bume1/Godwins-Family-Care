'use strict';
// ============================================================================
// payrollEngine.js — a payroll run from the hours the app already holds
// (spec v2 §2 items 8-9, build steps 3-5).
//
// WHERE PAY COMES FROM, per person, for the pay period:
//   caregivers   completed GPS time logs (clock-in date in the period), each
//                at the three-level rate: shift -> per client -> base
//   clinicians   My Day visit stamps (start to end) at their hourly rate, or a
//                count of visits at their per-visit rate, or salary
//   everyone     the staff clock (admin, training, clinical, exam time)
//   W-2 examiners  completed IME exams at their per-exam rate
// Hours are never moved between days and a caregiver's clock-in is never
// changed by payroll (owner, 2026-11-08).
//
// OVERTIME: over 40 hours in a Monday-to-Sunday workweek, at 1.5x the regular
// rate (payrollTax.hourlyEarnings). Salaried staff are treated as exempt.
//
// LOCKING: an approved run records every hour item it paid (`ref`). Those
// items are never paid again, and the time-log edit route refuses a locked
// row; a later correction is a new adjustment line in the next run.
//
// PURE. The route gathers the rows; this decides the money.
// ============================================================================
const tax = require('./payrollTax');
const { stateName, employeePrograms } = require('./payrollTaxTables');
const profiles = require('./payrollProfiles');

const MAX_ITEM_MINUTES = 16 * 60;   // a single stamp longer than this is a mistake, not a shift
const RUN_STATUSES = Object.freeze(['draft', 'approved', 'paid']);
const ADJUSTMENT_TYPES = Object.freeze({ bonus: 'Bonus', reimbursement: 'Reimbursement (not taxed)', correction: 'Correction to an earlier period' });

const minutesBetween = (a, b) => {
  const m = Math.round((Date.parse(b) - Date.parse(a)) / 60000);
  return Number.isFinite(m) && m > 0 ? m : null;
};

/**
 * Every payable hour item in the period, keyed to a person.
 * Returns Map<userId, items[]>, plus `skipped` with reasons.
 */
function gatherItems({ period, users, profilesById, timeLogs, shifts, visitTimings, imeCases, paidRefs, localDate, resolvePayRate }) {
  const byUser = new Map();
  const skipped = [];
  const add = (uid, it) => {
    if (paidRefs && paidRefs.has(it.ref)) return;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(it);
  };
  const inPeriod = (d) => d && d >= period.start && d <= period.end;
  const userById = new Map((users || []).map(u => [String(u.id), u]));
  const shiftById = new Map((shifts || []).map(s => [String(s.id), s]));

  for (const l of timeLogs || []) {
    if (!l || !l.clock_out_at || !(Number(l.total_minutes) > 0)) continue;
    if (paidRefs && paidRefs.has(`log:${l.id}`)) continue;   // paid already: never looked at again
    const d = localDate(l.clock_in_at);
    if (!inPeriod(d)) continue;
    // W-2 staff clock on the same clock as caregivers (main, 2026-11-08):
    // a row with no shift and no client. They are paid at their payroll
    // profile's hourly rate; a salaried person's clocked time is covered by
    // the salary.
    if (l.kind === 'staff' || (!l.shift_id && !l.client_id)) {
      const p = profilesById.get(String(l.caregiver_id));
      if (p && p.payType === 'salary') continue;
      if (Number(l.total_minutes) > MAX_ITEM_MINUTES) { skipped.push({ userId: l.caregiver_id, ref: `log:${l.id}`, reason: 'Clocked time is too long to be one shift. Correct it in Time Logs.' }); continue; }
      add(String(l.caregiver_id), { ref: `log:${l.id}`, kind: 'hours', source: 'Staff time', date: d, minutes: Number(l.total_minutes), rateCents: (p && p.hourlyRateCents) || 0, rateSource: 'profile' });
      continue;
    }
    const cg = userById.get(String(l.caregiver_id));
    const r = resolvePayRate(cg, l.client_id, shiftById.get(String(l.shift_id)) || null);
    if (r.rate === null) { skipped.push({ userId: l.caregiver_id, ref: `log:${l.id}`, reason: 'No pay rate set (shift, client or base).' }); continue; }
    add(String(l.caregiver_id), { ref: `log:${l.id}`, kind: 'hours', source: 'Caregiver shift', date: d, minutes: Number(l.total_minutes), rateCents: Math.round(r.rate * 100), rateSource: r.source });
  }

  // A clinician who is ON THE CLOCK (the staff clock or a staff shift) when
  // a visit happens is already paid for that time by the clock. Paying the
  // visit's minutes as well would pay the same hour twice. Per-visit pay is a
  // different arrangement (a fee per visit), so only hourly visits are held.
  const clockedSpans = new Map();
  for (const l of timeLogs || []) {
    if (!l || !l.clock_in_at || !l.clock_out_at) continue;
    if (!(l.kind === 'staff' || (!l.shift_id && !l.client_id))) continue;
    const k = String(l.caregiver_id);
    if (!clockedSpans.has(k)) clockedSpans.set(k, []);
    clockedSpans.get(k).push([Date.parse(l.clock_in_at), Date.parse(l.clock_out_at)]);
  }
  const onTheClock = (uid, a, b) => (clockedSpans.get(String(uid)) || []).some(([s, e]) => Date.parse(a) < e && Date.parse(b) > s);

  for (const t of visitTimings || []) {
    if (!t || !t.startedAt || !t.endedAt || !t.byId) continue;
    if (paidRefs && paidRefs.has(`visit:${t.id}`)) continue;
    const d = localDate(t.startedAt);
    if (!inPeriod(d)) continue;
    const p = profilesById.get(String(t.byId));
    const mins = minutesBetween(t.startedAt, t.endedAt);
    if (!mins || mins > MAX_ITEM_MINUTES) { skipped.push({ userId: t.byId, ref: `visit:${t.id}`, reason: 'Visit start and end do not make a usable length.' }); continue; }
    if (!(p && p.payType === 'per_visit') && onTheClock(t.byId, t.startedAt, t.endedAt)) continue;   // paid by the clock
    if (p && p.payType === 'per_visit') add(String(t.byId), { ref: `visit:${t.id}`, kind: 'visit', source: 'Clinical visit', date: d, count: 1, rateCents: p.perVisitRateCents || 0 });
    else if (p && p.payType === 'salary') continue;   // salary covers it
    else add(String(t.byId), { ref: `visit:${t.id}`, kind: 'hours', source: 'Clinical visit', date: d, minutes: mins, rateCents: (p && p.hourlyRateCents) || 0 });
  }


  // A completed exam pays its examiner once. W-2 examiners are paid here;
  // 1099 (and HYBRID, contractor for exams) are paid through contractor pay.
  for (const c of imeCases || []) {
    if (!c || c.status !== 'report_submitted' || !c.examinerId) continue;
    const d = localDate(c.reportSubmittedAt);
    if (!inPeriod(d)) continue;
    const p = profilesById.get(String(c.examinerId));
    if (!p || p.workerType !== profiles.WORKER_TYPES.W2) continue;
    add(String(c.examinerId), { ref: `exam:${c.id}`, kind: 'exam', source: 'IME exam', date: d, count: 1, rateCents: p.perExamRateCents || 0 });
  }
  return { byUser, skipped };
}

/** The earnings lines for one person from their items. */
function earningsFor(profile, items, perYear) {
  const lines = [];
  const hourly = items.filter(i => i.kind === 'hours');
  const missingRate = hourly.filter(i => !(i.rateCents > 0)).length;
  if (hourly.length) {
    const h = tax.hourlyEarnings(hourly.filter(i => i.rateCents > 0));
    if (h.totalMinutes) {
      lines.push({ code: 'regular', label: 'Hours worked', minutes: h.totalMinutes, amountCents: h.straightTimeCents });
      if (h.overtimeMinutes) lines.push({ code: 'overtime', label: 'Overtime premium (half time over 40 hrs a week)', minutes: h.overtimeMinutes, amountCents: h.overtimePremiumCents, weeks: h.weeks.filter(w => w.overtimeMinutes) });
    }
  }
  for (const kind of ['visit', 'exam']) {
    const list = items.filter(i => i.kind === kind);
    if (!list.length) continue;
    const amount = list.reduce((a, i) => a + i.rateCents, 0);
    lines.push({ code: kind === 'visit' ? 'per_visit' : 'per_exam', label: kind === 'visit' ? 'Visits' : 'IME exams', count: list.length, rateCents: list[0].rateCents, amountCents: amount });
  }
  if (profile && profile.payType === 'salary' && profile.salaryAnnualCents > 0) {
    lines.push({ code: 'salary', label: 'Salary', amountCents: Math.round(profile.salaryAnnualCents / perYear) });
  }
  return { lines, missingRate };
}

/**
 * Build a draft run. Everything is passed in; nothing is read here.
 *   people: [{ user, profile }] — every active W-2 (or HYBRID) person
 *   ytdByUser: Map<userId, { grossCents, taxes, employer }> from earlier approved runs this year
 *   adjustments: [{ userId, type, amountCents, note }]
 */
/** A run's totals from its workers. Shared by app runs and imported history. */
function runTotals(workers) {
  const paid = workers.filter(w => w.pay);
  const sum = (f) => paid.reduce((a, w) => a + (f(w) || 0), 0);
  const totals = {
    grossCents: sum(w => w.pay.grossCents),
    federalCents: sum(w => w.pay.taxes.federal),
    socialSecurityCents: sum(w => w.pay.taxes.socialSecurity),
    medicareCents: sum(w => w.pay.taxes.medicare),
    georgiaCents: sum(w => w.pay.taxes.georgia),
    netCents: sum(w => w.pay.netCents),
    reimbursementsCents: sum(w => w.pay.reimbursementsCents),
    employerSocialSecurityCents: sum(w => w.pay.employer.socialSecurity),
    employerMedicareCents: sum(w => w.pay.employer.medicare),
    futaCents: sum(w => w.pay.employer.futa),
    gaSutaCents: sum(w => w.pay.employer.gaSuta),
    // Every state but Georgia, kept by state for its own deposits and reports.
    stateWithholdingCents: sum(w => w.pay.taxes.state),
    stateSutaCents: sum(w => w.pay.employer.stateSuta),
    byState: {}
  };
  for (const w of paid) {
    const st = w.pay.workState || w.workState || 'GA';
    if (st === 'GA') continue;
    const b = totals.byState[st] || (totals.byState[st] = { wagesCents: 0, withheldCents: 0, sutaCents: 0 });
    b.wagesCents += w.pay.grossCents; b.withheldCents += w.pay.taxes.state || 0; b.sutaCents += w.pay.employer.stateSuta || 0;
  }
  // Cash GFC needs: net pay out now, plus every tax it will deposit.
  totals.cashNeededCents = totals.netCents + totals.federalCents + totals.socialSecurityCents + totals.medicareCents
    + totals.georgiaCents + totals.employerSocialSecurityCents + totals.employerMedicareCents + totals.futaCents + totals.gaSutaCents
    + totals.stateWithholdingCents + totals.stateSutaCents;
  return totals;
}

// HOW EACH PERSON IS SENT PAY (owner, 2026-11-13): the office chooses per run,
// Direct deposit or P2P (Cash App from GFC's account), with a per-person
// override. `channels` = { default, byUser }.
const PAY_CHANNELS = Object.freeze({ direct_deposit: 'Direct deposit', p2p: 'P2P (Cash App)' });
const channelOf = (channels, uid) => { const c = channels || {}; const v = (c.byUser || {})[uid] || c.default; return PAY_CHANNELS[v] ? v : 'direct_deposit'; };
// Taxes entered by hand (owner, 2026-11-14), for the rare period the office
// must pay before the forms are in, or adjust what was withheld. The Super
// Admin enters the employee's withholding with a reason; employer taxes are
// still figured. A missing W-4 or withholding certificate then does not hold
// pay, and other missing paperwork is listed as still owed rather than
// blocking: hours worked are paid on payday. How they are paid and a pay rate
// are still needed, since without them nothing can be paid at all.
const BLOCKS_EVEN_BY_HAND = (m) => /^How they are paid|^Pay rate|^Works in|also withholds for/.test(m);
const FORM_ITEMS = (m) => m === 'W-4' || m === 'G-4' || /withholding certificate$/.test(m);
function buildRun({ period, settings, people, gathered, ytdByUser, tables, adjustments, channels, manualTaxes }) {
  // The run's own schedule decides the divisor (52 weekly, 26 biweekly).
  const frequency = (period && period.frequency) || settings.frequency;
  const perYear = tax.FREQUENCIES[frequency].perYear;
  const workers = [];
  for (const { user, profile } of people) {
    const uid = String(user.id);
    const items = gathered.byUser.get(uid) || [];
    const adj = (adjustments || []).filter(a => String(a.userId) === uid);
    const salaried = profile && profile.payType === 'salary';
    if (!items.length && !adj.length && !salaried) continue;
    const { lines, missingRate } = earningsFor(profile, items, perYear);
    for (const a of adj.filter(x => x.type !== 'reimbursement')) lines.push({ code: a.type, label: ADJUSTMENT_TYPES[a.type] || a.type, amountCents: a.amountCents, note: a.note || '' });
    const reimbursementsCents = adj.filter(x => x.type === 'reimbursement').reduce((s, a) => s + a.amountCents, 0);
    const channel = channelOf(channels, uid);
    const missing = profiles.missingForPay(profile, { p2p: channel === 'p2p' });
    // Georgia first; another state is paid only once its table is approved,
    // and never taxed as Georgian.
    const ws = (profile && profile.workState) || 'GA';
    const stTable = ws === 'GA' ? tables.GA : (tables.states || {})[ws];
    if (ws !== 'GA' && !stTable) missing.push(`Works in ${stateName(ws)}: approve a ${stateName(ws)} tax table under Tax Tables first`);
    // A state that withholds for paid leave, disability or a local tax: not
    // handled yet, so blocked rather than paid short.
    const progs = ws === 'GA' ? [] : employeePrograms(ws);
    if (progs.length) missing.push(`${stateName(ws)} also withholds for ${progs.map(p => p.program).join('; ')}. The app does not handle these yet, so pay them outside the app`);
    if (ws !== 'GA' && stTable && stTable.incomeTax && !(profile && profile.stateCert)) missing.push(`${stateName(ws)} withholding certificate`);
    const stRate = ws === 'GA' ? settings.gaSutaRatePct : ((settings.states || {})[ws] || {}).sutaRatePct;
    if (missingRate) missing.push(`Pay rate for ${missingRate} item${missingRate === 1 ? '' : 's'}`);
    const w = {
      userId: uid, name: user.name || user.email || uid,
      workerType: profile ? profile.workerType : 'W2', wageAccount: profile ? profile.wageAccount : 'clinical',
      payMethod: channel === 'p2p' ? 'p2p' : profile && profile.payMethod ? profile.payMethod.method : null, channel,
      refs: items.map(i => i.ref), earnings: lines, missing, workState: ws
    };
    const byHand = (manualTaxes || {})[uid];
    if (byHand && stTable) {
      // The figured paycheck (with the default forms where theirs are not in)
      // supplies gross and employer taxes; the employee's withholding is the
      // office's.
      const base = tax.paycheck({
        earnings: lines, reimbursementsCents, ytd: ytdByUser.get(uid), w4: (profile && profile.w4) || { filingStatus: 'single' }, g4: (profile && profile.g4) || { filingStatus: 'A' },
        tables, perYear, sutaRatePct: stRate, workState: ws, stateCert: (profile && profile.stateCert) || { filingStatus: 'single', allowances: 0 }
      });
      const taxes = { federal: byHand.federal, socialSecurity: byHand.socialSecurity, medicare: byHand.medicare, georgia: ws === 'GA' ? byHand.stateTax : 0 };
      if (ws !== 'GA') taxes.state = byHand.stateTax;
      const taxCents = Object.values(taxes).reduce((a, v) => a + v, 0);
      w.pay = { ...base, taxes, taxCents, netCents: base.grossCents - taxCents + base.reimbursementsCents };
      // Gross when the taxes were entered: a line added or removed since then
      // changes gross but not hand-entered taxes, so the screen warns.
      const enteredOn = Number.isFinite(byHand.grossCents) ? byHand.grossCents : null;
      w.manualTaxes = { reason: byHand.reason, by: byHand.by, at: byHand.at, grossCents: enteredOn, grossChanged: enteredOn !== null && enteredOn !== base.grossCents };
      w.paperworkOwed = missing.filter(m => !BLOCKS_EVEN_BY_HAND(m) && !FORM_ITEMS(m));
      w.missing = missing.filter(BLOCKS_EVEN_BY_HAND);
    } else if (profile && profile.w4 && (ws !== 'GA' || profile.g4) && stTable && !(stTable.incomeTax && ws !== 'GA' && !profile.stateCert)) {
      w.pay = tax.paycheck({
        earnings: lines, reimbursementsCents, ytd: ytdByUser.get(uid), w4: profile.w4, g4: profile.g4,
        tables, perYear, sutaRatePct: stRate, workState: ws, stateCert: profile.stateCert
      });
    }
    workers.push(w);
  }
  workers.sort((a, b) => a.name.localeCompare(b.name));
  const totals = runTotals(workers);
  return {
    period, frequency, perYear, schedule: (period && period.schedule) || null,
    workers, totals,
    blocked: workers.filter(w => w.missing.length).map(w => ({ userId: w.userId, name: w.name, missing: w.missing })),
    sutaRateMissing: workers.some(w => w.workState === 'GA') && (settings.gaSutaRatePct === null || settings.gaSutaRatePct === undefined),
    // Another state where someone was paid and GFC's rate there is not set.
    stateRatesMissing: [...new Set(workers.filter(w => w.pay && w.workState !== 'GA' && w.pay.employer.stateSuta === null).map(w => w.workState))]
  };
}

/** Year-to-date per person from approved runs paid earlier in the year. */
function ytdFrom(runs, { year, beforePayDate }) {
  const out = new Map();
  for (const r of runs || []) {
    if (!r || r.status === 'draft' || !r.period || !String(r.period.payDate).startsWith(String(year))) continue;
    if (beforePayDate && r.period.payDate >= beforePayDate) continue;
    for (const w of r.workers || []) {
      if (!w.pay) continue;
      const y = out.get(w.userId) || { grossCents: 0, netCents: 0, taxes: { federal: 0, socialSecurity: 0, medicare: 0, georgia: 0, state: 0 }, earnings: {}, reimbursementsCents: 0 };
      y.grossCents += w.pay.grossCents; y.netCents += w.pay.netCents; y.reimbursementsCents += w.pay.reimbursementsCents || 0;
      for (const k of Object.keys(y.taxes)) y.taxes[k] += w.pay.taxes[k] || 0;
      for (const e of w.earnings || []) y.earnings[e.code] = (y.earnings[e.code] || 0) + e.amountCents;
      out.set(w.userId, y);
    }
  }
  return out;
}

/** Every hour item already paid by an approved run. */
function paidRefsFrom(runs) {
  const s = new Set();
  for (const r of runs || []) if (r && r.status !== 'draft') for (const w of r.workers || []) for (const ref of w.refs || []) s.add(ref);
  return s;
}

module.exports = { PAY_CHANNELS, channelOf, RUN_STATUSES, ADJUSTMENT_TYPES, MAX_ITEM_MINUTES, gatherItems, earningsFor, runTotals, buildRun, ytdFrom, paidRefsFrom };
