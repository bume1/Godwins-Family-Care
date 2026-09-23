// GFC appointment types — Service + Appointment Type → Modality → Location.
// Owner config 2026-09-23. Every guard here is about what reaches a CLAIM or
// what a clinician is asked to document, so the mutations are written against
// the two ways this goes wrong: a wrong place of service, and a wrong code
// family.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const A = require('../appointmentTypes');

const root = path.join(__dirname, '..');

test('location sets the place of service, across every combination', () => {
  const pos = (modality, location, facilityPos) => A.resolvePos({ modality, location, facilityPos });
  assert.equal(pos('in_person', 'clinic').pos, '11');
  assert.equal(pos('in_person', 'home').pos, '12');
  // A facility's POS is 13, 14 or 33 depending on what kind of building it is,
  // and that lives on the facility's own record in OpenEMR. Guessing here
  // would put a second answer beside the authoritative one.
  assert.equal(pos('in_person', 'facility', '13').pos, '13');
  assert.equal(pos('in_person', 'facility', '33').pos, '33');
  assert.equal(pos('in_person', 'facility', '13').source, 'facility_record');
  // Refused, never defaulted: a facility visit billed at the wrong place is a
  // claim asserting care happened somewhere it did not.
  const missing = pos('in_person', 'facility');
  assert.equal(missing.code, 'FACILITY_POS_MISSING');
  assert.equal(missing.pos, undefined);
  assert.match(missing.error, /Administration → Facilities/);
  // Neither axis may be assumed.
  assert.equal(pos(null, 'home').code, 'MODALITY_REQUIRED');
  assert.equal(pos('in_person', null).code, 'LOCATION_REQUIRED');
  assert.equal(pos('in_person', 'nonsense').code, 'LOCATION_REQUIRED');
});

test('telehealth POS is 10 to the patient’s home and 02 everywhere else', () => {
  assert.equal(A.resolvePos({ modality: 'telehealth', location: 'home' }).pos, '10');
  assert.equal(A.resolvePos({ modality: 'telehealth', location: 'clinic' }).pos, '02');
  assert.equal(A.resolvePos({ modality: 'telehealth', location: 'facility' }).pos, '02');
  // 10 and 02 are different codes and collapsing them is a wrong claim.
  assert.notEqual(A.TELEHEALTH_POS_PATIENT_HOME, A.TELEHEALTH_POS_ELSEWHERE);
  // A telehealth visit needs no facility POS — nobody is at the facility.
  assert.equal(A.resolvePos({ modality: 'telehealth', location: 'facility' }).code, undefined);
});

test('MODALITY sets the code family, and that asymmetry is the whole rule', () => {
  const fam = (modality, location) => A.resolveCodeFamily({ modality, location });
  // In person, the location decides: home-visit codes assume the clinician is
  // physically there.
  assert.equal(fam('in_person', 'clinic').family.key, 'office');
  assert.equal(fam('in_person', 'home').family.key, 'home');
  assert.equal(fam('in_person', 'facility').family.key, 'home');
  // ⚠️ THE ONE THAT PRODUCES A FALSE CLAIM IF IT IS WRONG. A video call to a
  // patient in their own front room is NOT a home visit, and billing it as
  // one asserts a visit that never happened.
  assert.equal(fam('telehealth', 'home').family.key, 'office',
    'a telehealth visit to a home patient must NOT bill the home-visit family');
  assert.equal(fam('telehealth', 'clinic').family.key, 'office');
  assert.equal(fam('telehealth', 'facility').family.key, 'office');
  for (const loc of ['clinic', 'home', 'facility']) {
    assert.equal(fam('telehealth', loc).telehealthModifier, true, 'every telehealth visit carries the modifier');
    assert.equal(fam('in_person', loc).telehealthModifier, false, 'no in-person visit carries it');
  }
  // The two families are genuinely different ranges, or the distinction is
  // decorative.
  assert.notEqual(A.CODE_FAMILIES.office.range, A.CODE_FAMILIES.home.range);
  // No CPT code is listed anywhere: AMA copyright, and a type suggests a
  // workflow and never assigns a code.
  const src = fs.readFileSync(path.join(root, 'appointmentTypes.js'), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/\b992\d{2}\b(?!–)/.test(src.replace(/99202–99215|99341–99350/g, '')),
    'no individual CPT code may be asserted by this config');
});

test('travel is needed exactly where somebody travels', () => {
  assert.equal(A.visitNeedsTravel({ modality: 'in_person', location: 'home' }), true);
  assert.equal(A.visitNeedsTravel({ modality: 'in_person', location: 'facility' }), true);
  assert.equal(A.visitNeedsTravel({ modality: 'in_person', location: 'clinic' }), false);
  for (const loc of ['clinic', 'home', 'facility']) {
    assert.equal(A.visitNeedsTravel({ modality: 'telehealth', location: loc }), false,
      'nobody drives to a video call');
  }
});

