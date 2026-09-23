// ============================================================
// GFC appointment types — Service + Appointment Type → Modality → Location
// ============================================================
// Owner-authored config, 2026-09-23. This replaces the flat nine-option
// `ENCOUNTER_TYPES` list, which tangled two different questions into one:
// half its entries said WHERE a visit happened and half said WHAT KIND it
// was, so "psychiatric home" and "psychiatric telehealth" had to exist as
// separate entries and every new combination multiplied the list.
//
// Three independent axes instead:
//   service + appointment type   what kind of visit, and what note it produces
//   modality                     in person or by video
//   location                     clinic, the patient's home, or a facility
//
// ⚠️ THE RULE THAT DECIDES A CORRECT CLAIM, AND IT IS NOT SYMMETRIC:
//
//     LOCATION SETS THE PLACE OF SERVICE. MODALITY SETS THE CODE FAMILY.
//
// In person, the code family follows the location: a clinic visit bills the
// office set and a home or facility visit bills the home-visit set, because
// those codes assume the clinician is physically there. A TELEHEALTH visit
// bills the OFFICE set wherever the patient is sitting — a video call to
// someone in their own front room is not a home visit, and billing it as one
// asserts a visit that never happened. The place of service still follows the
// location (10 to the home, 02 anywhere else), so the two axes answer two
// different questions and neither can be derived from the other.
//
// AN APPOINTMENT TYPE SUGGESTS A BILLING WORKFLOW AND NEVER ASSIGNS A CODE.
// The provider's documentation drives the level. Nothing in this file picks a
// code; it narrows the set a clinician chooses from, which is the difference
// between helping and asserting.

const SERVICES = Object.freeze([
  { key: 'primary_care', label: 'Primary Care' },
  { key: 'behavioral_health', label: 'Behavioral Health' },
  { key: 'ime', label: 'IME / C&P' }
]);

const MODALITIES = Object.freeze([
  { key: 'in_person', label: 'In-Person' },
  { key: 'telehealth', label: 'Telehealth' }
]);

// `pos: null` on `facility` is deliberate and load-bearing: an assisted living
// facility, a personal care home and a group home are 13, 14 and 33, and which
// one a given building is lives on ITS OWN RECORD in OpenEMR. Encoding a guess
// here would put a second answer beside the authoritative one.
const LOCATIONS = Object.freeze([
  { key: 'clinic', label: 'Clinic', pos: '11', fromFacilityRecord: false },
  { key: 'home', label: 'Private Home', pos: '12', fromFacilityRecord: false },
  { key: 'facility', label: 'Facility (ALF, PCH, group home)', pos: null, fromFacilityRecord: true }
]);

// The two E/M families. Codes are NOT listed: CPT is AMA-copyrighted, OpenEMR
// ships none, and GFC hand-enters the set it bills into the fee schedule. The
// family is a RANGE a picker filters by, never a list this file asserts.
const CODE_FAMILIES = Object.freeze({
  office: { key: 'office', label: 'Office / outpatient E/M', range: '99202–99215' },
  home: { key: 'home', label: 'Home or residence E/M', range: '99341–99350' }
});

const TELEHEALTH_POS_PATIENT_HOME = '10';   // telehealth to the patient's home
const TELEHEALTH_POS_ELSEWHERE = '02';      // telehealth anywhere else

const serviceByKey = (k) => SERVICES.find(s => s.key === String(k || '')) || null;
const modalityByKey = (k) => MODALITIES.find(m => m.key === String(k || '')) || null;
const locationByKey = (k) => LOCATIONS.find(l => l.key === String(k || '')) || null;

// ---- Place of service ----------------------------------------------------
// `facilityPos` is what the patient's assigned facility carries in OpenEMR.
// It is REQUIRED for an in-person facility visit and refused rather than
// guessed, because a facility visit billed at the wrong place of service is a
// claim asserting care happened somewhere it did not.
const resolvePos = ({ modality, location, facilityPos } = {}) => {
  const m = modalityByKey(modality);
  const l = locationByKey(location);
  if (!m) return { error: `Modality is required — one of: ${MODALITIES.map(x => x.key).join(', ')}`, code: 'MODALITY_REQUIRED' };
  if (!l) return { error: `Location is required — one of: ${LOCATIONS.map(x => x.key).join(', ')}`, code: 'LOCATION_REQUIRED' };
  if (m.key === 'telehealth') {
    // The patient's own home is 10; everywhere else is 02. This is the ONE
    // place location still decides the POS on a telehealth visit, which is why
    // location stays required even when nobody travels.
    return { pos: l.key === 'home' ? TELEHEALTH_POS_PATIENT_HOME : TELEHEALTH_POS_ELSEWHERE, source: 'telehealth_modality' };
  }
  if (l.fromFacilityRecord) {
    const p = String(facilityPos || '').trim();
    if (!p) {
      return {
        error: 'This is an in-person visit at a facility, and the place of service comes from that facility\'s record in OpenEMR, which has none set. An admin sets it on the facility (Administration → Facilities).',
        code: 'FACILITY_POS_MISSING'
      };
    }
    return { pos: p, source: 'facility_record' };
  }
  return { pos: l.pos, source: 'location' };
};

