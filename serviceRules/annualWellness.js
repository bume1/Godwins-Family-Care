'use strict';
// serviceRules/annualWellness.js — the annual wellness visit (spec 3b.3).
//
// SOURCES (3b.6): Code validity for 2026, CMS PPRRVU2026 October non-QPP file.
// G0438 is the patient's first AWV in their lifetime; G0439 every later one,
// no more than once in 12 months. ANOTHER PRACTICE'S CLAIM WILL NOT APPEAR IN
// GFC'S RECORDS, so "no prior AWV" here means none GFC has, and the result
// says so every time (the Palmetto eServices check is the real answer).
const { PROVENANCE, chosen, none } = require('./common');

const FAMILY = 'annual_wellness';
const verifiedAgainst = Object.freeze(['CMS PPRRVU2026 October non-QPP']);
const INITIAL = 'G0438';
const SUBSEQUENT = 'G0439';
const CODES = Object.freeze([INITIAL, SUBSEQUENT]);
const OTHER_PRACTICE = 'Another practice\'s AWV will not appear in GFC\'s records. Check Palmetto eServices before this claim is released.';

const plusYear = (ymd) => `${Number(ymd.slice(0, 4)) + 1}${ymd.slice(4)}`;
// priorAwvDates: dates of AWVs GFC has billed for this patient.
const select = (input = {}) => {
  const dos = String(input.dos || '').slice(0, 10);
  const prior = (Array.isArray(input.priorAwvDates) ? input.priorAwvDates : []).map(d => String(d).slice(0, 10)).filter(d => d && d < dos).sort();
  if (!prior.length) return chosen(FAMILY, [{ code: INITIAL, units: 1 }], 'GFC has no earlier AWV for this patient, so this is coded as the first.', { notes: [OTHER_PRACTICE] });
  const last = prior[prior.length - 1];
  if (dos < plusYear(last)) return none(FAMILY, `GFC billed an AWV on ${last}, less than 12 months before this visit.`, { notes: [OTHER_PRACTICE] });
  return chosen(FAMILY, [{ code: SUBSEQUENT, units: 1 }], `A subsequent AWV: GFC's last was on ${last}.`, { notes: [OTHER_PRACTICE] });
};

// priorAwvDates is filled by the server from GFC's own records, never typed.
const FIELDS = Object.freeze([]);

module.exports = { FAMILY, FIELDS, label: 'Annual wellness visit', ...PROVENANCE, verifiedAgainst, catalogActive: true, INITIAL, SUBSEQUENT, CODES, OTHER_PRACTICE, select };
