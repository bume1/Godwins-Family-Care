// ============================================================================
// PRIVILEGING
// Per Part 3.1 of GFC_Clinical_Onboarding_Playbook_v1.md: "GFC has no
// privileging process today. This is it."
// ============================================================================
// THE RULE, and it is the only rule that matters here:
//
//   Her privileges mirror the service allowances in her protocol agreement. The
//   agreement is written to full practitioner scope. PRIVILEGES CAN BE NARROWER
//   THAN THE AGREEMENT BUT NEVER BROADER. If the agreement does not allow it,
//   the app will not let anyone grant it.
//
// So `grant` is not a free decision. A privilege is grantable only when the
// agreement's mapped allowances carry it, and `narrow()` refuses to widen —
// build-enforced, because a privilege granted beyond the agreement is a claim
// GFC cannot defend and the signature on it belongs to a physician who never
// agreed to it.
//
// DEFAULT IS THE FULL SCOPE OF HER AGREEMENT unless the Clinical Director or the
// supervising physician narrows a specific item WITH A REASON RECORDED. A
// narrowing with no reason is a decision nobody can explain at a review.
//
// ⚠️ ENFORCEMENT IS NOT WIRED IN THIS CHANGE, DELIBERATELY, AND THE REASON IS
// RECORDED HERE SO NOBODY READS IT AS AN OVERSIGHT. `capabilityMap()` returns
// the app capabilities a privilege list implies, and clinicalRoles.can() is the
// single place all 28 capability checks in the app funnel through, so switching
// it on is one intersection in one function. What it needs first is the owner's
// answer to one question: a clinician with no privilege list yet would be
// refused on the day it ships. Every existing clinician is in that position.
// Defaulting closed takes prescribing away from the people doing the work; the
// recommendation on the record is to default OPEN for anyone already working,
// closed for anyone added afterwards, with a banner naming who still needs a
// list signed. That is an access-control decision, not a build detail.
// ============================================================================

'use strict';

// ---- CATEGORIES (playbook 3.1) --------------------------------------------
// The protocol agreement template should list its allowances in these same
// categories so the app maps them one to one. It does not yet (playbook 3.5
// item 1), so `mapAgreement` takes the mapping a person records rather than
// parsing a document — the app never guesses what an agreement allows.
const CATEGORIES = Object.freeze([
  { id: 'settings', title: 'Settings',
    privileges: [
      { id: 'setting_home', title: 'Home' },
      { id: 'setting_clinic', title: 'Clinic' },
      { id: 'setting_facility', title: 'Facility (ALF, personal care home)' },
      { id: 'setting_telehealth', title: 'Telehealth' }
    ] },
  { id: 'populations', title: 'Populations',
    privileges: [
      { id: 'pop_adult', title: 'Adult' },
      { id: 'pop_geriatric', title: 'Geriatric' },
      { id: 'pop_pediatric', title: 'Pediatric', requiresAddon: 'FNP' },
      { id: 'pop_psychiatric', title: 'Psychiatric', requiresAddon: 'PMHNP' }
    ] },
  { id: 'assessment', title: 'Assessment',
    privileges: [
      { id: 'asmt_hp', title: 'History and physical' },
      { id: 'asmt_awv', title: 'Annual Wellness Visit' },
      { id: 'asmt_cognitive', title: 'Cognitive screening' },
      { id: 'asmt_functional', title: 'Functional assessment' }
    ] },
  { id: 'diagnostics', title: 'Diagnostics',
    privileges: [
      { id: 'dx_labs', title: 'Order and interpret labs' },
      { id: 'dx_imaging', title: 'Order and interpret imaging' },
      { id: 'dx_ekg', title: 'Order and interpret EKG' },
      { id: 'dx_poct', title: 'Point-of-care testing performed' }
    ] },
  { id: 'prescribing', title: 'Prescribing',
    privileges: [
      { id: 'rx_noncontrolled', title: 'Non-controlled medication', requiresAddon: 'PRESCRIBES' },
      { id: 'rx_controlled_3_5', title: 'Controlled, Schedules III to V', requiresAddon: 'CONTROLLED' },
      { id: 'rx_dme', title: 'Durable medical equipment and home health orders' }
    ] },
  { id: 'procedures', title: 'Procedures',
    privileges: [
      { id: 'proc_wound', title: 'Wound care' },
      { id: 'proc_ind', title: 'Incision and drainage' },
      { id: 'proc_suture', title: 'Suturing' },
      { id: 'proc_specimen', title: 'Specimen collection' },
      // Listed and marked not granted (playbook 3.1). Listed ON PURPOSE: a
      // privilege absent from the list reads as an oversight, while one listed
      // and withheld is a decision somebody made.
      { id: 'proc_joint_injection', title: 'Joint injections', defaultNotGranted: true }
    ] },
  { id: 'care_management', title: 'Care management',
    privileges: [
      { id: 'cm_ccm', title: 'Chronic care management' },
      { id: 'cm_apcm', title: 'Advanced primary care management' },
      { id: 'cm_rpm', title: 'Remote patient monitoring' },
      { id: 'cm_tcm', title: 'Transitional care management' },
      { id: 'cm_bhi', title: 'Behavioral health integration' }
    ] },
  { id: 'psychiatric', title: 'Psychiatric', requiresAddon: 'PMHNP',
    privileges: [
      { id: 'psy_eval', title: 'Psychiatric evaluation' },
      { id: 'psy_medmgmt', title: 'Medication management' },
      { id: 'psy_psychotherapy', title: 'Psychotherapy' },
      { id: 'psy_crisis', title: 'Crisis assessment' }
    ] },
  { id: 'exams', title: 'Exams', requiresLane: 'EXAMS',
    privileges: [
      // By exam type the contractor allows NPs to perform. The types come from
      // the contractor record, never from a list in here.
      { id: 'exam_by_type', title: 'By exam type', perExamType: true }
    ] },
  { id: 'referrals', title: 'Referrals and coordination',
    privileges: [
      { id: 'ref_specialist', title: 'Specialist referral' },
      { id: 'ref_hospice', title: 'Hospice certification where allowed' },
      { id: 'ref_home_health', title: 'Home health certification where allowed' }
    ] }
].map(Object.freeze));

