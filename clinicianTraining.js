// ============================================================================
// THE CLINICIAN TRAINING LIBRARY
// Per docs/GFC_NP_Training_Library_v1.md (owner-authored, 2026-11)
// ============================================================================
// Modules filter on the SAME four inputs the item library filters on, so a
// module and a checklist item can never disagree about who they are for.
//
// EVERY CHECK QUESTION HERE IS COPIED FROM A WRITTEN SOP. None is invented.
// Where an SOP has not been written yet the module carries NO questions, and the
// admin screen says which modules still need theirs — an empty question set is
// a gap to fill, never a module that happens to be easy. The library spec allows
// multiple-choice `options`, and the SOPs supply a scenario, the correct answer
// and its manual reference but no wrong answers, so a check runs as THINK, THEN
// REVEAL and the learner scores herself. Writing plausible wrong answers to
// clinical questions is not something to do without the Clinical Director
// reading them, and a self-scored recall check is the standard way to run spaced
// recall anyway. `options` is honoured the day real distractors are written.
//
// SPACED RE-CHECK (library §1.4): the app re-asks one or two questions at day
// 3, 10, 30 and 90. A wrong answer sends her back to the module. That is the
// whole retention mechanism, so the schedule is derived from the completion
// date and never stored as a list of dates that would drift.
// ============================================================================

'use strict';

const PHASES = Object.freeze({
  WELCOME: 'WELCOME', EXAMS: 'EXAMS', CLINICAL_PREP: 'CLINICAL_PREP',
  GO_LIVE: 'GO_LIVE', FIRST_90: 'FIRST_90'
});
const PHASE_ORDER = Object.freeze(['WELCOME', 'EXAMS', 'CLINICAL_PREP', 'GO_LIVE', 'FIRST_90']);
const PHASE_TITLES = Object.freeze({
  WELCOME: 'Welcome',
  EXAMS: 'Exams',
  CLINICAL_PREP: 'Getting ready for patients',
  GO_LIVE: 'Your first patients',
  FIRST_90: 'First 90 days'
});
const PHASE_WHEN = Object.freeze({
  WELCOME: 'Now, while your paperwork finishes',
  EXAMS: 'Once your screening application clears',
  CLINICAL_PREP: 'While the Board reviews your protocol agreement',
  GO_LIVE: 'Once the Board approves it',
  FIRST_90: 'Running in the background'
});

const FORMATS = Object.freeze({
  VIDEO: 'VIDEO', READ: 'READ', LIVE: 'LIVE', EXTERNAL: 'EXTERNAL',
  OBSERVED: 'OBSERVED', SHADOW: 'SHADOW', IN_APP: 'IN_APP'
});
const FORMAT_LABELS = Object.freeze({
  VIDEO: 'Video', READ: 'Read', LIVE: 'Live session', EXTERNAL: 'Outside training',
  OBSERVED: 'Watched and signed off', SHADOW: 'Shadowing', IN_APP: 'In the app'
});

const SIGNOFF = Object.freeze({
  ATTEST: 'ATTEST', COUNTERSIGN: 'COUNTERSIGN', OBSERVED: 'OBSERVED',
  CERTIFICATE: 'CERTIFICATE', NONE: 'NONE'
});
const SIGNOFF_LABELS = Object.freeze({
  ATTEST: 'You sign it',
  COUNTERSIGN: 'You sign it, the Clinical Director countersigns',
  OBSERVED: 'Signed off by whoever watched',
  CERTIFICATE: 'Upload the certificate',
  NONE: 'Nothing to sign'
});

const DEFAULT_RECHECK_DAYS = Object.freeze([3, 10, 30, 90]);

// ---- Check questions, copied from GFC_Clinical_SOPs_Set1_v1 ---------------
const C = (prompt, answer, source) => ({ prompt, answer, source, options: [], style: 'reveal_self_score' });

