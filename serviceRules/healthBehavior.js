'use strict';
// serviceRules/healthBehavior.js — health behavior assessment and
// intervention, and the neurobehavioral status exam (spec 3b.3).
//
// SOURCES (3b.6):
//   Health behavior intervention coding guidance:
//     https://www.ndbh.com/Docs/PCP/6-22-2020/Health%20Behavior%20Intervention%20codes.pdf
//   Code validity for 2026: CMS PPRRVU2026 October non-QPP file.
// DERIVED, NOT QUOTED: the first 15-minute add-on unit is placed at 38 minutes
// (30 for the base plus more than half of 15), and the neurobehavioral exam's
// first hour at 31 minutes, by the CPT rule that a unit of time is attained
// once its midpoint is passed. Confirm both against the CPT book at the
// January review.
const { PROVENANCE, num, chosen, none, nearNext, addOnUnits } = require('./common');

const FAMILY = 'health_behavior';
const verifiedAgainst = Object.freeze([
  'https://www.ndbh.com/Docs/PCP/6-22-2020/Health%20Behavior%20Intervention%20codes.pdf',
  'CMS PPRRVU2026 October non-QPP'
]);
const ASSESSMENT = '96156';
const INTERVENTIONS = Object.freeze({
  individual: Object.freeze({ base: '96158', addOn: '96159' }),
  group: Object.freeze({ base: '96164', addOn: '96165' }),
  family: Object.freeze({ base: '96167', addOn: '96168' })
});
const BASE_FROM = 16;      // none of the base codes is reported under 16 minutes
const ADD_ON_FROM = 38;    // derived, see header
const ADD_ON_STEP = 15;
const NEUROBEHAVIORAL = Object.freeze({ code: '96116', from: 31 });  // derived, see header

const CODES = Object.freeze([ASSESSMENT, ...Object.values(INTERVENTIONS).flatMap(x => [x.base, x.addOn]), NEUROBEHAVIORAL.code]);

// kind: 'assessment' | 'individual' | 'group' | 'family' | 'neurobehavioral'.
const select = (input = {}) => {
  const kind = input.kind;
  if (kind === 'assessment') return chosen(FAMILY, [{ code: ASSESSMENT, units: 1 }], 'A health behavior assessment. It carries no time unit.');
  const minutes = num(input.minutes);
  if (kind === 'neurobehavioral') {
    if (minutes == null || minutes < NEUROBEHAVIORAL.from) return none(FAMILY, `The neurobehavioral status exam's first hour is not reached under ${NEUROBEHAVIORAL.from} minutes.`);
    return chosen(FAMILY, [{ code: NEUROBEHAVIORAL.code, units: 1 }], `${minutes} minutes of neurobehavioral status exam: the first hour.`);
  }
  const iv = INTERVENTIONS[kind];
  if (!iv) return none(FAMILY, 'Say whether this was an assessment, or an individual, group or family intervention.');
  if (minutes == null) return none(FAMILY, 'No intervention time is recorded.');
  if (minutes < BASE_FROM) return none(FAMILY, `A health behavior intervention is not reported under ${BASE_FROM} minutes; ${minutes} are recorded.`);
  const units = addOnUnits(minutes, ADD_ON_FROM, ADD_ON_STEP);
  const nextAt = minutes < ADD_ON_FROM ? ADD_ON_FROM : ADD_ON_FROM + units * ADD_ON_STEP;
  return chosen(FAMILY, [{ code: iv.base, units: 1 }, ...(units ? [{ code: iv.addOn, units }] : [])],
    `${minutes} minutes of ${kind} health behavior intervention: ${iv.base}${units ? ` and ${iv.addOn} × ${units}` : ''}.`,
    { reviewFlag: nearNext({ minutes, chosenCode: units ? iv.addOn : iv.base, nextCode: iv.addOn, nextAt, what: 'intervention time' }) });
};

const FIELDS = Object.freeze([
  { key: 'kind', label: 'Service', type: 'select', options: [['assessment', 'Health behavior assessment'], ['individual', 'Intervention, individual'], ['group', 'Intervention, group'], ['family', 'Intervention, family with the patient'], ['neurobehavioral', 'Neurobehavioral status exam']] },
  { key: 'minutes', label: 'Minutes', type: 'number', when: { kind: ['individual', 'group', 'family', 'neurobehavioral'] } }
]);

module.exports = { FAMILY, FIELDS, label: 'Health behavior and neurobehavioral', ...PROVENANCE, verifiedAgainst, catalogActive: true,
  ASSESSMENT, INTERVENTIONS, BASE_FROM, ADD_ON_FROM, ADD_ON_STEP, NEUROBEHAVIORAL, CODES, select };