// ---- Code family ---------------------------------------------------------
// Modality first, and that ordering IS the rule. Reading location first would
// bill a video visit to a home patient as a home visit.
const resolveCodeFamily = ({ modality, location } = {}) => {
  const m = modalityByKey(modality);
  const l = locationByKey(location);
  if (!m) return { error: 'Modality is required', code: 'MODALITY_REQUIRED' };
  if (!l) return { error: 'Location is required', code: 'LOCATION_REQUIRED' };
  if (m.key === 'telehealth') {
    return { family: CODE_FAMILIES.office, telehealthModifier: true, reason: 'Telehealth bills the office/outpatient set wherever the patient is; a video visit is not a home visit.' };
  }
  if (l.key === 'clinic') return { family: CODE_FAMILIES.office, telehealthModifier: false, reason: 'Seen in clinic.' };
  return { family: CODE_FAMILIES.home, telehealthModifier: false, reason: 'Seen in person where the patient lives.' };
};

// Home and facility visits mean somebody travels, so they need an address and
// travel time on the schedule. Clinic and telehealth do not.
const visitNeedsTravel = ({ modality, location } = {}) => {
  const m = modalityByKey(modality); const l = locationByKey(location);
  if (!m || !l) return false;
  return m.key === 'in_person' && (l.key === 'home' || l.key === 'facility');
};

// ---- The note section vocabulary ----------------------------------------
// Declared ONCE. Eight templates reference these keys; a label lives here and
// nowhere else, so renaming a section renames it on every note that carries
// it rather than on the ones somebody remembered.
const SECTIONS = Object.freeze({
  chiefComplaint: 'Chief Complaint',
  reasonForVisit: 'Chief Complaint / Reason for Visit',
  hpi: 'HPI',
  intervalHistory: 'Interval History',
  pmhSurgical: 'Past Medical / Surgical History',
  familyHistory: 'Family History',
  socialHistory: 'Social History',
  medReconciliation: 'Medication Reconciliation',
  medicationReview: 'Medication Review',
  allergies: 'Allergies',
  ros: 'ROS',
  pertinentRos: 'Pertinent ROS',
  vitals: 'Vitals',
  physicalExam: 'Physical Exam',
  focusedExam: 'Focused Physical Exam',
  assessment: 'Assessment / Diagnoses',
  plan: 'Plan',
  ordersRxReferrals: 'Orders / Rx / Referrals',
  ordersRx: 'Orders / Rx',
  careManagementEligibility: 'Care Management Eligibility (CCM/BHI flag)',
  returnPrecautions: 'Return / ER Precautions',
  followUp: 'Follow-up',
  mdmOrTime: 'MDM or Total Time statement',
  // Annual wellness
  hraReview: 'Health Risk Assessment review',
  historyUpdate: 'Medical / Family History update',
  providersSuppliers: 'Current Providers & Suppliers list',
  awvVitals: 'Vitals: height, weight, BMI, BP',
  cognitiveAssessment: 'Cognitive Assessment',
  depressionScreen: 'Depression Screen',
  functionalFallRisk: 'Functional Ability & Safety / Fall Risk',
  screeningSchedule: 'Screening Schedule (5–10 yr)',
  riskFactorsInterventions: 'Risk Factors & Interventions',
  preventionPlan: 'Personalized Prevention Plan',
  advanceCarePlanning: 'Advance Care Planning (99497)',
  careGapsOrders: 'Care Gaps / Orders',
  // Transitional care
  dischargeDateFacility: 'Discharge Date & Facility',
  twoDayContact: 'Date of 2-Day Interactive Contact',
  hospitalCourse: 'Hospital Course Summary',
  dischargeRecordsReviewed: 'Discharge Records Reviewed',
  pendingTests: 'Pending Tests / Results Follow-up',
  referralsResources: 'Referrals / Community Resources',
  patientCaregiverEducation: 'Patient & Caregiver Education',
  followUpAppointments: 'Follow-up Appointments',
  mdmComplexity: 'MDM Complexity (moderate or high)',
  // Behavioral health
  psychiatricHistory: 'Psychiatric History',
  medicalHistory: 'Medical History',
  medicationHistory: 'Medication History / Prior Trials',
  substanceUse: 'Substance Use',
  familyPsychHistory: 'Family Psychiatric History',
  mentalStatusExam: 'Mental Status Exam',
  riskAssessment: 'Risk Assessment: suicide / violence',
  screeningScores: 'Screening Scores (PHQ-9, GAD-7)',
  treatmentPlan: 'Treatment Plan',
  medicationsRx: 'Medications / Rx',
  safetyPlan: 'Safety Plan',
  medicationAdherence: 'Medication Adherence & Side Effects',
  planMedChanges: 'Plan / Medication Changes',
  psychotherapyTime: 'Psychotherapy Time (separate from E/M time)',
  // IME / C&P
  examRequest: 'Exam Request / Referring Entity',
  identityVerification: 'Identity Verification',
  recordsReviewed: 'Records Reviewed',
  history: 'History',
  examination: 'Examination',
  dbqForms: 'DBQ / Required Forms',
  medicalOpinion: 'Medical Opinion',
  reportAttachment: 'Report Attachment'
});

