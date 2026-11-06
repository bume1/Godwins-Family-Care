// ============================================================================
// THE RESOURCE MAP — every document the wizard points at
// Per docs/GFC_Wizard_Resource_Map_v1.md (owner-authored, re-checked 2026-11-06)
// ============================================================================
// SIX RULES, all of them the owner's, all of them load-bearing:
//
// 1. THE WIZARD STORES THE DRIVE LINK, NEVER A COPY OF THE FILE. Edit the Google
//    Doc and the wizard shows the new text next time somebody opens it. A copy
//    would be a second version of a policy document, silently stale.
// 2. SIGNING HAPPENS IN THE APP, NOT IN THE GOOGLE DOC. She opens the document
//    from here, then signs on the wizard screen.
// 3. EVERY SIGNATURE RECORDS THE VERSION IT WAS SIGNED AGAINST: the version
//    label plus Drive's modified time at the moment of signing. A signature with
//    no version is a signature on an unknown document.
// 4. BUMPING A VERSION LABEL RE-PROMPTS EVERYONE WHO SIGNED THE OLDER ONE.
//    Typo fixes do not change the label, so nobody is re-prompted for those —
//    that distinction is the whole reason the label is manual.
// 5. CONTRACTOR-SPECIFIC RESOURCES CARRY A `contractor` TAG and show only when
//    that contractor is assigned. Contractor names live in resource records and
//    in Drive, NEVER in the playbook text or the item library.
// 6. A LINK THAT FAILS TO OPEN NEVER BLOCKS THE WIZARD. It reads "Ask Bianca or
//    Kate for access" and is flagged on the Admin Hub. A policy document nobody
//    shared yet is an access problem, and stopping onboarding over it would
//    strand her on a screen she cannot pass.
// ============================================================================

'use strict';

const ACTIONS = Object.freeze({
  READ: 'READ', ACKNOWLEDGE: 'ACKNOWLEDGE', SIGN: 'SIGN',
  ATTEST_WITH_CHECKS: 'ATTEST_WITH_CHECKS', UPLOAD_CERTIFICATE: 'UPLOAD_CERTIFICATE',
  COMPLETE_EXTERNAL: 'COMPLETE_EXTERNAL', REFERENCE: 'REFERENCE'
});
const ACTION_LABELS = Object.freeze({
  READ: 'Read it', ACKNOWLEDGE: 'Read and acknowledge', SIGN: 'Read and sign',
  ATTEST_WITH_CHECKS: 'Read, answer the questions, attest',
  UPLOAD_CERTIFICATE: 'Complete it, then upload the certificate',
  COMPLETE_EXTERNAL: 'Complete it outside the app, then upload it',
  REFERENCE: 'Reference'
});

const STEPS = Object.freeze({
  WELCOME: 'WELCOME', CORE_PAPERWORK: 'CORE_PAPERWORK', TRAINING: 'TRAINING',
  EXAMS: 'EXAMS', REFERENCE_SHELF: 'REFERENCE_SHELF'
});
const STEP_ORDER = Object.freeze(['WELCOME', 'CORE_PAPERWORK', 'TRAINING', 'EXAMS', 'REFERENCE_SHELF']);
const STEP_TITLES = Object.freeze({
  WELCOME: 'Welcome',
  CORE_PAPERWORK: 'Your paperwork',
  TRAINING: 'Training',
  EXAMS: 'Exams',
  REFERENCE_SHELF: 'Reference shelf'
});

