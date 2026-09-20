// ============================================================================
// The enrollment submission, declared once (2026-09-20)
// ============================================================================
// Owner instruction: "make sure the entire enrollment editable by admin and
// clinicians essentially." Two days earlier a staff editor was built covering
// what the enrollment page displays — about thirty values. The rest of the
// submission, roughly a hundred and twenty answers across the care situation,
// the schedule, function and safety, and caregiver matching, was still the
// client's alone and could be corrected by nobody.
//
// WHY THIS IS A MODULE AND NOT A HUNDRED MORE FORM FIELDS.
// The questions used to live in exactly one place — the JSX of the client's
// intake wizard — with the staff editor restating a subset of them and the
// server restating a third copy as its allow-list. Three copies of "what an
// enrollment asks" is three copies that drift, and the drift is silent: a
// select offering an option the validator refuses, or a validator refusing a
// value the wizard just saved. This file is the one declaration. The wizard
// renders from it, the staff editor renders from it, and the server validates
// against it — which is the rule the competency catalog and the consent
// registry already follow, applied to the biggest form in the app.
//
// IT IS STILL AN ALLOW-LIST, which is the point of declaring it. A path this
// file does not carry never reaches a client record through the staff editor,
// so a field a later session adds to the wizard is not silently staff-writable
// until somebody puts it here. Four things are deliberately outside it, each
// because it already has ONE writer and two writers for one value is how the
// two start disagreeing:
//
//   the client's NAME        — the admin user form
//   the SERVICE LINE         — its own route, which recomputes the consent set
//   the CARE TIER            — the clinician's triage at the H&P
//   the AGREED RATE          — its own route, with its own re-signature rule
//
// And three kinds of value are outside it because they are not answers at all:
// the consent signatures and their provenance, the derived fields (age, prior
// providers, timestamps), and `uploads`, which holds pointers to files in Drive
// and is managed by the document-exchange routes.
// ============================================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GFC_INTAKE_FIELDS = api;
})(typeof self !== 'undefined' ? self : this, function () {

  // ---- Option catalogs -----------------------------------------------------
  // Lifted verbatim out of the intake wizard, where they were declared inline
  // as `IO`. The wizard now reads them from here, so an option a client was
  // offered is provably the same string the staff editor offers and the
  // validator accepts.
  const OPTIONS = {
    gender: ['Female', 'Male', 'Non-binary', 'Prefer not to say'],
    livesWith: ['Lives alone', 'Spouse / partner', 'Adult child', 'Other family member', 'Assisted living / memory care'],
    contactRelationship: ['Spouse / Partner', 'Adult child', 'Sibling', 'Legal guardian', 'Other family member'],
    contactPreference: ['Phone call', 'Text message', 'Email'],
    decisionAuthority: ['Yes — legal (POA/guardianship)', 'Yes — family decision-maker, informal', 'No — client decides', 'Shared'],
    servicePath: ['Home Care', 'In-Home Primary Care', 'Both', 'Not sure'],
    adlLevel: ['Independent', 'Some help', 'A lot of help', 'Total assistance'],
    helpNeeded: ['Companionship & socialization', 'Personal care / bathing / dressing', 'Medication reminders', 'Mobility & transfer assistance', 'Meal preparation', 'Transportation to appointments', 'Overnight or 24/7 care', 'Memory care / dementia support', 'Skilled nursing at home', 'Hospice or end-of-life support'],
    appointmentAccess: ['No difficulty', 'Somewhat difficult', 'Very difficult', 'Cannot attend'],
    ongoingConditions: ['Diabetes', 'Heart condition / CHF', 'COPD / breathing issues', "Dementia / Alzheimer's", 'Stroke / neurological', 'Recent hospitalization', 'Multiple chronic conditions', 'None / generally healthy'],
    hasPCP: ['Yes', 'No', 'Unsure'],
    cognitionLevel: ['None', 'Mild', 'Moderate', 'Significant'],
    urgency: ['Immediately', 'Within a week', 'Within a month', 'Just exploring'],
    preferredDays: ['Weekday mornings', 'Weekday afternoons', 'Weekday evenings', 'Weekends', 'Overnight', '24/7 continuous'],
    recurring: ['Recurring', 'One-time', 'Not sure'],
    paymentExpectation: ['Private pay', 'Insurance', 'Medicaid', 'Medicare', 'Combination', 'Not sure'],
    serviceInterests: ['Case management', 'Behavioral health support', 'Continuous Care Program', 'Not interested in add-on services'],
    caregiverStress: ['Managing fine', 'Stretched thin', 'Overwhelmed', 'Breaking point'],
    homebound: ['Completely homebound', 'Leaves with assistance', 'Leaves occasionally', 'Independent'],
    appointmentDifficulty: ['Cannot attend', 'Very difficult', 'Somewhat difficult', 'No difficulty'],
    currentServices: ['Home health', 'Hospice', 'Palliative care', 'Skilled nursing (private)', 'Outpatient PT/OT', 'None'],
    hbpcInterests: ['In-home primary care visits', 'Telehealth visits', 'Medication management', 'Chronic disease management', 'Labs drawn at home', 'Mobile imaging', 'Care coordination across providers'],
    diagnoses: ["Dementia / Alzheimer's", "Parkinson's disease", 'Stroke / TIA', 'Depression', 'Anxiety', 'COPD / respiratory', 'Heart failure / cardiac', 'Diabetes', 'Cancer', 'Arthritis', 'Osteoporosis', 'Renal disease', 'Bipolar disorder', 'Schizophrenia', 'PTSD', 'Substance use history'],
    dnr: ['Yes — DNR in place', 'Yes — advance directive / living will', 'Yes — healthcare proxy / POA', 'No', 'Unknown'],
    skilledTasks: ['Wound care', 'Injections', 'Catheter care', 'Ostomy care', 'Tube feeding', 'Oxygen management', 'Suctioning', 'Tracheostomy care', 'IV therapy', 'Blood glucose monitoring', 'Blood pressure monitoring', 'Medication administration', 'Behavioral supervision', 'Seizure monitoring', 'None'],
    recentEvents: ['Hospitalized in past 30 days', 'SNF or rehab stay in past 90 days', 'Recent falls', 'Recent infections', 'New medications since discharge', 'Difficulty following discharge instructions', 'Concern for readmission'],
    adlLevels: ['Independent', 'Needs verbal cues', 'Needs physical assistance', 'Fully dependent'],
    adlWalking: ['Independent', 'Uses walker / cane', 'Needs physical assistance', 'Wheelchair — self-propels', 'Wheelchair — pushed', 'Bed-bound'],
    adlToileting: ['Independent', 'Needs verbal cues', 'Needs physical assistance', 'Incontinent — needs full care'],
    adlTransfers: ['Independent', 'Standby assist', 'Hands-on assist', 'Two-person assist / mechanical lift'],
    fallRisk: ['Low', 'Moderate', 'High'],
    transferNeed: ['Independent', 'Standby', 'One-person assist', 'Two-person assist', 'Mechanical lift'],
    equipment: ['Walker', 'Cane', 'Wheelchair', 'Hoyer lift', 'Hospital bed', 'Grab bars', 'Shower chair', 'Stair lift'],
    iadl: ['Meal preparation', 'Grocery shopping', 'Light housekeeping', 'Laundry', 'Medication reminders', 'Transportation to appointments', 'Errands', 'Companionship', 'Phone / technology help', 'Managing mail / paperwork'],
    cognitiveStatus: ['Intact', 'Mild impairment', 'Moderate dementia', 'Severe dementia', 'Mental health diagnosis affecting cognition'],
    dementiaStage: ['Early / mild', 'Moderate', 'Late / severe', 'Unknown / undiagnosed'],
    behavioral: ['Wandering', 'Agitation / aggression', 'Sundowning', 'Sleep disturbances', 'Hallucinations', 'Mood swings', 'Resistance to care', 'Self-harm risk', 'Suicidal ideation history'],
    functionalRisk6mo: ['Fallen', 'Wandered from home', 'Been hospitalized', 'Significant weight loss', 'Missed medications', 'Left stove/appliances running', 'Become aggressive', 'Missed important appointments', 'Experienced dehydration', 'None'],
    homeSafety: ['Smokers in home', 'Pets in home', 'Firearms in home', 'Hoarding or clutter', 'Pest issues', 'Stairs required', 'Oxygen tanks', 'Working utilities', 'Other household substance use', 'None'],
    twoPersonAssist: ['No', 'Sometimes', 'Yes routinely'],
    decisionMaking: ['Client independently', 'Shared with family', 'Surrogate decision-maker needed', 'Capacity concerns'],
    legalDocs: ['Healthcare POA activated', 'Financial POA activated', 'Guardianship', 'Healthcare surrogate designated', 'Advance directive on file', 'None'],
    personality: ['Quiet and reserved', 'Warm and chatty', 'Likes structure and routine', 'Prefers independence', 'Can get anxious', 'Resistant to care'],
    genderPref: ['No preference', 'Female preferred', 'Male preferred', 'Female — strong', 'Male — strong'],
    caregiverExp: ['Entry-level OK', 'Some experience', 'Experienced', 'Dementia-trained', 'Behavioral support certified'],
    insuranceTypes: ['Medicare Part A & B', 'Medicare Advantage', 'Medicaid', 'Dual eligible', 'VA benefits', 'Commercial insurance', 'Managed care organization', 'Long-term care insurance', 'Private pay only'],
    payerType: ['Private pay', 'LTC insurance', 'Medicaid waiver', 'VA', 'Medicare Part B', 'Dual eligible', 'Commercial', 'Combination'],
    medicareType: ['Part A & B', 'Medicare Advantage (Part C)', 'Dual eligible', 'Not applicable'],
    medicaidWaiver: ['CCSP', 'ICWP', 'SOURCE', 'Katie Beckett', 'Other waiver', 'Not on a waiver'],
    policyHolderRel: ['Self', 'Spouse', 'Parent', 'Child', 'Other'],
    homeBenefit: ['Covered — verified', 'Covered — unverified', 'Not covered', 'Unknown'],
    ltcCarrier: ['Genworth', 'Mutual of Omaha', 'Northwestern Mutual', 'John Hancock', 'Transamerica', 'Other', 'Not applicable'],
    auth911: ['Yes — authorized', 'Yes — call family first if time allows', 'No — always call family first'],
    usState: ['GA', 'AL', 'FL', 'NC', 'SC', 'TN']
  };

  // `open: true` marks a select whose list is a SUGGESTION rather than the whole
  // world. Staff transcribing from a phone call write "Daughter" where the
  // wizard offers "Adult child", and every one of these four was a free-text box
  // on the staff editor before the sections were declared here — turning them
  // into closed vocabularies would have narrowed what the office could already
  // record, silently. Everything else is a closed list: the client picked from
  // it, and the matching and billing engines read the codes behind it.
  const f = (path, label, type, extra) => Object.assign({ path, label, type: type || 'text' }, extra || {});

  // ---- The submission, section by section ----------------------------------
  // The order and grouping follow the client's own wizard, so a staff member on
  // the phone with a client is reading the questions in the order the client
  // was asked them.
  const SECTIONS = [
    {
      key: 'client', label: 'Client details',
      blurb: 'Identity and where they live. These print onto the face sheet and into signed consents.',
      fields: [
        f('clientFirst', 'Client first name'),
        f('clientLast', 'Client last name'),
        f('preferredName', 'Preferred name / nickname'),
        f('dob', 'Date of birth', 'date'),
        f('gender', 'Gender', 'select', { options: 'gender', open: true }),
        f('primaryLanguage', 'Primary language'),
        f('phone', 'Home phone', 'tel'),
        f('addressLine1', 'Home address, as the client gave it'),
        f('livesWith', 'Lives with', 'select', { options: 'livesWith' }),
        // The structured address is the staff-side copy: the wizard captures one
        // free-text line, and scheduling, the geofence and the consents need the
        // parts. Both are kept — overwriting what the client typed with our
        // parse of it loses the original.
        f('address.line1', 'Street address', 'text', { staffOnly: true }),
        f('address.line2', 'Apt / unit', 'text', { staffOnly: true }),
        f('address.city', 'City', 'text', { staffOnly: true }),
        f('address.state', 'State', 'select', { options: 'usState', staffOnly: true, open: true }),
        f('address.zip', 'ZIP', 'text', { staffOnly: true })
      ]
    },
    {
      key: 'contacts', label: 'Contacts and authority',
      fields: [
        f('submitter.first', 'Form submitter — first name'),
        f('submitter.last', 'Form submitter — last name'),
        f('submitter.email', 'Form submitter — email', 'email'),
        f('submitter.phone', 'Form submitter — phone', 'tel'),
        f('primaryContact.name', 'Primary contact — full name'),
        f('primaryContact.relationship', 'Primary contact — relationship', 'select', { options: 'contactRelationship', open: true }),
        f('primaryContact.phone', 'Primary contact — phone', 'tel'),
        f('primaryContact.email', 'Primary contact — email', 'email'),
        f('primaryContact.preferredChannel', 'Best way to reach them', 'select', { options: 'contactPreference' }),
        f('decisionAuthority', 'Authorized to make care decisions?', 'select', { options: 'decisionAuthority' }),
        f('emergencyContacts', 'Emergency contacts', 'list', {
          keys: ['name', 'relationship', 'phone', 'email', 'address'],
          requires: ['name'],
          columns: [
            { key: 'name', label: 'Full name' },
            { key: 'relationship', label: 'Relationship' },
            { key: 'phone', label: 'Phone', type: 'tel' },
            { key: 'email', label: 'Email', type: 'email' },
            { key: 'address', label: 'Address' }
          ]
        })
      ]
    },
    {
      key: 'situation', label: 'Care situation',
      fields: [
        f('situation.adlLevel', 'Level of help needed with daily activities', 'select', { options: 'adlLevel' }),
        f('helpNeeded', 'Types of personal care / home support', 'multi', { options: 'helpNeeded' }),
        f('ongoingConditions', 'Ongoing health conditions being managed', 'multi', { options: 'ongoingConditions' }),
        f('situation.cognitionLevel', 'Memory or cognition concerns', 'select', { options: 'cognitionLevel' }),
        f('situation.hasPCP', 'Has a primary care provider?', 'select', { options: 'hasPCP' }),
        f('situation.appointmentAccess', 'Difficulty getting to in-office appointments', 'select', { options: 'appointmentAccess' }),
        f('situation.mainReason', "What's prompting them to reach out now?", 'textarea'),
        f('caregiverStress', 'How the family caregiver is holding up', 'select', { options: 'caregiverStress' }),
        f('stressNotes', 'Anything else we should know', 'textarea')
      ]
    },
    {
      key: 'schedule', label: 'Schedule and urgency',
      fields: [
        f('schedule.startDate', 'Requested start date', 'date'),
        f('schedule.hoursPerWeek', 'Hours per week (approx.)', 'number'),
        f('schedule.urgency', 'How soon care is needed', 'select', { options: 'urgency' }),
        f('schedule.recurring', 'Recurring or one-time', 'select', { options: 'recurring' }),
        f('preferredDays', 'Preferred days / shifts', 'multi', { options: 'preferredDays' }),
        f('schedule.paymentExpectation', 'How they expect to pay', 'select', { options: 'paymentExpectation' }),
        f('serviceInterests', 'Support services of interest', 'multi', { options: 'serviceInterests' })
      ]
    },
    {
      key: 'homebound', label: 'Homebound and recent care',
      fields: [
        f('homebound', 'Homebound status', 'select', { options: 'homebound' }),
        f('appointmentDifficulty', 'Difficulty attending in-office appointments', 'select', { options: 'appointmentDifficulty' }),
        f('lastPCPVisit', 'Last PCP visit'),
        f('lastHospitalization', 'Last hospitalization'),
        f('erVisits6mo', 'ER visits in past 6 months', 'number'),
        f('currentServices', 'Currently receiving', 'multi', { options: 'currentServices' }),
        f('hbpcInterests', 'In-home medical services of interest', 'multi', { options: 'hbpcInterests' })
      ]
    },
    {
      key: 'medical', label: 'Medical',
      fields: [
        f('conditions', 'Primary diagnoses', 'multi', { options: 'diagnoses' }),
        f('additionalDiagnoses', 'Additional diagnoses or medical history', 'textarea'),
        f('allergies', 'Known allergies', 'textarea'),
        f('advanceDirective.status', 'DNR / advance directive on file?', 'select', { options: 'dnr' }),
        f('medications', 'Medications', 'list', {
          keys: ['name', 'dose', 'route', 'frequency', 'prescriber', 'pharmacy'],
          requires: ['name'],
          columns: [
            { key: 'name', label: 'Medication' },
            { key: 'dose', label: 'Dose' },
            { key: 'route', label: 'Route' },
            { key: 'frequency', label: 'Frequency' },
            { key: 'prescriber', label: 'Prescriber' },
            { key: 'pharmacy', label: 'Pharmacy' }
          ]
        }),
        f('medNotes', 'Additional medication notes', 'textarea'),
        f('medicalTeam.pcpName', 'Primary care physician'),
        f('medicalTeam.pcpPractice', 'PCP practice / clinic'),
        f('medicalTeam.pcpPhone', 'PCP phone', 'tel'),
        f('medicalTeam.specialist1Name', 'Specialist 1'),
        f('medicalTeam.specialist1Phone', 'Specialist 1 phone', 'tel'),
        f('medicalTeam.specialist2Name', 'Specialist 2'),
        f('medicalTeam.preferredHospital', 'Preferred hospital / ER'),
        f('medicalTeam.preferredPharmacy', 'Preferred pharmacy'),
        f('medicalTeam.pharmacyPhone', 'Pharmacy phone', 'tel'),
        f('skilledTasksNeeded', 'Skilled care needs', 'multi', { options: 'skilledTasks' }),
        f('skilledTasksProvider', 'Who currently performs these skilled tasks', 'textarea'),
        f('recentEvents', 'Recent clinical events (past 30–90 days)', 'multi', { options: 'recentEvents' })
      ]
    },
    {
      key: 'function', label: 'Function and safety',
      fields: [
        f('adl.bathing', 'Bathing / showering', 'select', { options: 'adlLevels' }),
        f('adl.dressing', 'Dressing', 'select', { options: 'adlLevels' }),
        f('adl.grooming', 'Grooming (hair, teeth, nails)', 'select', { options: 'adlLevels' }),
        f('adl.toileting', 'Toileting', 'select', { options: 'adlToileting' }),
        f('adl.transfers', 'Transferring (bed, chair, car)', 'select', { options: 'adlTransfers' }),
        f('adl.ambulation', 'Ambulation / walking', 'select', { options: 'adlWalking' }),
        f('adl.eating', 'Eating / feeding', 'select', { options: 'adlLevels' }),
        f('fallRisk', 'Fall risk', 'select', { options: 'fallRisk' }),
        f('transferNeed', 'Transfer / lift need', 'select', { options: 'transferNeed' }),
        f('equipment', 'Mobility equipment at home', 'multi', { options: 'equipment' }),
        f('adlNotes', 'Additional ADL notes', 'textarea'),
        f('iadl', 'Household tasks needing help', 'multi', { options: 'iadl' }),
        f('dietary', 'Dietary needs or restrictions'),
        f('foodAllergies', 'Food allergies'),
        f('cognitiveStatus', 'Cognitive status', 'select', { options: 'cognitiveStatus' }),
        f('dementiaStage', 'Dementia stage', 'select', { options: 'dementiaStage' }),
        f('behavioralFlags', 'Behavioral concerns', 'multi', { options: 'behavioral' }),
        f('behavioralNotes', 'Behavioral notes — triggers, patterns, what helps', 'textarea'),
        f('functionalRisk6mo', 'In the past 6 months, has the client…', 'multi', { options: 'functionalRisk6mo' }),
        f('homeSafetyFlags', 'Home environment / staff safety', 'multi', { options: 'homeSafety' }),
        f('twoPersonAssist', 'Does any task require two-person assist?', 'select', { options: 'twoPersonAssist' }),
        f('staffSafetyConcerns', 'Anything else affecting staff safety', 'textarea'),
        f('decisionMaking', 'Who makes healthcare / care decisions', 'select', { options: 'decisionMaking' }),
        f('legalDocs', 'Legal status', 'multi', { options: 'legalDocs' })
      ]
    },
    {
      key: 'matching', label: 'Caregiver match',
      blurb: 'Preferences, not requirements. The matching engine reads these.',
      fields: [
        f('matching.personality', "Client's personality", 'multi', { options: 'personality' }),
        f('matching.genderPreference', 'Gender preference for caregiver', 'select', { options: 'genderPref' }),
        f('matching.languagePreference', 'Language / cultural preferences'),
        f('matching.caregiverExperience', 'Caregiver experience required', 'select', { options: 'caregiverExp' }),
        f('matching.interests', 'Interests, hobbies, what brings comfort', 'textarea'),
        f('matching.pastCaregiver', 'Past caregiver experience', 'textarea')
      ]
    },
    {
      key: 'insurance', label: 'Insurance and payment',
      fields: [
        f('ssnLast4', 'SSN (last 4 only)'),
        f('insuranceTypes', 'Insurance types held', 'multi', { options: 'insuranceTypes' }),
        f('payerType', 'Primary payer type', 'select', { options: 'payerType' }),
        f('medicare.id', 'Medicare ID / beneficiary number'),
        f('medicare.type', 'Medicare type', 'select', { options: 'medicareType' }),
        f('medicare.advantagePlan', 'Medicare Advantage plan name'),
        f('medicare.advMemberId', 'Advantage member ID'),
        f('medicare.advGroupNum', 'Advantage group #'),
        f('medicare.partD', 'Medicare Part D plan'),
        f('medicaid.memberId', 'Medicaid member ID'),
        f('medicaid.plan', 'Medicaid managed care plan'),
        f('medicaid.waiver', 'Medicaid waiver program', 'select', { options: 'medicaidWaiver' }),
        f('medicaid.caseManager', 'Medicaid case manager'),
        f('medicaid.caseManagerPhone', 'Case manager phone', 'tel'),
        f('commercial.carrier', 'Insurance carrier'),
        f('commercial.planName', 'Plan name'),
        f('commercial.memberId', 'Member ID'),
        f('commercial.groupNum', 'Group number'),
        f('commercial.policyHolder', 'Policy holder name'),
        f('commercial.policyHolderDob', 'Policy holder DOB', 'date'),
        f('commercial.policyHolderRel', 'Policy holder relationship', 'select', { options: 'policyHolderRel' }),
        f('commercial.insPhone', 'Insurance phone (member services)', 'tel'),
        f('commercial.homeBenefit', 'Home health / personal care benefit', 'select', { options: 'homeBenefit' }),
        f('ltc.carrier', 'LTC insurance carrier', 'select', { options: 'ltcCarrier', open: true }),
        f('ltc.carrierOther', 'Other LTC carrier name'),
        f('ltc.policyNum', 'LTC policy number'),
        f('ltc.policyHolder', 'LTC policy holder name'),
        f('ltc.benefit', 'Daily / monthly benefit'),
        f('ltc.elimination', 'Elimination period'),
        f('ltc.notes', 'LTC insurance notes', 'textarea'),
        f('insuranceIds', 'Insurance cards on file', 'list', {
          keys: ['carrier', 'memberId', 'group'],
          requires: ['carrier', 'memberId'],
          columns: [
            { key: 'carrier', label: 'Carrier' },
            { key: 'memberId', label: 'Member ID' },
            { key: 'group', label: 'Group' }
          ]
        }),
        f('paymentMethod', 'Primary payment method'),
        f('billingContact', 'Billing contact (if different)')
      ]
    },
    {
      key: 'emergency', label: 'Emergency and information sharing',
      fields: [
        f('auth911', 'Call 911 in a medical emergency?', 'select', { options: 'auth911' }),
        f('crisisNotify', 'Who to notify first in a crisis'),
        f('roiFamilyDetail.authorized', 'Who may receive information about the client'),
        f('roiFamilyDetail.restrictions', 'Restrictions on information sharing')
      ]
    }
  ];

  // ---- Derived views, computed once ----------------------------------------
  const ALL_FIELDS = [];
  SECTIONS.forEach(s => s.fields.forEach(x => ALL_FIELDS.push(Object.assign({ section: s.key }, x))));

  const LIST_FIELDS = ALL_FIELDS.filter(x => x.type === 'list');
  const VALUE_FIELDS = ALL_FIELDS.filter(x => x.type !== 'list');

  const EDITABLE_PATHS = Object.freeze(VALUE_FIELDS.map(x => x.path));
  const LISTS = Object.freeze(LIST_FIELDS.reduce((acc, x) => {
    acc[x.path] = { keys: x.keys, requires: x.requires, columns: x.columns };
    return acc;
  }, {}));

  const BY_PATH = ALL_FIELDS.reduce((acc, x) => { acc[x.path] = x; return acc; }, {});
  const fieldAt = (path) => BY_PATH[path] || null;
  const optionsFor = (field) => (field && field.options ? (OPTIONS[field.options] || []) : []);

  // A path is editable when this file declares it. Nothing else makes it so.
  const isEditablePath = (path) => EDITABLE_PATHS.indexOf(path) !== -1;

  // Named so the refusal can say WHY, rather than answering "unknown field" for
  // a value that is deliberately somebody else's to write.
  const HAS_ANOTHER_WRITER = Object.freeze({
    name: 'the client name is set on the admin user form',
    clientName: 'the client name is set on the admin user form',
    serviceLine: 'the service line has its own route, which recomputes the consent set',
    careTier: 'the care tier is the clinician’s triage at the H&P',
    rateAgreement: 'the agreed rate has its own route, with its own re-signature rule',
    consents: 'a consent is signed, never edited',
    consentMeta: 'a consent is signed, never edited',
    uploads: 'uploaded documents are managed on the Documents card',
    age: 'age is derived from the date of birth',
    priorProviders: 'the prior-provider list is derived from the medical team'
  });

  return {
    OPTIONS, SECTIONS, ALL_FIELDS, VALUE_FIELDS, LIST_FIELDS,
    EDITABLE_PATHS, LISTS, fieldAt, optionsFor, isEditablePath, HAS_ANOTHER_WRITER
  };
});
