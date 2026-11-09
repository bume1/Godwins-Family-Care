'use strict';
// ============================================================================
// payrollTaxTables.js — the tax figures payroll is allowed to use.
//
// THESE SHIP STAGED. They are seeded into `payroll_tax_tables` with status
// 'staged' and pay nothing until the owner approves them in the app (spec v2
// item 14). Each carries its source, so the owner checks it against the
// agency's own document before clicking Approve.
//
// Every figure below was read from the official 2026 documents on 2026-11-08
// (IRS Pub 15-T and Pub 15, Georgia DOR Employer's Withholding Tax Guide
// revised Sept 2026, Form G-4 rev. 06/03/26, Georgia DOL DOL-4E, SB 160),
// except where a note says UNCONFIRMED.
// ============================================================================

// [atLeast, butLessThan (null = no cap), base tax, rate %] — annual amounts
// (Pub 15-T 2026, "Percentage Method Tables for Automated Payroll Systems").
const FED_2026 = {
  worksheet1g: { mfj: 12900, other: 8600 },
  annual: {
    standard: {
      mfj: [[0, 19300, 0, 0], [19300, 44100, 0, 10], [44100, 120100, 2480, 12], [120100, 230700, 11600, 22], [230700, 422850, 35932, 24], [422850, 531750, 82048, 32], [531750, 788000, 116896, 35], [788000, null, 206583.5, 37]],
      single: [[0, 7500, 0, 0], [7500, 19900, 0, 10], [19900, 57900, 1240, 12], [57900, 113200, 5800, 22], [113200, 209275, 17966, 24], [209275, 263725, 41024, 32], [263725, 648100, 58448, 35], [648100, null, 192979.25, 37]],
      hoh: [[0, 15550, 0, 0], [15550, 33250, 0, 10], [33250, 83000, 1770, 12], [83000, 121250, 7740, 22], [121250, 217300, 16155, 24], [217300, 271750, 39207, 32], [271750, 656150, 56631, 35], [656150, null, 191171, 37]]
    },
    checkbox: {
      mfj: [[0, 16100, 0, 0], [16100, 28500, 0, 10], [28500, 66500, 1240, 12], [66500, 121800, 5800, 22], [121800, 217875, 17966, 24], [217875, 272325, 41024, 32], [272325, 400450, 58448, 35], [400450, null, 103291.75, 37]],
      single: [[0, 8050, 0, 0], [8050, 14250, 0, 10], [14250, 33250, 620, 12], [33250, 60900, 2900, 22], [60900, 108938, 8983, 24], [108938, 136163, 20512, 32], [136163, 328350, 29224, 35], [328350, null, 96489.63, 37]],
      hoh: [[0, 12075, 0, 0], [12075, 20925, 0, 10], [20925, 45800, 885, 12], [45800, 64925, 3870, 22], [64925, 112950, 8077.5, 24], [112950, 140175, 19603.5, 32], [140175, 332375, 28315.5, 35], [332375, null, 95585.5, 37]]
    }
  },
  ssRatePct: 6.2, ssWageBaseCents: 18450000,                 // Pub 15 (2026) §9
  medicareRatePct: 1.45, addlMedicareRatePct: 0.9, addlMedicareThresholdCents: 20000000,
  futaNetRatePct: 0.6, futaWageBaseCents: 700000,            // Pub 15 (2026) §14; GA not on the 2026 potential credit-reduction list
  // CONFIRMED 2026-11-09: the 1099-NEC threshold is $2,000 for payments after
  // 2025 (P.L. 119-21), indexed for inflation from 2027. IRS Pub 15 (2026);
  // Instructions for Forms 1099-MISC and 1099-NEC (Rev. December 2026), box 1a.
  necThresholdCents: 200000
};

// Georgia from May 11, 2026 (HB 463): flat 4.99%. G-4 (rev. 06/03/26) letters:
// A Single · B Married filing separate, or joint with both spouses working ·
// C Married filing joint, one spouse working · D Head of household. There is
// no personal allowance in the 2026 formula; each allowance is $5,000.
const GA_2026 = {
  effectiveFrom: '2026-05-11',
  ratePct: 4.99,
  standardDeduction: { A: 15000, B: 15000, C: 30000, D: 15000 },
  personalAllowance: { A: 0, B: 0, C: 0, D: 0 },
  dependentAllowance: 5000,
  sutaWageBaseCents: 950000,             // GA DOL DOL-4E
  newEmployerSutaRatePct: 2.70            // 2.64% + 0.06% administrative assessment (SB 160), through 2026-12-31
};

// ---- other states (Georgia is first and keeps its own G-4 formula above) ----
const { STATE_SOURCES } = require('./payrollStateSources');
// Every state an employee may work in. A person in a state is paid in the app
// only once that state has a table the owner approved, like Georgia's.
const STATE_NAMES = Object.freeze({
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming'
});
const stateName = (code) => STATE_NAMES[code] || code;

