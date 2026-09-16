// ============================================================================
// THE CAREGIVER WELCOME PACKET — the vocabulary and the rules, in one place
// ============================================================================
// Ported from the printed packet "GFC Welcome Packet — Caregivers" (2026-09).
// Part One is the caregiver profile; Part Two is the document checklist. Both
// halves live here rather than in the page, for the same reason the competency
// catalog and the caregiver document kinds do: a screen that restates a list
// drifts from the validator that refuses what is not on it, and the drift is
// silent until somebody's answer is dropped.
//
// WHAT GATES WHAT (owner decision, 2026-09-13). Two gates, not one:
//
//   1. APP ACCESS — the caregiver's OWN part: the eight profile sections, their
//      emergency contact, and their signature. Nothing else. Gating app access
//      on the uploads would lock them out of the only screen where uploading
//      happens, and gating it on our clearances would lock them out for days
//      waiting on us.
//
//   2. SHIFT CLEARANCE — the documents and the office's own checks. Georgia
//      requires a caregiver to be cleared before working in a client's home, so
//      this is what stands between them and claiming a shift.
//
// It is the same shape as the client enrollment gate: the ask is free, and what
// gets checked is the commitment. Finishing work already in flight — clocking
// out, filing a visit log for a visit that happened — is never gated by either.
//
// Pure functions over plain records. No I/O, no request context, so the routes,
// the tests, the PDF writer and the importer all read one rule.
// ============================================================================

'use strict';

// Bumped when the QUESTIONS change, not when wording is tidied. A stored packet
// keeps the version it was signed against, so a packet signed in September is
// still readable as the document that was actually put in front of someone.
const PACKET_VERSION = '2026-09-packet-v1';

const opt = (value, label) => ({ value, label });