// How a section is required:
//   true         always
//   false        offered, never demanded
//   'in_person'  required in person, offered and marked patient-reported on
//                a telehealth visit — you cannot take a blood pressure over
//                video, and demanding one would teach people to type a number
//                they did not measure
//   'risk_positive'  required once the risk assessment is not negative
const REQUIRED = Object.freeze({ ALWAYS: true, OPTIONAL: false, IN_PERSON: 'in_person', RISK_POSITIVE: 'risk_positive' });
const R = REQUIRED;

const t = (key, required) => ({ key, required });

// ---- What must be in hand before the visit -------------------------------
// ⚠️ THE MISTAKE THIS REPLACES, RECORDED SO IT IS NOT REPEATED. The first
// version of this file listed intake as free strings transcribed straight out
// of the owner's config table — `demographics`, `insurance`, `allergies`,
// `consent_to_treat` and thirty more. SEVENTEEN OF THEM ALREADY EXISTED under
// different names: the enrollment wizard has collected demographics, payer,
// conditions, medications, allergies, contacts and the medical team since
// 3.2, and consentToTreat and practiceNpp are consents in the registry. That
// made a THIRD vocabulary for things the app already had, which is precisely
// the drift `intake-fields.js` was created to end.
//
// So an intake requirement is no longer a string. It is a REFERENCE into a
// vocabulary that already owns the answer:
//
//   F('medications')   a declared intake field — public/intake-fields.js
//   C('consentToTreat') a consent — consentRegistry.js
//   D('priorRecords')  an expected document — GFC_EXPECTED_DOCUMENTS
//   I('phq9', why)     genuinely NEW, with what it is and why nothing covers it
//
// `assertIntakeIsDeclared()` runs at load and refuses a reference that does
// not resolve, so naming a field this app does not have fails the build rather
// than sitting in a config nobody cross-checks. `I()` is the only escape, and
// it has to say in words why it is not one of the other three — which is what
// makes a genuinely missing instrument visible instead of hidden among names
// that merely look new.
const intakeFields = require('./public/intake-fields.js');
const consentRegistry = require('./consentRegistry.js');

const F = (path) => ({ from: 'intake', path });
const C = (type) => ({ from: 'consent', type });
const D = (kind) => ({ from: 'document', kind });
const I = (key, why) => ({ from: 'new', key, why });
// ⚠️ OWNER, 2026-09-23: "OpenEMR already has these templates so I don't want
// to recreate but add." An instrument that exists in the EMR is NOT new, and
// calling it new is how a second PHQ-9 gets built beside the real one — the
// same mistake as the invented intake names, one layer along. `E()` says the
// template exists and this app's job is to SURFACE it.
//
// No OpenEMR template identifier is written here. Nothing in this sandbox can
// reach the EMR to check one, and inventing an id would be the third version
// of exactly the error above. The identifier is supplied by whoever wires the
// read, and `what` describes the instrument so the right template can be
// matched to it.
const E = (key, what) => ({ from: 'openemr', key, what });

