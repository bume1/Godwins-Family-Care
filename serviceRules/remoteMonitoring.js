'use strict';
// serviceRules/remoteMonitoring.js — remote patient monitoring and remote
// therapeutic monitoring (spec 3b.3).
//
// SOURCES (3b.6):
//   CY2026 PFS final rule (including 99445, 99470, 98985 and 98979):
//     https://www.federalregister.gov/documents/2025/11/05/2025-19787/medicare-and-medicaid-programs-cy-2026-payment-policies-under-the-physician-fee-schedule-and-other
//   Code validity for 2026: CMS PPRRVU2026 October non-QPP file.
// RPM: 99453 one-time setup and education. Device supply 99454 for 16 to 30
// days of readings in a 30-day period, or 99445 for 2 to 15. Management time
// per calendar month: 99470 for 10 to 19 minutes, 99457 for the first 20,
// +99458 each additional 20. RTM has the same shape and is LOADED INACTIVE in
// OpenEMR, so its codes are not checked against the live catalog (rtm.catalogActive).
const { PROVENANCE, num, chosen, none, nearNext, addOnUnits } = require('./common');

const FAMILY = 'remote_monitoring';
const verifiedAgainst = Object.freeze([
  'https://www.federalregister.gov/documents/2025/11/05/2025-19787/medicare-and-medicaid-programs-cy-2026-payment-policies-under-the-physician-fee-schedule-and-other',
  'CMS PPRRVU2026 October non-QPP'
]);
const RPM = Object.freeze({
  setup: '99453',
  supply: Object.freeze({ full: '99454', fullFrom: 16, fullTo: 30, short: '99445', shortFrom: 2, shortTo: 15 }),
  management: Object.freeze({ brief: '99470', briefFrom: 10, base: '99457', baseFrom: 20, addOn: '99458', step: 20 })
});
const RTM = Object.freeze({
  setup: '98975',
  supply: Object.freeze({
    respiratory: Object.freeze({ full: '98976' }),
    musculoskeletal: Object.freeze({ full: '98977', short: '98985' }),
    cbt: Object.freeze({ full: '98978' })
  }),
  management: Object.freeze({ brief: '98979', base: '98980', addOn: '98981' })
});
const RPM_CODES = Object.freeze([RPM.setup, RPM.supply.full, RPM.supply.short, RPM.management.brief, RPM.management.base, RPM.management.addOn]);
const RTM_CODES = Object.freeze([RTM.setup, RTM.supply.respiratory.full, RTM.supply.musculoskeletal.full, RTM.supply.musculoskeletal.short, RTM.supply.cbt.full, RTM.management.brief, RTM.management.base, RTM.management.addOn]);
const CODES = Object.freeze([...RPM_CODES, ...RTM_CODES]);

// The same day and minute shape for both; RTM borrows RPM's numbers.
const supplyCode = (days, codes) => {
  const s = RPM.supply;
  if (days >= s.fullFrom && days <= s.fullTo) return codes.full || null;
  if (days >= s.shortFrom && days <= s.shortTo) return codes.short || null;
  return null;
};
const managementCodes = (minutes, codes) => {
  const m = RPM.management;
  if (minutes < m.briefFrom) return { codes: [], nextAt: m.briefFrom, nextCode: codes.brief, chosenCode: null };
  if (minutes < m.baseFrom) return { codes: [{ code: codes.brief, units: 1 }], nextAt: m.baseFrom, nextCode: codes.base, chosenCode: codes.brief };
  const units = addOnUnits(minutes, m.baseFrom + m.step, m.step);
  return { codes: [{ code: codes.base, units: 1 }, ...(units ? [{ code: codes.addOn, units }] : [])], nextAt: m.baseFrom + m.step + units * m.step, nextCode: codes.addOn, chosenCode: units ? codes.addOn : codes.base };
};

// kind: 'rpm' | 'rtm'. part: 'setup' | 'supply' ({ days, device for rtm }) | 'management' ({ minutes }).
const select = (input = {}) => {
  const rtm = input.kind === 'rtm';
  const T = rtm ? RTM : RPM;
  const prefix = rtm ? 'Remote therapeutic monitoring (inactive in OpenEMR)' : 'Remote patient monitoring';
  if (input.part === 'setup') return chosen(FAMILY, [{ code: T.setup, units: 1 }], `${prefix}: setup and education, once.`);
  if (input.part === 'supply') {
    const days = num(input.days);
    const codes = rtm ? (RTM.supply[input.device] || null) : RPM.supply;
    if (!codes) return none(FAMILY, 'Say which device: respiratory, musculoskeletal or cognitive behavioral therapy.');
    if (days == null) return none(FAMILY, 'No days of readings are recorded for the 30-day period.');
    const code = supplyCode(days, codes);
    return code ? chosen(FAMILY, [{ code, units: 1 }], `${prefix}: ${days} days of readings in the 30-day period, ${code}.`) : none(FAMILY, `${prefix}: ${days} days of readings has no device supply code for this device.`);
  }
  if (input.part === 'management') {
    const minutes = num(input.minutes);
    if (minutes == null) return none(FAMILY, 'No management time is recorded for the month.');
    const r = managementCodes(minutes, T.management);
    const flag = nearNext({ minutes, chosenCode: r.chosenCode, nextCode: r.nextCode, nextAt: r.nextAt, what: 'management time' });
    return r.codes.length
      ? chosen(FAMILY, r.codes, `${prefix}: ${minutes} minutes of management in the month, ${r.codes.map(c => (c.units > 1 ? `${c.code} × ${c.units}` : c.code)).join(' and ')}.`, { reviewFlag: flag })
      : none(FAMILY, `${prefix}: ${minutes} minutes of management does not reach ${T.management.brief}.`, { reviewFlag: flag });
  }
  return none(FAMILY, 'Say whether this is setup, device supply or management time.');
};

const FIELDS = Object.freeze([
  { key: 'kind', label: 'Program', type: 'select', options: [['rpm', 'Remote patient monitoring'], ['rtm', 'Remote therapeutic monitoring (inactive)']] },
  { key: 'part', label: 'What', type: 'select', options: [['setup', 'Setup and education'], ['supply', 'Device supply'], ['management', 'Management time']] },
  { key: 'device', label: 'Device', type: 'select', options: [['respiratory', 'Respiratory'], ['musculoskeletal', 'Musculoskeletal'], ['cbt', 'Cognitive behavioral therapy']], when: { kind: ['rtm'], part: ['supply'] } },
  { key: 'days', label: 'Days of readings in the 30-day period', type: 'number', when: { part: ['supply'] } },
  { key: 'minutes', label: 'Management minutes this month', type: 'number', when: { part: ['management'] } }
]);

module.exports = { FAMILY, FIELDS, label: 'Remote patient and therapeutic monitoring', ...PROVENANCE, verifiedAgainst,
  // RPM is active in OpenEMR; RTM is loaded inactive (spec 3b.3).
  catalogActive: true, catalogInactiveCodes: RTM_CODES,
  RPM, RTM, RPM_CODES, RTM_CODES, CODES, select };
