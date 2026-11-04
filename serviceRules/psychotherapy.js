'use strict';
// serviceRules/psychotherapy.js — psychotherapy, crisis, the psychiatric
// diagnostic evaluation, interactive complexity, and family and group
// psychotherapy (AI coding pipeline spec 3b.3).
//
// SOURCES (3b.6):
//   APA Services, psychotherapy codes:
//     https://www.apaservices.org/practice/reimbursement/health-codes/psychotherapy
//   and its FAQ:
//     https://www.apaservices.org/practice/reimbursement/health-codes/psychotherapy-services-faq
//   Code validity for 2026: CMS PPRRVU2026 October non-QPP file.
// DERIVED, NOT QUOTED: the add-on bands for 90833, 90836 and 90838 mirror the
// base codes; and the second and later 90840 units are placed at each further
// 30 minutes after the first at 75. Confirm both against the CPT book at the
// January review.
//
// Psychotherapy time is documented separately from E/M time, and the same
// minutes are never counted twice (enforced in the claim scrub, 3b.4).
const { PROVENANCE, num, chosen, none, nearNext, addOnUnits } = require('./common');

const FAMILY = 'psychotherapy';
const verifiedAgainst = Object.freeze([
  'https://www.apaservices.org/practice/reimbursement/health-codes/psychotherapy',
  'https://www.apaservices.org/practice/reimbursement/health-codes/psychotherapy-services-faq',
  'CMS PPRRVU2026 October non-QPP'
]);

// Session-time bands, low end inclusive. Standalone, and the add-ons used with an E/M.
const BANDS = Object.freeze([
  Object.freeze({ from: 16, code: '90832', addOn: '90833' }),
  Object.freeze({ from: 38, code: '90834', addOn: '90836' }),
  Object.freeze({ from: 53, code: '90837', addOn: '90838' })
]);
const CRISIS = Object.freeze({ base: '90839', baseFrom: 30, addOn: '90840', addOnFrom: 75, addOnStep: 30 });
const DIAGNOSTIC = Object.freeze({ withoutMedical: '90791', withMedical: '90792' });
const INTERACTIVE_COMPLEXITY = '90785';
const FAMILY_GROUP = Object.freeze({ family_without_patient: '90846', family_with_patient: '90847', group: '90853' });

const ADD_ONS = Object.freeze(BANDS.map(b => b.addOn));
const CODES = Object.freeze([...BANDS.flatMap(b => [b.code, b.addOn]), CRISIS.base, CRISIS.addOn,
  DIAGNOSTIC.withoutMedical, DIAGNOSTIC.withMedical, INTERACTIVE_COMPLEXITY, ...Object.values(FAMILY_GROUP)]);

// kind: 'session' (with withEm), 'crisis', 'diagnostic', 'family_group'.
const select = (input = {}) => {
  const kind = input.kind || 'session';
  const extra = [];
  if (input.interactiveComplexity) extra.push({ code: INTERACTIVE_COMPLEXITY, units: 1 });
  if (kind === 'diagnostic') {
    if (!input.medicalServices) return chosen(FAMILY, [{ code: DIAGNOSTIC.withoutMedical, units: 1 }, ...extra], 'A psychiatric diagnostic evaluation without medical services.');
    if (!input.prescriber) return none(FAMILY, 'A diagnostic evaluation with medical services requires a prescriber, and this clinician is not one.');
    return chosen(FAMILY, [{ code: DIAGNOSTIC.withMedical, units: 1 }, ...extra], 'A psychiatric diagnostic evaluation with medical services, by a prescriber.');
  }
  if (kind === 'family_group') {
    const code = FAMILY_GROUP[input.type];
    if (!code) return none(FAMILY, 'Say whether this was family psychotherapy without the patient, with the patient, or group psychotherapy.');
    return chosen(FAMILY, [{ code, units: 1 }, ...extra], 'Family or group psychotherapy, as recorded.');
  }
  const minutes = num(input.minutes);
  if (minutes == null) return none(FAMILY, 'No psychotherapy time is recorded.');
  if (kind === 'crisis') {
    if (minutes < CRISIS.baseFrom) return none(FAMILY, `Crisis psychotherapy is not reported under ${CRISIS.baseFrom} minutes; ${minutes} are recorded.`);
    const units = addOnUnits(minutes, CRISIS.addOnFrom, CRISIS.addOnStep);
    const codes = [{ code: CRISIS.base, units: 1 }, ...(units ? [{ code: CRISIS.addOn, units }] : []), ...extra];
    const nextAt = minutes < CRISIS.addOnFrom ? CRISIS.addOnFrom : CRISIS.addOnFrom + units * CRISIS.addOnStep;
    return chosen(FAMILY, codes, `${minutes} minutes of crisis psychotherapy: ${CRISIS.base}${units ? ` and ${CRISIS.addOn} × ${units}` : ''}.`,
      { reviewFlag: nearNext({ minutes, chosenCode: units ? CRISIS.addOn : CRISIS.base, nextCode: CRISIS.addOn, nextAt, what: 'crisis psychotherapy time' }) });
  }
  const i = BANDS.findIndex((b, j) => minutes >= b.from && (j === BANDS.length - 1 || minutes < BANDS[j + 1].from));
  if (i < 0) return none(FAMILY, `Psychotherapy is not reported under ${BANDS[0].from} minutes; ${minutes} are recorded.`);
  const band = BANDS[i]; const next = BANDS[i + 1];
  const code = input.withEm ? band.addOn : band.code;
  return chosen(FAMILY, [{ code, units: 1 }, ...extra],
    `${minutes} minutes of psychotherapy${input.withEm ? ', with an E/M on the same visit' : ''}: ${code}.`,
    { reviewFlag: next ? nearNext({ minutes, chosenCode: code, nextCode: input.withEm ? next.addOn : next.code, nextAt: next.from, what: 'psychotherapy time' }) : null });
};

const FIELDS = Object.freeze([
  { key: 'kind', label: 'Service', type: 'select', options: [['session', 'Psychotherapy session'], ['crisis', 'Crisis psychotherapy'], ['diagnostic', 'Psychiatric diagnostic evaluation'], ['family_group', 'Family or group psychotherapy']] },
  { key: 'minutes', label: 'Psychotherapy minutes', type: 'number', when: { kind: ['session', 'crisis'] } },
  { key: 'withEm', label: 'An E/M was done at the same visit', type: 'boolean', when: { kind: ['session'] } },
  { key: 'medicalServices', label: 'Included medical services', type: 'boolean', when: { kind: ['diagnostic'] } },
  { key: 'prescriber', label: 'The clinician is a prescriber', type: 'boolean', when: { kind: ['diagnostic'] } },
  { key: 'type', label: 'Which', type: 'select', options: [['family_without_patient', 'Family, without the patient'], ['family_with_patient', 'Family, with the patient'], ['group', 'Group']], when: { kind: ['family_group'] } },
  { key: 'interactiveComplexity', label: 'Interactive complexity is documented', type: 'boolean' }
]);

module.exports = { FAMILY, FIELDS, label: 'Psychotherapy and psychiatric evaluation', ...PROVENANCE, verifiedAgainst, catalogActive: true,
  BANDS, CRISIS, DIAGNOSTIC, INTERACTIVE_COMPLEXITY, FAMILY_GROUP, ADD_ONS, CODES, select };