// The document kinds live in server.js's GFC_EXPECTED_DOCUMENTS, which this
// pure module must not require. Mirrored as the small fixed list it is, and a
// test asserts the two agree — a mirror that can drift silently is the same
// mistake one layer along.
const EXPECTED_DOCUMENT_KINDS = Object.freeze([
  'photoId', 'insuranceCard', 'poaGuardianship', 'advanceDirective',
  'dnrPolst', 'medicationList', 'priorRecords',
  // Added in 4.9b for a faxed face sheet and a signed order. Missed out of
  // the first draft of this mirror, and caught by the test that compares the
  // two — which is the entire reason that test exists.
  'referral', 'physicianOrder',
  // Per-visit (scope VISIT, 2026-09-23). These belong to ONE encounter and
  // never appear on the client's checklist — a patient is not asked to
  // produce their own discharge summary.
  'dischargeSummary', 'dischargeMedList', 'imeRecords', 'imeExamRequest'
]);

const intakeFieldPaths = () => new Set(
  (intakeFields.ALL_FIELDS || []).map(f => f && f.path).filter(Boolean)
    .map(p => String(p).split('.')[0])
);
const consentTypes = () => new Set((consentRegistry.GFC_CONSENT_DEFS || []).map(d => d.type));

const resolveIntakeRef = (ref) => {
  if (!ref || typeof ref !== 'object') return { ok: false, why: 'not a reference' };
  if (ref.from === 'intake') {
    return intakeFieldPaths().has(String(ref.path).split('.')[0])
      ? { ok: true } : { ok: false, why: `no intake field "${ref.path}" is declared in public/intake-fields.js` };
  }
  if (ref.from === 'consent') {
    return consentTypes().has(ref.type)
      ? { ok: true } : { ok: false, why: `no consent "${ref.type}" is in the registry` };
  }
  if (ref.from === 'document') {
    return EXPECTED_DOCUMENT_KINDS.includes(ref.kind)
      ? { ok: true } : { ok: false, why: `no expected document kind "${ref.kind}"` };
  }
  if (ref.from === 'new') {
    return String(ref.why || '').trim().length > 15
      ? { ok: true } : { ok: false, why: `"${ref.key}" is declared new but does not say why nothing existing covers it` };
  }
  if (ref.from === 'openemr') {
    return String(ref.what || '').trim().length > 15
      ? { ok: true } : { ok: false, why: `"${ref.key}" comes from OpenEMR but does not say what instrument it is` };
  }
  return { ok: false, why: `unknown reference source "${ref.from}"` };
};