// A resource with no URL is DECLARED AND UNAVAILABLE, never omitted. The
// Clinical SOPs are not in Drive yet; hiding the row would hide the gap, and
// CLIN-16 depends on it.
const RESOURCES = Object.freeze([
  { id: 'RES-01', title: 'Team Onboarding Deck', fileType: 'HTML', version: '2026-11',
    url: 'https://drive.google.com/file/d/1A2HQ4BlUUxjTkX7hVysT1iERuZv96jt1/view',
    action: ACTIONS.READ, step: STEPS.WELCOME, module: 'TRN-001', required: true, audience: {} },
  { id: 'RES-02', title: 'Team Roles and Responsibilities', fileType: 'PDF', version: 'v2',
    url: 'https://drive.google.com/file/d/1Z6v89NQvbcY7yBmixo8hw-LIPQ3YE5yc/view',
    action: ACTIONS.ACKNOWLEDGE, step: STEPS.WELCOME, playbookItem: 'CORE-13',
    module: 'TRN-002', required: true, audience: {} },
  { id: 'RES-03', title: 'Employee Handbook', fileType: 'GDOC', version: 'v2.0',
    url: 'https://docs.google.com/document/d/1ZOdrECrlD1C7k5byIyE77K5XFT7fypz3bEnBbvHV-eU/view',
    action: ACTIONS.READ, step: STEPS.CORE_PAPERWORK, playbookItem: 'CORE-12',
    required: true, audience: { relationship: ['W2', 'HYBRID'] } },
  { id: 'RES-04', title: 'Employee Handbook Acknowledgment', fileType: 'GDOC', version: 'v2.0',
    url: 'https://docs.google.com/document/d/1ZAg8Ki1oRVHKLMp7dPyGM8rs41I_4slHZLLw1czoHVk/view',
    action: ACTIONS.SIGN, step: STEPS.CORE_PAPERWORK, playbookItem: 'CORE-12',
    pairsWith: 'RES-03', required: true, audience: { relationship: ['W2', 'HYBRID'] } },
  { id: 'RES-05', title: 'Staff Code of Conduct', fileType: 'GDOC', version: 'v2.0',
    url: 'https://docs.google.com/document/d/1LPwApafMaKYwe37JVYV95GUo-QgOFkCv4vEFVQwPNnA/view',
    action: ACTIONS.SIGN, step: STEPS.CORE_PAPERWORK, playbookItem: 'CORE-11',
    required: true, audience: {} },
  { id: 'RES-06', title: 'Field Addendum to the Staff Code of Conduct', fileType: 'GDOC', version: 'v1.0',
    url: 'https://docs.google.com/document/d/1E_AbrZWagGWYyGgerji3Sf5-zEBXUf5G_Rbl9kRQ9Hs/view',
    action: ACTIONS.SIGN, step: STEPS.CORE_PAPERWORK, playbookItem: 'CORE-11',
    required: true, audience: { field: true } },
  { id: 'RES-07', title: 'HIPAA and Confidentiality Training Acknowledgment', fileType: 'GDOC', version: 'v2.0',
    url: 'https://docs.google.com/document/d/1hHrVZalxuGVqmM53yL0aV8sS2MGkt4fMNp0qyLYhCGY/view',
    action: ACTIONS.SIGN, step: STEPS.TRAINING, playbookItem: 'CORE-14',
    module: 'TRN-005', unlocksAfter: ['TRN-005'], required: true, audience: {} },
  { id: 'RES-08', title: 'Clinical Policies and Procedures (IHPPC)', fileType: 'DOCX', version: 'v2.0',
    url: 'https://drive.google.com/file/d/1R9PhvBNaqmebOKKm_i6kPbGd5DK0OAVU/view',
    action: ACTIONS.ATTEST_WITH_CHECKS, countersign: 'CLINICAL_DIRECTOR',
    step: STEPS.TRAINING, playbookItem: 'CLIN-17', module: 'TRN-006',
    required: true, audience: {},
    note: 'Still a .docx. Convert it to a Google Doc so the link shows the current text.' },
  { id: 'RES-09', title: 'Clinical SOPs, Set 1', fileType: 'GDOC', version: 'v1.0',
    url: null, action: ACTIONS.ATTEST_WITH_CHECKS, countersign: 'CLINICAL_DIRECTOR',
    step: STEPS.TRAINING, playbookItem: 'CLIN-16', required: true, audience: {},
    note: 'Not in Drive yet. The eight SOPs are written; the file needs uploading and this link filling in.' },
  { id: 'RES-20', title: 'Provider screening application', fileType: 'PDF', version: 'blank',
    url: 'https://drive.google.com/file/d/1T6KdyfsHwEqClVwG8hc1v3__LntRdYt2/view',
    action: ACTIONS.COMPLETE_EXTERNAL, step: STEPS.EXAMS, playbookItem: 'EXM-02',
    required: true, audience: { lanes: ['EXAMS'], contractors: ['VES'] } },
  { id: 'RES-21', title: 'Network Examiner Handbook', fileType: 'PDF', version: 'current',
    url: 'https://drive.google.com/file/d/1QGB8dvQdJaZS7EJcSBakYVJjEpWoBhfn/view',
    action: ACTIONS.READ, step: STEPS.EXAMS, playbookItem: 'EXM-05',
    required: true, audience: { lanes: ['EXAMS'], contractors: ['LSGS'] } },
  { id: 'RES-22', title: 'SOP: Abnormal Findings', fileType: 'PDF', version: 'current',
    url: 'https://drive.google.com/file/d/1iONq4GwTKaMBxPffVSqhWOBWw3T4pu53/view',
    action: ACTIONS.ATTEST_WITH_CHECKS, step: STEPS.EXAMS, module: 'TRN-105',
    required: true, audience: { lanes: ['EXAMS'] } },
  { id: 'RES-23', title: 'Attachment M: Rules for Diagnostic and Ancillary Tests',
    fileType: 'PDF', version: 'current',
    url: 'https://drive.google.com/file/d/1EW0mTsLcuITnoAwxHfK7Vt8X0Npkn2Ow/view',
    action: ACTIONS.READ, step: STEPS.EXAMS, module: 'TRN-104',
    required: true, audience: { lanes: ['EXAMS'] } },
  { id: 'RES-24', title: 'Ancillary Item Purchase Links', fileType: 'PDF', version: 'current',
    url: 'https://drive.google.com/file/d/1Q8cWNBRMXow3oPI2qvvuP68PgIVMSyeb/view',
    action: ACTIONS.REFERENCE, step: STEPS.EXAMS, module: 'TRN-104',
    required: false, audience: { lanes: ['EXAMS'] } },
  { id: 'RES-30', title: 'GFC Team README (Start Here)', fileType: 'GDOC', version: '2026-11-06',
    url: 'https://docs.google.com/document/d/1BrANo-fKoY2tW_8dDDjR9ykUddsp1spCQcrn3yFJrIk/view',
    action: ACTIONS.REFERENCE, step: STEPS.REFERENCE_SHELF, required: false,
    audience: {}, pinned: true },
  { id: 'RES-31', title: 'Regulatory Compliance Reference', fileType: 'GDOC', version: '2026-08',
    url: 'https://docs.google.com/document/d/1jJQSsrs1rEoEcNRNghINouwAZGct2hrjLM-betf7Du8/view',
    action: ACTIONS.REFERENCE, step: STEPS.REFERENCE_SHELF, required: false, audience: {},
    note: 'Last updated August 2026. Check it against the v2.0 manual before relying on it.' },
  { id: 'RES-32', title: 'Clinical Billing Plan: Enrollment to Claims', fileType: 'GDOC', version: 'current',
    url: 'https://docs.google.com/document/d/16zJq__jdYeVje8D96pJfc-Wblc_VmDk_fUqVTgku7rM/view',
    action: ACTIONS.REFERENCE, step: STEPS.REFERENCE_SHELF, required: false, audience: {} },
  { id: 'RES-33', title: 'Quo Phone Tree Setup', fileType: 'PDF', version: '2026-11-05',
    url: 'https://drive.google.com/file/d/1actG1vaO5IKWgHd5AqjMnjmR2gcX_Z5E/view',
    action: ACTIONS.REFERENCE, step: STEPS.REFERENCE_SHELF, required: false, audience: {} },
  { id: 'RES-34', title: 'Lab Test Menu', fileType: 'PDF', version: 'current',
    url: 'https://drive.google.com/file/d/1Rl--cdg0MjwafV_lobT5-kNJjqw6MYLA/view',
    action: ACTIONS.REFERENCE, step: STEPS.REFERENCE_SHELF, module: 'TRN-206',
    required: false, audience: {} },
  { id: 'RES-35', title: 'Continuous Care Program (CCM)', fileType: 'PDF', version: 'current',
    url: 'https://drive.google.com/file/d/1t39l8PijHMepC83zVUOY6U21vgQOdP8b/view',
    action: ACTIONS.REFERENCE, step: STEPS.REFERENCE_SHELF, module: 'TRN-213',
    required: false, audience: {} },
  { id: 'RES-36', title: 'Patient Journey Infographic', fileType: 'PDF', version: 'current',
    url: 'https://drive.google.com/file/d/1kxXTqyLO3b_equPW1vkd3ar0NxoEY3iF/view',
    action: ACTIONS.REFERENCE, step: STEPS.REFERENCE_SHELF, module: 'TRN-201',
    required: false, audience: {} },
  { id: 'RES-37', title: 'GFC App: Accepting Shifts and Clocking In', fileType: 'VIDEO', version: 'current',
    url: 'https://drive.google.com/file/d/1YcwdwNhYIa1NKqmEdibsAYKlhekcQgHA/view',
    action: ACTIONS.READ, step: STEPS.TRAINING, module: 'TRN-202', required: false, audience: {},
    note: 'The caregiver version. NPs use the same check-in, so it stands in until a clinician one is recorded.' }
].map(Object.freeze));

