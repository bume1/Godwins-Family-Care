// ============================================================================
// ONBOARDING VOCABULARY — the words every chapter shares
// ============================================================================
// Read with onboarding/sources.js. Nothing here states a requirement; it names
// the kinds of thing a requirement can be, who can act on it, and how a
// requirement's origin is classified.
// ============================================================================

'use strict';

// ---- REQUIREMENT CLASSIFICATION -------------------------------------------
// Each source document classifies its obligations by origin. The classes are
// the Training Library's `source_class` enum (GFC-CLIN-TRN §2) plus
// CONTRACTUAL, which the Clinical Manual's §1.6 table uses for the Google
// Workspace BAA conditions.
//
// AN ITEM NEVER CARRIES A CLASS WE ASSIGNED. It carries the document's own
// phrase ("Statutory and regulatory"), the row it came from, and the classes
// that phrase parses to. The page shows the phrase, so the interface explains
// a step in the document's words rather than ours.
const CLASSES = Object.freeze({
  STATUTORY: 'STATUTORY',
  REGULATORY: 'REGULATORY',
  ACCREDITATION: 'ACCREDITATION',
  INTERNAL_POLICY: 'INTERNAL_POLICY',
  RECOMMENDED: 'RECOMMENDED',
  CONTRACTUAL: 'CONTRACTUAL'
});

// Every phrase a source document uses, mapped to its classes. A phrase not in
// this table is REFUSED, never guessed: a new phrase in a reissued document is
// something a person reads, not something a fallback swallows.
const CLASSIFICATION_PHRASES = Object.freeze({
  'statutory': ['STATUTORY'],
  'regulatory': ['REGULATORY'],
  'statutory and regulatory': ['STATUTORY', 'REGULATORY'],
  'accreditation standard': ['ACCREDITATION'],
  'internal policy': ['INTERNAL_POLICY'],
  'recommended practice': ['RECOMMENDED'],
  'regulatory and internal policy': ['REGULATORY', 'INTERNAL_POLICY'],
  'regulatory and contractual': ['REGULATORY', 'CONTRACTUAL'],
  'contractual condition of baa coverage': ['CONTRACTUAL']
});

// Which classes may be described as a legal requirement. Accreditation,
// internal policy and recommended practice are not law, and the prompt's
// second rule is that a GFC standard is never presented as one.
const LEGAL_CLASSES = Object.freeze(['STATUTORY', 'REGULATORY']);