const APPOINTMENT_TYPES = Object.freeze([
  {
    key: 'pc_new_patient', service: 'primary_care', label: 'New Patient',
    defaultMinutes: 60, telehealthAllowed: true, telehealthPayerCaveat: true,
    credentials: ['MD', 'DO', 'NP'], specialty: null,
    intake: [
      // Already collected at enrollment — referenced, never renamed.
      F('dob'), F('gender'), F('primaryLanguage'), F('phone'), F('address'),
      F('payerType'), F('insuranceTypes'),
      F('conditions'), F('additionalDiagnoses'), F('medications'), F('allergies'),
      F('emergencyContacts'), F('primaryContact'), F('medicalTeam'),
      C('consentToTreat'), C('practiceNpp'),
      // Genuinely new: this app scores nothing today.
      E('phq2', 'PHQ-2 depression screen. A template OpenEMR already holds; surface it, do not rebuild it.')
    ],
    sections: [
      t('chiefComplaint', R.ALWAYS), t('hpi', R.ALWAYS), t('pmhSurgical', R.ALWAYS),
      t('familyHistory', R.OPTIONAL), t('socialHistory', R.ALWAYS), t('medReconciliation', R.ALWAYS),
      t('allergies', R.ALWAYS), t('ros', R.OPTIONAL), t('vitals', R.IN_PERSON), t('physicalExam', R.IN_PERSON),
      t('assessment', R.ALWAYS), t('plan', R.ALWAYS), t('ordersRxReferrals', R.OPTIONAL),
      t('careManagementEligibility', R.OPTIONAL), t('followUp', R.ALWAYS), t('mdmOrTime', R.ALWAYS)
    ]
  },
  {
    key: 'pc_follow_up', service: 'primary_care', label: 'Follow-up',
    defaultMinutes: 30, telehealthAllowed: true, telehealthPayerCaveat: true,
    credentials: ['MD', 'DO', 'NP'], specialty: null,
    intake: [
      // A follow-up CONFIRMS what is on file rather than collecting it again.
      F('dob'), F('phone'), F('payerType'), F('medications')
    ],
    sections: [
      t('reasonForVisit', R.ALWAYS), t('intervalHistory', R.ALWAYS), t('medReconciliation', R.ALWAYS),
      t('ros', R.OPTIONAL), t('vitals', R.IN_PERSON), t('physicalExam', R.IN_PERSON),
      t('assessment', R.ALWAYS), t('plan', R.ALWAYS), t('ordersRxReferrals', R.OPTIONAL),
      t('followUp', R.ALWAYS), t('mdmOrTime', R.ALWAYS)
    ]
  },
  {
    key: 'pc_acute', service: 'primary_care', label: 'Acute / Sick',
    defaultMinutes: 30, telehealthAllowed: true, telehealthPayerCaveat: true,
    credentials: ['MD', 'DO', 'NP'], specialty: null,
    intake: [
      // The reason and the onset are the note's own chief complaint and HPI,
      // so they are not restated here as intake.
      F('medications')
    ],
    sections: [
      t('chiefComplaint', R.ALWAYS), t('hpi', R.ALWAYS), t('pertinentRos', R.ALWAYS),
      t('vitals', R.IN_PERSON), t('focusedExam', R.IN_PERSON), t('medicationReview', R.OPTIONAL),
      t('assessment', R.ALWAYS), t('plan', R.ALWAYS), t('ordersRx', R.OPTIONAL),
      t('returnPrecautions', R.ALWAYS), t('followUp', R.OPTIONAL), t('mdmOrTime', R.ALWAYS)
    ]
  },
  {
    key: 'pc_awv', service: 'primary_care', label: 'Annual Wellness Visit',
    defaultMinutes: 60, telehealthAllowed: true, telehealthPayerCaveat: true,
    credentials: ['MD', 'DO', 'NP'], specialty: null,
    // See awvEligibility(): this app cannot ASK Medicare. It warns from a
    // recorded date and says where the date came from.
    priorVisitWarning: true,
    intake: [
      F('medications'), F('medicalTeam'), F('fallRisk'), F('adl'),
      E('hra', 'Medicare Health Risk Assessment for the annual wellness visit. Expected to be an existing OpenEMR template — confirm which.'),
      E('phq9', 'PHQ-9 depression screen. A template OpenEMR already holds; surface it, do not rebuild it.')
    ],
    sections: [
      t('hraReview', R.ALWAYS), t('historyUpdate', R.ALWAYS), t('providersSuppliers', R.ALWAYS),
      // Height, weight, BMI and BP are the AWV's own required element set, so
      // this one is required on a telehealth AWV too rather than IN_PERSON.
      t('awvVitals', R.ALWAYS),
      t('cognitiveAssessment', R.ALWAYS), t('depressionScreen', R.ALWAYS),
      t('functionalFallRisk', R.ALWAYS), t('screeningSchedule', R.ALWAYS),
      t('riskFactorsInterventions', R.ALWAYS), t('preventionPlan', R.ALWAYS),
      t('advanceCarePlanning', R.OPTIONAL), t('careGapsOrders', R.OPTIONAL)
    ]
  },
  {
    key: 'pc_tcm', service: 'primary_care', label: 'Transitional Care',
    defaultMinutes: 60, telehealthAllowed: true, telehealthPayerCaveat: true,
    credentials: ['MD', 'DO', 'NP'], specialty: null,
    requiresDischargeDate: true,
    intake: [
      F('medications'),
      D('priorRecords'),
      D('dischargeSummary'),
      D('dischargeMedList')
    ],
    sections: [
      t('dischargeDateFacility', R.ALWAYS), t('twoDayContact', R.ALWAYS), t('hospitalCourse', R.ALWAYS),
      t('dischargeRecordsReviewed', R.ALWAYS), t('medReconciliation', R.ALWAYS), t('pendingTests', R.ALWAYS),
      t('vitals', R.IN_PERSON), t('physicalExam', R.IN_PERSON),
      t('assessment', R.ALWAYS), t('plan', R.ALWAYS), t('referralsResources', R.OPTIONAL),
      t('patientCaregiverEducation', R.ALWAYS), t('followUpAppointments', R.ALWAYS), t('mdmComplexity', R.ALWAYS)
    ]
  },
  {
    key: 'bh_initial', service: 'behavioral_health', label: 'Psych Initial Evaluation',
    defaultMinutes: 60, telehealthAllowed: true, telehealthPayerCaveat: false,
    // A PMHNP is an NP; a psychiatrist is an MD. The SPECIALTY is what makes
    // either one a psych prescriber — see canBookType.
    credentials: ['MD', 'DO', 'NP'], specialty: 'behavioral_health',
    intake: [
      F('medications'), F('conditions'), F('allergies'),
      C('consentToTreat'),
      E('psych_intake', 'Psychiatric intake questionnaire. Expected to be an existing OpenEMR template — confirm which.'),
      E('phq9', 'PHQ-9 depression screen. A template OpenEMR already holds; surface it, do not rebuild it.'),
      E('gad7', 'GAD-7 anxiety screen. A template OpenEMR already holds; surface it, do not rebuild it.'),
      E('substance_use', 'Substance use screen. Expected to be an existing OpenEMR template — confirm which.'),
      E('prior_psych_treatment', 'Previous psychiatric treatment and medication trials, part of the psych intake questionnaire.')
    ],
    sections: [
      t('chiefComplaint', R.ALWAYS), t('hpi', R.ALWAYS), t('psychiatricHistory', R.ALWAYS),
      t('medicalHistory', R.OPTIONAL), t('medicationHistory', R.ALWAYS), t('substanceUse', R.ALWAYS),
      t('socialHistory', R.ALWAYS), t('familyPsychHistory', R.OPTIONAL),
      t('mentalStatusExam', R.ALWAYS), t('riskAssessment', R.ALWAYS), t('screeningScores', R.ALWAYS),
      t('assessment', R.ALWAYS), t('treatmentPlan', R.ALWAYS), t('medicationsRx', R.OPTIONAL),
      t('safetyPlan', R.RISK_POSITIVE), t('followUp', R.ALWAYS), t('psychotherapyTime', R.OPTIONAL)
    ]
  },
  {
    key: 'bh_follow_up', service: 'behavioral_health', label: 'Psych Follow-up / Med Mgmt',
    defaultMinutes: 30, telehealthAllowed: true, telehealthPayerCaveat: false,
    credentials: ['MD', 'DO', 'NP'], specialty: 'behavioral_health',
    intake: [
      F('medications'),
      E('phq9', 'PHQ-9 depression screen. A template OpenEMR already holds; surface it, do not rebuild it.'),
      E('gad7', 'GAD-7 anxiety screen. A template OpenEMR already holds; surface it, do not rebuild it.'),
      E('medication_adherence', 'Adherence and side effects since the last visit, asked on the psych follow-up template.')
    ],
    sections: [
      t('intervalHistory', R.ALWAYS), t('medicationAdherence', R.ALWAYS), t('mentalStatusExam', R.ALWAYS),
      t('riskAssessment', R.ALWAYS), t('screeningScores', R.OPTIONAL),
      t('assessment', R.ALWAYS), t('planMedChanges', R.ALWAYS),
      t('safetyPlan', R.RISK_POSITIVE), t('followUp', R.ALWAYS), t('psychotherapyTime', R.OPTIONAL)
    ]
  },
  {
    key: 'ime_exam', service: 'ime', label: 'Exam',
    defaultMinutes: 90, telehealthAllowed: false, telehealthPayerCaveat: false,
    credentials: ['MD', 'DO', 'NP', 'PA'], specialty: 'ime_examiner',
    // An IME is billed to the contracting entity and NEVER attached to a
    // Medicare claim. Build-enforced downstream; declared here so the rule
    // travels with the type rather than living only in a comment.
    neverMedicare: true,
    intake: [
      // An IME is not treatment: nothing about it comes from the client's own
      // enrollment record, and it is billed to the contracting entity.
      D('imeRecords'),
      D('imeExamRequest'),
    ],
    sections: [
      t('examRequest', R.ALWAYS), t('identityVerification', R.ALWAYS), t('recordsReviewed', R.ALWAYS),
      t('history', R.ALWAYS), t('examination', R.ALWAYS), t('dbqForms', R.ALWAYS),
      t('medicalOpinion', R.ALWAYS), t('reportAttachment', R.ALWAYS)
    ]
  }
]);