// ---------------------------------------------------------------------------
// PART ONE — the caregiver profile, section for section as printed.
// ---------------------------------------------------------------------------
// `required: true` marks a field that must carry a value before the packet can
// be signed. Everything the packet asks for is kept; only the fields that make
// a placement possible are required, because a packet that refuses to submit
// over a blank "preferred name" is a packet nobody finishes.
const PACKET_SECTIONS = Object.freeze([
  {
    id: 'about',
    number: 1,
    title: 'About You',
    intro: null,
    fields: [
      { id: 'firstName',     label: 'First name',     type: 'text',  required: true,  max: 80 },
      { id: 'lastName',      label: 'Last name',      type: 'text',  required: true,  max: 80 },
      { id: 'preferredName', label: 'Preferred name', type: 'text',  required: false, max: 80 },
      { id: 'mobilePhone',   label: 'Mobile phone',   type: 'tel',   required: true,  max: 40 },
      { id: 'email',         label: 'Email',          type: 'email', required: true,  max: 160 },
      { id: 'dateOfBirth',   label: 'Date of birth',  type: 'date',  required: true },
      { id: 'homeAddress',   label: 'Home address',   type: 'text',  required: true,  max: 240 },
      { id: 'homeZip',       label: 'Home ZIP code',  type: 'text',  required: true,  max: 12 }
    ]
  },
  {
    id: 'credentials',
    number: 2,
    title: 'Credentials',
    intro: 'If you do not have a certification yet, that is fine. We train, and we help people get certified.',
    fields: [
      {
        id: 'certifications', label: 'Certifications you hold', type: 'multi', required: false,
        options: [
          opt('cna', 'CNA'), opt('hha', 'HHA'), opt('pca', 'PCA'), opt('med_tech', 'Med Tech'),
          opt('lpn', 'LPN'), opt('rn', 'RN'), opt('nursing_student', 'Nursing student'),
          opt('none_yet', 'None yet')
        ]
      },
      {
        id: 'currentCertifications', label: 'Current certifications', type: 'multi', required: false,
        options: [
          opt('cpr', 'CPR'), opt('first_aid', 'First Aid'), opt('bls', 'BLS'),
          opt('dementia_training', 'Dementia training'), opt('de_escalation', 'De-escalation')
        ]
      },
      { id: 'licenseNumber',     label: 'License or certificate number', type: 'text', required: false, max: 60 },
      { id: 'licenseExpiration', label: 'Expiration date',               type: 'date', required: false }
    ]
  },
  {
    id: 'where',
    number: 3,
    title: 'Where You Can Work',
    intro: 'We place caregivers close to home. Short commutes mean more of your pay stays in your pocket.',
    fields: [
      {
        id: 'maxCommute', label: 'Longest commute you will accept', type: 'single', required: true,
        options: [opt('15', '15 min'), opt('30', '30 min'), opt('45', '45 min'), opt('60', '1 hour')]
      },
      {
        id: 'transportation', label: 'Reliable transportation', type: 'single', required: true,
        options: [opt('own_vehicle', 'Own vehicle'), opt('shared', 'Shared'), opt('transit', 'Transit'), opt('rides', 'Rides')]
      },
      {
        id: 'licenseAndInsurance', label: "Driver's license and auto insurance", type: 'single', required: true,
        options: [opt('both_current', 'Both current'), opt('license_only', 'License only'), opt('neither', 'Neither')]
      },
      {
        id: 'willingToDriveClients', label: 'Willing to drive clients', type: 'single', required: true,
        options: [opt('yes_my_car', 'Yes, my car'), opt('clients_car_only', "Client's car only"), opt('no', 'No')]
      },
      { id: 'preferredAreas', label: 'Cities or areas you prefer', type: 'text', required: false, max: 240 }
    ]
  },
  {
    id: 'availability',
    number: 4,
    title: 'Your Availability',
    intro: 'Check every block you can reliably work. Be honest here. We build schedules around what you actually commit to.',
    fields: [
      {
        id: 'availability', label: 'Availability', type: 'grid', required: true,
        rows: [
          opt('monday', 'Monday'), opt('tuesday', 'Tuesday'), opt('wednesday', 'Wednesday'),
          opt('thursday', 'Thursday'), opt('friday', 'Friday'), opt('saturday', 'Saturday'),
          opt('sunday', 'Sunday')
        ],
        columns: [
          opt('morning', 'Morning 6a–12p'), opt('afternoon', 'Afternoon 12p–5p'),
          opt('evening', 'Evening 5p–10p'), opt('overnight', 'Overnight 10p–6a')
        ]
      },
      {
        id: 'hoursPerWeek', label: 'Hours per week you want', type: 'single', required: true,
        options: [opt('under_20', 'Under 20'), opt('20_30', '20–30'), opt('30_40', '30–40'), opt('40_plus', '40+')]
      },
      {
        id: 'extendedShifts', label: 'Open to extended shifts', type: 'multi', required: false,
        options: [opt('10_12hr', '10–12 hr'), opt('24hr', '24 hr'), opt('live_in', 'Live-in'), opt('standard_only', 'Standard only')]
      },
      { id: 'earliestStartDate', label: 'Earliest start date', type: 'date', required: true },
      {
        id: 'scheduleNotes', label: 'Anything about your schedule we should know', type: 'textarea', required: false, max: 1000,
        hint: 'School, another job, childcare, standing commitments'
      }
    ]
  },
  {
    id: 'experience',
    number: 5,
    title: 'Your Experience',
    intro: null,
    fields: [
      {
        id: 'yearsExperience', label: 'Years of caregiving experience', type: 'single', required: true,
        options: [
          opt('new', 'New'), opt('under_1', 'Under 1'), opt('1_3', '1–3'),
          opt('3_7', '3–7'), opt('7_15', '7–15'), opt('15_plus', '15+')
        ]
      },
      {
        id: 'settings', label: 'Settings you have worked in', type: 'multi', required: false,
        options: [
          opt('private_home', 'Private home'), opt('assisted_living', 'Assisted living'),
          opt('memory_care', 'Memory care'), opt('skilled_nursing', 'Skilled nursing'),
          opt('hospital', 'Hospital'), opt('family', 'Family')
        ]
      },
      {
        id: 'careExperience', label: 'Care you are experienced and comfortable providing', type: 'multi', required: true,
        hint: 'Only check what you have actually done and would do again.',
        options: [
          opt('bathing', 'Bathing and showering'), opt('dressing', 'Dressing and grooming'),
          opt('toileting', 'Toileting'), opt('incontinence', 'Incontinence care'),
          opt('transfers', 'Transfers and lifting'), opt('hoyer', 'Hoyer lift'),
          opt('feeding', 'Feeding assistance'), opt('med_reminders', 'Medication reminders'),
          opt('dementia', "Dementia and Alzheimer's"), opt('de_escalation', 'Behavioral de-escalation'),
          opt('diabetes', 'Diabetes support'), opt('post_surgical', 'Post-surgical recovery'),
          opt('hospice', 'Hospice and end of life'), opt('catheter_ostomy', 'Catheter or ostomy'),
          opt('oxygen', 'Oxygen'), opt('wheelchair', 'Wheelchair mobility'),
          opt('meal_prep', 'Meal preparation'), opt('housekeeping', 'Light housekeeping'),
          opt('errands', 'Errands and shopping'), opt('companionship', 'Companionship')
        ]
      },
      {
        id: 'liftingComfort', label: 'Comfortable lifting or transferring', type: 'single', required: true,
        options: [
          opt('with_equipment', 'With equipment'), opt('without_equipment', 'Without equipment'),
          opt('light_assist_only', 'Light assist only'), opt('no_lifting', 'No lifting')
        ]
      },
      {
        id: 'acuityPreference', label: 'Acuity you prefer', type: 'single', required: false,
        options: [
          opt('lower', 'Lower, mostly companionship'), opt('moderate', 'Moderate, hands-on ADL'),
          opt('higher', 'Higher, complex care'), opt('any', 'Any level')
        ]
      }
    ]
  },
  {
    id: 'how_you_work',
    number: 6,
    title: 'How You Work',
    intro: 'This is the part most agencies skip. It is the part that decides whether a placement lasts.',
    fields: [
      {
        id: 'style', label: 'Your style with clients', type: 'multi', required: false,
        options: [
          opt('quiet_calm', 'Quiet and calm'), opt('warm_chatty', 'Warm and chatty'),
          opt('structured', 'Structured and routine-driven'), opt('flexible', 'Flexible, go with the flow'),
          opt('patient_anxiety', 'Patient with anxiety'), opt('resists_care', 'Good with clients who resist care')
        ]
      },
      {
        id: 'clientSituations', label: 'Client situations you prefer', type: 'multi', required: false,
        options: [
          opt('lives_alone', 'Client lives alone'), opt('family_in_home', 'Family in the home'),
          opt('couple', 'Caring for a couple'), opt('in_facility', 'Client in a facility')
        ]
      },
      { id: 'languages', label: 'Languages you speak', type: 'text', required: false, max: 200 },
      {
        id: 'clientGender', label: 'Client gender you are comfortable with', type: 'single', required: false,
        options: [opt('any', 'Any'), opt('female_only', 'Female only'), opt('male_only', 'Male only')]
      },
      {
        id: 'pets', label: 'Comfortable with pets', type: 'single', required: false,
        options: [
          opt('dogs_and_cats', 'Dogs and cats'), opt('dogs_only', 'Dogs only'), opt('cats_only', 'Cats only'),
          opt('no_allergy', 'No, allergy'), opt('no_preference', 'No, preference')
        ]
      },
      {
        id: 'cooking', label: 'Cooking ability', type: 'single', required: false,
        options: [
          opt('confident', 'Confident, full meals'), opt('simple', 'Simple meals'),
          opt('reheating', 'Reheating only'), opt('prefer_not', 'Prefer not to cook')
        ]
      },
      {
        id: 'smoke', label: 'Do you smoke', type: 'single', required: false,
        options: [opt('no', 'No'), opt('yes_never_on_shift', 'Yes, never on shift'), opt('yes', 'Yes')]
      },
      {
        id: 'smokingHome', label: 'Comfortable in a home where someone smokes', type: 'single', required: false,
        options: [opt('yes', 'Yes'), opt('no', 'No')]
      },
      {
        id: 'ownWords', label: 'In your own words', type: 'textarea', required: true, max: 2000,
        hint: 'Two or three sentences. Where you are from, why you do this work, what you are like on a shift. Clients read this, so write it the way you would say it out loud.'
      },
      {
        id: 'clientStory', label: 'Tell us about a client you enjoyed working with', type: 'textarea', required: false, max: 2000,
        hint: 'No names. Just what made it a good fit.'
      }
    ]
  },
  {
    id: 'growth',
    number: 7,
    title: 'Where You Want To Go',
    intro: 'We invest in caregivers who want to grow. Tell us what you are working toward and we will help you get there.',
    fields: [
      {
        id: 'careerGoal', label: 'Your career goal', type: 'single', required: false,
        options: [
          opt('stay_caregiver', 'Stay a caregiver, this is my calling'), opt('become_cna', 'Become a CNA'),
          opt('become_lpn', 'Become an LPN'), opt('become_rn', 'Become an RN'),
          opt('scheduling_office', 'Scheduling or office'), opt('supervision_training', 'Supervision or training'),
          opt('still_deciding', 'Still deciding')
        ]
      },
      {
        id: 'inSchool', label: 'Currently enrolled in school', type: 'single', required: false,
        options: [
          opt('yes_nursing', 'Yes, nursing program'), opt('yes_other', 'Yes, other'),
          opt('no_planning_to', 'No, planning to'), opt('no', 'No')
        ]
      },
      {
        id: 'supportWanted', label: 'Support you would use if we offered it', type: 'multi', required: false,
        options: [
          opt('tuition', 'Tuition support'), opt('certification_sponsorship', 'Certification sponsorship'),
          opt('schedule_around_class', 'Schedule around class'), opt('clinical_mentorship', 'Clinical mentorship'),
          opt('skills_training', 'Skills training'), opt('exam_help', 'Help with certification exam')
        ]
      }
    ]
  },
  {
    id: 'references',
    number: 8,
    title: 'References',
    intro: 'Two people who have supervised your work or who you have cared for. Please let them know we will be calling.',
    fields: [
      {
        id: 'references', label: 'References', type: 'rows', required: true, rowCount: 2,
        rowFields: [
          { id: 'name',         label: 'Name',         type: 'text', required: true, max: 120 },
          { id: 'relationship', label: 'Relationship', type: 'text', required: true, max: 120 },
          { id: 'phone',        label: 'Best phone',   type: 'tel',  required: true, max: 40 }
        ]
      }
    ]
  },
  {
    // Item 5 on the printed document list, and it is the one item there that is
    // DATA rather than a file. It belongs with the profile, where it can be
    // asked for and validated, not on a checklist of things to photograph.
    id: 'emergency_contact',
    number: 9,
    title: 'Emergency Contact',
    intro: 'Someone we can reach if something happens while you are on shift.',
    fields: [
      { id: 'emergencyName',         label: 'Name',         type: 'text', required: true, max: 120 },
      { id: 'emergencyRelationship', label: 'Relationship', type: 'text', required: true, max: 120 },
      { id: 'emergencyPhone',        label: 'Phone',        type: 'tel',  required: true, max: 40 }
    ]
  }
]);

