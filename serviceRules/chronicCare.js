'use strict';
// serviceRules/chronicCare.js — chronic care management and advanced primary
// care management, per calendar month (spec 3b.3).
//
// SOURCES (3b.6):
//   CMS MLN, Chronic Care Management Services:
//     https://www.cms.gov/files/document/chroniccaremanagement.pdf
//   Code validity for 2026: CMS PPRRVU2026 October non-QPP file.
// WHOSE TIME IT IS is the distinction that matters. Clinical staff time:
// 99490 for the first 20 minutes, +99439 each additional 20; complex CCM 99487
// for the first 60, +99489 each additional 30. The billing practitioner's own
// time: 99491 for the first 30, +99437 each additional 30. Clinical staff time
// never counts toward 99491 or 99437, which is why the two are separate inputs.
// APCM has no minute count: G0556 one or no chronic conditions, G0557 two or
// more, G0558 two or more and a Qualified Medicare Beneficiary. The behavioral
// add-ons G0568, G0569 and G0570 each need a base APCM code that month (the
// claim scrub blocks one without it, 3b.4).
const { PROVENANCE, num, chosen, none, nearNext, addOnUnits } = require('./common');

const FAMILY = 'chronic_care';
const verifiedAgainst = Object.freeze(['https://www.cms.gov/files/document/chroniccaremanagement.pdf', 'CMS PPRRVU2026 October non-QPP']);
const STAFF = Object.freeze({ base: '99490', baseFrom: 20, addOn: '99439', step: 20 });
const STAFF_COMPLEX = Object.freeze({ base: '99487', baseFrom: 60, addOn: '99489', step: 30 });
const PRACTITIONER = Object.freeze({ base: '99491', baseFrom: 30, addOn: '99437', step: 30 });
const APCM = Object.freeze({ low: 'G0556', multi: 'G0557', multiQmb: 'G0558', multiFrom: 2 });
const APCM_ADD_ONS = Object.freeze(['G0568', 'G0569', 'G0570']);
const CCM_CODES = Object.freeze([STAFF.base, STAFF.addOn, STAFF_COMPLEX.base, STAFF_COMPLEX.addOn, PRACTITIONER.base, PRACTITIONER.addOn]);
const APCM_CODES = Object.freeze([APCM.low, APCM.multi, APCM.multiQmb, ...APCM_ADD_ONS]);
const CODES = Object.freeze([...CCM_CODES, ...APCM_CODES]);

const timed = (rule, minutes, label) => {
  if (minutes < rule.baseFrom) return { codes: [], nextAt: rule.baseFrom, nextCode: rule.base, chosenCode: null, text: `${label}: ${minutes} minutes does not reach ${rule.base} (${rule.baseFrom}).` };
  const firstAddOn = rule.baseFrom + rule.step;
  const units = addOnUnits(minutes, firstAddOn, rule.step);
  return {
    codes: [{ code: rule.base, units: 1 }, ...(units ? [{ code: rule.addOn, units }] : [])],
    nextAt: firstAddOn + units * rule.step, nextCode: rule.addOn, chosenCode: units ? rule.addOn : rule.base,
    text: `${label}: ${minutes} minutes, ${rule.base}${units ? ` and ${rule.addOn} × ${units}` : ''}.`
  };
};

// kind: 'ccm' ({ staffMinutes, practitionerMinutes, complex }) | 'apcm' ({ chronicConditions, qmb }).
const select = (input = {}) => {
  if (input.kind === 'apcm') {
    const n = num(input.chronicConditions);
    if (n == null) return none(FAMILY, 'The number of chronic conditions is not recorded.');
    const code = n >= APCM.multiFrom ? (input.qmb ? APCM.multiQmb : APCM.multi) : APCM.low;
    return chosen(FAMILY, [{ code, units: 1 }], `Advanced primary care management, ${n} chronic condition${n === 1 ? '' : 's'}${n >= APCM.multiFrom && input.qmb ? ', Qualified Medicare Beneficiary' : ''}: ${code}. Once per calendar month.`);
  }
  const staff = num(input.staffMinutes); const prac = num(input.practitionerMinutes);
  if (staff == null && prac == null) return none(FAMILY, 'No care management time is recorded for the month.');
  const codes = []; const parts = []; let flag = null;
  if (staff != null) {
    const r = timed(input.complex ? STAFF_COMPLEX : STAFF, staff, input.complex ? 'Complex CCM, clinical staff time' : 'CCM, clinical staff time');
    codes.push(...r.codes); parts.push(r.text);
    flag = flag || nearNext({ minutes: staff, chosenCode: r.chosenCode, nextCode: r.nextCode, nextAt: r.nextAt, what: 'clinical staff time' });
  }
  if (prac != null) {
    const r = timed(PRACTITIONER, prac, 'CCM, the billing practitioner\'s own time');
    codes.push(...r.codes); parts.push(r.text);
    flag = flag || nearNext({ minutes: prac, chosenCode: r.chosenCode, nextCode: r.nextCode, nextAt: r.nextAt, what: 'practitioner time' });
  }
  return codes.length ? chosen(FAMILY, codes, parts.join(' '), { reviewFlag: flag }) : none(FAMILY, parts.join(' '), { reviewFlag: flag });
};

const FIELDS = Object.freeze([
  { key: 'kind', label: 'Service', type: 'select', options: [['ccm', 'Chronic care management (time)'], ['apcm', 'Advanced primary care management (monthly)']] },
  { key: 'staffMinutes', label: 'Clinical staff minutes this month', type: 'number', when: { kind: ['ccm'] } },
  { key: 'complex', label: 'Complex CCM', type: 'boolean', when: { kind: ['ccm'] } },
  { key: 'practitionerMinutes', label: 'Billing practitioner\'s own minutes this month', type: 'number', when: { kind: ['ccm'] } },
  { key: 'chronicConditions', label: 'Number of chronic conditions', type: 'number', when: { kind: ['apcm'] } },
  { key: 'qmb', label: 'Qualified Medicare Beneficiary', type: 'boolean', when: { kind: ['apcm'] } }
]);

module.exports = { FAMILY, FIELDS, label: 'Chronic care and advanced primary care management', ...PROVENANCE, verifiedAgainst, catalogActive: true,
  STAFF, STAFF_COMPLEX, PRACTITIONER, APCM, APCM_ADD_ONS, CCM_CODES, APCM_CODES, CODES, select };