// Runs at LOAD. A requirement that names something this app does not have is
// a promise the booking screen cannot keep, and it must not be discoverable
// only by somebody reading the config against three other files by hand.
// Takes the types so it can be GIVEN a bad set. Called with none it checks
// the real config; a test that could only ever hand it a valid one could not
// distinguish a working assertion from a deleted one.
const assertIntakeIsDeclared = (types = APPOINTMENT_TYPES) => {
  const bad = [];
  for (const type of types) {
    for (const ref of type.intake || []) {
      const r = resolveIntakeRef(ref);
      if (!r.ok) bad.push(`${type.key}: ${r.why}`);
    }
  }
  if (bad.length) {
    throw new Error(`appointmentTypes.js declares intake this app cannot satisfy:\n  ${bad.join('\n  ')}`);
  }
};
assertIntakeIsDeclared();

// What is not satisfied yet, DERIVED rather than kept as a second list that
// goes stale — and split in two, because they are different jobs.
//
//   toSurface()  the instrument EXISTS in OpenEMR. The work is a read, and
//                building a second copy here would be the duplicate this
//                whole file was just corrected for.
//   toBuild()    genuinely nothing anywhere. The per-visit documents.
const gather = (from, describe) => {
  const out = new Map();
  for (const type of APPOINTMENT_TYPES) {
    for (const ref of (type.intake || []).filter(r => r.from === from)) {
      if (!out.has(ref.key)) out.set(ref.key, { key: ref.key, description: describe(ref), types: [] });
      out.get(ref.key).types.push(type.key);
    }
  }
  return [...out.values()];
};
const toSurface = () => gather('openemr', r => r.what);
const toBuild = () => gather('new', r => r.why);
// Kept as the union so nothing reading "what is outstanding" silently loses
// half of it when only one of the two is consulted.
const unbuiltIntake = () => [...toSurface(), ...toBuild()];

