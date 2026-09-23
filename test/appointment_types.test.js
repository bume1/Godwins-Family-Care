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

// ── Intake references something that already exists, or says it is new ──
// ⚠️ THE MISTAKE THESE GUARD. The first version of this config listed intake
// as free strings copied out of the owner's table — `demographics`,
// `insurance`, `allergies`, `consent_to_treat` and thirty more. SEVENTEEN
// already existed under other names: the enrollment wizard has collected
// demographics, payer, conditions, medications, allergies, contacts and the
// medical team since 3.2, and consentToTreat and practiceNpp are consents in
// the registry. It was a third vocabulary for things the app already had —
// exactly the drift `intake-fields.js` exists to end — and nothing would have
// caught it except somebody reading four files side by side.
const intakeFields = require('../public/intake-fields.js');
const consentRegistry = require('../consentRegistry.js');

test('every intake requirement resolves to a vocabulary that already owns the answer', () => {
  // Load-time assertion, re-run here so the failure names the type — and
  // GIVEN a bad set, because "it did not throw" on a valid config says nothing
  // about whether it still checks anything. That survived its first mutation.
  assert.doesNotThrow(() => A.assertIntakeIsDeclared());
  assert.throws(() => A.assertIntakeIsDeclared([
    { key: 'made_up', intake: [{ from: 'intake', path: 'demographics' }] }
  ]), /cannot satisfy/, 'the assertion must refuse a field this app does not declare');
  assert.throws(() => A.assertIntakeIsDeclared([
    { key: 'made_up', intake: [{ from: 'consent', type: 'hipaa_acknowledgment' }] }
  ]), /cannot satisfy/);
  assert.throws(() => A.assertIntakeIsDeclared([
    { key: 'made_up', intake: [{ from: 'new', key: 'x', why: 'no' }] }
  ]), /cannot satisfy/, 'and something declared new with no real reason');
  for (const type of A.APPOINTMENT_TYPES) {
    assert.ok(type.intake.length > 0, `${type.key} declares no intake`);
    for (const ref of type.intake) {
      const r = A.resolveIntakeRef(ref);
      assert.ok(r.ok, `${type.key}: ${r.why}`);
      assert.ok(['intake', 'consent', 'document', 'new', 'openemr'].includes(ref.from),
        `${type.key} uses an unknown reference source "${ref.from}"`);
      // A bare string is the mistake itself and can never come back.
      assert.notEqual(typeof ref, 'string', `${type.key} has a free-string intake item`);
    }
  }
});

test('an intake reference to something this app does not have FAILS, in every vocabulary', () => {
  // The guard has to be GIVEN something to find, or "it resolved" says nothing
  // about whether it still checks.
  assert.equal(A.resolveIntakeRef({ from: 'intake', path: 'demographics' }).ok, false,
    '"demographics" is not a declared intake field — it was one of the invented names');
  assert.equal(A.resolveIntakeRef({ from: 'intake', path: 'insurance' }).ok, false);
  assert.equal(A.resolveIntakeRef({ from: 'intake', path: 'medical_history' }).ok, false);
  assert.equal(A.resolveIntakeRef({ from: 'consent', type: 'hipaa_acknowledgment' }).ok, false,
    'the consent is called practiceNpp; the invented name must not resolve');
  assert.equal(A.resolveIntakeRef({ from: 'document', kind: 'discharge_summary' }).ok, false);
  assert.equal(A.resolveIntakeRef({ from: 'sideways', key: 'x' }).ok, false);
  assert.equal(A.resolveIntakeRef('medications').ok, false, 'a bare string is not a reference');
  assert.equal(A.resolveIntakeRef(null).ok, false);

  // And the real ones do resolve, or the guard is refusing everything.
  assert.equal(A.resolveIntakeRef({ from: 'intake', path: 'medications' }).ok, true);
  assert.equal(A.resolveIntakeRef({ from: 'intake', path: 'medicalTeam.preferredPharmacy' }).ok, true,
    'a nested path resolves through its top-level field');
  assert.equal(A.resolveIntakeRef({ from: 'consent', type: 'consentToTreat' }).ok, true);
  assert.equal(A.resolveIntakeRef({ from: 'consent', type: 'practiceNpp' }).ok, true);
  assert.equal(A.resolveIntakeRef({ from: 'document', kind: 'priorRecords' }).ok, true);
});