function parseClassification(phrase) {
  const key = String(phrase || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const classes = CLASSIFICATION_PHRASES[key];
  if (!classes) {
    const e = new Error(`Unrecognised classification phrase: "${phrase}"`);
    e.code = 'CLASSIFICATION_UNKNOWN';
    throw e;
  }
  return classes.slice();
}

// `phrase` is the document's wording, `row` the requirement row it sits on,
// `from` a ref() into the source. Built once, at load, so a typo in the
// catalog fails the require rather than a request.
function classification(phrase, row, from) {
  if (!from || !from.source) throw new Error(`Classification "${phrase}" has no source reference`);
  return Object.freeze({
    phrase: String(phrase),
    row: String(row),
    classes: Object.freeze(parseClassification(phrase)),
    from
  });
}

function isLegalRequirement(cls) {
  return !!(cls && cls.classes && cls.classes.some(c => LEGAL_CLASSES.includes(c)));
}

// ---- WHO ACTS -------------------------------------------------------------
// Onboarding is COLLABORATIVE (owner, 2026-11-08): the new hire completes and
// submits the items that are hers, and the office completes or verifies the
// rest. This overrides GFC-WIZ-PROMPT v2.0 §1, which describes a wizard the
// office operates alone.
//
// The office roles are the ones the Playbook's Roles and Responsibilities
// tables name. A role is mapped to a person in settings (Playbook R3.1), never
// here, so a change in personnel never changes the catalog.
const ACTORS = Object.freeze({
  NEW_HIRE: 'NEW_HIRE',
  EXECUTIVE_DIRECTOR: 'EXECUTIVE_DIRECTOR',
  CLINICAL_DIRECTOR: 'CLINICAL_DIRECTOR',
  CREDENTIALING_OWNER: 'CREDENTIALING_OWNER',
  PAYROLL_FINANCE_OFFICER: 'PAYROLL_FINANCE_OFFICER',
  DELEGATING_PHYSICIAN: 'DELEGATING_PHYSICIAN',
  SUPERVISOR: 'SUPERVISOR',
  READINESS_OWNER: 'READINESS_OWNER',
  // The office as a whole, on a task the office added itself.
  OFFICE: 'OFFICE'
});
const ACTOR_LABELS = Object.freeze({
  NEW_HIRE: 'New hire',
  EXECUTIVE_DIRECTOR: 'Executive Director',
  CLINICAL_DIRECTOR: 'Clinical Director',
  CREDENTIALING_OWNER: 'Credentialing owner',
  PAYROLL_FINANCE_OFFICER: 'Payroll and Finance Officer',
  DELEGATING_PHYSICIAN: 'Delegating physician',
  SUPERVISOR: 'Supervisor',
  READINESS_OWNER: 'Named readiness owner',
  OFFICE: 'GFC office'
});
const OFFICE_ACTORS = Object.freeze(Object.values(ACTORS).filter(a => a !== 'NEW_HIRE'));

// What the acting party does.
const ACTIONS = Object.freeze({
  SUBMIT: 'SUBMIT',           // she provides a document or information
  SIGN: 'SIGN',               // she signs, against a server-recorded version
  ACKNOWLEDGE: 'ACKNOWLEDGE', // she reads and acknowledges a named document version
  COMPLETE: 'COMPLETE',       // she completes a task (a module, an enrollment)
  VERIFY: 'VERIFY',           // the office checks a primary source and dates it
  RECORD: 'RECORD',           // the office records a fact or a determination
  PROVISION: 'PROVISION',     // the office switches something on
  EXECUTE: 'EXECUTE',         // the office (or physician) executes an instrument
  OBSERVE: 'OBSERVE',         // a named person observes and signs off
  REVIEW: 'REVIEW'            // the office reviews a task it added (no primary source)
});

// A step's completion. An item whose first step is hers and whose second is a
// verification lands SUBMITTED on her action and COMPLETE only on the office's.
// She can never move an item that has a verifier to COMPLETE herself.
//
// THE OFFICE CAN ACT ON EVERY ITEM, HERS INCLUDED (owner, 2026-11-08). If she
// already signed an acknowledgment in Gusto or emailed her license, the office
// files it on her behalf and it reads complete on her side, labelled with who
// filed it. She can still upload her own copy. The rule runs one way only: the
// office may do both steps of a verified item; she may do neither second step.
//
// An acknowledgment is satisfied only at the version she actually signed. A
// copy filed for her at an older version (Clinical P&P 2.0 signed in Gusto)
// reads "signed 2.0, 2.2 required", never complete.
const FILED_BY = Object.freeze({ SELF: 'SELF', OFFICE_ON_BEHALF: 'OFFICE_ON_BEHALF' });
const ITEM_STATES = Object.freeze({
  NOT_STARTED: 'NOT_STARTED',
  SUBMITTED: 'SUBMITTED',
  RETURNED: 'RETURNED',       // the office sent her submission back, with a reason
  COMPLETE: 'COMPLETE',
  NOT_APPLICABLE: 'NOT_APPLICABLE'
});

// ---- SIGN-OFF TYPES (Training Library §2) ---------------------------------
const SIGNOFF = Object.freeze({
  ATTEST: 'ATTEST', COUNTERSIGN: 'COUNTERSIGN', OBSERVED: 'OBSERVED',
  CERTIFICATE: 'CERTIFICATE', NONE: 'NONE'
});

// ---- WHAT A MODULE OR ITEM IS REQUIRED FOR (Training Library §2.3) ---------
const DETERMINATIONS = Object.freeze(['IME', 'PRIVATE_PAY', 'INSURED', 'BEHAVIORAL']);
const PRIVILEGES = Object.freeze(['TELEHEALTH']);

function parseRequiredFor(value) {
  const m = /^(phase|determination|privilege):(.+)$/.exec(String(value || ''));
  if (!m) throw new Error(`Unrecognised required_for value: "${value}"`);
  const [, kind, target] = m;
  if (kind === 'determination' && !DETERMINATIONS.includes(target)) {
    throw new Error(`Unknown determination "${target}"`);
  }
  if (kind === 'privilege' && !PRIVILEGES.includes(target)) {
    throw new Error(`Unknown privilege "${target}"`);
  }
  if (kind === 'phase' && !/^[A-H]\.\d+$/.test(target)) {
    throw new Error(`Phase "${target}" is not chapter-scoped (expected like C.8)`);
  }
  return Object.freeze({ kind, target });
}

module.exports = {
  CLASSES, CLASSIFICATION_PHRASES, LEGAL_CLASSES,
  parseClassification, classification, isLegalRequirement,
  ACTORS, ACTOR_LABELS, OFFICE_ACTORS, ACTIONS, ITEM_STATES, FILED_BY,
  SIGNOFF, DETERMINATIONS, PRIVILEGES, parseRequiredFor
};
