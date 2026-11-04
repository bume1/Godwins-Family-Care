'use strict';
// serviceRules — Phase 3b: service selection for the codes that are not
// level-based (AI coding pipeline spec, 2026-11-04). One file per family; the
// thresholds live in each file and nowhere else (build-enforced). Each file
// carries verified, verifiedOn, verifiedAgainst and nextReviewDue.
//
// Nursing facility codes 99304-99310 are loaded inactive and have no file: if
// they are activated, they are added to emLevels.js, never a second table.
const FAMILIES = Object.freeze([
  require('./psychotherapy'), require('./healthBehavior'), require('./advanceCarePlanning'), require('./annualWellness'),
  require('./transitionalCare'), require('./chronicCare'), require('./behavioralIntegration'), require('./remoteMonitoring')
]);
const byFamily = (key) => FAMILIES.find(f => f.FAMILY === key) || null;
const select = (family, input) => {
  const f = byFamily(family);
  if (!f) return { error: `There is no selection rule for "${family}".`, code: 'SERVICE_FAMILY_UNKNOWN', families: FAMILIES.map(x => x.FAMILY) };
  return f.select(input || {});
};
// The codes each family names, for the catalog check (active ones only).
const ruleLists = () => FAMILIES.map(f => ({
  file: `serviceRules/${f.FAMILY}`, list: 'CODES',
  codes: f.CODES.filter(c => !(f.catalogInactiveCodes || []).includes(c))
}));
const reviewStatus = (today) => FAMILIES.map(f => ({ family: f.FAMILY, verifiedOn: f.verifiedOn, nextReviewDue: f.nextReviewDue, overdue: String(today) >= f.nextReviewDue }));
module.exports = { FAMILIES, byFamily, select, ruleLists, reviewStatus };