test('something declared NEW has to say why nothing existing covers it', () => {
  // `I()` is the only escape from the three real vocabularies, so it is the
  // one that could hide a duplicate. Requiring a reason is what makes a
  // genuinely missing instrument visible rather than lost among names that
  // merely look new.
  assert.equal(A.resolveIntakeRef({ from: 'new', key: 'phq9' }).ok, false, 'no reason given');
  assert.equal(A.resolveIntakeRef({ from: 'new', key: 'phq9', why: 'because' }).ok, false, 'not a reason');
  assert.equal(A.resolveIntakeRef({ from: 'new', key: 'phq9', why: 'Depression screen, 9-item.' }).ok, true);
  // Asserted NON-EMPTY first, and against known contents. A loop over an empty
  // list passes vacuously — the same trap, twice in one file.
  const unbuilt = A.unbuiltIntake();
  assert.ok(unbuilt.length >= 10, `expected the screening instruments and visit documents, found ${unbuilt.length}`);
  const keys = unbuilt.map(u => u.key);
  for (const expected of ['phq9', 'gad7', 'substance_use', 'hra', 'discharge_summary', 'records_received']) {
    assert.ok(keys.includes(expected), `${expected} is genuinely missing and must appear in the unbuilt list`);
  }
  // It is DERIVED from the config, so a type that stops wanting one drops out.
  assert.deepEqual(unbuilt.find(u => u.key === 'gad7').types.sort(), ['bh_follow_up', 'bh_initial']);
  assert.deepEqual(unbuilt.find(u => u.key === 'hra').types, ['pc_awv']);
  for (const u of unbuilt) {
    assert.ok(u.description.length > 15, `${u.key} must say what it is`);
    assert.ok(u.types.length > 0, `${u.key} must be wanted by at least one appointment type`);
  }
});

