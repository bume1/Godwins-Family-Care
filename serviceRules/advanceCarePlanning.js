'use strict';
// serviceRules/advanceCarePlanning.js — advance care planning (spec 3b.3).
//
// SOURCES (3b.6):
//   Coalition for Compassionate Care of California, ACP coding FAQ:
//     https://coalitionccc.org/common/Uploaded%20files/PDFs/ACP%20CodesFAQs_CCCC_Oct2023c.pdf
//   Code validity for 2026: CMS PPRRVU2026 October non-QPP file.
// 99497 covers the first 30 minutes and is always billed first; under 16
// minutes it is not ACP. 99498 is each additional 30 minutes, and the two
// together need 46 minutes or more. DERIVED: a second 99498 unit at 76
// minutes (46 plus 30). Confirm against the CPT book at the January review.
const { PROVENANCE, num, chosen, none, nearNext, addOnUnits } = require('./common');

const FAMILY = 'advance_care_planning';
const verifiedAgainst = Object.freeze([
  'https://coalitionccc.org/common/Uploaded%20files/PDFs/ACP%20CodesFAQs_CCCC_Oct2023c.pdf',
  'CMS PPRRVU2026 October non-QPP'
]);
const BASE = Object.freeze({ code: '99497', from: 16 });
const ADD_ON = Object.freeze({ code: '99498', from: 46, step: 30 });
const CODES = Object.freeze([BASE.code, ADD_ON.code]);

const select = (input = {}) => {
  const minutes = num(input.minutes);
  if (minutes == null) return none(FAMILY, 'No advance care planning time is recorded.');
  if (minutes < BASE.from) return none(FAMILY, `A discussion under ${BASE.from} minutes is not reported as advance care planning; ${minutes} are recorded.`);
  const units = addOnUnits(minutes, ADD_ON.from, ADD_ON.step);
  const nextAt = minutes < ADD_ON.from ? ADD_ON.from : ADD_ON.from + units * ADD_ON.step;
  return chosen(FAMILY, [{ code: BASE.code, units: 1 }, ...(units ? [{ code: ADD_ON.code, units }] : [])],
    `${minutes} minutes of advance care planning: ${BASE.code}${units ? ` and ${ADD_ON.code} × ${units}` : ''}.`,
    { reviewFlag: nearNext({ minutes, chosenCode: units ? ADD_ON.code : BASE.code, nextCode: ADD_ON.code, nextAt, what: 'advance care planning time' }) });
};

const FIELDS = Object.freeze([{ key: 'minutes', label: 'Advance care planning minutes', type: 'number' }]);

module.exports = { FAMILY, FIELDS, label: 'Advance care planning', ...PROVENANCE, verifiedAgainst, catalogActive: true, BASE, ADD_ON, CODES, select };