const typeByKey = (k) => APPOINTMENT_TYPES.find(a => a.key === String(k || '')) || null;
const typesForService = (svc) => APPOINTMENT_TYPES.filter(a => a.service === String(svc || ''));

// ---- What this note must contain ----------------------------------------
// Resolved per VISIT, not per type: the same appointment type demands a
// physical exam in person and does not over video.
const sectionsFor = (typeKey, { modality, riskPositive } = {}) => {
  const type = typeByKey(typeKey);
  if (!type) return [];
  const telehealth = modalityByKey(modality) && modalityByKey(modality).key === 'telehealth';
  return type.sections.map(s => {
    let required = s.required === true;
    if (s.required === R.IN_PERSON) required = !telehealth;
    if (s.required === R.RISK_POSITIVE) required = !!riskPositive;
    return {
      key: s.key, label: SECTIONS[s.key], required,
      // A vital sign taken over video was reported by the patient, and the
      // note says so rather than reading as though it was measured.
      patientReported: s.required === R.IN_PERSON && telehealth
    };
  });
};

const requiredSectionKeys = (typeKey, opts) => sectionsFor(typeKey, opts).filter(s => s.required).map(s => s.key);

// ---- Who may book it -----------------------------------------------------
// Both halves must pass. An LCSW or LMSW is refused either psych type BY
// CONSTRUCTION — neither appears in any `credentials` list — because both
// types include medication decisions and those are a prescriber's. If therapy
// is added later it gets its own type rather than widening these.
const canBookType = (typeKey, { prescriberCredential, specialties } = {}) => {
  const type = typeByKey(typeKey);
  if (!type) return { ok: false, code: 'UNKNOWN_APPOINTMENT_TYPE', error: `"${typeKey}" is not an appointment type.` };
  const cred = String(prescriberCredential || '').trim().toUpperCase();
  if (!cred) {
    return { ok: false, code: 'NO_CREDENTIAL', error: 'This clinician has no prescriber credential on file. An admin sets it on their user record.' };
  }
  if (!type.credentials.includes(cred)) {
    return { ok: false, code: 'CREDENTIAL_NOT_PERMITTED',
      error: `A ${cred} cannot be booked for ${type.label}. This type is for: ${type.credentials.join(', ')}.` };
  }
  if (type.specialty) {
    const held = Array.isArray(specialties) ? specialties.map(x => String(x).trim()) : [];
    if (!held.includes(type.specialty)) {
      return { ok: false, code: 'SPECIALTY_REQUIRED',
        error: `${type.label} needs the ${type.specialty.replace(/_/g, ' ')} specialty on this clinician's record. A PMHNP is an NP who holds it; a psychiatrist is an MD who holds it.` };
    }
  }
  return { ok: true, error: null, code: null };
};

const canBeTelehealth = (typeKey) => {
  const type = typeByKey(typeKey);
  return !!(type && type.telehealthAllowed);
};

