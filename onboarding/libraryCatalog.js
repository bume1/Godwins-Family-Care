// ============================================================================
// WHY EACH TRAINING EXISTS, AND WHAT IT STILL NEEDS (owner, 2026-11-10)
// ============================================================================
// Taken from the owner's Training Material Tracker. One entry per module in
// the Training Library:
//
//   group    where it sits on the office's library page
//   policy   the canonical document it ties to and the sections, never the
//            text: the manual stays the one copy (the tracker's own rule)
//   next     what the office still has to do for it (office only)
//   note     the office's working note (office only: several name policy
//            holes that are not for staff)
//
// Staff see the policy line only. Whether a training is READY is never set
// here: it is computed from a written SOP or attached material.
// Pure, no I/O.
// ============================================================================

'use strict';

const { SOURCES } = require('./sources');

const GROUPS = Object.freeze(['Every role', 'Caregivers', 'Exams lane', 'Systems and orientation',
  'Clinical prep', 'Ready to see patients', 'First 90 days']);
const NEXT = Object.freeze({
  write: 'Write SOP', attach: 'Attach existing', done: 'Covered', external: 'External',
  none: 'No material needed', confirm: 'Confirm source', gap: 'Policy gap'
});

const ALL = 'Every role', CG = 'Caregivers', EX = 'Exams lane', SY = 'Systems and orientation',
  CP = 'Clinical prep', RD = 'Ready to see patients', F90 = 'First 90 days';
const M = (sections) => ({ doc: 'CLINICAL_MANUAL', sections });
const SOP = (sop, sections) => ({ doc: 'CLINICAL_SOPS_SET1', sections: `${sop} · Manual ${sections}` });
const PHC = (sections) => ({ doc: 'PHC_MANUAL', sections });
const e = (group, policy, next, note) => Object.freeze({ group, policy: policy ? Object.freeze(policy) : null, next, note: note || '' });