const CHECKS = Object.freeze({
  'SOP-SYS-01': [
    C('A daughter asks you to text her mom’s lab results to her personal phone. What do you do?',
      'Confirm the patient agrees to share with her, then send through the patient portal or another approved secure channel. Never by personal text.', 'Manual 21.3'),
    C('Where is the legal medical record?',
      'OpenEMR. You work in the GFC app, and the app writes to OpenEMR.', 'Manual 3.1, 3.2'),
    C('You realize you sent a message with patient information to the wrong colleague. What now?',
      'Report it to the Privacy Officer the same day. Reporting quickly is the right thing to do. Hiding it is the violation.', 'Manual 21.5')
  ],
  'SOP-ESC-01': [
    C('A medication change sits right at the edge of what your protocol agreement covers. The patient would clearly benefit. What do you do?',
      'Consult the Supervising Physician before acting, and document the consult.', 'Manual 2.5'),
    C('A caregiver calls at 6 PM to say the patient seems more confused than usual. What happens?',
      'A licensed clinician reviews it the same day and decides the response. A change in condition is never held overnight.', 'Manual 18.4'),
    C('Who handles a question about your schedule or system access?',
      'The Executive Director.', 'Manual 2.8')
  ],
  'SOP-VIS-01': [
    C('You arrive and there’s a man on the porch shouting at someone inside. What do you do?',
      'Don’t enter. Leave, then report to the Clinical Director the same day.', 'Manual 17.4, 17.6'),
    C('Where does your clinical bag go in the home?',
      'On a clean, hard, non-porous surface, on a barrier. Never on the floor, a bed, or upholstered furniture.', 'Manual 16.2'),
    C('The med list says lisinopril 10 mg, but the bottle in the kitchen says 20 mg. What do you reconcile against?',
      'What the patient is actually taking. Resolve the difference and document it. The reconciled list becomes the list in the record.', 'Manual 12.5')
  ],
  'SOP-DOC-01': [
    C('You realize a signed note from Tuesday lists the wrong medication dose. How do you fix it?',
      'Write an addendum stating what was wrong, what’s correct, the date, and your name. Never edit or overwrite the original.', 'Manual 9.3'),
    C('What’s the signing deadline, and what happens to the claim if the note isn’t signed?',
      '48 hours. No claim is submitted until the note is signed.', 'Manual 9.2'),
    C('You didn’t redo the lung exam today, but last visit’s normal lung exam is still in the template. What do you do?',
      'Remove it or update it. Never carry forward an exam you didn’t perform.', 'Manual 9.4')
  ],
  'SOP-ORD-01': [
    C('When do you label a specimen?',
      'At the bedside, in front of the patient. Never before the visit and never after you leave.', 'Manual 11.3'),
    C('What must every order carry?',
      'The clinical indication, the ordering clinician, and the date.', 'Manual 11.1')
  ],
  'SOP-ORD-02': [
    C('A lab calls with a critical potassium on your patient. What do you do?',
      'Act immediately, decide whether they need emergency care, reach the patient the same day, and document every step with times.', 'Manual 11.6'),
    C('How quickly do you act on a significantly abnormal result that isn’t critical?',
      'Within 1 business day.', 'Manual 11.6'),
    C('A coordinator asks if a result “looks okay” so they can tell the patient. What do you say?',
      'Results are reviewed and explained by a clinician, not office staff. Review it yourself and tell the patient, or tell the coordinator exactly what to communicate.', 'Manual 11.5, 2.7')
  ],
  'SOP-RX-01': [
    C('A patient on long-term oxycodone needs a refill. What do you do?',
      'It’s Schedule II. Route it to the Supervising Physician and document the referral.', 'Manual 12.3, 2.5'),
    C('A refill request comes in for a patient last seen 8 months ago, and their plan says every 3 months. What happens?',
      'Don’t refill automatically. Schedule the patient.', 'Manual 12.4'),
    C('What do you do before writing any controlled substance?',
      'Check the Georgia PDMP and document the check.', 'Manual 12.3')
  ],
  'SOP-EXM-01': [
    C('Midway through an exam, the veteran says he has no primary care doctor and asks if you could become his. What do you do?',
      'Finish the exam without soliciting him. Tell him he’s free to contact GFC on his own afterward if he wants to.', 'Manual 14.4'),
    C('During an exam you find a blood pressure of 210/120 with a headache. What do you do?',
      'Follow the contractor’s emergent-finding procedure, advise him to seek care now, call 911 if warranted, and document it.', 'Manual 14.3'),
    C('A veteran’s attorney sends a gift card “for your time.” What do you do?',
      'Decline it, document the offer, and report it to the Executive Director the same day.', 'Manual 23.5')
  ]
});