// ---------------------------------------------------------------------------
// PART TWO — what to send us.
// ---------------------------------------------------------------------------
// `source` says who produces the document, and it is the difference between a
// caregiver who is stuck and one who is waiting:
//   'caregiver' — they already have it, or they get it
//   'gusto'     — it is in their Gusto HR onboarding portal to read and sign,
//                 and the signed copy comes back here
//   'office'    — we do it. They cannot upload their way past it.
//
// `upload: true` means a file is expected here. An office item is tracked by
// STATUS, because there is nothing for the caregiver to attach.
//
// `required` — true, false, or a predicate over the submitted packet. The
// printed document says "if you hold one" and "only if you will be driving",
// and a checklist that ignores those conditions chases people for paperwork
// that does not apply to them.
const DOCUMENT_ITEMS = Object.freeze([
  // A — Identification and Payroll
  {
    item: 1, group: 'A', kind: 'id_document', source: 'caregiver', upload: true, required: true,
    title: 'Government-issued photo ID',
    detail: "Driver's license, state ID, or passport. Must be unexpired."
  },
  {
    item: 2, group: 'A', kind: 'ssn_card', source: 'caregiver', upload: true, required: true,
    title: 'Social Security card',
    detail: 'Needed for payroll and for your background check to match correctly.',
    help: 'Lost yours? Order a free replacement at ssa.gov. Tell us and we will work around the timing.'
  },
  {
    item: 3, group: 'A', kind: 'work_authorization', source: 'caregiver', upload: true, required: true,
    title: 'Work authorization documents',
    detail: 'Whatever proves you can legally work in the United States. Your ID and Social Security card usually cover this. We will complete the I-9 form with you in person.'
  },
  {
    item: 4, group: 'A', kind: 'direct_deposit', source: 'caregiver', upload: true, required: true,
    title: 'Voided check or bank letter',
    detail: 'For direct deposit. A screenshot of your account and routing numbers from your banking app works too.'
  },
  {
    // Data, not a file — collected in the profile section above. Listed here so
    // the checklist matches the printed packet item for item, and ticked from
    // the profile rather than from an upload.
    item: 5, group: 'A', kind: 'emergency_contact', source: 'caregiver', upload: false, required: true,
    fromProfile: ['emergencyName', 'emergencyRelationship', 'emergencyPhone'],
    title: 'Emergency contact',
    detail: 'Name, relationship, and phone number for someone we can reach if something happens while you are on shift.'
  },

  // B — Background Check
  {
    item: 6, group: 'B', kind: 'fingerprinting', source: 'office', upload: false, required: true,
    statuses: ['not_started', 'scheduled', 'done'],
    title: 'Fingerprinting appointment completed',
    detail: 'We send you a registration link and you pick a location and time near you. Takes about fifteen minutes.',
    help: 'This one has the longest wait, so do it first. Results usually come back in a few days but can take longer.'
  },
  {
    item: 7, group: 'B', kind: 'background_check_auth', source: 'gfc_sign', upload: false, sign: true, required: true,
    title: 'Background check authorization',
    detail: 'Read it and sign it here. We cannot start your screening until you do, and the screening has the longest wait on this list.'
  },
  {
    item: 8, group: 'B', kind: 'registry_attestation', source: 'gfc_sign', upload: false, sign: true, required: true,
    title: 'Registry attestation',
    detail: 'Your own statement about abuse and neglect registries. Read it and sign it here. Takes a minute.'
  },

  // C — Health Records
  {
    item: 9, group: 'C', kind: 'tb_test', source: 'caregiver', upload: true, required: true,
    title: 'TB test, within the last 12 months',
    detail: 'A skin test, a blood test, or a chest x-ray if you have tested positive before. We need the actual result on paper, not just your word that you had one.',
    help: 'No current test? Urgent care, your doctor, or a county health department can do it. Ask us first, we may cover the cost.'
  },
  {
    item: 10, group: 'C', kind: 'drug_screen', source: 'caregiver', upload: true, required: true,
    title: 'Drug screen, within the last 12 months',
    detail: 'If you do not have a recent one, we send you to a lab and we pay for it.'
  },
  {
    item: 11, group: 'C', kind: 'immunization_record', source: 'caregiver', upload: true, required: false,
    title: 'Immunization record',
    detail: 'Whatever you have. Some clients and families ask for specific vaccines, and having your record on file means we can place you faster.'
  },
  {
    item: 12, group: 'C', kind: 'physical_ability', source: 'gfc_sign', upload: false, sign: true, required: true,
    title: 'Physical ability acknowledgement',
    detail: 'What the work involves physically, and what you can do. Read it and sign it here.',
    help: 'If you have a limitation, say so on the form. We will match you to an assignment that fits rather than one that does not.'
  },

  // D — Certifications and Driving
  {
    item: 13, group: 'D', kind: 'cpr_first_aid', source: 'caregiver', upload: true, required: true,
    title: 'Current CPR and First Aid cards',
    detail: 'Front and back, with the expiration date visible.',
    help: 'Expired or never certified? Tell us. We run classes and we sponsor certification.'
  },
  {
    item: 14, group: 'D', kind: 'certification', source: 'caregiver', upload: true,
    // "If you hold one." Asked for only when they said on the profile that they
    // hold one — chasing a CNA certificate from someone who ticked "None yet"
    // is how a checklist teaches people to ignore it.
    required: (packet) => {
      const held = ((packet || {}).certifications) || [];
      return held.some(c => ['cna', 'hha', 'pca', 'lpn', 'rn'].includes(c));
    },
    title: 'CNA, HHA, PCA, or LPN certificate',
    detail: 'If you hold one. Include the certificate number and expiration date. We verify it with the state directly, so the number matters more than the card.'
  },
  {
    item: 15, group: 'D', kind: 'license_insurance', source: 'caregiver', upload: true,
    // "Only if you will be driving clients or driving as part of your shift."
    required: (packet) => {
      const p = packet || {};
      return p.willingToDriveClients === 'yes_my_car' || p.willingToDriveClients === 'clients_car_only';
    },
    requiredWhen: 'You told us you are willing to drive clients.',
    // OWNER, 2026-09-14: the driver's licence is ITEM 1. Asking for it again
    // here made a caregiver photograph the same card twice for two different
    // slots, and a checklist that asks twice for one document is a checklist
    // people stop trusting. The KIND still reads `license_insurance` because
    // documents already filed carry it — renaming the kind would orphan them
    // and show a file we hold as missing.
    title: 'Current auto insurance',
    detail: 'Only if you will be driving clients or driving as part of your shift. The card must be current and show your name. We already have your license from item 1.'
  },

  // E — Paperwork in your Gusto HR onboarding portal
  //
  // OWNER CHANGE, 2026-09-13. The printed packet said "You do not need to find
  // these. We email them and you sign and return." That is no longer how it
  // works: these live in Gusto, the caregiver reads and signs them there, and
  // the signed copy comes back here. Saying "we email them" would leave someone
  // waiting for an email that is not coming.
  //
  // GUSTO IS THE SYSTEM OF RECORD and nothing here transmits to it — the same
  // rule the payroll documents already follow. What the app holds is the
  // office's copy.
  {
    item: 16, group: 'E', kind: 'offer_letter', source: 'gusto', upload: true, required: true,
    title: 'Offer letter and employee agreement',
    detail: 'Your role, your hourly rate, and your status as a W2 employee. Read it, and ask us about anything that is not clear.'
  },
  {
    item: 17, group: 'E', kind: 'employee_handbook', source: 'gusto', upload: true, required: true,
    title: 'Employee handbook',
    detail: 'Read it and sign the acknowledgement.'
  },
  {
    item: 18, group: 'E', kind: 'privacy_policy', source: 'gusto', upload: true, required: true,
    title: 'Privacy and confidentiality policy',
    detail: "How we protect our clients' information, and what you agree to. Signed before we give you any client details."
  },
  {
    item: 19, group: 'E', kind: 'code_of_conduct', source: 'gusto', upload: true, required: true,
    title: 'Code of conduct, attendance, and incident reporting',
    detail: 'What we expect on a shift, and how to tell us when something goes wrong.'
  },

  // F — Signed here, with us
  //
  // OWNER, 2026-09-14: the mandatory reporter acknowledgement LEFT GROUP E.
  // It is not a Gusto document — it is Georgia law and it is our form — and
  // leaving it under a heading whose intro says "each of these is waiting in
  // your Gusto portal" would have been a contradiction on the screen. It keeps
  // its printed item number; only its group moved.
  {
    item: 20, group: 'F', kind: 'mandatory_reporter', source: 'gfc_sign', upload: false, sign: true, required: true,
    title: 'Mandatory reporter acknowledgement',
    detail: 'In Georgia this is your personal legal duty, not the agency\'s. Read it and sign it here.'
  },

  // G — Before Your First Shift
  {
    item: 21, group: 'G', kind: 'orientation', source: 'office', upload: false, required: true,
    statuses: ['not_started', 'scheduled', 'done'],
    title: 'Orientation',
    detail: 'About eight hours covering safety, privacy, infection control, body mechanics, and how we document visits. Paid.'
  },
  {
    item: 22, group: 'G', kind: 'app_training', source: 'office', upload: false, required: true,
    statuses: ['not_started', 'scheduled', 'done'],
    title: 'App and clock-in training',
    detail: 'You will use our app for your schedule, clocking in and out, and visit notes. We make sure you are comfortable with it before your first shift.'
  },
  {
    item: 23, group: 'G', kind: 'skills_check', source: 'office', upload: false, required: true,
    statuses: ['not_started', 'scheduled', 'done'],
    title: 'Skills check',
    detail: 'You show us the hands-on skills your assignment calls for. This is not a test to trip you up. It tells us where to support you.'
  }
]);