// Documents deliberately NOT shown to clinicians, and why. Declared rather than
// merely absent, so a later session does not "helpfully" add one back: each
// manual says people follow the manual for their own work.
const WITHHELD = Object.freeze([
  { title: 'Administrative and Business Operations P&P', reason: 'For admin, coordination and outreach roles' },
  { title: 'Private Home Care P&P, home care videos, Client Service Packet', reason: 'The caregiver and home care track' },
  { title: 'Billing Setup Guide', reason: 'A billing staff tool' },
  { title: 'OpenEMR Master Setup Guide', reason: 'A server build document. Clinicians never use OpenEMR directly' },
  { title: 'Hiring and Screening Protocol, job postings', reason: 'Hiring staff tools' }
].map(Object.freeze));

/** Who a resource is for. Same narrowing shape as items and modules. */
function resourceApplies(res, inputs) {
  const a = res.audience || {};
  const lanes = (inputs && inputs.lanes) || [];
  const addons = (inputs && inputs.addons) || [];
  const contractors = (inputs && inputs.contractors) || [];
  const relationship = (inputs && inputs.relationship) || null;
  const field = !!(inputs && inputs.field);
  if (a.relationship && !a.relationship.includes(relationship)) return false;
  if (a.lanes && !a.lanes.some(l => lanes.includes(l))) return false;
  if (a.addons && !a.addons.some(x => addons.includes(x))) return false;
  if (a.field === true && !field) return false;
  // Rule 5: a contractor-tagged resource shows only when that contractor is
  // assigned, so nobody reads another contractor's handbook.
  if (a.contractors && !a.contractors.some(c => contractors.includes(c))) return false;
  return true;
}