// ---- Annual wellness eligibility ----------------------------------------
// ⚠️ THIS APP CANNOT ASK MEDICARE. There is no Palmetto or Availity
// integration — eligibility is B1 and unbuilt — so nothing here CHECKS
// anything. It warns from a date somebody recorded, and says so in the
// sentence, because a block that did not really check would read as "the
// system verified this" and that is worse than no check at all. Real blocking
// waits for B1.
const AWV_INTERVAL_DAYS = 365;
const awvEligibility = ({ lastAwvDate, today } = {}) => {
  const last = String(lastAwvDate || '').trim();
  const now = String(today || '').trim();
  if (!last) {
    return { status: 'unknown', blocking: false,
      message: 'No previous annual wellness visit is recorded for this patient. Medicare allows one every 12 months and this app cannot check with Medicare — confirm the last date before billing.' };
  }
  const a = new Date(`${last}T00:00:00Z`); const b = new Date(`${now}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) {
    return { status: 'unknown', blocking: false, message: 'The recorded last annual wellness visit date could not be read. Confirm it before billing.' };
  }
  const days = Math.floor((b - a) / 86400000);
  if (days < AWV_INTERVAL_DAYS) {
    return { status: 'too_soon', blocking: false, days,
      message: `The last annual wellness visit recorded for this patient was ${last}, ${days} days ago. Medicare allows one every 12 months, so this one is likely to be denied. This is from the date on file, not from Medicare — confirm with the payer before billing.` };
  }
  return { status: 'eligible', blocking: false, days,
    message: `Last annual wellness visit on file: ${last}, ${days} days ago. From the date on file, not from Medicare.` };
};

// ---- What this visit IS, resolved -----------------------------------------
// Three fields travel together and are stamped on the encounter at creation:
//
//     { appointmentType, modality, location }
//
// The BOOKING is authoritative. The patient's enrollment record carries their
// usual location, which is a default and nothing more: a home patient seen in
// clinic once is normal, and the booking is where that was known. Resolving
// the other way round would bill the visit at the place the patient usually
// is rather than the place they were.
const resolveVisit = ({ appointmentType, bookedModality, bookedLocation, patientDefaultLocation } = {}) => {
  const type = typeByKey(appointmentType);
  const modality = modalityByKey(bookedModality);
  const booked = locationByKey(bookedLocation);
  const fallback = locationByKey(patientDefaultLocation);
  const location = booked || fallback || null;
  const problems = [];
  if (!type) problems.push({ field: 'appointmentType', code: 'APPOINTMENT_TYPE_REQUIRED', error: 'This visit has no appointment type, so nothing can say what note it produces or what it bills as.' });
  if (!modality) problems.push({ field: 'modality', code: 'MODALITY_REQUIRED', error: 'This visit has no modality. In person and telehealth bill different code families, so it cannot be guessed.' });
  if (!location) problems.push({ field: 'location', code: 'LOCATION_REQUIRED', error: 'This visit has no location, and none is recorded on the patient either. Location sets the place of service, so it is required before the visit can be saved.' });
  if (type && modality && type.telehealthAllowed === false && modality.key === 'telehealth') {
    problems.push({ field: 'modality', code: 'TELEHEALTH_NOT_ALLOWED', error: `${type.label} cannot be done by video.` });
  }
  return {
    appointmentType: type ? type.key : null,
    modality: modality ? modality.key : null,
    location: location ? location.key : null,
    locationSource: booked ? 'booking' : (fallback ? 'patient_default' : 'unset'),
    label: type && modality && location ? `${type.label} · ${modality.label} · ${location.label}` : null,
    problems, ok: problems.length === 0
  };
};

// Which documents THIS visit needs in hand, and which are already filed.
// Derived from the appointment type's own intake list, so a type that stops
// needing one stops asking for it — no second list of "what a TCM visit
// wants" to keep in step.
const visitDocumentsFor = (appointmentType, filedKinds) => {
  const type = typeByKey(appointmentType);
  if (!type) return [];
  const filed = new Set((filedKinds || []).map(String));
  return (type.intake || [])
    .filter(r => r.from === 'document')
    .map(r => ({ kind: r.kind, filed: filed.has(r.kind) }));
};
const visitDocumentsOutstanding = (appointmentType, filedKinds) =>
  visitDocumentsFor(appointmentType, filedKinds).filter(d => !d.filed).map(d => d.kind);

const isBehavioralHealth = (appointmentType) => {
  const t = typeByKey(appointmentType);
  return !!(t && t.service === 'behavioral_health');
};

module.exports = {
  SECTIONS, REQUIRED, APPOINTMENT_TYPES,
  typeByKey, typesForService, sectionsFor, requiredSectionKeys,
  canBookType, canBeTelehealth, awvEligibility, AWV_INTERVAL_DAYS,
  resolveVisit, isBehavioralHealth, visitDocumentsFor, visitDocumentsOutstanding,
  resolveIntakeRef, assertIntakeIsDeclared, unbuiltIntake, toSurface, toBuild, EXPECTED_DOCUMENT_KINDS,

  SERVICES, MODALITIES, LOCATIONS, CODE_FAMILIES,
  TELEHEALTH_POS_PATIENT_HOME, TELEHEALTH_POS_ELSEWHERE,
  serviceByKey, modalityByKey, locationByKey,
  resolvePos, resolveCodeFamily, visitNeedsTravel
};