const GROUP_TITLES = Object.freeze({
  A: 'Identification and Payroll',
  B: 'Background Check',
  C: 'Health Records',
  D: 'Certifications and Driving',
  E: 'Paperwork in your Gusto HR portal',
  F: 'Forms you sign with us',
  G: 'Before Your First Shift'
});

const GROUP_INTROS = Object.freeze({
  A: null,
  B: 'Georgia requires this for every caregiver. We pay for it and we schedule it.',
  C: 'These protect you and the people you care for. Your records go in a private file separate from everything else.',
  D: null,
  // The one place the printed wording was replaced rather than ported.
  E: 'Each of these is waiting in your Gusto HR onboarding portal to review and sign. Once you have signed a document in Gusto, upload the signed copy here so the office has it on file. Uploading here does not file it in Gusto, and signing in Gusto does not send it here — both are needed.',
  F: 'You sign this one right here. Nothing to print, nothing to send back.',
  G: null
});

const PAY_PROMISE = 'Your first shift is paid. Every hour you work with us is paid at your full hourly rate, including your first shift with a new client. We do not do unpaid working interviews. If you are ever asked to work unpaid hours, tell us immediately.';

// The document kinds this packet introduces, for the caregiver document store.
// Derived from the list above rather than typed out again, so a kind cannot
// exist on the checklist and be refused by the upload route.
const PACKET_DOCUMENT_KINDS = Object.freeze(
  DOCUMENT_ITEMS.filter(d => d.upload).map(d => Object.freeze({
    kind: d.kind, label: d.title, item: d.item, group: d.group, source: d.source
  }))
);

