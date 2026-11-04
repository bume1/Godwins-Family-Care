'use strict';
// serviceRules/behavioralIntegration.js — behavioral health integration and
// collaborative care, per calendar month (spec 3b.3).
//
// SOURCES (3b.6):
//   CMS MLN, Behavioral Health Integration Services:
//     https://www.hhs.gov/guidance/sites/default/files/hhs-guidance-documents/CMS/mln909432_bhi_services_2025_508_final.pdf
//   Code validity for 2026: CMS PPRRVU2026 October non-QPP file.
// 99484: at least 20 minutes of clinical staff time in the month, directed by
// the billing practitioner. Collaborative care, behavioral health care manager
// time: 99492 at 70 minutes in the initial month, 99493 at 60 in later months,
// +99494 each additional 30, G2214 for the first 30 minutes. DERIVED: G2214 is
// used when the month reaches 30 minutes but not the 99492/99493 threshold, and
// the first 99494 unit falls 30 minutes after that threshold. Confirm at the
// January review.
const { PROVENANCE, num, chosen, none, nearNext, addOnUnits } = require('./common');

const FAMILY = 'behavioral_integration';
const verifiedAgainst = Object.freeze([
  'https://www.hhs.gov/guidance/sites/default/files/hhs-guidance-documents/CMS/mln909432_bhi_services_2025_508_final.pdf',
  'CMS PPRRVU2026 October non-QPP'
]);
const BHI = Object.freeze({ code: '99484', from: 20 });
const COCM = Object.freeze({ initial: '99492', initialFrom: 70, subsequent: '99493', subsequentFrom: 60, addOn: '99494', step: 30, firstThirty: 'G2214', firstThirtyFrom: 30 });
const CODES = Object.freeze([BHI.code, COCM.initial, COCM.subsequent, COCM.addOn, COCM.firstThirty]);

// kind: 'bhi' ({ staffMinutes }) | 'cocm' ({ managerMinutes, initialMonth }).
const select = (input = {}) => {
  if (input.kind === 'bhi') {
    const m = num(input.staffMinutes);
    if (m == null) return none(FAMILY, 'No clinical staff time is recorded for the month.');
    if (m < BHI.from) return none(FAMILY, `Behavioral health integration needs ${BHI.from} minutes in the month; ${m} are recorded.`, { reviewFlag: nearNext({ minutes: m, chosenCode: null, nextCode: BHI.code, nextAt: BHI.from, what: 'clinical staff time' }) });
    return chosen(FAMILY, [{ code: BHI.code, units: 1 }], `${m} minutes of clinical staff time in the month: ${BHI.code}.`);
  }
  const m = num(input.managerMinutes);
  if (m == null) return none(FAMILY, 'No care manager time is recorded for the month.');
  const base = input.initialMonth ? COCM.initial : COCM.subsequent;
  const from = input.initialMonth ? COCM.initialFrom : COCM.subsequentFrom;
  if (m >= from) {
    const units = addOnUnits(m, from + COCM.step, COCM.step);
    return chosen(FAMILY, [{ code: base, units: 1 }, ...(units ? [{ code: COCM.addOn, units }] : [])],
      `${m} minutes of care manager time in ${input.initialMonth ? 'the initial' : 'a later'} month: ${base}${units ? ` and ${COCM.addOn} × ${units}` : ''}.`,
      { reviewFlag: nearNext({ minutes: m, chosenCode: units ? COCM.addOn : base, nextCode: COCM.addOn, nextAt: from + COCM.step + units * COCM.step, what: 'care manager time' }) });
  }
  if (m >= COCM.firstThirtyFrom) {
    return chosen(FAMILY, [{ code: COCM.firstThirty, units: 1 }], `${m} minutes of care manager time: ${COCM.firstThirty}, below the ${from}-minute ${base} threshold.`,
      { reviewFlag: nearNext({ minutes: m, chosenCode: COCM.firstThirty, nextCode: base, nextAt: from, what: 'care manager time' }) });
  }
  return none(FAMILY, `Collaborative care is not reported under ${COCM.firstThirtyFrom} minutes in the month; ${m} are recorded.`);
};

const FIELDS = Object.freeze([
  { key: 'kind', label: 'Service', type: 'select', options: [['bhi', 'Behavioral health integration'], ['cocm', 'Collaborative care']] },
  { key: 'staffMinutes', label: 'Clinical staff minutes this month', type: 'number', when: { kind: ['bhi'] } },
  { key: 'managerMinutes', label: 'Care manager minutes this month', type: 'number', when: { kind: ['cocm'] } },
  { key: 'initialMonth', label: 'This is the initial month', type: 'boolean', when: { kind: ['cocm'] } }
]);

module.exports = { FAMILY, FIELDS, label: 'Behavioral health integration and collaborative care', ...PROVENANCE, verifiedAgainst, catalogActive: true, BHI, COCM, CODES, select };