test('the eight types are declared once, each with a note template and a duration', () => {
  assert.equal(A.APPOINTMENT_TYPES.length, 8);
  const keys = A.APPOINTMENT_TYPES.map(t => t.key);
  assert.equal(new Set(keys).size, keys.length, 'a duplicate key would make typeByKey silently pick one');
  assert.deepEqual(A.typesForService('primary_care').map(t => t.key),
    ['pc_new_patient', 'pc_follow_up', 'pc_acute', 'pc_awv', 'pc_tcm']);
  assert.equal(A.typesForService('behavioral_health').length, 2);
  assert.equal(A.typesForService('ime').length, 1);
  for (const t of A.APPOINTMENT_TYPES) {
    assert.ok(t.defaultMinutes > 0, `${t.key} needs a duration — booking has to put one number in the diary`);
    assert.ok(t.sections.length > 0, `${t.key} needs a note template`);
    assert.ok(t.credentials.length > 0, `${t.key} needs somebody who can book it`);
    assert.ok(t.intake.length > 0, `${t.key} needs its intake declared`);
    // Every section a template names must exist in the vocabulary, or the
    // note renders a blank heading nobody can fill in.
    for (const s of t.sections) {
      assert.ok(A.SECTIONS[s.key], `${t.key} names section "${s.key}", which is not declared`);
    }
  }
  assert.equal(A.typeByKey('made_up'), null);
});

test('a physical exam is required in person and patient-reported over video', () => {
  const inPerson = A.sectionsFor('pc_follow_up', { modality: 'in_person' });
  const tele = A.sectionsFor('pc_follow_up', { modality: 'telehealth' });
  const vitalsIn = inPerson.find(s => s.key === 'vitals');
  const vitalsTele = tele.find(s => s.key === 'vitals');
  assert.equal(vitalsIn.required, true);
  // You cannot take a blood pressure over video. Demanding one teaches people
  // to type a number they did not measure.
  assert.equal(vitalsTele.required, false);
  assert.equal(vitalsTele.patientReported, true, 'and the note must say it was reported, not measured');
  assert.equal(vitalsIn.patientReported, false);
  assert.equal(tele.find(s => s.key === 'physicalExam').required, false);
  // The section is still OFFERED over video — a clinician who observes
  // something has somewhere to put it.
  assert.ok(tele.some(s => s.key === 'physicalExam'));
  // Everything not marked in-person is unchanged by modality.
  assert.equal(tele.find(s => s.key === 'assessment').required, true);
  assert.equal(tele.find(s => s.key === 'medReconciliation').required, true);
});

test('the annual wellness vitals are required over video too, unlike every other exam section', () => {
  // Height, weight, BMI and BP are the AWV's own required element set, so this
  // is a deliberate exception rather than an oversight.
  const tele = A.sectionsFor('pc_awv', { modality: 'telehealth' });
  assert.equal(tele.find(s => s.key === 'awvVitals').required, true);
  assert.equal(tele.find(s => s.key === 'awvVitals').patientReported, false);
});

test('a safety plan is required once risk is positive, and not before', () => {
  for (const type of ['bh_initial', 'bh_follow_up']) {
    const negative = A.sectionsFor(type, { modality: 'in_person', riskPositive: false });
    const positive = A.sectionsFor(type, { modality: 'in_person', riskPositive: true });
    assert.equal(negative.find(s => s.key === 'safetyPlan').required, false);
    assert.equal(positive.find(s => s.key === 'safetyPlan').required, true, `${type} must demand a safety plan once risk is positive`);
    // The risk assessment itself is always required on a psych visit.
    assert.equal(negative.find(s => s.key === 'riskAssessment').required, true);
    assert.equal(positive.find(s => s.key === 'mentalStatusExam').required, true);
  }
  assert.ok(A.requiredSectionKeys('bh_initial', { modality: 'in_person', riskPositive: true }).includes('safetyPlan'));
  assert.ok(!A.requiredSectionKeys('bh_initial', { modality: 'in_person', riskPositive: false }).includes('safetyPlan'));
});