const OFFICE_ITEM_KINDS = Object.freeze(DOCUMENT_ITEMS.filter(d => d.source === 'office').map(d => d.kind));
const OFFICE_STATUSES = Object.freeze(['not_started', 'scheduled', 'done']);

// ---------------------------------------------------------------------------
// Normalizing what comes back from a form, a PDF, or an importer.
// ---------------------------------------------------------------------------

const FIELD_INDEX = (() => {
  const map = new Map();
  for (const section of PACKET_SECTIONS) {
    for (const field of section.fields) map.set(field.id, { field, section });
  }
  return map;
})();

// The attestation wording and its version live in caregiverAttestations.js.
// Required rather than restated: a second copy of "which version counts"
// is how a checklist ticks an item the signing route would refuse.
const ATTESTATION_VERSION = require('./caregiverAttestations').CURRENT_VERSION;

const trim = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 500);

const isBlank = (v) =>
  v == null || v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

const normalizeDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/**
 * Take a raw submission and return only what the packet actually asks for,
 * in the shape it asks for it.
 *
 * A value the packet did not offer is DROPPED, not stored — the same rule the
 * visit log follows. A stored answer that no question produced is an answer
 * nobody can read back, and on a matching profile it would quietly steer
 * placements off a value nobody chose.
 */