const checksFor = (sopRefs) => []
  .concat(...(sopRefs || []).map(s => CHECKS[s] || []));

// ---- THE MODULES (library §3) ---------------------------------------------
// `when` matches the item library's shape exactly, so one predicate reads both.
const M = (o) => Object.freeze(Object.assign({
  when: {}, format: FORMATS.VIDEO, minutes: null, host: null,
  signoff: SIGNOFF.ATTEST, sopRefs: [], manualRefs: [], feedsGate: [],
  unlocksAfter: [], recheckDays: DEFAULT_RECHECK_DAYS,
  videoUrl: null, driveUrl: null, externalUrl: null, resources: []
}, o, { checks: checksFor(o.sopRefs) }));

const MODULE_LIBRARY = Object.freeze([
  // Phase 1 · WELCOME
  M({ id: 'TRN-001', phase: PHASES.WELCOME, title: 'Welcome to GFC: who we are, our service lines, who does what',
    minutes: 15, host: 'EXECUTIVE_DIRECTOR', feedsGate: ['G1', 'G2'], resources: ['RES-01'] }),
  M({ id: 'TRN-002', phase: PHASES.WELCOME, format: FORMATS.READ,
    title: 'Your role card: what you own, what you don’t, who to ask, what a good week looks like',
    minutes: 10, host: 'EXECUTIVE_DIRECTOR', feedsGate: ['G1', 'G2'], resources: ['RES-02'] }),
  M({ id: 'TRN-003', phase: PHASES.WELCOME, title: 'Our systems: the GFC app, e-prescribing, faxing, Google Workspace, phone lines, team chat',
    minutes: 15, host: 'CLINICAL_OPS_COORDINATOR', feedsGate: ['G1', 'G2'],
    sopRefs: ['SOP-SYS-01'], manualRefs: ['3', '21'], resources: ['RES-09'] }),
  M({ id: 'TRN-004', phase: PHASES.WELCOME, format: FORMATS.IN_APP, title: 'App tour on first login',
    minutes: 10, host: null, signoff: SIGNOFF.NONE, feedsGate: ['G1', 'G2'] }),
  M({ id: 'TRN-005', phase: PHASES.WELCOME, title: 'Privacy and security in the home and in our systems',
    minutes: 15, host: 'EXECUTIVE_DIRECTOR', feedsGate: ['G1', 'G2'],
    sopRefs: ['SOP-SYS-01'], manualRefs: ['21'], resources: ['RES-07'] }),
  M({ id: 'TRN-006', phase: PHASES.WELCOME, format: FORMATS.READ,
    title: 'Clinical Policies and Procedures Manual: read, attest, scenarios',
    minutes: 60, host: 'CLINICAL_DIRECTOR', signoff: SIGNOFF.COUNTERSIGN,
    feedsGate: ['G2'], resources: ['RES-08'] }),
  M({ id: 'TRN-007', phase: PHASES.WELCOME, format: FORMATS.READ, title: 'Home-based clinical care SOPs',
    minutes: 20, host: 'CLINICAL_DIRECTOR', signoff: SIGNOFF.COUNTERSIGN,
    feedsGate: ['G1', 'G2'], resources: ['RES-08', 'RES-09'] }),

  // Phase 2 · EXAMS
  M({ id: 'TRN-101', phase: PHASES.EXAMS, when: { lanes: ['EXAMS'] },
    title: 'What an exam is and isn’t: evaluative, no treating, no solicitation',
    minutes: 10, host: 'EXECUTIVE_DIRECTOR', feedsGate: ['G1'],
    sopRefs: ['SOP-EXM-01'], manualRefs: ['14', '23.5'] }),
  M({ id: 'TRN-102', phase: PHASES.EXAMS, when: { lanes: ['EXAMS'] }, format: FORMATS.EXTERNAL,
    title: 'Disability examination training', minutes: 1200, host: null,
    signoff: SIGNOFF.CERTIFICATE, feedsGate: ['G1'],
    detail: 'About 20 hours. The link comes from the contractor once screening clears.' }),
  M({ id: 'TRN-103', phase: PHASES.EXAMS, when: { lanes: ['EXAMS'] }, format: FORMATS.EXTERNAL,
    title: 'Contractor’s required training', minutes: null, host: null,
    signoff: SIGNOFF.CERTIFICATE, feedsGate: ['G1'], resources: ['RES-21'] }),
  M({ id: 'TRN-104', phase: PHASES.EXAMS, when: { lanes: ['EXAMS'] }, format: FORMATS.LIVE,
    title: 'GFC exam workflow: scheduling, check-in, templates, turnaround, quality review, restricted access',
    minutes: 120, host: 'EXECUTIVE_DIRECTOR', signoff: SIGNOFF.OBSERVED, feedsGate: ['G1'],
    sopRefs: ['SOP-EXM-01'], resources: ['RES-23', 'RES-24'] }),
  M({ id: 'TRN-105', phase: PHASES.EXAMS, when: { lanes: ['EXAMS'] },
    title: 'Emergent findings during an exam', minutes: 10, host: 'CLINICAL_DIRECTOR',
    feedsGate: ['G1'], sopRefs: ['SOP-EXM-01'], resources: ['RES-22'] }),
  M({ id: 'TRN-106', phase: PHASES.EXAMS, when: { lanes: ['EXAMS'] }, format: FORMATS.OBSERVED,
    title: 'First exam reports reviewed', minutes: null, host: 'CLINICAL_DIRECTOR',
    signoff: SIGNOFF.OBSERVED, feedsGate: [], focusedReview: true,
    detail: 'The first 5 reports, against the contractor’s standard and ours.' }),

  // Phase 3 · CLINICAL PREP
  M({ id: 'TRN-201', phase: PHASES.CLINICAL_PREP, when: { lanes: ['CLINICAL'] },
    title: 'From referral to first visit: acceptance, intake, consents, the first-visit standard',
    minutes: 15, host: 'CLINICAL_OPS_COORDINATOR', feedsGate: ['G2'], resources: ['RES-36'] }),
  M({ id: 'TRN-202', phase: PHASES.CLINICAL_PREP, when: { lanes: ['CLINICAL'] },
    title: 'Visit day: itinerary, check-in and check-out, field safety, leaving a visit',
    minutes: 15, host: 'CLINICAL_DIRECTOR', feedsGate: ['G2'],
    sopRefs: ['SOP-VIS-01'], manualRefs: ['8', '16', '17'], resources: ['RES-37'] }),
  M({ id: 'TRN-203', phase: PHASES.CLINICAL_PREP, when: { lanes: ['CLINICAL'] }, format: FORMATS.OBSERVED,
    title: 'Infection prevention and bag technique', minutes: 20, host: 'CLINICAL_DIRECTOR',
    signoff: SIGNOFF.OBSERVED, feedsGate: ['G2'], sopRefs: ['SOP-VIS-01'], manualRefs: ['16'] }),
  M({ id: 'TRN-204', phase: PHASES.CLINICAL_PREP, when: { relationship: ['W2', 'HYBRID'] },
    format: FORMATS.EXTERNAL, title: 'Bloodborne pathogens', minutes: 60, host: null,
    signoff: SIGNOFF.CERTIFICATE, feedsGate: ['G2'] }),
  M({ id: 'TRN-205', phase: PHASES.CLINICAL_PREP, when: { lanes: ['CLINICAL'] },
    title: 'Documentation: note types, required sections, signing within the standard, corrections',
    minutes: 15, host: 'CLINICAL_DIRECTOR', feedsGate: ['G2'],
    sopRefs: ['SOP-DOC-01'], manualRefs: ['8.5', '9'] }),
  M({ id: 'TRN-206', phase: PHASES.CLINICAL_PREP, when: { lanes: ['CLINICAL'] },
    title: 'Orders and results: ordering, faxed requisitions, the results inbox, closing the loop, critical values',
    minutes: 15, host: 'CLINICAL_OPS_COORDINATOR', feedsGate: ['G2'],
    sopRefs: ['SOP-ORD-01', 'SOP-ORD-02'], manualRefs: ['11'], resources: ['RES-34'] }),
  M({ id: 'TRN-207', phase: PHASES.CLINICAL_PREP, when: { addons: ['PRESCRIBES'] },
    title: 'Prescribing and refills: scope, the e-prescribing handoff, refill rules',
    minutes: 15, host: 'CLINICAL_DIRECTOR', feedsGate: ['G2'],
    sopRefs: ['SOP-RX-01'], manualRefs: ['12'] }),
  M({ id: 'TRN-208', phase: PHASES.CLINICAL_PREP, when: { addons: ['CONTROLLED'] },
    title: 'Controlled substances: the PDMP, the Schedule II referral path, treatment agreements',
    minutes: 10, host: 'CLINICAL_DIRECTOR', feedsGate: ['G3'],
    sopRefs: ['SOP-RX-01'], manualRefs: ['12.3'] }),
  M({ id: 'TRN-209', phase: PHASES.CLINICAL_PREP, when: { lanes: ['CLINICAL'] },
    title: 'Escalation: when to consult the physician, the urgent clinical line, change in condition',
    minutes: 10, host: 'CLINICAL_DIRECTOR', feedsGate: ['G2'],
    sopRefs: ['SOP-ESC-01'], manualRefs: ['2.5', '2.8', '18'], resources: ['RES-33'] }),
  M({ id: 'TRN-210', phase: PHASES.CLINICAL_PREP, when: { lanes: ['CLINICAL'] },
    title: 'Medical emergencies in the home', minutes: 10, host: 'CLINICAL_DIRECTOR',
    feedsGate: ['G2'], manualRefs: ['18'] }),
  M({ id: 'TRN-211', phase: PHASES.CLINICAL_PREP, when: { addons: ['PMHNP'] },
    title: 'Psych risk assessment, safety planning and crisis response',
    minutes: 20, host: 'CLINICAL_DIRECTOR', feedsGate: ['G4'] }),
  M({ id: 'TRN-212', phase: PHASES.CLINICAL_PREP, when: { addons: ['PMHNP'] },
    title: 'Psych visit workflow and note set', minutes: 15, host: 'CLINICAL_DIRECTOR',
    feedsGate: ['G4'] }),
  M({ id: 'TRN-213', phase: PHASES.CLINICAL_PREP, when: { lanes: ['CLINICAL'] },
    title: 'Care management programs: consent, who does what, time logging',
    minutes: 15, host: 'CLINICAL_OPS_COORDINATOR', feedsGate: ['G2'], resources: ['RES-35'] }),
  M({ id: 'TRN-214', phase: PHASES.CLINICAL_PREP, when: { lanes: ['CLINICAL'] },
    title: 'Transitions of care: discharge follow-up, medication reconciliation',
    minutes: 10, host: 'CLINICAL_OPS_COORDINATOR', feedsGate: ['G2'] }),
  M({ id: 'TRN-215', phase: PHASES.CLINICAL_PREP, when: { lanes: ['CLINICAL'] },
    title: 'Coding and billing integrity', minutes: 15, host: 'EXECUTIVE_DIRECTOR',
    feedsGate: ['G2'], resources: ['RES-32'] }),
  M({ id: 'TRN-216', phase: PHASES.CLINICAL_PREP, when: { lanes: ['CLINICAL'] },
    title: 'Mandatory reporting', minutes: 10, host: 'CLINICAL_DIRECTOR', feedsGate: ['G2'] }),
  M({ id: 'TRN-217', phase: PHASES.CLINICAL_PREP, when: { lanes: ['CLINICAL'] },
    title: 'Incidents and near misses: what to report and how',
    minutes: 10, host: 'CLINICAL_DIRECTOR', feedsGate: ['G2'] }),
  M({ id: 'TRN-218', phase: PHASES.CLINICAL_PREP, when: { addons: ['TELEHEALTH'] },
    title: 'Telehealth visits', minutes: 10, host: 'CLINICAL_DIRECTOR', feedsGate: [] }),
  M({ id: 'TRN-219', phase: PHASES.CLINICAL_PREP, when: { lanes: ['CLINICAL'] }, format: FORMATS.SHADOW,
    title: 'Shadow home visits, observing only', minutes: null, host: 'CLINICAL_DIRECTOR',
    signoff: SIGNOFF.OBSERVED, feedsGate: ['G2'],
    detail: 'Two or three visits. Allowed in this phase because she only observes.' }),
  M({ id: 'TRN-220', phase: PHASES.CLINICAL_PREP, when: { lanes: ['CLINICAL'] }, format: FORMATS.OBSERVED,
    title: 'Point-of-care testing and home equipment competency', minutes: 30,
    host: 'CLINICAL_DIRECTOR', signoff: SIGNOFF.OBSERVED, feedsGate: ['G2'] }),

  // Phase 4 · GO-LIVE
  M({ id: 'TRN-301', phase: PHASES.GO_LIVE, when: { lanes: ['CLINICAL'] }, format: FORMATS.LIVE,
    title: 'Live clinical session: protocol judgment and a real chart walked together',
    minutes: 120, host: 'CLINICAL_DIRECTOR', signoff: SIGNOFF.OBSERVED, feedsGate: ['G2'] }),
  M({ id: 'TRN-302', phase: PHASES.GO_LIVE, when: { lanes: ['CLINICAL'] }, format: FORMATS.OBSERVED,
    title: 'Paired first visits, same-day debrief', minutes: null, host: 'CLINICAL_DIRECTOR',
    signoff: SIGNOFF.OBSERVED, feedsGate: [], focusedReview: true }),
  M({ id: 'TRN-303', phase: PHASES.GO_LIVE, when: { lanes: ['CLINICAL'] }, format: FORMATS.OBSERVED,
    title: 'Chart review on every early encounter', minutes: null, host: 'CLINICAL_DIRECTOR',
    signoff: SIGNOFF.OBSERVED, feedsGate: [], focusedReview: true,
    detail: 'The first 30 days, or the first 10 encounters per new privilege.' }),
  M({ id: 'TRN-304', phase: PHASES.GO_LIVE, when: { lanes: ['CLINICAL'] }, format: FORMATS.OBSERVED,
    title: 'Workflow sign-offs: each hands-on workflow marked independent',
    minutes: null, host: 'CLINICAL_DIRECTOR', signoff: SIGNOFF.OBSERVED, feedsGate: [] }),

  // Phase 5 · FIRST 90 DAYS — check-ins, not modules. Day-offset driven.
  M({ id: 'TRN-401', phase: PHASES.FIRST_90, title: 'Week-one check-in', format: FORMATS.LIVE,
    minutes: 30, host: 'EXECUTIVE_DIRECTOR', signoff: SIGNOFF.NONE, dayOffset: 5, feedsGate: [] }),
  M({ id: 'TRN-403', phase: PHASES.FIRST_90, title: '30-day review: friction and what’s unclear',
    format: FORMATS.LIVE, minutes: 30, host: 'EXECUTIVE_DIRECTOR', signoff: SIGNOFF.NONE,
    dayOffset: 30, feedsGate: [] }),
  M({ id: 'TRN-404', phase: PHASES.FIRST_90, title: '60-day review: coaching', format: FORMATS.LIVE,
    minutes: 30, host: 'CLINICAL_DIRECTOR', signoff: SIGNOFF.NONE, dayOffset: 60, feedsGate: [] }),
  M({ id: 'TRN-405', phase: PHASES.FIRST_90, title: '90-day review: performance and scope',
    format: FORMATS.LIVE, minutes: 60, host: 'CLINICAL_DIRECTOR', signoff: SIGNOFF.NONE,
    dayOffset: 90, feedsGate: [] })
]);