const CATALOG = Object.freeze({
  'TRN-001': e(ALL, { doc: 'TEAM_ROLES', sections: 'Whole guide' }, 'attach', 'Attached: Team Roles & Responsibilities v2. The Team Onboarding Deck slides 2 to 17 cover the same ground.'),
  'TRN-002': e(ALL, { doc: 'TEAM_ROLES', sections: 'Role cards, pages 12 to 21' }, 'attach', 'Attached: the guide. Split per role later if wanted.'),
  'TRN-004': e(ALL, { doc: 'ADMIN_SOPS_SET1', sections: 'SOP-ACC-01 signing in, SOP-ONB-01 onboarding · Set 2 SOP-SIG-02 signing documents · Admin Manual 3' }, 'write', 'Attached: SOP Set 1, SOP Set 2 and the Staff Pay Guide (in Drive). The same pay guide is also on the pay setup step of every onboarding list. The working SOP 1 Google Doc is retired. Still to write: SOP-SCH-01 Scheduling & Availability.'),
  'TRN-005': e(ALL, SOP('SOP-SYS-01', '3, 10.7–10.10, 21'), 'done'),
  'TRN-216': e(ALL, M('19.1–19.3'), 'write', 'Hole: 19.2 says report to the authority Georgia law requires, within the time it requires, and names neither. Verify against primary sources.'),
  'TRN-217': e(ALL, M('24.1–24.3 clinical · 21.5 privacy · 10.10 AI'), 'write', 'Three separate reporting paths. The SOP has to unify them into one decision point.'),

  'TRN-501': e(CG, PHC('11.1 scheduling, 11.2 attendance, 11.3 timekeeping'), 'done', 'Video: Accepting Shifts, Clocking In - GFC App.'),
  'TRN-502': e(CG, PHC('9.2 documenting services, 9.3 corrections, 11.3 timekeeping'), 'done', 'Video: Submitting Visit Report, Clocking Out - GFC App.'),
  'TRN-503': e(CG, PHC('17.1 qualification before client contact, 17.3 orientation'), 'done', 'Video: Home Care Staff Onboarding-Documents. Also attached: the Staff Pay Guide and SOP Set 2 (SOP-SIG-02, signing from the app). The same pay guide is on the pay step of the onboarding list.'),

  'TRN-102': e(EX, null, 'external'),
  'TRN-103': e(EX, null, 'external'),
  'TRN-104': e(EX, SOP('SOP-EXM-01', '14, 23.5'), 'done'),
  'TRN-105': e(EX, SOP('SOP-EXM-01', '14.3'), 'done'),
  'TRN-106': e(EX, null, 'none'),

  'TRN-003': e(SY, SOP('SOP-SYS-01', '3, 10.7–10.10, 21'), 'done'),
  'TRN-006': e(SY, M('Whole manual'), 'done'),
  'TRN-007': e(SY, M('8 visit standards, 16 infection prevention, 17 field safety'), 'confirm', 'No manual or SOP reference in the Library. SOP-VIS-01 already teaches these sections as TRN-202 and TRN-203. Decide: a separate read, or a duplicate.'),
  'TRN-008': e(SY, SOP('SOP-SYS-01', '10.7–10.10'), 'done'),
  'TRN-009': e(SY, M('3.4 other systems, 13.3 who does what, 13.7 vendors'), 'write', 'KaiCare supplies the platform and RPM devices; GFC clinical staff perform the care-coordination time. Active CCM management lives in KaiCare until an integration exists.'),

  'TRN-201': e(CP, M('6.2, 6.4, 8.2, 22.1'), 'write'),
  'TRN-202': e(CP, SOP('SOP-VIS-01', '8, 16, 17'), 'done'),
  'TRN-203': e(CP, SOP('SOP-VIS-01', '16'), 'done'),
  'TRN-204': e(CP, null, 'external'),
  'TRN-205': e(CP, SOP('SOP-DOC-01', '8.5, 9, 10.9'), 'done'),
  'TRN-206': e(CP, SOP('SOP-ORD-01 and SOP-ORD-02', '11.1–11.7'), 'done'),
  'TRN-207': e(CP, SOP('SOP-RX-01', '12'), 'done'),
  'TRN-208': e(CP, SOP('SOP-RX-01', '12.3'), 'done'),
  'TRN-209': e(CP, SOP('SOP-ESC-01', '2.5, 2.8, 18'), 'done'),
  'TRN-210': e(CP, M('18.1, 18.4'), 'write'),
  'TRN-211': e(CP, M('15.2, 15.3, 15.4'), 'write', 'PMHNP only.'),
  'TRN-212': e(CP, null, 'gap', 'The only true policy gap. Section 15 covers risk and crisis; sections 8 and 9 the generic visit and note. Nothing describes a psychiatric encounter start to finish. Needs the owner and Thanmayie.'),
  'TRN-213': e(CP, M('13.1–13.4'), 'write', 'Active management lives in KaiCare Ai, not the GFC app. Time logging follows the platform, and the SOP has to say so.'),
  'TRN-214': e(CP, M('20.3'), 'write'),
  'TRN-215': e(CP, M('23.1, 23.3'), 'write'),
  'TRN-218': e(CP, M('7.3'), 'write'),
  'TRN-219': e(CP, null, 'none'),
  'TRN-220': e(CP, M('11.3 and the CLIA certificate scope'), 'confirm', 'Observed competency. Confirm which written standard it is checked against.'),

  'TRN-301': e(RD, null, 'none'),
  'TRN-302': e(RD, null, 'none'),
  'TRN-303': e(RD, M('4.2 physician review intervals'), 'none'),
  'TRN-304': e(RD, null, 'none'),

  'TRN-401': e(F90, null, 'none'),
  'TRN-402': e(F90, null, 'none'),
  'TRN-403': e(F90, null, 'none'),
  'TRN-404': e(F90, null, 'none'),
  'TRN-405': e(F90, null, 'none')
});

// Reference rows on the library page that are not modules: they live elsewhere
// in the app and are listed so a role's path reads complete.
const REFERENCE_ROWS = Object.freeze([
  Object.freeze({ id: 'Care Courses', title: 'Forty-hour training program and annual refresher (Care Courses)', group: CG,
    policy: Object.freeze(PHC('17.2 the forty-hour training program')), where: "Each caregiver's onboarding, Training tab" }),
  // Office only: moving payroll records off Gusto (owner, 2026-11-11). Not a
  // staff training, so it is a reference row rather than a module.
  Object.freeze({ id: 'SOP Set 3', title: 'Payroll records, Gusto to the app (admins and managers)', group: SY,
    policy: Object.freeze({ doc: 'ADMIN_SOPS_SET3', sections: 'SOP-PAY-01 moving the records, SOP-PAY-02 what staff set up' }), where: 'Admin hub, User Management and Payroll' })
]);

const entryFor = (id) => CATALOG[id] || null;

function resolve(policy) {
  if (!policy) return null;
  const src = SOURCES[policy.doc];
  return Object.freeze({
    document: src ? `${src.title}${src.transcribedFromVersion ? ` v${src.transcribedFromVersion}` : ''}` : policy.doc,
    sections: policy.sections,
    url: src ? `https://drive.google.com/file/d/${src.driveFileId}/view` : null
  });
}
/** The policy line, resolved to its document's title and canonical link. */
const policyFor = (id) => resolve((entryFor(id) || {}).policy);
/** The reference rows with their policy resolved. */
const referenceRows = () => REFERENCE_ROWS.map(r => Object.assign({}, r, { policy: resolve(r.policy) }));


module.exports = { GROUPS, NEXT, CATALOG, REFERENCE_ROWS, entryFor, policyFor, referenceRows };
