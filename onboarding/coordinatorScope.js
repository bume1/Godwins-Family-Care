// ============================================================================
// CLINICAL SCOPE, FOR A CARE COORDINATOR (owner, 2026-11-09)
// ============================================================================
// A coordinator supports every kind of clinician GFC employs, so their
// onboarding says what each one may do, and what the coordinator never does.
// Every line is BUILT from clinicalRoles.ROLE_CAPABILITIES, the allow-list the
// app enforces, so the onboarding cannot tell a coordinator something the app
// does not do. Only the plain-English wording lives here.
// ============================================================================

'use strict';

const CR = require('../clinicalRoles');

// The capabilities that tell the roles apart, in the order they are read,
// each in words a coordinator uses. A capability left out here is one every
// clinical role shares (reading the chart) or a back-office one.
const WORDS = Object.freeze([
  ['prescribe', 'prescribes'],
  ['orderDirect', 'places orders on their own authority'],
  ['orderStanding', 'places orders under a signed standing order'],
  ['authorStandingOrder', 'writes and signs standing orders'],
  ['selectServiceCodes', 'chooses billing codes'],
  ['signBillableEncounter', 'signs billable visits'],
  ['acknowledgeAbnormalResult', 'signs off abnormal results'],
  ['carePlanSign', 'signs care plans'],
  ['medRec', 'reconciles medications'],
  ['problemListWrite', 'edits the problem list'],
  ['behavioralDiagnosis', 'adds mental health diagnoses'],
  ['nursingNote', 'writes nursing notes'],
  ['behavioralNote', 'writes behavioural health notes'],
  ['vitalsWrite', 'records vitals'],
  ['screeningInstrument', 'runs screenings (PHQ-9, GAD-7, social needs)'],
  ['carePlanAuthor', 'drafts care plans'],
  ['referExternal', 'refers out to other practices'],
  ['referInternal', 'refers within the GFC team'],
  ['referralCoordination', 'works referrals through (fax, schedule, consult note)'],
  ['documentUpload', 'files documents'],
  ['scheduling', 'schedules visits']
]);

const ROLES = Object.freeze([
  ['provider', 'Provider (FNP, MD, PA)'],
  ['rn', 'Registered nurse (RN)'],
  ['lcsw', 'LCSW (clinical social worker)'],
  ['lmsw', 'LMSW (case manager)']
]);

const has = (role, cap) => (CR.ROLE_CAPABILITIES[role] || []).includes(cap);
const sentence = (list) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

// One line per clinical role: who they are, and what they may do.
function scopeLines() {
  return ROLES.map(([role, label]) => {
    const caps = WORDS.filter(([c]) => has(role, c)).map(([, w]) => w);
    const author = (CR.AUTHOR_SIGNER_ROLES || []).includes(role) ? '. Their signature authors a note; a provider\'s or LCSW\'s addendum makes it billable' : '';
    return `${label}: ${sentence(caps)}${author}.`;
  });
}

// What a coordinator does, and the clinical acts they never do.
function coordinatorDoes() {
  return WORDS.filter(([c]) => has('coordinator', c)).map(([, w]) => w);
}
function coordinatorNever() {
  return WORDS.filter(([c]) => !has('coordinator', c) && ROLES.some(([r]) => has(r, c))).map(([, w]) => w);
}

module.exports = { WORDS, ROLES, sentence, scopeLines, coordinatorDoes, coordinatorNever };