// A state table other than Georgia's. method:
//   'none'      no state income tax on wages (Texas, Florida, ...)
//   'flat'      ratePct of annualized wages less exemptionCents per allowance
//   'brackets'  annualized wages less standardDeductionCents[status] and
//               allowanceCents per allowance, then annual brackets[status]
//               ([atLeastCents, lessThanCents|null, baseCents, ratePct])
// Each state also has its unemployment wage base. The rate itself is GFC's
// own, from that state's notice, and lives in Payroll → Settings.
// Texas: no income tax on wages. Texas Workforce Commission unemployment tax
// on the first $9,000 per employee per year (Texas Labor Code 201.082). A
// new employer pays 2.7% or its industry average, whichever is higher; GFC's
// actual rate is on the TWC notice and is set in Settings.
const TX_2026 = { incomeTax: false, method: 'none', sutaWageBaseCents: 900000, newEmployerSutaRatePct: 2.7 };

const SEEDS = Object.freeze([
  { key: 'federal-2026', year: 2026, jurisdiction: 'federal', data: FED_2026,
    source: 'IRS Pub 15-T (2026) percentage method tables + Worksheet 1A; IRS Pub 15 (2026) Social Security wage base $184,500, Medicare, FUTA. 1099-NEC $2,000 threshold confirmed (Instructions for Forms 1099-MISC and 1099-NEC, Rev. December 2026).' },
  { key: 'GA-2026', year: 2026, jurisdiction: 'GA', data: GA_2026,
    source: 'Georgia DOR Employer\'s Withholding Tax Guide 2026 (revised Sept 2026), Tables E and F: 4.99% from May 11, 2026. Form G-4 rev. 06/03/26. GA DOL wage base $9,500.' },
  { key: 'TX-2026', year: 2026, jurisdiction: 'TX', data: TX_2026,
    source: 'Texas: no state income tax on wages (Texas Comptroller; Tex. Const. art. 8 sec. 24-a). TWC "Your 2026 Tax Rates": tax on the first $9,000 per employee, 2026 rates 0.32% to 6.32%; TWC New Texas Employer Information: 2026 entry-level rate 2.70% (or the industry average if higher). Set GFC\'s own rate from the TWC notice in Settings.' }
]);

// A table the owner stages by hand is checked for shape before it is stored.
function validateStateTable(d) {
  if (!(typeof d.sutaWageBaseCents === 'number' && d.sutaWageBaseCents >= 0)) return 'sutaWageBaseCents is needed.';
  if (typeof d.incomeTax !== 'boolean') return 'incomeTax is true or false.';
  if (!d.incomeTax) return d.method === 'none' ? null : 'A state with no income tax uses method "none".';
  if (d.method === 'flat') {
    if (!(d.ratePct > 0 && d.ratePct < 20)) return 'ratePct is needed for a flat state.';
    if (!(d.exemptionCents >= 0)) return 'exemptionCents (per allowance, per year) is needed; 0 if none.';
    return null;
  }
  if (d.method === 'brackets') {
    for (const st of ['single', 'married']) {
      const rows = d.brackets && d.brackets[st];
      if (!(Array.isArray(rows) && rows.length && rows.every(r => Array.isArray(r) && r.length === 4) && rows[rows.length - 1][1] === null)) return `brackets.${st} is not in the right shape.`;
      if (!(d.standardDeductionCents && d.standardDeductionCents[st] >= 0)) return `standardDeductionCents.${st} is needed.`;
    }
    if (!(d.allowanceCents >= 0)) return 'allowanceCents is needed; 0 if none.';
    return null;
  }
  return 'method is none, flat or brackets.';
}