const ALL_PRIVILEGES = Object.freeze([].concat(
  ...CATEGORIES.map(c => c.privileges.map(p => Object.freeze(
    Object.assign({}, p, { category: c.id, categoryTitle: c.title,
      requiresAddon: p.requiresAddon || c.requiresAddon || null,
      requiresLane: p.requiresLane || c.requiresLane || null })
  )))
));

const findPrivilege = (id) => ALL_PRIVILEGES.find(p => p.id === String(id || '')) || null;

const STATUS = Object.freeze({
  NOT_IN_AGREEMENT: 'not_in_agreement', // the agreement does not allow it: ungrantable
  GRANTED: 'granted',
  NARROWED: 'narrowed'                  // allowed by the agreement, withheld with a reason
});

/**
 * Which privileges this person's inputs could ever reach, before the agreement
 * is even consulted. A psych privilege on a clinician with no PMHNP add-on is
 * not a narrowing decision; it is not applicable.
 */
function applicablePrivileges(inputs) {
  const lanes = (inputs && inputs.lanes) || [];
  const addons = (inputs && inputs.addons) || [];
  return ALL_PRIVILEGES.filter(p => {
    if (p.requiresAddon && !addons.includes(p.requiresAddon)) return false;
    if (p.requiresLane && !lanes.includes(p.requiresLane)) return false;
    return true;
  });
}

/**
 * Step 1 and 2 of the workflow: the agreement's allowances are recorded, and the
 * privilege list is generated AT FULL AGREEMENT SCOPE.
 *
 * `allowances` is the list of privilege ids the agreement allows, recorded by
 * whoever mapped the document. Nothing here reads a PDF: the app does not guess
 * what a protocol agreement permits, and a wrong guess here is a privilege
 * granted that no physician agreed to.
 */
function generateList({ inputs, allowances, agreement } = {}) {
  const allowed = new Set((allowances || []).map(String));
  const rows = applicablePrivileges(inputs).map(p => ({
    id: p.id, title: p.title, category: p.category, categoryTitle: p.categoryTitle,
    inAgreement: allowed.has(p.id),
    // Default: the full scope of her agreement, except the ones the playbook
    // itself marks withheld by default.
    status: !allowed.has(p.id) ? STATUS.NOT_IN_AGREEMENT
      : (p.defaultNotGranted ? STATUS.NARROWED : STATUS.GRANTED),
    reason: (allowed.has(p.id) && p.defaultNotGranted)
      ? 'Withheld by default. Grant it deliberately if the agreement covers it.' : null,
    perExamType: !!p.perExamType, examTypes: []
  }));
  return {
    agreement: agreement || null,
    rows,
    generatedAt: new Date().toISOString(),
    reviewedAt: null, reviewedBy: null,
    coSignedAt: null, coSignedBy: null
  };
}

/**
 * Narrow one privilege, with a reason.
 *
 * REFUSES TO WIDEN. Granting something the agreement does not carry is the one
 * thing this module exists to make impossible, so it is refused by name rather
 * than silently ignored — a silent refusal would leave somebody believing they
 * had granted it.
 */