function resourcesFor(inputs) {
  return RESOURCES.filter(r => resourceApplies(r, inputs));
}

const findResource = (id) => RESOURCES.find(r => r.id === String(id || '')) || null;

/**
 * Rule 4: has the document moved on since she signed it?
 *
 * Compared on the VERSION LABEL alone, never on Drive's modified time. The
 * modified time changes when somebody fixes a typo, and re-prompting a whole
 * team to re-sign a policy because of a comma is how signature prompts start
 * being clicked through without reading. The modified time is still RECORDED at
 * signing, because it says which exact text she saw.
 */
function signatureStale(res, signature) {
  if (!res || !signature) return false;
  const signedVersion = String(signature.version || '').trim();
  if (!signedVersion) return true;      // no version recorded: treat as unknown
  return signedVersion !== String(res.version || '').trim();
}

/** A resource whose link is missing or unreachable. Never blocks the wizard. */
function resourceAvailability(res, accessFailures) {
  if (!res.url) {
    return { available: false, reason: 'not_uploaded',
      message: 'This document has not been uploaded yet.' };
  }
  const failed = (accessFailures || {})[res.id];
  if (failed) {
    return { available: false, reason: 'no_access',
      message: 'Ask Bianca or Kate for access to this document.' };
  }
  return { available: true, reason: null, message: null };
}

/** The resource shelf, grouped by wizard step, with each row's state. */
function buildResources({ inputs, signatures, accessFailures } = {}) {
  const rows = resourcesFor(inputs).map(r => {
    const sig = ((signatures || {})[r.id]) || null;
    const avail = resourceAvailability(r, accessFailures);
    return {
      id: r.id, title: r.title, url: r.url, fileType: r.fileType, version: r.version,
      action: r.action, actionLabel: ACTION_LABELS[r.action] || r.action,
      step: r.step, stepTitle: STEP_TITLES[r.step],
      playbookItem: r.playbookItem || null, module: r.module || null,
      pairsWith: r.pairsWith || null, countersign: r.countersign || null,
      required: !!r.required, pinned: !!r.pinned, note: r.note || null,
      available: avail.available, unavailableReason: avail.reason,
      unavailableMessage: avail.message,
      signedAt: sig ? sig.at : null, signedVersion: sig ? sig.version : null,
      signedModifiedTime: sig ? (sig.driveModifiedTime || null) : null,
      stale: signatureStale(r, sig)
    };
  });
  const byStep = STEP_ORDER.map(s => ({
    step: s, title: STEP_TITLES[s],
    resources: rows.filter(r => r.step === s)
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
  })).filter(g => g.resources.length);
  return {
    rows, byStep, withheld: WITHHELD,
    counts: {
      total: rows.length,
      unavailable: rows.filter(r => !r.available).length,
      stale: rows.filter(r => r.stale).length,
      unsigned: rows.filter(r => r.required && !r.signedAt
        && (r.action === ACTIONS.SIGN || r.action === ACTIONS.ACKNOWLEDGE
          || r.action === ACTIONS.ATTEST_WITH_CHECKS)).length
    },
    stepOrder: STEP_ORDER, stepTitles: STEP_TITLES
  };
}

module.exports = {
  ACTIONS, ACTION_LABELS, STEPS, STEP_ORDER, STEP_TITLES,
  RESOURCES, WITHHELD,
  resourceApplies, resourcesFor, findResource,
  signatureStale, resourceAvailability, buildResources
};