function validateTable(b) {
  const year = Number(b.year);
  if (!Number.isInteger(year) || year < 2025 || year > 2100) return { error: 'Give the tax year.', code: 'TABLE_YEAR' };
  if (b.jurisdiction !== 'federal' && !STATE_NAMES[b.jurisdiction]) return { error: 'Jurisdiction is federal or a state code such as GA or TX.', code: 'TABLE_JURISDICTION' };
  const d = b.data;
  if (!d || typeof d !== 'object') return { error: 'Give the table figures.', code: 'TABLE_DATA' };
  const rowsOk = (rows) => Array.isArray(rows) && rows.length > 1 && rows.every(r => Array.isArray(r) && r.length === 4 && r.slice(0, 1).concat(r.slice(2)).every(n => typeof n === 'number' && n >= 0))
    && rows[rows.length - 1][1] === null;
  if (b.jurisdiction === 'federal') {
    for (const sch of ['standard', 'checkbox']) for (const st of ['mfj', 'single', 'hoh']) {
      if (!rowsOk(d.annual && d.annual[sch] && d.annual[sch][st])) return { error: `The ${sch} ${st} brackets are not in the right shape.`, code: 'TABLE_BRACKETS' };
    }
    for (const k of ['ssRatePct', 'ssWageBaseCents', 'medicareRatePct', 'addlMedicareRatePct', 'addlMedicareThresholdCents', 'futaNetRatePct', 'futaWageBaseCents', 'necThresholdCents']) {
      if (!(typeof d[k] === 'number' && d[k] >= 0)) return { error: `${k} is missing.`, code: 'TABLE_FIELD' };
    }
    if (!d.worksheet1g || !(d.worksheet1g.mfj >= 0) || !(d.worksheet1g.other >= 0)) return { error: 'worksheet1g is missing.', code: 'TABLE_FIELD' };
  } else if (b.jurisdiction !== 'GA') {
    const bad = validateStateTable(d);
    if (bad) return { error: bad, code: 'TABLE_FIELD' };
  } else {
    if (!(d.ratePct > 0 && d.ratePct < 15)) return { error: 'ratePct is missing.', code: 'TABLE_FIELD' };
    for (const k of ['standardDeduction', 'personalAllowance']) if (!d[k] || !['A', 'B', 'C', 'D'].every(l => typeof d[k][l] === 'number')) return { error: `${k} needs A, B, C and D.`, code: 'TABLE_FIELD' };
    if (!(d.dependentAllowance >= 0) || !(d.sutaWageBaseCents >= 0)) return { error: 'dependentAllowance and sutaWageBaseCents are needed.', code: 'TABLE_FIELD' };
  }
  return { value: { year, jurisdiction: b.jurisdiction, data: d } };
}

// Boot: add any shipped table not yet in the store, STAGED. Never touches a
// table already there, so an owner's approval is never undone.
/**
 * A seed's wording can be corrected after it shipped (a source confirmed, say).
 * Only a STAGED row nobody has approved takes the new source text and data;
 * an approved or retired row is the record of what was approved and is never
 * rewritten. Returns the rows to replace, or [].
 */
function refreshStagedSeeds(existing) {
  const bySeed = new Map(SEEDS.map(s => [s.key, s]));
  const out = [];
  for (const t of existing || []) {
    const s = t && t.seedKey && bySeed.get(t.seedKey);
    if (!s || t.status !== 'staged') continue;
    if (t.source === s.source && JSON.stringify(t.data) === JSON.stringify(s.data)) continue;
    out.push({ ...t, source: s.source, data: s.data });
  }
  return out;
}

function seedRows(existing, { uuid, at }) {
  const have = new Set((existing || []).map(t => t.seedKey).filter(Boolean));
  const add = SEEDS.filter(s => !have.has(s.key)).map(s => ({
    id: uuid(), seedKey: s.key, year: s.year, jurisdiction: s.jurisdiction, data: s.data, source: s.source,
    status: 'staged', stagedAt: at, stagedBy: 'Shipped with the app'
  }));
  return add;
}

// The pages the Apps Script watches for rate changes, one set per
// jurisdiction. Served at GET /api/payroll/automation/tax-sources, with every
// state someone on payroll works in, so a new state is watched (or reported
// as unwatched) without editing the script.
const SOURCE_PAGES = Object.freeze({
  federal: [
    { name: 'IRS Publication 15-T', url: 'https://www.irs.gov/pub/irs-pdf/p15t.pdf' },
    { name: 'IRS Publication 15', url: 'https://www.irs.gov/pub/irs-pdf/p15.pdf' }
  ],
  GA: [
    { name: "Georgia Employer's Tax Guide", url: 'https://dor.georgia.gov/withholding-tax' },
    { name: 'Georgia Form G-4', url: 'https://dor.georgia.gov/document/form/tsdemployeeswithholdingallowancecertificateg-4pdf/download' },
    { name: 'Georgia DOL employer tax', url: 'https://dol.georgia.gov/employers' }
  ]
});
// Programs a state withholds from pay besides income tax (paid leave,
// disability, local income tax). The app does not withhold these yet.
const employeePrograms = (code) => ((STATE_SOURCES[code] || {}).otherPrograms || []).filter(p => p.who !== 'employer');

function sourcesFor(states) {
  // Federal, then Georgia, then every other state in alphabetical order.
  const want = ['federal', 'GA', ...[...new Set(states || [])].filter(s => s && s !== 'GA').sort()];
  const sources = [], unwatched = [];
  for (const j of want) {
    // Federal and Georgia from the curated lists above; every other state from
    // its official pages in payrollStateSources.js.
    const pages = SOURCE_PAGES[j] || ((STATE_SOURCES[j] || {}).pages || []).map(p => ({ name: `${stateName(j)}: ${p.name}`, url: p.url }));
    if (!pages.length) { unwatched.push(j); continue; }
    for (const p of pages) sources.push({ ...p, jurisdiction: j });
  }
  return { sources, unwatched };
}

module.exports = { FED_2026, GA_2026, TX_2026, STATE_NAMES, STATE_SOURCES, stateName, employeePrograms, SEEDS, SOURCE_PAGES, validateTable, validateStateTable, seedRows, refreshStagedSeeds, sourcesFor };