function sanitizePacket(raw) {
  const input = (raw && typeof raw === 'object') ? raw : {};
  const clean = {};
  const dropped = [];

  for (const key of Object.keys(input)) {
    if (!FIELD_INDEX.has(key)) dropped.push(key);
  }

  for (const [id, { field }] of FIELD_INDEX.entries()) {
    if (!(id in input)) continue;
    const value = input[id];
    if (value == null) continue;

    switch (field.type) {
      case 'single': {
        const allowed = field.options.map(o => o.value);
        const v = trim(value, 80);
        if (allowed.includes(v)) clean[id] = v;
        else if (v) dropped.push(id);
        break;
      }
      case 'multi': {
        const allowed = field.options.map(o => o.value);
        const list = Array.isArray(value) ? value : [value];
        const kept = [...new Set(list.map(v => trim(v, 80)).filter(v => allowed.includes(v)))];
        if (list.some(v => !allowed.includes(trim(v, 80)))) dropped.push(id);
        clean[id] = kept;
        break;
      }
      case 'grid': {
        const rows = field.rows.map(r => r.value);
        const cols = field.columns.map(c => c.value);
        const out = {};
        const src = (value && typeof value === 'object') ? value : {};
        for (const row of rows) {
          const picked = Array.isArray(src[row]) ? src[row] : [];
          const kept = [...new Set(picked.map(v => trim(v, 40)).filter(v => cols.includes(v)))];
          if (kept.length) out[row] = kept;
        }
        clean[id] = out;
        break;
      }
      case 'rows': {
        const src = Array.isArray(value) ? value : [];
        const out = [];
        for (let i = 0; i < field.rowCount; i++) {
          const row = (src[i] && typeof src[i] === 'object') ? src[i] : {};
          const kept = {};
          for (const rf of field.rowFields) {
            const v = trim(row[rf.id], rf.max);
            if (v) kept[rf.id] = v;
          }
          out.push(kept);
        }
        clean[id] = out;
        break;
      }
      case 'date': {
        const d = normalizeDate(value);
        if (d) clean[id] = d;
        else if (trim(value, 40)) dropped.push(id);
        break;
      }
      default: {
        const v = trim(value, field.max || 500);
        if (v) clean[id] = v;
        break;
      }
    }
  }

  return { clean, dropped: [...new Set(dropped)] };
}