test('a psych visit needs the credential AND the specialty, and an LCSW can never book one', () => {
  // A PMHNP is an NP who holds the specialty; a psychiatrist is an MD who
  // holds it. Making PMHNP its own prescriber credential would stop the
  // Schedule II guard recognising that person as an NP, and a Georgia NP is
  // refused a Schedule II by law — so the specialty is a separate field.
  assert.equal(A.canBookType('bh_initial', { prescriberCredential: 'NP', specialties: ['behavioral_health'] }).ok, true);
  assert.equal(A.canBookType('bh_initial', { prescriberCredential: 'MD', specialties: ['behavioral_health'] }).ok, true);
  assert.equal(A.canBookType('bh_initial', { prescriberCredential: 'NP', specialties: [] }).code, 'SPECIALTY_REQUIRED');
  assert.equal(A.canBookType('bh_follow_up', { prescriberCredential: 'NP' }).code, 'SPECIALTY_REQUIRED');
  // Both psych types include medication decisions, which are a prescriber's.
  // An LCSW or LMSW holds no prescriber credential at all, so they are refused
  // BY CONSTRUCTION — no credential list mentions them.
  assert.equal(A.canBookType('bh_initial', { prescriberCredential: '', specialties: ['behavioral_health'] }).code, 'NO_CREDENTIAL');
  for (const t of A.APPOINTMENT_TYPES) {
    for (const bad of ['LCSW', 'LMSW', 'RN']) {
      assert.ok(!t.credentials.includes(bad), `${t.key} must not admit ${bad}`);
      assert.equal(A.canBookType(t.key, { prescriberCredential: bad, specialties: ['behavioral_health', 'ime_examiner'] }).code,
        'CREDENTIAL_NOT_PERMITTED', `${bad} must be refused ${t.key}`);
    }
  }
  // A PA may do primary care and an IME but not psych.
  assert.equal(A.canBookType('bh_initial', { prescriberCredential: 'PA', specialties: ['behavioral_health'] }).code, 'CREDENTIAL_NOT_PERMITTED');
  assert.equal(A.canBookType('ime_exam', { prescriberCredential: 'PA', specialties: ['ime_examiner'] }).ok, true);
  assert.equal(A.canBookType('made_up', { prescriberCredential: 'MD' }).code, 'UNKNOWN_APPOINTMENT_TYPE');
});

test('an IME is examiner-only, never telehealth, and never a Medicare claim', () => {
  const ime = A.typeByKey('ime_exam');
  assert.equal(ime.specialty, 'ime_examiner');
  assert.equal(A.canBookType('ime_exam', { prescriberCredential: 'MD', specialties: [] }).code, 'SPECIALTY_REQUIRED');
  // An IME is not treatment and is not billed to Medicare.
  assert.equal(ime.neverMedicare, true);
  assert.equal(A.canBeTelehealth('ime_exam'), false);
  // Every other type may be telehealth; behavioural telehealth to the home is
  // permanent, the rest carry a payer caveat.
  for (const t of A.APPOINTMENT_TYPES.filter(x => x.key !== 'ime_exam')) {
    assert.equal(A.canBeTelehealth(t.key), true, `${t.key} must be bookable as telehealth`);
  }
  assert.equal(A.typeByKey('bh_initial').telehealthPayerCaveat, false, 'behavioural telehealth to the home is permanent');
  assert.equal(A.typeByKey('pc_follow_up').telehealthPayerCaveat, true, 'non-behavioural telehealth depends on current CMS flexibilities');
});

test('annual wellness eligibility WARNS from a recorded date and never claims to have checked Medicare', () => {
  // ⚠️ This app has no Palmetto or Availity integration — eligibility is B1
  // and unbuilt. A block that did not really check would read as "the system
  // verified this", which is worse than no check at all.
  const tooSoon = A.awvEligibility({ lastAwvDate: '2026-06-01', today: '2026-09-23' });
  assert.equal(tooSoon.status, 'too_soon');
  assert.equal(tooSoon.blocking, false, 'it must not block on something it cannot observe');
  assert.match(tooSoon.message, /not from Medicare/i, 'the message must say where the date came from');

  const eligible = A.awvEligibility({ lastAwvDate: '2025-06-01', today: '2026-09-23' });
  assert.equal(eligible.status, 'eligible');
  assert.equal(eligible.blocking, false);

  // No date on file is "unknown", never "eligible" — an absent record is not
  // evidence that the visit is allowed.
  const none = A.awvEligibility({ today: '2026-09-23' });
  assert.equal(none.status, 'unknown');
  assert.notEqual(none.status, 'eligible');
  assert.equal(A.awvEligibility({ lastAwvDate: 'not-a-date', today: '2026-09-23' }).status, 'unknown');

  // Nothing anywhere in the config pretends to reach a payer.
  const src = fs.readFileSync(path.join(root, 'appointmentTypes.js'), 'utf8');
  assert.ok(!/fetch\(|https?:\/\//.test(src), 'this config must make no network call');
  // The boundary is exactly 12 months.
  assert.equal(A.awvEligibility({ lastAwvDate: '2025-09-23', today: '2026-09-23' }).status, 'eligible');
  assert.equal(A.awvEligibility({ lastAwvDate: '2025-09-24', today: '2026-09-23' }).status, 'too_soon');
});

test('transitional care declares the discharge date it cannot be booked without', () => {
  assert.equal(A.typeByKey('pc_tcm').requiresDischargeDate, true);
  // The two deadline elements are required sections, so the note carries what
  // the claim depends on.
  const req = A.requiredSectionKeys('pc_tcm', { modality: 'in_person' });
  assert.ok(req.includes('dischargeDateFacility'));
  assert.ok(req.includes('twoDayContact'));
  assert.ok(req.includes('medReconciliation'));
  assert.ok(req.includes('mdmComplexity'));
  // No other type demands a discharge date.
  for (const t of A.APPOINTMENT_TYPES.filter(x => x.key !== 'pc_tcm')) {
    assert.ok(!t.requiresDischargeDate, `${t.key} must not demand a discharge date`);
  }
});