// ---- WHO A MODULE IS FOR --------------------------------------------------
// Deliberately the same shape as the item library's `when`, read by the same
// kind of predicate, so a module and an item cannot disagree about audience.
function moduleApplies(mod, inputs) {
  const w = mod.when || {};
  const roles = (inputs && inputs.roles) || [];
  const lanes = (inputs && inputs.lanes) || [];
  const addons = (inputs && inputs.addons) || [];
  const relationship = (inputs && inputs.relationship) || null;
  if (w.roles && !w.roles.some(r => roles.includes(r))) return false;
  if (w.relationship && !w.relationship.includes(relationship)) return false;
  if (w.lanes && !w.lanes.some(l => lanes.includes(l))) return false;
  if (w.addons && !w.addons.some(a => addons.includes(a))) return false;
  return true;
}

function modulesFor(inputs) {
  return MODULE_LIBRARY.filter(m => moduleApplies(m, inputs))
    .sort((a, b) => {
      const pa = PHASE_ORDER.indexOf(a.phase), pb = PHASE_ORDER.indexOf(b.phase);
      if (pa !== pb) return pa - pb;
      return a.id.localeCompare(b.id, 'en');
    });
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ymd = (v) => String(v || '').slice(0, 10);
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const addDays = (from, n) =>
  new Date(Date.parse(`${from}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * A module's state, plus the re-checks it owes.
 *
 * "Release rule: modules unlock by phase and by gate, not all at once. She only
 * sees the next few things she needs." So a module whose `unlocksAfter` is not
 * done reads LOCKED, and the screen shows a short "up next" rather than 40 rows.
 */
function moduleStatus(mod, progress, today) {
  const p = (progress && progress[mod.id]) || null;
  const done = !!(p && p.completedAt);
  const locked = (mod.unlocksAfter || []).some(id => !((progress || {})[id] || {}).completedAt);
  const now = isYmd(today) ? today : new Date().toISOString().slice(0, 10);

  const rechecks = [];
  if (done && (mod.checks || []).length) {
    const base = ymd(p.completedAt);
    for (const d of (mod.recheckDays || DEFAULT_RECHECK_DAYS)) {
      const dueAt = addDays(base, d);
      const answered = ((p.rechecks || {})[String(d)]) || null;
      rechecks.push({
        day: d, dueAt,
        due: !answered && dueAt <= now,
        answeredAt: answered ? answered.at : null,
        correct: answered ? !!answered.correct : null,
        // A wrong answer sends her back to the module (library §1.4).
        sentBack: answered ? answered.correct === false : false
      });
    }
  }
  const needsRedo = rechecks.some(r => r.sentBack && !r.answeredAgainAt);
  return {
    status: locked ? 'locked' : (done ? (needsRedo ? 'redo' : 'complete') : 'available'),
    completedAt: done ? p.completedAt : null,
    score: p && typeof p.score === 'number' ? p.score : null,
    signedOffAt: p ? (p.signedOffAt || null) : null,
    signedOffBy: p ? (p.signedOffByName || null) : null,
    countersignedAt: p ? (p.countersignedAt || null) : null,
    certificates: p ? (p.certificates || []) : [],
    questionsLogged: p ? (p.questions || []) : [],
    rechecks, locked, needsRedo
  };
}

/** Every re-check question due today, across every module. */
function rechecksDue(inputs, progress, today) {
  const out = [];
  for (const mod of modulesFor(inputs)) {
    const st = moduleStatus(mod, progress, today);
    for (const rc of st.rechecks) {
      if (!rc.due) continue;
      // One or two questions, not the whole set (library §1.4).
      const picked = (mod.checks || []).slice(0, 2);
      out.push({ moduleId: mod.id, moduleTitle: mod.title, day: rc.day, dueAt: rc.dueAt, checks: picked });
    }
  }
  return out;
}

/** The learner's own view: "up next", her phases, and today's re-checks. */
function buildTraining({ inputs, progress, today, upNext = 3 } = {}) {
  const mods = modulesFor(inputs);
  const rows = mods.map(m => {
    const st = moduleStatus(m, progress, today);
    return {
      id: m.id, phase: m.phase, phaseTitle: PHASE_TITLES[m.phase],
      title: m.title, detail: m.detail || null,
      format: m.format, formatLabel: FORMAT_LABELS[m.format] || m.format,
      minutes: m.minutes, host: m.host,
      signoff: m.signoff, signoffLabel: SIGNOFF_LABELS[m.signoff] || m.signoff,
      feedsGate: m.feedsGate, sopRefs: m.sopRefs, manualRefs: m.manualRefs,
      resources: m.resources, videoUrl: m.videoUrl, externalUrl: m.externalUrl,
      checkCount: (m.checks || []).length,
      // An empty question set is a GAP, not an easy module. Named so the admin
      // screen can list what still needs writing.
      checksMissing: (m.checks || []).length === 0 && m.signoff !== SIGNOFF.NONE,
      focusedReview: !!m.focusedReview, dayOffset: m.dayOffset || null,
      status: st.status, completedAt: st.completedAt, score: st.score,
      signedOffAt: st.signedOffAt, signedOffBy: st.signedOffBy,
      countersignedAt: st.countersignedAt, certificates: st.certificates,
      rechecks: st.rechecks, needsRedo: st.needsRedo, locked: st.locked
    };
  });
  const byPhase = PHASE_ORDER.map(ph => ({
    phase: ph, title: PHASE_TITLES[ph], when: PHASE_WHEN[ph],
    modules: rows.filter(r => r.phase === ph)
  })).filter(g => g.modules.length);

  const open = rows.filter(r => r.status === 'available' || r.status === 'redo');
  return {
    rows, byPhase,
    upNext: open.slice(0, upNext),
    rechecksDue: rechecksDue(inputs, progress, today),
    counts: {
      total: rows.length,
      complete: rows.filter(r => r.status === 'complete').length,
      open: open.length,
      locked: rows.filter(r => r.locked).length,
      checksMissing: rows.filter(r => r.checksMissing).length
    },
    phaseOrder: PHASE_ORDER, phaseTitles: PHASE_TITLES
  };
}

module.exports = {
  PHASES, PHASE_ORDER, PHASE_TITLES, PHASE_WHEN,
  FORMATS, FORMAT_LABELS, SIGNOFF, SIGNOFF_LABELS,
  DEFAULT_RECHECK_DAYS, CHECKS, MODULE_LIBRARY,
  moduleApplies, modulesFor, moduleStatus, rechecksDue, buildTraining
};