/**
 * Which required profile fields are still empty.
 * → [{ id, label, section, sectionTitle }]
 */
function missingProfileFields(packet) {
  const p = packet || {};
  const missing = [];
  for (const section of PACKET_SECTIONS) {
    for (const field of section.fields) {
      if (!field.required) continue;
      let empty;
      if (field.type === 'rows') {
        const rows = Array.isArray(p[field.id]) ? p[field.id] : [];
        empty = rows.length < field.rowCount ||
          rows.slice(0, field.rowCount).some(row =>
            field.rowFields.some(rf => rf.required && isBlank((row || {})[rf.id])));
      } else if (field.type === 'grid') {
        const grid = (p[field.id] && typeof p[field.id] === 'object') ? p[field.id] : {};
        empty = !Object.keys(grid).some(row => (grid[row] || []).length > 0);
      } else {
        empty = isBlank(p[field.id]);
      }
      if (empty) {
        missing.push({ id: field.id, label: field.label, section: section.id, sectionTitle: section.title });
      }
    }
  }
  return missing;
}

/** Is this document item required for THIS caregiver's answers? */
function itemRequired(item, packet) {
  if (typeof item.required === 'function') return !!item.required(packet || {});
  return !!item.required;
}

/**
 * The document checklist for one caregiver: every item, with what we have.
 *
 * DERIVED, never stored. A stored checklist is a second copy of the truth that
 * goes stale the moment a document is accepted or a profile answer changes —
 * the same reason the client document checklist is derived from the registry.
 *
 * @param packet    the submitted profile (decides the conditional items)
 * @param documents caregiver_documents rows for this caregiver
 * @param office    { [kind]: { status, at, byName } } office-tracked items
 */