test('the 17 names that were invented are all gone, and the things they duplicated are referenced', () => {
  const src = fs.readFileSync(path.join(root, 'appointmentTypes.js'), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  // Each of these named something the app already had.
  const invented = ['demographics', 'insurance', 'medical_history', 'medication_list',
    'emergency_contact', 'preferred_pharmacy', 'fall_risk_screen', 'functional_adl_screen',
    'confirm_demographics', 'confirm_insurance', 'current_medications', 'medication_changes',
    'providers_and_suppliers', 'consent_to_treat', 'hipaa_acknowledgment', 'reason_for_visit', 'symptom_onset'];
  for (const name of invented) {
    assert.ok(!src.includes(`'${name}'`), `"${name}" was a second name for something that already exists — it must not come back`);
  }
  // And what they stood for is referenced through the real vocabularies.
  const refs = A.APPOINTMENT_TYPES.flatMap(t => t.intake);
  const fieldPaths = refs.filter(r => r.from === 'intake').map(r => r.path);
  for (const p of ['medications', 'allergies', 'payerType', 'conditions', 'emergencyContacts', 'medicalTeam', 'fallRisk', 'adl']) {
    assert.ok(fieldPaths.includes(p), `${p} must be referenced, not renamed`);
  }
  assert.ok(refs.some(r => r.from === 'consent' && r.type === 'consentToTreat'));
  assert.ok(refs.some(r => r.from === 'consent' && r.type === 'practiceNpp'));
});

test('the mirrored document kinds agree with the ones server.js actually declares', () => {
  // This module is pure and must not require server.js, so the kinds are
  // mirrored. A mirror that can drift silently is the same mistake one layer
  // along, so the two are compared.
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const block = (server.match(/const GFC_EXPECTED_DOCUMENTS = \[[\s\S]*?\n\];/) || [''])[0];
  assert.ok(block.length > 50, 'precondition: the document catalog was found in server.js');
  const real = [...block.matchAll(/kind: '([a-zA-Z_]+)'/g)].map(m => m[1]);
  assert.ok(real.length > 0, 'precondition: kinds were parsed');
  assert.deepEqual([...A.EXPECTED_DOCUMENT_KINDS].sort(), real.sort(),
    'the mirrored document kinds have drifted from GFC_EXPECTED_DOCUMENTS');
});

test('the intake vocabularies are READ, not copied — this file declares none of its own', () => {
  const src = fs.readFileSync(path.join(root, 'appointmentTypes.js'), 'utf8');
  // It must reach for the real declarations rather than listing them.
  assert.match(src, /require\('\.\/public\/intake-fields\.js'\)/);
  assert.match(src, /require\('\.\/consentRegistry\.js'\)/);
  assert.match(src, /intakeFields\.ALL_FIELDS/, 'intake paths come from the declaration the wizard renders');
  assert.match(src, /consentRegistry\.GFC_CONSENT_DEFS/, 'consent types come from the registry');
  // Precondition: those exports are real, or this test asserts against nothing.
  assert.ok(Array.isArray(intakeFields.ALL_FIELDS) && intakeFields.ALL_FIELDS.length > 50);
  assert.ok(Array.isArray(consentRegistry.GFC_CONSENT_DEFS) && consentRegistry.GFC_CONSENT_DEFS.length > 10);
});

// ── An instrument OpenEMR already holds is SURFACED, never rebuilt ──
// ⚠️ OWNER, 2026-09-23: "OpenEMR already has these templates so I don't want
// to recreate but add." Declaring one NEW is how a second PHQ-9 gets built
// beside the real one — the invented-intake-names mistake, one layer along.
test('a screening instrument is declared as OpenEMR’s, not as something to build', () => {
  const surfaced = A.toSurface().map(u => u.key);
  const building = A.toBuild().map(u => u.key);
  // Every instrument the note templates reference belongs to the EMR.
  for (const k of ['phq2', 'phq9', 'gad7', 'substance_use', 'hra', 'psych_intake']) {
    assert.ok(surfaced.includes(k), `${k} is an OpenEMR template — it must be surfaced, not rebuilt`);
    assert.ok(!building.includes(k), `${k} must NOT be on the build list; OpenEMR already holds it`);
  }
  // What genuinely has nowhere to live is documents, not questionnaires.
  for (const k of ['discharge_summary', 'records_received']) {
    assert.ok(building.includes(k), `${k} is a per-visit document with no home yet`);
    assert.ok(!surfaced.includes(k));
  }
  // The two lists never overlap — an item is one or the other, or "what is
  // outstanding" has two different answers.
  assert.deepEqual(surfaced.filter(k => building.includes(k)), []);
  // And the union is what anything asking "what is outstanding" gets, so
  // consulting one list alone cannot silently lose half of it.
  assert.deepEqual(A.unbuiltIntake().map(u => u.key).sort(), [...surfaced, ...building].sort());
});

test('nothing here invents an OpenEMR template identifier', () => {
  // Nothing in this sandbox can reach the EMR to check one, and a made-up id
  // would be the third version of the same error. The reference says WHAT the
  // instrument is so the right template can be matched to it by whoever wires
  // the read; it does not assert which template that is.
  for (const u of A.toSurface()) {
    assert.ok(u.description.length > 15, `${u.key} must describe the instrument`);
    // No LBF name, form id or FHIR resource id may be asserted from here.
    assert.ok(!/\bLBF[a-zA-Z0-9_]*\b/.test(u.description), `${u.key} must not name an OpenEMR form id`);
    assert.ok(!/questionnaire\/[a-z0-9-]+/i.test(u.description), `${u.key} must not assert a Questionnaire resource id`);
  }
  const src = fs.readFileSync(path.join(root, 'appointmentTypes.js'), 'utf8');
  assert.match(src, /No OpenEMR template identifier is written here/,
    'the reason must stay written down, or a later session supplies a guess');
  // An OpenEMR reference still has to say what it is, same bar as a new one.
  assert.equal(A.resolveIntakeRef({ from: 'openemr', key: 'phq9' }).ok, false);
  assert.equal(A.resolveIntakeRef({ from: 'openemr', key: 'phq9', what: 'short' }).ok, false);
  assert.equal(A.resolveIntakeRef({ from: 'openemr', key: 'phq9', what: 'PHQ-9 depression screen, held in OpenEMR.' }).ok, true);
});

test('the coverage catalog says the templates EXIST, and that writing one is refused because of it', () => {
  const coverage = require('../openemrCoverage');
  const read = coverage.CATALOG.find(r => r.resource === 'QuestionnaireResponse' && r.kind === 'read');
  const write = coverage.CATALOG.find(r => r.resource === 'Questionnaire' && r.kind === 'write');
  assert.ok(read && write);
  // The note used to hedge — "if they are ever entered in OpenEMR" — which is
  // now known to be wrong. A catalog that hedges about a fact somebody has
  // confirmed is worse than one that says nothing.
  // Asserted on what the note CLAIMS, not by banning a phrase — the first
  // version of this matched the note's own account of the hedge it removed,
  // which is a guard that cannot tell a statement from a description of one.
  assert.match(read.note, /ALREADY HOLDS|already holds/, 'the read note must say the templates exist');
  assert.match(read.note, /must not rebuild/i, 'and that this app does not rebuild them');
  assert.ok(!/^.{0,120}\bif\b.{0,40}ever entered/i.test(read.note), 'the claim must not be conditional');
  // And the write stays refused FOR THAT REASON, not despite it.
  assert.equal(write.status, 'not_wired');
  assert.match(write.note, /second copy|already/i, 'writing one would duplicate an instrument that has an authoritative version');
});