function applyDecision(list, { privilegeId, status, reason, by, byName }) {
  const rows = (list && list.rows) || [];
  const idx = rows.findIndex(r => r.id === String(privilegeId || ''));
  if (idx < 0) {
    return { ok: false, code: 'PRIVILEGE_UNKNOWN',
      error: 'That is not a privilege on this list.' };
  }
  const row = rows[idx];
  if (!row.inAgreement) {
    return { ok: false, code: 'PRIVILEGE_NOT_IN_AGREEMENT',
      error: `${row.title} is not allowed by the protocol agreement, so it cannot be granted. Amend the agreement first.` };
  }
  if (status !== STATUS.GRANTED && status !== STATUS.NARROWED) {
    return { ok: false, code: 'PRIVILEGE_STATUS_INVALID',
      error: 'A privilege is either granted or narrowed.' };
  }
  if (status === STATUS.NARROWED && !String(reason || '').trim()) {
    return { ok: false, code: 'PRIVILEGE_REASON_REQUIRED',
      error: `Say why ${row.title} is being withheld. A narrowing with no reason cannot be explained at a review.` };
  }
  const next = rows.slice();
  next[idx] = Object.assign({}, row, {
    status,
    reason: status === STATUS.NARROWED ? String(reason).trim() : null,
    decidedAt: new Date().toISOString(),
    decidedBy: by || null, decidedByName: byName || null
  });
  return { ok: true, list: Object.assign({}, list, { rows: next }) };
}

/**
 * Step 8: an amendment to the agreement flags her privileges for review
 * AUTOMATICALLY. Re-privileging every 3 years, and whenever the agreement
 * changes, because the agreement is what the privileges mirror.
 */
function needsReview(list, { agreementVersion, today } = {}) {
  if (!list) return { review: false, reason: null };
  if (!list.coSignedAt) return { review: true, reason: 'never_co_signed' };
  const signedAgainst = (list.agreement && list.agreement.version) || null;
  if (agreementVersion && signedAgainst && agreementVersion !== signedAgainst) {
    return { review: true, reason: 'agreement_amended' };
  }
  const now = String(today || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const due = new Date(Date.parse(`${String(list.coSignedAt).slice(0, 10)}T12:00:00Z`)
    + 1095 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (now > due) return { review: true, reason: 'three_years_elapsed', dueAt: due };
  return { review: false, reason: null, dueAt: due };
}

/**
 * Focused review (step 6): the first 30 days, or the first 10 encounters per
 * NEW privilege. The exam lane is the first 5 reports.
 */
const FOCUSED_REVIEW = Object.freeze({
  days: 30, encountersPerPrivilege: 10, examReports: 5
});

/**
 * The app capabilities a privilege list implies.
 *
 * This is the bridge to clinicalRoles.js's capability matrix and is returned for
 * display and for the follow-up that switches enforcement on. It is NOT consulted
 * by any permission check today — see the note at the top of this file.
 */
const CAPABILITY_FOR_PRIVILEGE = Object.freeze({
  rx_noncontrolled: ['prescribe'],
  rx_controlled_3_5: ['prescribe'],
  dx_labs: ['orderDirect'],
  dx_imaging: ['orderDirect'],
  rx_dme: ['orderDirect'],
  psy_eval: ['behavioralNote', 'behavioralDiagnosis'],
  psy_medmgmt: ['prescribe'],
  psy_psychotherapy: ['behavioralNote'],
  asmt_hp: ['nursingNote'],
  ref_specialist: ['referExternal']
});

function capabilityMap(list) {
  const granted = ((list && list.rows) || []).filter(r => r.status === STATUS.GRANTED);
  const caps = new Set();
  granted.forEach(r => (CAPABILITY_FOR_PRIVILEGE[r.id] || []).forEach(c => caps.add(c)));
  return Array.from(caps).sort();
}

function buildPrivileges({ inputs, list, agreementVersion, today } = {}) {
  const applicable = applicablePrivileges(inputs);
  if (!list) {
    return {
      exists: false, rows: [], byCategory: [],
      review: { review: true, reason: 'not_generated' },
      counts: { applicable: applicable.length, granted: 0, narrowed: 0, notInAgreement: 0 },
      capabilities: [], focusedReview: FOCUSED_REVIEW,
      message: 'No privilege list yet. Record the protocol agreement’s allowances to generate one.'
    };
  }
  const rows = list.rows || [];
  const byCategory = CATEGORIES.map(c => ({
    id: c.id, title: c.title,
    rows: rows.filter(r => r.category === c.id)
  })).filter(g => g.rows.length);
  return {
    exists: true, rows, byCategory,
    agreement: list.agreement || null,
    reviewedAt: list.reviewedAt || null, reviewedBy: list.reviewedBy || null,
    coSignedAt: list.coSignedAt || null, coSignedBy: list.coSignedBy || null,
    review: needsReview(list, { agreementVersion, today }),
    counts: {
      applicable: applicable.length,
      granted: rows.filter(r => r.status === STATUS.GRANTED).length,
      narrowed: rows.filter(r => r.status === STATUS.NARROWED).length,
      notInAgreement: rows.filter(r => r.status === STATUS.NOT_IN_AGREEMENT).length
    },
    capabilities: capabilityMap(list),
    focusedReview: FOCUSED_REVIEW
  };
}

module.exports = {
  CATEGORIES, ALL_PRIVILEGES, STATUS, FOCUSED_REVIEW, CAPABILITY_FOR_PRIVILEGE,
  findPrivilege, applicablePrivileges, generateList, applyDecision,
  needsReview, capabilityMap, buildPrivileges
};