/**
 * @param attestations  the caregiver's signed attestation rows. A signable item
 *                      is ticked by a SIGNATURE, never by a file. Defaults to
 *                      none, which fails closed: an item nobody proved signed
 *                      reads as outstanding rather than as done.
 */
function buildChecklist(packet, documents, office, attestations) {
  const docs = Array.isArray(documents) ? documents : [];
  const signed = Array.isArray(attestations) ? attestations : [];
  const officeState = (office && typeof office === 'object') ? office : {};
  const p = packet || {};

  return DOCUMENT_ITEMS.map(item => {
    const required = itemRequired(item, p);
    const row = {
      item: item.item,
      group: item.group,
      groupTitle: GROUP_TITLES[item.group],
      kind: item.kind,
      title: item.title,
      detail: item.detail || null,
      help: item.help || null,
      source: item.source,
      upload: !!item.upload,
      sign: !!item.sign,
      required,
      requiredWhen: (typeof item.required === 'function' && required) ? (item.requiredWhen || null) : null,
      status: 'missing',
      uploads: []
    };

    // A SIGNABLE ITEM IS SATISFIED BY A SIGNATURE AT THE CURRENT VERSION, and
    // by nothing else. A signature against superseded wording is kept, still
    // renders its own text, and deliberately does NOT tick the box: the
    // document changed, so the signature is on a different document. The row
    // says which of the two it is, because "never signed" and "signed the old
    // one" need different sentences on a phone.
    if (item.sign) {
      const record = signed.find(r => r && r.kind === item.kind) || null;
      const current = record && record.signed_at && record.version === ATTESTATION_VERSION;
      row.signedAt = record ? (record.signed_at || null) : null;
      row.signedVersion = record ? (record.version || null) : null;
      row.supersededSignature = !!(record && record.signed_at && !current);
      row.status = current ? 'complete' : 'missing';
      return row;
    }

    if (item.fromProfile) {
      // A profile-backed item is satisfied by the answers, not by a file.
      row.status = item.fromProfile.every(f => !isBlank(p[f])) ? 'complete' : 'missing';
      return row;
    }

    if (item.source === 'office') {
      const state = officeState[item.kind] || {};
      const status = OFFICE_STATUSES.includes(state.status) ? state.status : 'not_started';
      row.officeStatus = status;
      row.officeAt = state.at || null;
      row.officeByName = state.byName || null;
      row.status = status === 'done' ? 'complete' : (status === 'scheduled' ? 'in_progress' : 'missing');
      return row;
    }

    const mine = docs
      .filter(d => d && d.kind === item.kind)
      .sort((a, b) => String(b.uploaded_at || '').localeCompare(String(a.uploaded_at || '')));
    row.uploads = mine.map(d => ({
      id: d.id, fileName: d.file_name, status: d.status,
      uploadedAt: d.uploaded_at, reviewNote: d.review_note || null,
      // "You sent this" and "the office filed it for you" are different facts,
      // and a caregiver looking at a ticked item they do not remember ticking
      // needs to be told which. Never the Drive id or the stored name: those
      // do not leave the server.
      uploadedByOffice: !!d.uploaded_by_office
    }));

    // A REJECTED upload is not a missing one, and the difference is the whole
    // point: somebody looked at it and said why. Telling a caregiver a rejected
    // document is "missing" sends them to photograph the same page again.
    if (mine.some(d => d.status === 'accepted')) row.status = 'complete';
    else if (mine.some(d => d.status === 'received')) row.status = 'in_review';
    else if (mine.some(d => d.status === 'rejected')) row.status = 'rejected';
    else row.status = 'missing';

    return row;
  });
}

module.exports = {
  PACKET_VERSION,
  PACKET_SECTIONS,
  DOCUMENT_ITEMS,
  GROUP_TITLES,
  GROUP_INTROS,
  PAY_PROMISE,
  PACKET_DOCUMENT_KINDS,
  OFFICE_ITEM_KINDS,
  OFFICE_STATUSES,
  FIELD_INDEX,
  sanitizePacket,
  missingProfileFields,
  itemRequired,
  buildChecklist,
  isBlank
};
